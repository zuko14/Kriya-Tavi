import { z } from "zod"

import {
  REGISTRY_HOSTS,
  runnerEnvironment,
  WorkspaceProviderError,
  type Opened,
  type WorkspaceProvider,
  type WorkspaceSpec,
} from "@/lib/cloud/provider"
import { ProviderHttp, type Fetcher } from "@/lib/cloud/providers/http"

// E2B (CD-07 candidate), from its published API description read 2026-10-31
// (e2b-dev/infra spec/openapi.yml, packages/envd/spec; E2B JS SDK source):
// lifecycle on api.e2b.app with the X-API-Key header; the runner started as
// root through the sandbox's envd (process.Process/Start, Connect JSON) with
// its token in that process's environment only. Create-time envVars don't
// reach a command baked into the template snapshot, so the adapter starts
// the runner itself and then disconnects (E2B documents that the process
// keeps running). Public traffic is off: every runner call carries the
// sandbox's traffic token. Pause keeps memory, so the runner survives it.

const API = "https://api.e2b.app"
const ENVD_PORT = 49983
const RUNNER_PORT = 10000
const START_MS = 30_000

// Ids and domains end up in host names: checked before use
const SandboxSchema = z.object({
  sandboxID: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  envdAccessToken: z.string().min(1).optional(),
  trafficAccessToken: z.string().min(1).nullish(),
  domain: z
    .string()
    .regex(/^[a-z0-9.-]{3,100}$/)
    .nullish(),
})
type Sandbox = z.infer<typeof SandboxSchema>

const ListedSchema = z.array(
  z.object({
    sandboxID: z.string(),
    state: z.string(),
    metadata: z.record(z.string(), z.string()).nullish(),
  })
)

// A Connect envelope: flags byte, big-endian length, JSON
function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message))
  const out = Buffer.alloc(5 + body.length)
  out.writeUInt8(0, 0)
  out.writeUInt32BE(body.length, 1)
  body.copy(out, 5)
  return new Uint8Array(out)
}

export class E2BWorkspaceProvider implements WorkspaceProvider {
  readonly name = "e2b" as const
  private readonly http: ProviderHttp
  private readonly api: string

  constructor(
    private readonly options: {
      apiKey: string
      // kriya_env tag: this deployment's host, so reconcile never touches another's
      env: string
      fetch?: Fetcher
      apiUrl?: string
    }
  ) {
    this.http = new ProviderHttp("e2b", options.fetch)
    this.api = options.apiUrl ?? API
  }

  private get headers() {
    return { "x-api-key": this.options.apiKey, "content-type": "application/json" }
  }

  private opened(sandbox: Sandbox): Opened {
    const domain = sandbox.domain ?? "e2b.app"
    return {
      ref: sandbox.sandboxID,
      runnerUrl: `https://${RUNNER_PORT}-${sandbox.sandboxID}.${domain}`,
      ...(sandbox.trafficAccessToken && {
        headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken },
      }),
    }
  }

  private parse(body: unknown) {
    const sandbox = SandboxSchema.safeParse(body)
    if (!sandbox.success)
      throw new WorkspaceProviderError(
        "The cloud workspace provider's answer was unreadable."
      )
    return sandbox.data
  }

  async create(spec: WorkspaceSpec) {
    const offline = spec.network === "offline"
    const created = await this.http.json<unknown>("create", `${this.api}/v2/sandboxes`, {
      method: "POST",
      headers: this.headers,
      timeoutMs: 60_000,
      body: JSON.stringify({
        templateID: spec.image,
        timeout: spec.timeoutSeconds,
        // Kriya stopped extending it: keep the disk and memory, stop billing
        autoPause: true,
        metadata: { kriya_env: this.options.env, workspace_id: spec.workspaceId },
        ...(offline && { allow_internet_access: false }),
        network: {
          allowPublicTraffic: false,
          ...(offline ? {} : { allowOut: REGISTRY_HOSTS }),
          denyOut: ["0.0.0.0/0"],
        },
      }),
    })
    const sandbox = this.parse(created)
    try {
      await this.startRunner(sandbox, spec)
    } catch (error) {
      await this.destroy(sandbox.sandboxID).catch(() => {})
      throw error
    }
    return this.opened(sandbox)
  }

  // Waits for the start event (the process exists), then lets go of the stream
  private async startRunner(sandbox: Sandbox, spec: WorkspaceSpec) {
    if (!sandbox.envdAccessToken)
      throw new WorkspaceProviderError("The cloud workspace can't be reached securely.")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), START_MS)
    try {
      const res = await this.http.request(
        "start runner",
        `https://${ENVD_PORT}-${sandbox.sandboxID}.${sandbox.domain ?? "e2b.app"}/process.Process/Start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/connect+json",
            "connect-protocol-version": "1",
            "x-access-token": sandbox.envdAccessToken,
            // envd runs the process as this user (CD-21: the runner is root)
            authorization: `Basic ${Buffer.from("root:").toString("base64")}`,
          },
          body: frame({
            process: {
              cmd: "/usr/local/bin/node",
              args: ["--import", "tsx", "runner/index.ts"],
              cwd: "/app",
              envs: runnerEnvironment(spec),
            },
            stdin: false,
          }),
          signal: controller.signal,
          timeoutMs: START_MS,
        }
      )
      const reader = res.body!.getReader()
      let pending = Buffer.alloc(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending = Buffer.concat([pending, Buffer.from(value)])
        while (pending.length >= 5) {
          const flags = pending.readUInt8(0)
          const length = pending.readUInt32BE(1)
          if (pending.length < 5 + length) break
          const message = JSON.parse(pending.subarray(5, 5 + length).toString()) as {
            event?: { start?: { pid?: number }; end?: unknown }
          }
          pending = pending.subarray(5 + length)
          // flags 2: the stream ended (an error, or the process already exited)
          if (flags & 2 || message.event?.end) break
          if (message.event?.start) {
            void reader.cancel().catch(() => {})
            return
          }
        }
      }
      throw new WorkspaceProviderError("The cloud workspace runner didn't start.")
    } catch (error) {
      if (error instanceof WorkspaceProviderError) throw error
      throw new WorkspaceProviderError("The cloud workspace runner didn't start.")
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  async resume(ref: string, spec: WorkspaceSpec) {
    const body = await this.http.json<unknown>(
      "resume",
      `${this.api}/v2/sandboxes/${encodeURIComponent(ref)}/connect`,
      {
        method: "POST",
        headers: this.headers,
        allow: [404],
        timeoutMs: 60_000,
        body: JSON.stringify({ timeout: spec.timeoutSeconds }),
      }
    )
    return body === null ? null : this.opened(this.parse(body))
  }

  async pause(ref: string) {
    // 404: gone; 409: already pausing or paused
    await this.http.request(
      "pause",
      `${this.api}/sandboxes/${encodeURIComponent(ref)}/pause`,
      {
        method: "POST",
        headers: this.headers,
        body: "{}",
        retry: true,
        allow: [404, 409],
        timeoutMs: 60_000,
      }
    )
  }

  async destroy(ref: string) {
    await this.http.request(
      "destroy",
      `${this.api}/sandboxes/${encodeURIComponent(ref)}`,
      {
        method: "DELETE",
        headers: this.headers,
        retry: true,
        allow: [404],
      }
    )
  }

  async extend(ref: string, seconds: number) {
    await this.http.request(
      "extend",
      `${this.api}/sandboxes/${encodeURIComponent(ref)}/timeout`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ timeout: seconds }),
        retry: true,
      }
    )
  }

  async list() {
    const out: { ref: string; workspaceId: string | null; running: boolean }[] = []
    let next: string | null = null
    // shortcut: 50 pages of 100; more sandboxes than that means a bigger problem than reconcile
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({
        metadata: `kriya_env=${encodeURIComponent(this.options.env)}`,
        state: "running,paused",
        limit: "100",
        ...(next && { nextToken: next }),
      })
      const res = await this.http.request("list", `${this.api}/v2/sandboxes?${query}`, {
        headers: this.headers,
        retry: true,
      })
      const listed = ListedSchema.safeParse(await res.json().catch(() => null))
      if (!listed.success)
        throw new WorkspaceProviderError(
          "The cloud workspace provider's answer was unreadable."
        )
      for (const sandbox of listed.data) {
        out.push({
          ref: sandbox.sandboxID,
          workspaceId: sandbox.metadata?.workspace_id ?? null,
          running: sandbox.state === "running",
        })
      }
      next = res.headers.get("x-next-token")
      if (!next) break
    }
    return out
  }
}
