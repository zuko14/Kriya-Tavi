import { createHash, randomUUID } from "node:crypto"

import { and, desc, eq, ne, sql } from "drizzle-orm"

import { privileged } from "@/db"
import {
  resourceUsage,
  workspaces,
  workspaceSessions,
  type Task,
  type WorkspaceChanges,
} from "@/db/schema"
import { saveCheckpoint } from "@/lib/cloud/checkpoint"
import { fabricSettings } from "@/lib/cloud/fabric"
import { RunnerClient, RunnerRequestError } from "@/lib/cloud/client"
import type {
  Opened,
  RepoSource,
  WorkspaceProvider,
  WorkspaceSpec,
} from "@/lib/cloud/provider"
import { DaytonaWorkspaceProvider } from "@/lib/cloud/providers/daytona"
import { DeviceWorkspaceProvider } from "@/lib/cloud/providers/device"
import { E2BWorkspaceProvider } from "@/lib/cloud/providers/e2b"
import { LocalWorkspaceProvider, localAllowed } from "@/lib/cloud/providers/local"
import { SelfHostedWorkspaceProvider } from "@/lib/cloud/providers/selfhosted"
import { runnerToken } from "@/lib/cloud/token"
import { getSecret, getSetting } from "@/lib/config"
import { githubTarball } from "@/lib/connectors/github"
import { fileStore, type FileStore } from "@/lib/files"
import { log } from "@/lib/log"

// One task's cloud workspace, from the worker's side (CD-16, TOOLS_AND_
// CONTRACTS §4), the counterpart of TaskBrowser: the session row (plan
// minutes, running cap, checked in SQL) before any compute, the sandbox
// resumed or rebuilt on the first workspace call, kept alive by the task
// heartbeat, checkpointed, paused and metered when the task ends. The
// privileged writes are this task's bookkeeping, scoped by its user id.

export type CloudSettings = {
  image: string
  size: string
  network: "registries" | "offline"
  commandTimeoutSeconds: number
  maxRunning: number
  maxImportMb: number
  maxCheckpointMb: number
  // Owner-entered price for the size; null = unpriced, never zero
  costMicroUsdPerHour: number | null
}

export async function cloudSettings(): Promise<CloudSettings> {
  const int = async (key: Parameters<typeof getSetting>[0], fallback: number) =>
    Number.parseInt((await getSetting(key)) ?? "", 10) || fallback
  const rate = await getSetting("cloud.costMicroUsdPerHour")
  return {
    image: (await getSetting("cloud.image")) ?? "local",
    size: (await getSetting("cloud.size")) ?? "2c-4g",
    network: (await getSetting("cloud.network")) === "offline" ? "offline" : "registries",
    commandTimeoutSeconds: await int("cloud.commandTimeoutSeconds", 600),
    maxRunning: await int("cloud.maxRunning", 3),
    maxImportMb: await int("cloud.maxImportMb", 200),
    maxCheckpointMb: await int("cloud.maxCheckpointMb", 50),
    costMicroUsdPerHour: rate ? Number.parseInt(rate, 10) : null,
  }
}

let forTests: WorkspaceProvider | null = null
let local: LocalWorkspaceProvider | null = null

export function setWorkspaceProviderForTests(provider: WorkspaceProvider | null) {
  forTests = provider
}

// The adapter for cloud.provider when its configuration is complete, else
// null. Only this reads provider settings (CT-IMP-03), and runTask calls it
// options.maxWaitSeconds: the janitor's shorter wait for self-hosted
// capacity, so a full node never stalls its loop
export async function workspaceProvider(
  options: { maxWaitSeconds?: number } = {}
): Promise<WorkspaceProvider | null> {
  if (forTests) return forTests
  const secret = getSecret("KRIYA_WORKSPACE_SECRET")
  if (!secret || secret.length < 32) return null
  const name = await getSetting("cloud.provider")
  // One instance: it tracks the runner processes it started
  if (name === "local")
    return localAllowed() ? (local ??= new LocalWorkspaceProvider()) : null
  // H10, HD-12: the person's own machine through kriya-relay
  if (name === "device") {
    const relayUrl = process.env.KRIYA_RELAY_URL?.trim()
    const relaySecret = getSecret("KRIYA_RELAY_SECRET")
    if ((await getSetting("harness.deviceWorld")) !== "on") return null
    return relayUrl && relaySecret && relaySecret.length >= 32
      ? new DeviceWorkspaceProvider({ relayUrl, secret: relaySecret })
      : null
  }
  // CD-28: machines Kriya operates (kriya-node), each key derived from
  // KRIYA_NODE_SECRET; no node configured means no workspace
  if (name === "selfhosted") {
    const nodeSecret = getSecret("KRIYA_NODE_SECRET")
    if (!nodeSecret || nodeSecret.length < 32) return null
    const fabric = await fabricSettings()
    return fabric.nodes.length
      ? new SelfHostedWorkspaceProvider({
          nodes: fabric.nodes,
          secret: nodeSecret,
          policy: {
            ...fabric.policy,
            maxWaitSeconds: options.maxWaitSeconds ?? fabric.policy.maxWaitSeconds,
          },
        })
      : null
  }
  // Vendors tag sandboxes with this deployment's host, so the janitor's
  // reconcile never touches another deployment's (C8)
  const env = deploymentHost()
  if (!env) return null
  if (name === "e2b") {
    const apiKey = getSecret("E2B_API_KEY")
    return apiKey ? new E2BWorkspaceProvider({ apiKey, env }) : null
  }
  if (name === "daytona") {
    const apiKey = getSecret("DAYTONA_API_KEY")
    return apiKey ? new DaytonaWorkspaceProvider({ apiKey, env }) : null
  }
  return null
}

function deploymentHost() {
  try {
    return new URL(process.env.KRIYA_APP_URL ?? "").host || null
  } catch {
    return null
  }
}

type StopReason = "canceled" | "lease_lost" | "deadline" | "budget" | "shutdown"
type Row = typeof workspaces.$inferSelect
type Status = Row["status"]
type CloseReason = NonNullable<(typeof workspaceSessions.$inferSelect)["closeReason"]>

export type WorkspaceLine = Pick<
  Row,
  "repo" | "baseRef" | "baseSha" | "status" | "changes" | "lastActiveAt"
> & { restored: boolean }

export type OpenResult = {
  repo: string | null
  ref: string | null
  baseSha: string | null
  status: Status
  restored: boolean
}

const MB = 1024 * 1024
// The provider stops a sandbox Kriya stopped extending; the task heartbeat
// extends it every few seconds, the janitor catches orphans sooner
const SANDBOX_SECONDS = 600

// A repository workspace that failed with nothing to restore can't be
// resumed; a new one is opened instead (DATA_MODEL §5)
const resumable = (row: Row) =>
  row.status !== "failed" || !row.repo || !!row.checkpointPath

// The SQL refusals of open_workspace_session in plain words
function refusal(error: unknown) {
  // Drizzle wraps the database's message in `cause`
  const { message, cause } = error as { message?: string; cause?: { message?: string } }
  const text = `${message} ${cause?.message}`
  if (/minutes used up/.test(text))
    return "This month's cloud workspace minutes are used up."
  if (/all busy/.test(text))
    return "Cloud workspaces are busy right now; try again in a few minutes."
  if (/workspace_sessions_one_open/.test(text)) {
    return "This workspace is in use by another task; try again when it finishes."
  }
  return "The workspace couldn't be started for this task."
}

// health takes no token, so a sandbox started before a KRIYA_WORKSPACE_SECRET
// rotation answers it and then refuses everything else: such a sandbox is
// gone for good. Only a 401 says so; any other failure is not a verdict
export async function tokenAccepted(client: RunnerClient) {
  try {
    await client.list({ depth: 1 })
    return true
  } catch (error) {
    return !(error instanceof RunnerRequestError && error.status === 401)
  }
}

export async function healthy(client: RunnerClient, generation: number, ms: number) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const health = await client.health(Math.min(2000, ms))
      if (health.ok && health.generation === generation) return
    } catch {}
    if (Date.now() >= deadline) throw new Error("the workspace runner didn't answer")
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// What the provider is asked for: the row's image, size and network, the
// runner's limits from the settings
export function workspaceSpec(
  row: Row,
  generation: number,
  settings: CloudSettings
): WorkspaceSpec {
  return {
    workspaceId: row.id,
    userId: row.userId,
    generation,
    image: row.image,
    size: row.size,
    network: row.network,
    runnerToken: runnerToken(row.id, generation),
    limits: {
      commandTimeoutSeconds: settings.commandTimeoutSeconds,
      importBytes: settings.maxImportMb * MB,
      checkpointBytes: settings.maxCheckpointMb * MB,
      // The runner's own egress policy follows the row (CD-12)
      network: row.network,
    },
    timeoutSeconds: SANDBOX_SECONDS,
  }
}

// A session's own seconds (closed_at - opened_at, or to its last heartbeat
// for an orphan) in workspace_seconds, priced only from the owner's rate
// (invariant 6). Only an open session closes, so nothing is metered twice
export async function closeWorkspaceSession(
  session: { id: string; userId: string; taskId: string | null },
  status: "closed" | "failed",
  reason: CloseReason,
  rate: number | null,
  until: "now" | "heartbeat" = "now"
) {
  const end = until === "now" ? sql`now()` : sql`${workspaceSessions.heartbeatAt}`
  const [closed] = await privileged
    .update(workspaceSessions)
    .set({
      status,
      closedAt: sql`now()`,
      seconds: sql`greatest(0, round(extract(epoch from ${end} - ${workspaceSessions.openedAt})))::int`,
      closeReason: reason,
    })
    .where(
      and(
        eq(workspaceSessions.id, session.id),
        eq(workspaceSessions.userId, session.userId),
        eq(workspaceSessions.status, "open")
      )
    )
    .returning({ seconds: workspaceSessions.seconds })
  if (!closed) return
  const seconds = closed.seconds ?? 0
  await privileged
    .insert(resourceUsage)
    .values({
      requestKey: `workspace:${session.id}`,
      userId: session.userId,
      taskId: session.taskId,
      kind: "workspace_seconds",
      quantity: seconds,
      // Integers only, rounded half up
      costMicroUsd: rate
        ? Number((BigInt(seconds) * BigInt(rate) + 1800n) / 3600n)
        : null,
    })
    .onConflictDoNothing()
}

type Active = {
  sessionId: string
  workspaceId: string
  ref: string
  generation: number
  client: RunnerClient
  checkpointSha256: string | null
  checkpointSeq: number
}

export class TaskWorkspace {
  private active: Active | null = null
  private starting: Promise<RunnerClient> | null = null
  private restored = false
  private readonly store: FileStore | null
  private readonly source: RepoSource
  private readonly healthMs: number

  constructor(
    private readonly provider: WorkspaceProvider,
    private readonly task: Pick<Task, "id" | "userId" | "threadId" | "agentId">,
    private readonly settings: CloudSettings,
    // GitHub through the person's connection unless a test passes fixtures
    deps: { source?: RepoSource; store?: FileStore | null; healthMs?: number } = {}
  ) {
    this.source = deps.source ?? { tarball: githubTarball }
    this.store = deps.store === undefined ? fileStore() : deps.store
    this.healthMs = deps.healthMs ?? 10_000
  }

  // This thread's latest workspace that isn't closed; only the task's own
  // person and thread
  private async current() {
    const [row] = await privileged
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.userId, this.task.userId),
          eq(workspaces.threadId, this.task.threadId),
          ne(workspaces.status, "closed")
        )
      )
      .orderBy(desc(workspaces.createdAt))
      .limit(1)
    return row ?? null
  }

  // A guarded status change; the transition trigger rejects any other
  private async move(id: string, from: Status, to: Status, extra: Partial<Row> = {}) {
    const moved = await privileged
      .update(workspaces)
      .set({ ...extra, status: to })
      .where(
        and(
          eq(workspaces.id, id),
          eq(workspaces.userId, this.task.userId),
          eq(workspaces.status, from)
        )
      )
      .returning({ id: workspaces.id })
    if (!moved.length) throw new Error(`the workspace wasn't ${from}`)
  }

  // For the prompt: the database row only, no provider call
  async describe(): Promise<WorkspaceLine | null> {
    const row = await this.current()
    return (
      row && {
        repo: row.repo,
        baseRef: row.baseRef,
        baseSha: row.baseSha,
        status: row.status,
        changes: row.changes,
        lastActiveAt: row.lastActiveAt,
        restored: this.restored,
      }
    )
  }

  // workspace_open: this thread's workspace, created on first use
  async open(input: { repo?: string; ref?: string }): Promise<OpenResult> {
    let row: Row | undefined = (await this.current()) ?? undefined
    if (row && !resumable(row)) row = undefined
    if (row && input.repo && row.repo !== input.repo) {
      throw new Error(
        `This thread's workspace is for ${row.repo ?? "a blank project"}; close it first to open ${input.repo}.`
      )
    }
    if (!row) {
      ;[row] = await privileged
        .insert(workspaces)
        .values({
          userId: this.task.userId,
          threadId: this.task.threadId,
          agentId: this.task.agentId,
          repo: input.repo ?? null,
          baseRef: input.ref ?? null,
          provider: this.provider.name,
          image: this.settings.image,
          size: this.settings.size,
          network: this.settings.network,
        })
        .returning()
    }
    await this.client()
    const [fresh] = await privileged
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, row.id), eq(workspaces.userId, this.task.userId)))
    return {
      repo: fresh.repo,
      ref: fresh.baseRef,
      baseSha: fresh.baseSha,
      status: fresh.status,
      restored: this.restored,
    }
  }

  // The runner, running: reused, resumed, or rebuilt from Git and the
  // latest checkpoint
  async client() {
    if (this.active) return this.active.client
    this.starting ??= this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private spec(row: Row, generation: number) {
    return workspaceSpec(row, generation, this.settings)
  }

  // A resumed sandbox that takes this generation's token
  private async accepts(opened: Opened, workspaceId: string, generation: number) {
    const client = new RunnerClient(
      opened.runnerUrl,
      runnerToken(workspaceId, generation),
      undefined,
      opened.headers
    )
    await healthy(client, generation, this.healthMs)
    return tokenAccepted(client)
  }

  private async start() {
    const row = await this.current()
    if (!row)
      throw new Error(
        "This thread has no cloud workspace yet; open one with workspace_open."
      )
    if (!resumable(row)) {
      throw new Error(
        "This workspace failed and has nothing to restore; open a new one with workspace_open."
      )
    }
    const sessionId = randomUUID()
    try {
      await privileged.execute(
        sql`select kriya.open_workspace_session(${sessionId}::uuid, ${this.task.id}::uuid, ${row.id}::uuid, ${this.provider.name}, ${this.settings.maxRunning}::int)`
      )
    } catch (error) {
      throw new Error(refusal(error))
    }
    // A crashed worker can leave it running without a session
    let from = row.status
    if (from === "running") {
      await this.move(row.id, "running", "paused")
      from = "paused"
    }
    await this.move(row.id, from, "starting")

    let generation = row.generation
    let ref = row.providerRef
    let created = false
    try {
      let opened: Opened | null = ref
        ? await this.provider.resume(ref, this.spec(row, generation))
        : null
      if (opened && !(await this.accepts(opened, row.id, generation))) {
        // Started under an earlier secret: rebuilt from the checkpoint; the
        // old sandbox is left to the janitor's reconcile
        log.warn("workspace token refused; rebuilding", { taskId: this.task.id })
        opened = null
      }
      if (!opened) {
        generation += 1
        opened = await this.provider.create(this.spec(row, generation))
        created = true
        ref = opened.ref
        await privileged
          .update(workspaces)
          .set({ generation, providerRef: ref })
          .where(and(eq(workspaces.id, row.id), eq(workspaces.userId, this.task.userId)))
        await privileged
          .update(workspaceSessions)
          .set({ generation })
          .where(
            and(
              eq(workspaceSessions.id, sessionId),
              eq(workspaceSessions.userId, this.task.userId)
            )
          )
      }
      const client = new RunnerClient(
        opened.runnerUrl,
        runnerToken(row.id, generation),
        undefined,
        opened.headers
      )
      await healthy(client, generation, this.healthMs)
      const base = created
        ? await this.rebuild(row, client)
        : { baseSha: row.baseSha, baseRef: row.baseRef }
      await this.move(row.id, "starting", "running", {
        ...base,
        lastActiveAt: new Date(),
        error: null,
      })
      this.restored = created && row.generation > 0
      this.active = {
        sessionId,
        workspaceId: row.id,
        ref: opened.ref,
        generation,
        client,
        checkpointSha256: row.checkpointSha256,
        checkpointSeq: row.checkpointSeq,
      }
      return client
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn("workspace start failed", { taskId: this.task.id, error: message })
      if (created && ref) {
        await this.provider.destroy(ref).catch(() => {})
        await privileged
          .update(workspaces)
          .set({ providerRef: null })
          .where(and(eq(workspaces.id, row.id), eq(workspaces.userId, this.task.userId)))
      }
      await this.closeSession(sessionId, "failed", "error")
      // A failed resume leaves the earlier sandbox as it was
      const earlier = Boolean(row.providerRef) && !created
      await this.move(row.id, "starting", earlier ? "paused" : "failed", {
        error: message.slice(0, 500),
      })
      throw new Error("The workspace couldn't be started for this task.")
    }
  }

  // A fresh sandbox: the repository at its base commit, then the latest
  // checkpoint on top. Returns the base commit and branch
  private async rebuild(row: Row, client: RunnerClient) {
    let baseSha = row.baseSha
    // The branch a pull request goes into: the default one, unless named
    let baseRef = row.baseRef
    if (row.repo) {
      const archive = await this.source.tarball(
        this.task.userId,
        row.repo,
        row.baseSha ?? row.baseRef
      )
      if (archive.bytes !== null && archive.bytes > this.settings.maxImportMb * MB) {
        throw new Error("the repository is larger than this workspace allows")
      }
      await client.import(archive.body, { base: archive.sha, strip: true })
      baseSha = archive.sha
      baseRef ??= archive.ref ?? null
    }
    if (row.checkpointPath) {
      const patch = await this.store?.read(row.checkpointPath)
      const digest = patch && createHash("sha256").update(patch).digest("hex")
      if (!patch || digest !== row.checkpointSha256) {
        throw new Error("the workspace's checkpoint couldn't be read")
      }
      await client.restore(patch)
    }
    return { baseSha, baseRef }
  }

  get userId() {
    return this.task.userId
  }

  // Where a publish may go: the open workspace's repository and base
  async target() {
    const row = await this.current()
    return row && { repo: row.repo, baseRef: row.baseRef, baseSha: row.baseSha }
  }

  // Bounded again by the runner's own limit
  get commandTimeoutSeconds() {
    return this.settings.commandTimeoutSeconds
  }

  // The strip's counts, after workspace_changes
  async noteChanges(changes: WorkspaceChanges) {
    const active = this.active
    if (!active) return
    await privileged
      .update(workspaces)
      .set({ changes, lastActiveAt: new Date() })
      .where(
        and(
          eq(workspaces.id, active.workspaceId),
          eq(workspaces.userId, this.task.userId)
        )
      )
  }

  async heartbeat() {
    const active = this.active
    if (!active) return
    await this.provider.extend(active.ref, SANDBOX_SECONDS).catch((error) =>
      log.warn("workspace extend failed", {
        taskId: this.task.id,
        error: String(error),
      })
    )
    await privileged
      .update(workspaceSessions)
      .set({ heartbeatAt: new Date() })
      .where(
        and(
          eq(workspaceSessions.id, active.sessionId),
          eq(workspaceSessions.userId, this.task.userId)
        )
      )
    await privileged
      .update(workspaces)
      .set({ lastActiveAt: new Date() })
      .where(
        and(
          eq(workspaces.id, active.workspaceId),
          eq(workspaces.userId, this.task.userId)
        )
      )
  }

  private closeSession(id: string, status: "closed" | "failed", reason: CloseReason) {
    return closeWorkspaceSession(
      { id, userId: this.task.userId, taskId: this.task.id },
      status,
      reason,
      this.settings.costMicroUsdPerHour
    )
  }

  // A new checkpoint when the tree differs from the last one (CD-13)
  private async checkpoint(active: Active): Promise<Partial<Row>> {
    const saved = await saveCheckpoint(this.store, active.client, {
      userId: this.task.userId,
      workspaceId: active.workspaceId,
      generation: active.generation,
      seq: active.checkpointSeq,
      sha256: active.checkpointSha256,
      taskId: this.task.id,
    })
    if (saved.checkpointSeq) {
      active.checkpointSeq = saved.checkpointSeq
      active.checkpointSha256 = saved.checkpointSha256 ?? null
    }
    return saved
  }

  // Right before a publish: what goes to GitHub is also in storage. False
  // when the checkpoint failed (the workspace is marked, its sandbox kept);
  // the publish then stops (owner decision, C9)
  async checkpointNow() {
    const active = this.active
    if (!active) return true
    const saved = await this.checkpoint(active)
    await privileged
      .update(workspaces)
      .set(saved)
      .where(
        and(
          eq(workspaces.id, active.workspaceId),
          eq(workspaces.userId, this.task.userId)
        )
      )
    return !saved.checkpointFailedAt
  }

  // At the task's end. Shutdown and a lost lease pause without a checkpoint
  // (fast; the next attempt resumes the same sandbox)
  async close(reason: StopReason | null) {
    const active = this.active
    if (!active) return
    this.active = null
    const quick = reason === "shutdown" || reason === "lease_lost"
    const saved = quick ? {} : await this.checkpoint(active)
    await this.provider
      .pause(active.ref)
      .catch((error) =>
        log.warn("workspace pause failed", { taskId: this.task.id, error: String(error) })
      )
    await this.move(active.workspaceId, "running", "paused", saved)
    await this.closeSession(active.sessionId, "closed", reason ?? "end")
  }
}
