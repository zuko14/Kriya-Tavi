import { and, desc, eq, isNull } from "drizzle-orm"

import { privileged } from "@/db"
import { harnessDevices } from "@/db/schema"
import {
  WorkspaceProviderError,
  type Opened,
  type WorkspaceProvider,
  type WorkspaceSpec,
} from "@/lib/cloud/provider"
import { log } from "@/lib/log"

// The `device` provider (track H, H10, HD-12): the person's own machine
// running `kriya serve` is the sandbox. Lifecycle calls go to the machine
// through kriya-relay (`/world/*`); runner calls go the same way with the
// relay secret and the workspace's ref as headers. A workspace only ever
// opens on a device of the task's own person (checked here in SQL, scoped by
// user id); the runner on the machine still checks the workspace's token.
//
// One folder per workspace and generation on the machine, inside the folder
// the person serves. Offline is not "gone": resume refuses, so the session
// leaves the workspace paused until the machine is back.

const REF = /^device-([0-9a-f-]{36})-([0-9a-f-]{36})-(\d{1,9})$/
// Devices tried per create, most recently used first
const CANDIDATES = 10

export class DeviceWorkspaceProvider implements WorkspaceProvider {
  readonly name = "device" as const

  constructor(
    private readonly options: {
      relayUrl: string
      secret: string
      fetcher?: typeof fetch
    }
  ) {}

  private get base() {
    return this.options.relayUrl.replace(/\/+$/, "")
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const { timeoutMs = 30_000, ...rest } = init
    try {
      return await (this.options.fetcher ?? fetch)(`${this.base}${path}`, {
        ...rest,
        headers: {
          "x-kriya-relay-secret": this.options.secret,
          "content-type": "application/json",
          ...rest.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      log.warn("kriya-relay unreachable", { op: path.split("/").slice(0, 3).join("/") })
      throw new WorkspaceProviderError("Kriya couldn't reach your machine's connection.")
    }
  }

  private async connected(deviceId: string) {
    const res = await this.call(`/v1/devices/${deviceId}`)
    if (!res.ok)
      throw new WorkspaceProviderError("Kriya couldn't reach your machine's connection.")
    return ((await res.json()) as { connected?: boolean }).connected === true
  }

  // A lifecycle call on the machine; its status, and the answer when JSON
  private async world(deviceId: string, op: string, body: unknown, timeoutMs?: number) {
    const res = await this.call(`/v1/forward/${deviceId}/world/${op}`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs,
    })
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, answer }
  }

  private opened(deviceId: string, ref: string): Opened {
    return {
      ref,
      runnerUrl: `${this.base}/v1/forward/${deviceId}`,
      headers: { "x-kriya-relay-secret": this.options.secret, "x-kriya-world-ref": ref },
    }
  }

  // This person's signed-in, unrevoked devices
  private async devicesOf(userId: string) {
    const rows = await privileged
      .select({ id: harnessDevices.id })
      .from(harnessDevices)
      .where(and(eq(harnessDevices.userId, userId), isNull(harnessDevices.revokedAt)))
      .orderBy(desc(harnessDevices.lastUsedAt))
      .limit(CANDIDATES)
    return rows.map((row) => row.id)
  }

  private open(deviceId: string, ref: string, spec: WorkspaceSpec, fresh: boolean) {
    // The runner's token, limits and generation go only to the machine's
    // runner (CD-09, the runner process's environment there)
    return this.world(deviceId, "open", {
      ref,
      generation: spec.generation,
      token: spec.runnerToken,
      limits: spec.limits,
      fresh,
    })
  }

  async create(spec: WorkspaceSpec) {
    for (const deviceId of await this.devicesOf(spec.userId)) {
      if (!(await this.connected(deviceId))) continue
      const ref = `device-${deviceId}-${spec.workspaceId}-${spec.generation}`
      const { status, answer } = await this.open(deviceId, ref, spec, true)
      if (status === 200) return this.opened(deviceId, ref)
      log.warn("device refused a workspace", { status })
      throw new WorkspaceProviderError(
        typeof answer?.error === "string"
          ? `Your machine refused the workspace: ${answer.error.slice(0, 200)}`
          : "Your machine refused the workspace."
      )
    }
    throw new WorkspaceProviderError(
      "None of your machines is serving Kriya right now. Run `kriya serve <folder>` on the machine you want to use."
    )
  }

  async resume(ref: string, spec: WorkspaceSpec): Promise<Opened | null> {
    const match = REF.exec(ref)
    if (!match || match[2] !== spec.workspaceId) return null
    const deviceId = match[1]
    // Signed out, revoked or someone else's: this workspace is gone for good
    if (!(await this.devicesOf(spec.userId)).includes(deviceId)) return null
    if (!(await this.connected(deviceId))) {
      throw new WorkspaceProviderError(
        "The machine this workspace is on isn't connected. Run `kriya serve` on it again."
      )
    }
    const { status } = await this.open(deviceId, ref, spec, false)
    if (status === 200) return this.opened(deviceId, ref)
    if (status === 404) return null
    throw new WorkspaceProviderError("Your machine refused to reopen the workspace.")
  }

  // Idempotent: a machine that's away has nothing running for Kriya
  async pause(ref: string) {
    await this.lifecycle(ref, "pause")
  }

  // The workspace's own folder on the machine goes; a machine that's away
  // keeps it until it's cleaned up there (the checkpoint is Kriya's copy)
  async destroy(ref: string) {
    await this.lifecycle(ref, "destroy")
  }

  // No provider-side clock: the machine runs while `kriya serve` does
  async extend() {}

  async list() {
    const res = await this.call("/v1/devices")
    if (!res.ok)
      throw new WorkspaceProviderError("Kriya couldn't reach your machine's connection.")
    const { devices } = (await res.json()) as { devices: string[] }
    const found: { ref: string; workspaceId: string | null; running: boolean }[] = []
    for (const deviceId of devices) {
      // A slow or hung machine is skipped this round, never the whole reconcile
      const { status, answer } = await this.world(deviceId, "list", {}, 10_000).catch(
        () => ({ status: 0, answer: null })
      )
      if (status !== 200 || !Array.isArray(answer?.refs)) continue
      for (const entry of answer.refs as { ref: string; running: boolean }[]) {
        const match = REF.exec(entry.ref)
        if (match?.[1] === deviceId)
          found.push({ ref: entry.ref, workspaceId: match[2], running: entry.running })
      }
    }
    return found
  }

  private async lifecycle(ref: string, op: "pause" | "destroy") {
    const deviceId = REF.exec(ref)?.[1]
    if (!deviceId || !(await this.connected(deviceId))) return
    const { status } = await this.world(deviceId, op, { ref })
    if (status !== 200 && status !== 404 && status !== 502)
      throw new WorkspaceProviderError("Your machine refused that workspace change.")
  }
}
