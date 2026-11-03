import { randomUUID } from "node:crypto"

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { workspaces, workspaceSessions } from "@/db/schema"
import {
  deleteCheckpoints,
  saveCheckpoint,
  type CheckpointAt,
} from "@/lib/cloud/checkpoint"
import { RunnerClient } from "@/lib/cloud/client"
import { fabricSettings, fabricSweep } from "@/lib/cloud/fabric"
import type { WorkspaceProvider } from "@/lib/cloud/provider"
import { SelfHostedWorkspaceProvider } from "@/lib/cloud/providers/selfhosted"
import {
  cloudSettings,
  closeWorkspaceSession,
  healthy,
  tokenAccepted,
  workspaceProvider,
  workspaceSpec,
  type CloudSettings,
} from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"
import { getSetting } from "@/lib/config"
import { BUCKET, fileStore, type FileStore } from "@/lib/files"
import { log } from "@/lib/log"

// The workspace janitor (TOOLS_AND_CONTRACTS §6, CD-04, CD-16), one step of
// the worker's scheduler loop: sessions whose worker died, workspaces the
// person closed or left unused, paused sandboxes kept too long, failed
// checkpoint uploads, sandboxes the provider runs without a row, and the
// storage of deleted accounts. Each step in its own try, in small batches.
// Writes are bookkeeping on rows it read, scoped by their user id.
//
// While it works on a workspace it holds the workspace's one open session
// (a row with no task), so a task can't start on it meanwhile, and that
// session's seconds are metered like any other. A sandbox is destroyed
// only after a checkpoint of its current tree (CS-14).

export type JanitorSettings = {
  enabled: boolean
  orphanSeconds: number
  pausedHours: number
  retentionDays: number
  cloud: CloudSettings
}

export async function janitorSettings(): Promise<JanitorSettings> {
  const int = async (key: Parameters<typeof getSetting>[0], fallback: number) =>
    Number.parseInt((await getSetting(key)) ?? "", 10) || fallback
  return {
    enabled: (await getSetting("cloud.workspaces")) === "on",
    orphanSeconds: await int("cloud.orphanSeconds", 120),
    pausedHours: await int("cloud.pausedHours", 24),
    retentionDays: await int("cloud.retentionDays", 14),
    cloud: await cloudSettings(),
  }
}

type Row = typeof workspaces.$inferSelect

const BATCH = 20
// A failed checkpoint upload is tried again after this
const RETRY_SECONDS = 600
const RECONCILE_MS = 10 * 60_000
let lastReconcile = 0

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OBJECT = /^workspaces\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//

const ago = (seconds: number) => sql`now() - make_interval(secs => ${seconds})`

const at = (row: Row, taskId: string | null = null): CheckpointAt => ({
  userId: row.userId,
  workspaceId: row.id,
  generation: row.generation,
  seq: row.checkpointSeq,
  sha256: row.checkpointSha256,
  taskId,
})

// A guarded write on one row; false when the row moved on meanwhile
async function update(row: Row, set: Partial<Row>, from: Row["status"]) {
  const moved = await privileged
    .update(workspaces)
    .set(set)
    .where(
      and(
        eq(workspaces.id, row.id),
        eq(workspaces.userId, row.userId),
        eq(workspaces.status, from)
      )
    )
    .returning({ id: workspaces.id })
  return moved.length > 0
}

// The workspace's one open session, or null while a task holds it
async function lock(row: Row) {
  const id = randomUUID()
  try {
    await privileged.insert(workspaceSessions).values({
      id,
      workspaceId: row.id,
      userId: row.userId,
      provider: row.provider,
      generation: row.generation,
    })
    return id
  } catch {
    return null
  }
}

export async function workspaceJanitor(
  deps: {
    provider?: WorkspaceProvider | null
    store?: FileStore | null
    settings?: JanitorSettings
    // Tests decide; otherwise every RECONCILE_MS
    reconcile?: boolean
    healthMs?: number
    // Self-hosted nodes being drained (selfhosted.drain); read when omitted
    drain?: string[]
  } = {}
) {
  const settings = deps.settings ?? (await janitorSettings())
  // Switched off, it still runs while anything is open, so compute stops
  if (!settings.enabled) {
    const [open] = await privileged
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(notInArray(workspaces.status, ["closed", "new"]))
      .limit(1)
    if (!open) return null
  }
  const provider =
    deps.provider === undefined
      ? await workspaceProvider({ maxWaitSeconds: 5 })
      : deps.provider
  const store = deps.store === undefined ? fileStore() : deps.store
  const healthMs = deps.healthMs ?? 10_000
  const rate = settings.cloud.costMicroUsdPerHour
  const result = {
    orphans: 0,
    closed: 0,
    destroyed: 0,
    retried: 0,
    reconciled: 0,
    swept: 0,
    leasesReleased: 0,
    nodesUnhealthy: 0,
  }

  // (0) Self-hosted fabric (CD-29, CD-35): node measurements and lease
  // reconcile before anything here asks a node for work
  const selfhosted = provider instanceof SelfHostedWorkspaceProvider ? provider : null
  const drain = selfhosted ? (deps.drain ?? (await fabricSettings()).drain) : []
  // A paused sandbox on a draining node is checkpointed and destroyed now,
  // not after pausedHours (runbook §5); its next use restores elsewhere
  const draining = (ref: string | null) =>
    !!ref && drain.some((id) => ref.startsWith(`sh-${id}-`))
  if (selfhosted) {
    try {
      const swept = await fabricSweep(selfhosted, drain)
      result.leasesReleased = swept.released
      result.nodesUnhealthy = swept.unhealthy
    } catch (error) {
      log.error("workspace fabric sweep failed", { error })
    }
  }

  const release = (id: string, userId: string) =>
    closeWorkspaceSession({ id, userId, taskId: null }, "closed", "end", rate)

  // The paused or orphaned sandbox's runner at its generation; null when
  // the provider no longer has it
  async function reach(row: Row) {
    const opened = await provider!.resume(
      row.providerRef!,
      workspaceSpec(row, row.generation, settings.cloud)
    )
    if (!opened) return null
    const client = new RunnerClient(
      opened.runnerUrl,
      runnerToken(row.id, row.generation),
      undefined,
      opened.headers
    )
    await healthy(client, row.generation, healthMs)
    // Started under an earlier KRIYA_WORKSPACE_SECRET: unreachable for good,
    // so treated as gone (never retried as a failed checkpoint)
    return (await tokenAccepted(client)) ? client : null
  }

  const pause = (row: Row) =>
    provider!
      .pause(row.providerRef!)
      .catch((error) =>
        log.warn("workspace pause failed", { workspaceId: row.id, error: String(error) })
      )

  // (1) A session without a heartbeat: its worker died. Checkpoint if the
  // runner answers, pause, meter to the last heartbeat
  try {
    const stale = await privileged
      .select({ session: workspaceSessions, row: workspaces })
      .from(workspaceSessions)
      .innerJoin(workspaces, eq(workspaces.id, workspaceSessions.workspaceId))
      .where(
        and(
          eq(workspaceSessions.status, "open"),
          lt(workspaceSessions.heartbeatAt, ago(settings.orphanSeconds))
        )
      )
      .limit(BATCH)
    for (const { session, row } of stale) {
      try {
        if (row.status === "running") {
          let saved: Partial<Row> = {}
          if (row.providerRef && provider) {
            const client = await reach(row).catch(() => null)
            if (client)
              saved = await saveCheckpoint(store, client, at(row, session.taskId))
            await pause(row)
          }
          await update(row, { ...saved, status: "paused" }, "running")
        } else if (row.status === "starting") {
          // Never destroyed here: an earlier sandbox may hold unsaved work
          await update(
            row,
            {
              status: row.providerRef ? "paused" : "failed",
              error: "The worker stopped while the workspace was starting.",
            },
            "starting"
          )
        }
        await closeWorkspaceSession(
          { id: session.id, userId: session.userId, taskId: session.taskId },
          "closed",
          "orphan",
          rate,
          "heartbeat"
        )
        result.orphans++
      } catch (error) {
        log.error("workspace orphan step failed", { workspaceId: row.id, error })
      }
    }
  } catch (error) {
    log.error("workspace orphan sweep failed", { error })
  }

  // (2) Asked to close, or unused past retentionDays: sandbox destroyed,
  // checkpoints deleted, closed. A step that failed earlier resumes here
  try {
    const closing = await privileged
      .select()
      .from(workspaces)
      .where(
        or(
          eq(workspaces.status, "closing"),
          and(
            inArray(workspaces.status, ["running", "paused", "failed"]),
            isNotNull(workspaces.closeRequestedAt)
          ),
          and(
            inArray(workspaces.status, ["paused", "failed"]),
            lt(workspaces.lastActiveAt, ago(settings.retentionDays * 86_400))
          )
        )
      )
      .limit(BATCH)
    for (const row of closing) {
      if (row.providerRef && !provider) continue
      const held = await lock(row)
      if (!held) continue
      try {
        if (
          row.status !== "closing" &&
          !(await update(row, { status: "closing" }, row.status))
        )
          continue
        if (row.providerRef) await provider!.destroy(row.providerRef)
        await deleteCheckpoints(store, at(row))
        await update(
          row,
          {
            status: "closed",
            closedAt: new Date(),
            providerRef: null,
            checkpointPath: null,
            checkpointSha256: null,
            checkpointBytes: null,
          },
          "closing"
        )
        result.closed++
      } catch (error) {
        log.error("workspace close failed", { workspaceId: row.id, error })
      } finally {
        await release(held, row.userId)
      }
    }
  } catch (error) {
    log.error("workspace close sweep failed", { error })
  }

  // (3) Paused past pausedHours: checkpointed, then destroyed (restored from
  // Git and the checkpoint on next use). A failed upload is retried; while
  // it keeps failing the sandbox stays
  if (provider) {
    try {
      const idle = await privileged
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.status, "paused"),
            isNotNull(workspaces.providerRef),
            isNull(workspaces.closeRequestedAt),
            or(
              lt(workspaces.lastActiveAt, ago(settings.pausedHours * 3600)),
              lt(workspaces.checkpointFailedAt, ago(RETRY_SECONDS)),
              ...drain.map((id) => like(workspaces.providerRef, `sh-${id}-%`))
            )
          )
        )
        .limit(BATCH)
      for (const row of idle) {
        const held = await lock(row)
        if (!held) continue
        try {
          const old =
            row.lastActiveAt.getTime() < Date.now() - settings.pausedHours * 3_600_000 ||
            draining(row.providerRef)
          const client = await reach(row)
          if (!client) {
            // The provider already let it go
            await update(row, { providerRef: null }, "paused")
            continue
          }
          const saved = await saveCheckpoint(store, client, at(row))
          if (saved.checkpointFailedAt || !old) {
            await pause(row)
            await update(row, saved, "paused")
            if (!saved.checkpointFailedAt) result.retried++
            continue
          }
          await provider.destroy(row.providerRef!)
          await update(row, { ...saved, providerRef: null }, "paused")
          result.destroyed++
        } catch (error) {
          log.error("workspace idle step failed", { workspaceId: row.id, error })
          await pause(row)
        } finally {
          await release(held, row.userId)
        }
      }
    } catch (error) {
      log.error("workspace idle sweep failed", { error })
    }
  }

  if (!(deps.reconcile ?? Date.now() - lastReconcile >= RECONCILE_MS)) return result
  lastReconcile = Date.now()

  // (4) Sandboxes the provider runs for no open workspace (rows deleted
  // with an account, older generations, lost bookkeeping). A workspace that
  // is starting may not have written its new ref yet
  if (provider) {
    try {
      const sandboxes = await provider.list()
      const ids = [
        ...new Set(
          sandboxes.map((s) => s.workspaceId).filter((id) => id && UUID.test(id))
        ),
      ] as string[]
      const owners = ids.length
        ? await privileged
            .select({
              id: workspaces.id,
              providerRef: workspaces.providerRef,
              status: workspaces.status,
            })
            .from(workspaces)
            .where(and(inArray(workspaces.id, ids), ne(workspaces.status, "closed")))
        : []
      for (const sandbox of sandboxes) {
        const owned = owners.some(
          (o) =>
            o.id === sandbox.workspaceId &&
            (o.providerRef === sandbox.ref || o.status === "starting")
        )
        if (owned) continue
        await provider
          .destroy(sandbox.ref)
          .then(() => result.reconciled++)
          .catch((error) => log.error("workspace reconcile destroy failed", { error }))
      }
    } catch (error) {
      log.error("workspace reconcile failed", { error })
    }
  }

  // (5) Checkpoints with no open workspace (account deleted, a delete that
  // failed). Names come from Supabase's storage.objects; deletes go
  // through the storage API
  if (store) {
    try {
      const names = rowsOf<{ name: string }>(
        await privileged.execute(
          sql`select name from storage.objects where bucket_id = ${BUCKET} and name like 'workspaces/%' limit 1000`
        )
      ).map((r) => r.name)
      const parsed = names
        .map((name) => ({ name, match: OBJECT.exec(name) }))
        .filter((p) => p.match && UUID.test(p.match[1]) && UUID.test(p.match[2]))
      const ids = [...new Set(parsed.map((p) => p.match![2]))]
      const live = ids.length
        ? await privileged
            .select({ id: workspaces.id, userId: workspaces.userId })
            .from(workspaces)
            .where(and(inArray(workspaces.id, ids), ne(workspaces.status, "closed")))
        : []
      const unowned = parsed
        .filter(
          (p) => !live.some((w) => w.id === p.match![2] && w.userId === p.match![1])
        )
        .map((p) => p.name)
      if (unowned.length) {
        await store.remove(unowned)
        result.swept += unowned.length
      }
    } catch (error) {
      log.warn("workspace storage sweep skipped", { error: String(error) })
    }
  }

  return result
}
