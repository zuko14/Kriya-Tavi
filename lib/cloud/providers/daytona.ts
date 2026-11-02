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

// Daytona (CD-07 candidate), from its published API description read
// 2026-10-31 (daytona.io/docs/openapi.json, toolbox-openapi.json, preview
// docs): lifecycle on app.daytona.io/api with a bearer key; the runner
// started through the toolbox's /process/execute with its token in `envs`,
// never in the command text (Daytona keeps command history) and never in
// the sandbox's create-time env (stored and returned by the API). The runner
// URL is a signed preview URL for its port only: the standard preview token
// is sandbox-wide and also opens the toolbox. A stopped sandbox keeps its
// disk and bills no compute; starting it again restarts the runner.

const API = "https://app.daytona.io/api"
const RUNNER_PORT = 10000
// Outlasts the longest task (7 200 s); a fresh one on every resume
const SIGNED_SECONDS = 10_800
const READY_MS = 120_000
// Daytona runs the command with a shell; the runner detaches from it
const START_RUNNER =
  "sh -c 'cd /app && setsid /usr/local/bin/node --import tsx runner/index.ts > /tmp/kriya-runner.log 2>&1 < /dev/null &'"

const SandboxSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  state: z.string().optional(),
  labels: z.record(z.string(), z.string()).nullish(),
  toolboxProxyUrl: z.string().url().optional(),
})
type Sandbox = z.infer<typeof SandboxSchema>

const GONE = new Set(["destroyed", "destroying"])
const FAILED = new Set(["error", "build_failed"])

export class DaytonaWorkspaceProvider implements WorkspaceProvider {
  readonly name = "daytona" as const
  private readonly http: ProviderHttp
  private readonly api: string

  constructor(
    private readonly options: {
      apiKey: string
      // kriya_env label: this deployment's host, so reconcile never touches another's
      env: string
      fetch?: Fetcher
      apiUrl?: string
      // Between state checks while a sandbox starts; tests pass 0
      pollMs?: number
    }
  ) {
    this.http = new ProviderHttp("daytona", options.fetch)
    this.api = options.apiUrl ?? API
  }

  private get headers() {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
    }
  }

  private url(ref: string, path = "") {
    return `${this.api}/sandbox/${encodeURIComponent(ref)}${path}`
  }

  private parse(body: unknown) {
    const sandbox = SandboxSchema.safeParse(body)
    if (!sandbox.success)
      throw new WorkspaceProviderError(
        "The cloud workspace provider's answer was unreadable."
      )
    return sandbox.data
  }

  private async get(ref: string) {
    const body = await this.http.json<unknown>("get", this.url(ref), {
      headers: this.headers,
      allow: [404],
    })
    return body === null ? null : this.parse(body)
  }

  // Until it runs; an error state or a timeout refuses
  private async ready(ref: string) {
    const deadline = Date.now() + READY_MS
    for (;;) {
      const sandbox = await this.get(ref)
      if (!sandbox || GONE.has(sandbox.state ?? "") || FAILED.has(sandbox.state ?? ""))
        break
      if (sandbox.state === "started") return sandbox
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 1000))
    }
    throw new WorkspaceProviderError(
      "The cloud workspace couldn't be started at the provider."
    )
  }

  private async open(sandbox: Sandbox, spec: WorkspaceSpec): Promise<Opened> {
    if (!sandbox.toolboxProxyUrl)
      throw new WorkspaceProviderError(
        "The cloud workspace provider's answer was unreadable."
      )
    const started = await this.http.json<{ exitCode?: number }>(
      "start runner",
      `${sandbox.toolboxProxyUrl}/${encodeURIComponent(sandbox.id)}/process/execute`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          command: START_RUNNER,
          envs: runnerEnvironment(spec),
          timeout: 30,
        }),
        timeoutMs: 45_000,
      }
    )
    if (started?.exitCode !== 0)
      throw new WorkspaceProviderError("The cloud workspace runner didn't start.")
    const query = new URLSearchParams({ expiresInSeconds: String(SIGNED_SECONDS) })
    const signed = await this.http.json<{ url?: string }>(
      "signed url",
      `${this.url(sandbox.id, `/ports/${RUNNER_PORT}/signed-preview-url`)}?${query}`,
      { headers: this.headers }
    )
    if (!signed?.url?.startsWith("https://"))
      throw new WorkspaceProviderError(
        "The cloud workspace provider's answer was unreadable."
      )
    return { ref: sandbox.id, runnerUrl: signed.url }
  }

  async create(spec: WorkspaceSpec) {
    const offline = spec.network === "offline"
    const created = await this.http.json<unknown>("create", `${this.api}/sandbox`, {
      method: "POST",
      headers: this.headers,
      timeoutMs: 60_000,
      body: JSON.stringify({
        snapshot: spec.image,
        labels: { kriya_env: this.options.env, workspace_id: spec.workspaceId },
        public: false,
        ...(offline
          ? { networkBlockAll: true }
          : { domainAllowList: REGISTRY_HOSTS.join(",") }),
        // Kriya stopped extending it: stop (disk kept, no compute billed)
        autoStopInterval: Math.max(1, Math.ceil(spec.timeoutSeconds / 60)),
        // The janitor deletes; Daytona's own auto-delete stays off
        autoDeleteInterval: -1,
      }),
    })
    const sandbox = this.parse(created)
    try {
      return await this.open(await this.ready(sandbox.id), spec)
    } catch (error) {
      await this.destroy(sandbox.id).catch(() => {})
      throw error
    }
  }

  async resume(ref: string, spec: WorkspaceSpec) {
    const sandbox = await this.get(ref)
    if (!sandbox || GONE.has(sandbox.state ?? "")) return null
    if (sandbox.state === "started") return this.open(sandbox, spec)
    await this.http.request("start", this.url(ref, "/start"), {
      method: "POST",
      headers: this.headers,
      timeoutMs: 60_000,
    })
    return this.open(await this.ready(ref), spec)
  }

  async pause(ref: string) {
    await this.http.request("pause", this.url(ref, "/stop"), {
      method: "POST",
      headers: this.headers,
      retry: true,
      allow: [404],
      timeoutMs: 60_000,
    })
  }

  async destroy(ref: string) {
    await this.http.request("destroy", this.url(ref), {
      method: "DELETE",
      headers: this.headers,
      retry: true,
      allow: [404],
    })
  }

  // Activity resets the auto-stop timer set at create
  async extend(ref: string) {
    await this.http.request("extend", this.url(ref, "/last-activity"), {
      method: "POST",
      headers: this.headers,
      retry: true,
    })
  }

  async list() {
    const out: { ref: string; workspaceId: string | null; running: boolean }[] = []
    let cursor: string | null = null
    // shortcut: 50 pages of 100; more sandboxes than that means a bigger problem than reconcile
    for (let page = 0; page < 50; page++) {
      const query: URLSearchParams = new URLSearchParams({
        labels: JSON.stringify({ kriya_env: this.options.env }),
        limit: "100",
        ...(cursor && { cursor }),
      })
      const body: { items?: unknown[]; nextCursor?: string | null } | null =
        await this.http.json("list", `${this.api}/sandbox?${query}`, {
          headers: this.headers,
          retry: true,
        })
      for (const item of body?.items ?? []) {
        const sandbox = SandboxSchema.safeParse(item)
        if (!sandbox.success || GONE.has(sandbox.data.state ?? "")) continue
        out.push({
          ref: sandbox.data.id,
          workspaceId: sandbox.data.labels?.workspace_id ?? null,
          running: sandbox.data.state === "started",
        })
      }
      cursor = body?.nextCursor ?? null
      if (!cursor) break
    }
    return out
  }
}
