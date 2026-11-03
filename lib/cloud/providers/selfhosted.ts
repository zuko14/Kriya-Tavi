import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { execLeases } from "@/db/schema"
import {
  WorkspaceProviderError,
  type Opened,
  type WorkspaceProvider,
  type WorkspaceSpec,
} from "@/lib/cloud/provider"
import { log } from "@/lib/log"
import {
  HEADERS,
  nodeKey,
  parseRef,
  proxyToken,
  signedHeaders,
  type ListedSandbox,
  type NodeStats,
} from "@/cloud-node/protocol"

// The `selfhosted` provider (CD-28…CD-33): sandboxes on machines Kriya
// operates, each running kriya-node. Before any compute it takes a lease in
// kriya.exec_leases and waits, polling exec_admit with jittered backoff,
// until the fabric's scheduler grants it a node (CD-29, CD-32) or the wait
// runs out ("busy", retryable, nothing dropped silently). The lease's id is
// the fence (CD-31): the node accepts runner traffic only with the newest
// fence's proxy token, so a worker that lost its lease is locked out.
//
// A resume must land on the node holding the sandbox's disk; a node that is
// unreachable is "not gone" (the workspace stays paused, like the device
// provider), while a node that no longer has the sandbox is (restore path).
// Writes are this workspace's bookkeeping, scoped by its user id.

export type FabricNode = { id: string; url: string }

export type FabricPolicy = {
  admission: "on" | "off"
  isolation: "gvisor" | "trusted-runc"
  users: "*" | string[]
  maxWaitSeconds: number
  maxPerUser: number
  maxQueued: number
  maxQueuedPerUser: number
  cpuOvercommitPct: number
  diskMb: number
  idleSeconds: number
  starvationSeconds: number
  staleSeconds: number
  abandonSeconds: number
  psiCpuMax: number
  psiMemMax: number
  psiIoMax: number
  pids: number
}

export const DEFAULT_POLICY: FabricPolicy = {
  admission: "on",
  isolation: "gvisor",
  users: [],
  maxWaitSeconds: 60,
  maxPerUser: 1,
  maxQueued: 50,
  maxQueuedPerUser: 2,
  cpuOvercommitPct: 150,
  diskMb: 10_240,
  idleSeconds: 900,
  starvationSeconds: 120,
  staleSeconds: 90,
  abandonSeconds: 30,
  psiCpuMax: 60,
  psiMemMax: 10,
  psiIoMax: 40,
  pids: 2048,
}

// cloud.size "2c-4g" → what a lease reserves
export function sizeOf(size: string) {
  const match = /^([1-8])c-([1-9]\d?)g$/.exec(size)
  if (!match) throw new WorkspaceProviderError("The workspace size isn't valid.")
  return { cpuMillis: Number(match[1]) * 1000, memMb: Number(match[2]) * 1024 }
}

// "id=https://host,…" from selfhosted.nodes; plain http only on loopback
export function parseNodes(value: string | undefined): FabricNode[] {
  const nodes: FabricNode[] = []
  for (const entry of (value ?? "").split(",").filter(Boolean)) {
    const at = entry.indexOf("=")
    const id = entry.slice(0, at)
    let url: URL
    try {
      url = new URL(entry.slice(at + 1))
    } catch {
      continue
    }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost"
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) continue
    nodes.push({ id, url: url.origin })
  }
  return nodes
}

// The SQL refusals in plain words; everything else stays generic
function plain(error: unknown) {
  const { message, cause } = error as { message?: string; cause?: { message?: string } }
  const text = `${message} ${cause?.message}`
  if (/queue is full/.test(text))
    return "Kriya's workspace machines are busy; try again in a few minutes."
  return "The workspace couldn't be scheduled."
}

const jitter = (ms: number) => Math.round(ms / 2 + Math.random() * (ms / 2))

export class SelfHostedWorkspaceProvider implements WorkspaceProvider {
  readonly name = "selfhosted" as const
  // The fences this instance opened (one TaskWorkspace's), so its pause or
  // destroy never acts with a newer holder's fence
  private readonly own = new Map<string, number>()

  constructor(
    private readonly options: {
      nodes: FabricNode[]
      secret: string
      policy: FabricPolicy
      fetcher?: typeof fetch
      sleep?: (ms: number) => Promise<void>
    }
  ) {}

  private node(id: string) {
    return this.options.nodes.find((n) => n.id === id) ?? null
  }

  private key(nodeId: string) {
    return nodeKey(this.options.secret, nodeId)
  }

  // A signed call to one node; transport errors and 5xx retried only when
  // the call is idempotent (every node call is, by ref and fence)
  async call<T>(
    nodeId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { retries?: number; timeoutMs?: number } = {}
  ): Promise<{ status: number; body: T | null }> {
    const node = this.node(nodeId)
    if (!node)
      throw new WorkspaceProviderError("That workspace machine isn't configured.")
    const text = body === undefined ? "" : JSON.stringify(body)
    const retries = opts.retries ?? 2
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await (this.options.fetcher ?? fetch)(`${node.url}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...signedHeaders(this.key(nodeId), method, path, text),
          },
          ...(method === "POST" && { body: text }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        })
        if (res.status >= 500 && res.status !== 507 && attempt < retries) {
          void res.body?.cancel().catch(() => {})
          await this.sleep(jitter(500 * 2 ** attempt))
          continue
        }
        const answer = (await res.json().catch(() => null)) as T | null
        return { status: res.status, body: answer }
      } catch {
        if (attempt < retries) {
          await this.sleep(jitter(500 * 2 ** attempt))
          continue
        }
        log.warn("workspace node unreachable", { node: nodeId, path: path.split("?")[0] })
        throw new WorkspaceProviderError("Kriya couldn't reach the workspace machine.")
      }
    }
  }

  private sleep(ms: number) {
    return (this.options.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms)
  }

  private allowed(userId: string) {
    const users = this.options.policy.users
    return users === "*" || users.includes(userId)
  }

  private opened(nodeId: string, ref: string, fence: number): Opened {
    return {
      ref,
      runnerUrl: `${this.node(nodeId)!.url}/v1/runner/${ref}`,
      headers: {
        [HEADERS.proxy]: proxyToken(this.key(nodeId), ref, fence),
        [HEADERS.fence]: String(fence),
      },
    }
  }

  private policyJson() {
    const p = this.options.policy
    return JSON.stringify({
      admission: p.admission,
      isolation: p.isolation,
      cpuOvercommitPct: p.cpuOvercommitPct,
      maxPerUser: p.maxPerUser,
      maxQueued: p.maxQueued,
      maxQueuedPerUser: p.maxQueuedPerUser,
      starvationSeconds: p.starvationSeconds,
      staleSeconds: p.staleSeconds,
      abandonSeconds: p.abandonSeconds,
      psiCpuMax: p.psiCpuMax,
      psiMemMax: p.psiMemMax,
      psiIoMax: p.psiIoMax,
    })
  }

  // A lease granted on a node, or WorkspaceProviderError("busy") when the
  // wait runs out (the lease is cancelled, never left to be granted later)
  private async lease(
    spec: WorkspaceSpec,
    pinned: string | null,
    replaces: number | null
  ) {
    const { cpuMillis, memMb } = sizeOf(spec.size)
    let id: number
    try {
      const rows = rowsOf<{ id: string }>(
        await privileged.execute(
          sql`select kriya.exec_request(${spec.userId}::uuid, ${spec.workspaceId}::uuid, ${spec.generation}::int, ${cpuMillis}::int, ${memMb}::int, ${this.options.policy.diskMb}::int, ${pinned}, ${replaces}::bigint, 0, ${this.policyJson()}::jsonb) as id`
        )
      )
      id = Number(rows[0].id)
    } catch (error) {
      throw new WorkspaceProviderError(plain(error))
    }
    const deadline = Date.now() + this.options.policy.maxWaitSeconds * 1000
    let wait = 250
    for (;;) {
      const [row] = rowsOf<{
        lease_status: string
        node_id: string | null
        ref: string | null
      }>(
        await privileged.execute(
          sql`select * from kriya.exec_admit(${id}::bigint, ${this.policyJson()}::jsonb)`
        )
      )
      if (row.lease_status === "granted" && row.node_id && row.ref)
        return { id, nodeId: row.node_id, ref: row.ref }
      if (row.lease_status !== "waiting" || Date.now() >= deadline) {
        const cancelled = await this.end(
          id,
          spec.userId,
          ["waiting"],
          "cancelled",
          "wait_timeout"
        )
        // Granted by another waiter's pass in between: taken, not leaked
        if (!cancelled) {
          const [late] = await privileged
            .select({
              status: execLeases.status,
              nodeId: execLeases.nodeId,
              ref: execLeases.ref,
            })
            .from(execLeases)
            .where(and(eq(execLeases.id, id), eq(execLeases.userId, spec.userId)))
          if (late?.status === "granted" && late.nodeId && late.ref)
            return { id, nodeId: late.nodeId, ref: late.ref }
        }
        log.info("workspace lease not granted", { lease: id, status: row.lease_status })
        throw new WorkspaceProviderError(
          "Kriya's workspace machines are busy; try again in a few minutes."
        )
      }
      await this.sleep(jitter(wait))
      wait = Math.min(2000, Math.round(wait * 1.5))
    }
  }

  private async end(
    id: number,
    userId: string,
    from: (typeof execLeases.$inferSelect)["status"][],
    to: "released" | "cancelled" | "stopped",
    reason: string
  ) {
    const moved = await privileged
      .update(execLeases)
      .set({ status: to, ...(to !== "stopped" && { endedAt: new Date() }), reason })
      .where(
        and(
          eq(execLeases.id, id),
          eq(execLeases.userId, userId),
          inArray(execLeases.status, from)
        )
      )
      .returning({ id: execLeases.id })
    return moved.length > 0
  }

  private openBody(spec: WorkspaceSpec, ref: string, fence: number, fresh: boolean) {
    const { cpuMillis, memMb } = sizeOf(spec.size)
    return {
      ref,
      workspaceId: spec.workspaceId,
      generation: spec.generation,
      fence,
      cpuMillis,
      memMb,
      diskMb: this.options.policy.diskMb,
      pids: this.options.policy.pids,
      network: spec.network,
      idleSeconds: this.options.policy.idleSeconds,
      fresh,
      // CD-09: the runner process's environment there, nowhere else
      env: {
        KRIYA_RUNNER_TOKEN: spec.runnerToken,
        KRIYA_RUNNER_LIMITS: JSON.stringify(spec.limits),
        KRIYA_RUNNER_GENERATION: String(spec.generation),
      },
    }
  }

  private async started(lease: { id: number }, userId: string) {
    await privileged
      .update(execLeases)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(execLeases.id, lease.id),
          eq(execLeases.userId, userId),
          eq(execLeases.status, "granted")
        )
      )
  }

  async create(spec: WorkspaceSpec) {
    if (!this.allowed(spec.userId))
      throw new WorkspaceProviderError(
        "Cloud workspaces aren't available for this account yet."
      )
    const lease = await this.lease(spec, null, null)
    const { status, body } = await this.call<{ error?: string }>(
      lease.nodeId,
      "POST",
      "/v1/sandboxes/open",
      this.openBody(spec, lease.ref, lease.id, true),
      { timeoutMs: 120_000 }
    ).catch(async (error: unknown) => {
      await this.end(lease.id, spec.userId, ["granted"], "released", "start_failed")
      throw error
    })
    if (status !== 200) {
      await this.end(lease.id, spec.userId, ["granted"], "released", "start_failed")
      // 409 here means a sandbox with this ref already exists on the node:
      // never adopted, so a fresh start never runs on someone's old disk
      log.warn("workspace node refused a sandbox", { node: lease.nodeId, status })
      throw new WorkspaceProviderError(
        status === 507 || status === 503
          ? "Kriya's workspace machines are busy; try again in a few minutes."
          : `The workspace machine refused the sandbox${body?.error ? `: ${body.error.slice(0, 120)}` : "."}`
      )
    }
    await this.started(lease, spec.userId)
    this.own.set(lease.ref, lease.id)
    return this.opened(lease.nodeId, lease.ref, lease.id)
  }

  async resume(ref: string, spec: WorkspaceSpec): Promise<Opened | null> {
    const parsed = parseRef(ref)
    if (!parsed || parsed.workspaceId !== spec.workspaceId) return null
    // The node left selfhosted.nodes: its sandboxes are gone for Kriya
    if (!this.node(parsed.nodeId)) return null
    // No allow-list check: it gates new sandboxes only, so the janitor can
    // still checkpoint and close the workspaces of someone taken off it
    // The stopped lease whose disk this resume takes over, if any
    const [previous] = await privileged
      .select({ id: execLeases.id, status: execLeases.status })
      .from(execLeases)
      .where(
        and(
          eq(execLeases.ref, ref),
          eq(execLeases.userId, spec.userId),
          inArray(execLeases.status, ["granted", "running", "stopped"])
        )
      )
      .orderBy(desc(execLeases.id))
      .limit(1)
    // A crashed worker left it running: stopped first, so it's taken over
    if (previous && previous.status !== "stopped")
      await this.end(
        previous.id,
        spec.userId,
        ["granted", "running"],
        "stopped",
        "taken_over"
      )
    const lease = await this.lease(spec, parsed.nodeId, previous?.id ?? null)
    let answer: { status: number; body: { error?: string } | null }
    try {
      answer = await this.call(
        lease.nodeId,
        "POST",
        "/v1/sandboxes/open",
        this.openBody(spec, ref, lease.id, false),
        { timeoutMs: 120_000 }
      )
    } catch (error) {
      // Unreachable is not gone: the workspace stays paused, the lease freed
      await this.end(lease.id, spec.userId, ["granted"], "released", "start_failed")
      throw error
    }
    if (answer.status === 404) {
      await this.end(lease.id, spec.userId, ["granted"], "released", "gone")
      return null
    }
    if (answer.status !== 200) {
      await this.end(lease.id, spec.userId, ["granted"], "released", "start_failed")
      log.warn("workspace node refused a resume", {
        node: lease.nodeId,
        status: answer.status,
      })
      throw new WorkspaceProviderError(
        "The workspace machine refused to reopen the workspace."
      )
    }
    await this.started(lease, spec.userId)
    this.own.set(ref, lease.id)
    return this.opened(lease.nodeId, ref, lease.id)
  }

  // This instance's fence, else the newest live lease's (the janitor's case)
  private async fenceOf(ref: string) {
    const own = this.own.get(ref)
    if (own) return own
    const [row] = await privileged
      .select({ id: execLeases.id })
      .from(execLeases)
      .where(
        and(
          eq(execLeases.ref, ref),
          inArray(execLeases.status, ["granted", "running", "stopped"])
        )
      )
      .orderBy(desc(execLeases.id))
      .limit(1)
    return row?.id ?? null
  }

  async pause(ref: string) {
    const parsed = parseRef(ref)
    if (!parsed || !this.node(parsed.nodeId)) return
    const fence = await this.fenceOf(ref)
    if (!fence) return
    const { status } = await this.call(parsed.nodeId, "POST", "/v1/sandboxes/stop", {
      ref,
      fence,
    })
    // 409: a newer holder has it; leave its lease and sandbox alone
    if (status === 409) return
    if (status !== 200)
      throw new WorkspaceProviderError("The workspace machine refused to pause it.")
    await privileged
      .update(execLeases)
      .set({ status: "stopped", reason: "paused" })
      .where(
        and(eq(execLeases.id, fence), inArray(execLeases.status, ["granted", "running"]))
      )
  }

  async destroy(ref: string) {
    const parsed = parseRef(ref)
    if (!parsed || !this.node(parsed.nodeId)) return
    const fence = await this.fenceOf(ref)
    const { status } = await this.call(parsed.nodeId, "POST", "/v1/sandboxes/destroy", {
      ref,
      ...(fence && { fence }),
    })
    if (status === 409) return
    if (status !== 200)
      throw new WorkspaceProviderError("The workspace machine refused to remove it.")
    await privileged
      .update(execLeases)
      .set({ status: "released", endedAt: new Date(), reason: "destroyed" })
      .where(
        and(
          eq(execLeases.ref, ref),
          inArray(execLeases.status, ["granted", "running", "stopped"])
        )
      )
    this.own.delete(ref)
  }

  // The node has no clock of its own on Kriya's behalf but the idle stop;
  // the heartbeat keeps it from firing while the task runs
  async extend(ref: string) {
    const parsed = parseRef(ref)
    const fence = this.own.get(ref)
    if (!parsed || !fence || !this.node(parsed.nodeId)) return
    await this.call(
      parsed.nodeId,
      "POST",
      "/v1/sandboxes/touch",
      { ref, fence },
      { retries: 0 }
    )
  }

  // One node's sandboxes, or null when it didn't answer
  async listNode(nodeId: string) {
    const answer = await this.call<{ sandboxes: ListedSandbox[] }>(
      nodeId,
      "GET",
      "/v1/sandboxes",
      undefined,
      { retries: 0, timeoutMs: 10_000 }
    ).catch(() => null)
    if (answer?.status !== 200 || !Array.isArray(answer.body?.sandboxes)) return null
    return answer.body.sandboxes.filter((s) => parseRef(s.ref)?.nodeId === nodeId)
  }

  // Every node's sandboxes; an unreachable node is skipped this round
  async list() {
    const out: { ref: string; workspaceId: string | null; running: boolean }[] = []
    for (const node of this.options.nodes) {
      for (const sandbox of (await this.listNode(node.id)) ?? [])
        out.push({
          ref: sandbox.ref,
          workspaceId: parseRef(sandbox.ref)!.workspaceId,
          running: sandbox.running,
        })
    }
    return out
  }

  // One node's measurements, for the fabric sweep
  async stats(nodeId: string) {
    const answer = await this.call<NodeStats>(nodeId, "GET", "/v1/node", undefined, {
      retries: 0,
      timeoutMs: 10_000,
    })
    return answer.status === 200 ? answer.body : null
  }

  get nodes() {
    return this.options.nodes
  }
}
