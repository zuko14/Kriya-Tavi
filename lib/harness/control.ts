import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import type { z } from "zod"

import { privileged, rowsOf, withUser } from "@/db"
import {
  harnessDevices,
  harnessDeviceState as state,
  harnessDispatches as dispatches,
  harnessRuns as runs,
} from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import {
  type DaemonHelloRequest,
  DaemonProject,
  DispatchPayloads,
  type DispatchReportRequest,
  type RunReportRequest,
} from "@/lib/harness/contract"

// The Control Center (CONTROL_CENTER.md). The person queues typed actions
// for one of their own computers (actions/harness-control.ts, withUser);
// the computer's daemon claims and runs them. Device writes are privileged
// after authenticateDevice and always scoped by the device's person and the
// device itself, as lib/harness/approvals.ts. Nothing here runs anything:
// the computer does, and only what its own daemon allows.

export type DispatchKind = keyof typeof DispatchPayloads
export const ONLINE_MS = 60_000
// A running process beats every minute (kriya-harness broadcastRun); silent this long, it's lost
export const RUN_LOST_MS = 3 * 60_000
const POLL_MS = 1_000
const WAIT_MAX_S = 25
// The most actions one person may queue in ten minutes (all computers)
export const QUEUE_LIMIT = 30

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/* ───────────────────────────── device side ───────────────────────────── */

export async function hello(
  device: DeviceUser,
  body: z.infer<typeof DaemonHelloRequest>
) {
  const values = {
    daemonVersion: body.daemonVersion,
    capabilities: body.capabilities,
    projects: body.projects,
    rules: body.rules,
    polledAt: new Date(),
    updatedAt: new Date(),
  }
  await privileged
    .insert(state)
    .values({ deviceId: device.deviceId, userId: device.id, ...values })
    .onConflictDoUpdate({
      target: state.deviceId,
      set: values,
      // A device row is its person's alone; never move it to another
      setWhere: eq(state.userId, device.id),
    })
  return { pollSeconds: WAIT_MAX_S }
}

const ours = (device: DeviceUser) =>
  and(eq(dispatches.userId, device.id), eq(dispatches.deviceId, device.deviceId))

/** Claims the oldest queued, unexpired action for this computer, if any */
async function claim(device: DeviceUser) {
  await privileged
    .update(dispatches)
    .set({ status: "expired", finishedAt: new Date() })
    .where(
      and(
        ours(device),
        eq(dispatches.status, "queued"),
        lt(dispatches.expiresAt, new Date())
      )
    )
  const claimed = await privileged.execute(sql`
    update kriya.harness_dispatches set status = 'claimed', claimed_at = now()
    where id = (
      select id from kriya.harness_dispatches
      where user_id = ${device.id} and device_id = ${device.deviceId}
        and status = 'queued' and expires_at > now()
      order by created_at limit 1
      for update skip locked
    )
    returning id, kind, payload, created_at`)
  return rowsOf<{
    id: string
    kind: DispatchKind
    payload: Record<string, unknown>
    created_at: string | Date
  }>(claimed)[0]
}

/**
 * The daemon's long poll: marks the computer online, returns the next action
 * (claimed) and the running ones the person asked to stop. Waits up to
 * `waitSeconds` for one to arrive.
 */
export async function next(
  device: DeviceUser,
  waitSeconds: number,
  signal?: AbortSignal
) {
  const until = Date.now() + Math.min(Math.max(waitSeconds, 0), WAIT_MAX_S) * 1000
  for (;;) {
    await privileged
      .update(state)
      .set({ polledAt: new Date() })
      .where(and(eq(state.deviceId, device.deviceId), eq(state.userId, device.id)))
    const cancel = (
      await privileged
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(ours(device), eq(dispatches.status, "canceling")))
        .limit(50)
    ).map((r) => r.id)
    const row = await claim(device)
    if (row || cancel.length || Date.now() >= until || signal?.aborted)
      return {
        dispatch: row
          ? {
              id: row.id,
              kind: row.kind,
              payload: row.payload,
              createdAt: new Date(row.created_at).toISOString(),
            }
          : null,
        cancel,
      }
    await new Promise((done) => setTimeout(done, POLL_MS))
  }
}

const NEXT: Record<string, string[]> = {
  claimed: ["running", "done", "failed"],
  running: ["done", "failed"],
  canceling: ["canceled", "done", "failed"],
}

/** The daemon says how an action went; false when it isn't this computer's or is finished */
export async function report(
  device: DeviceUser,
  id: string,
  body: z.infer<typeof DispatchReportRequest>
) {
  const [row] = await privileged
    .select({ status: dispatches.status })
    .from(dispatches)
    .where(and(ours(device), eq(dispatches.id, id)))
  if (!row) return false
  // A run the person is stopping stays "canceling" until it ends
  if (row.status === "canceling" && body.status === "running") return true
  // A flow's progress while it runs (track S, SD-14): the status stays as it is
  if (row.status === "running" && body.status === "running") {
    if (body.result)
      await privileged
        .update(dispatches)
        .set({ result: body.result })
        .where(and(ours(device), eq(dispatches.id, id), eq(dispatches.status, "running")))
    return true
  }
  if (!NEXT[row.status]?.includes(body.status)) return false
  const done = body.status !== "running"
  await privileged
    .update(dispatches)
    .set({
      status: body.status,
      ...(body.result && { result: body.result }),
      ...(done && { finishedAt: new Date() }),
    })
    .where(and(ours(device), eq(dispatches.id, id), eq(dispatches.status, row.status)))
  return true
}

/** One kriya process's state, from the terminal or a dispatch */
export async function recordRun(
  device: DeviceUser,
  body: z.infer<typeof RunReportRequest>
) {
  const ended = body.status !== "running"
  const values = {
    source: body.source,
    kind: body.kind,
    mode: body.mode ?? null,
    switches: body.switches ?? {},
    project: body.project ?? null,
    status: body.status,
    exitCode: body.exitCode ?? null,
    updatedAt: new Date(),
    endedAt: ended ? new Date() : null,
  }
  // A dispatch id is kept only when it's this computer's own action
  let dispatchId: string | null = null
  if (body.dispatchId) {
    const [own] = await privileged
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(ours(device), eq(dispatches.id, body.dispatchId)))
    dispatchId = own?.id ?? null
  }
  await privileged
    .insert(runs)
    .values({
      userId: device.id,
      deviceId: device.deviceId,
      localId: body.localId,
      dispatchId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [runs.deviceId, runs.localId],
      set: { ...values, ...(dispatchId && { dispatchId }) },
      setWhere: eq(runs.userId, device.id),
    })
}

/* ───────────────────────────── person side ───────────────────────────── */

type Capabilities = { fullAccess?: boolean; serve?: boolean; handoff?: boolean }

/**
 * Queues one action for the person's own computer, after every check: the
 * computer is theirs, signed in and online; the payload is the kind's; the
 * project is one the computer itself offered; Full access and serve only
 * where the computer allows them; a rule only one it listed; and at most
 * QUEUE_LIMIT actions in ten minutes. RLS checks ownership again.
 */
export async function queue(
  userId: string,
  deviceId: string,
  kind: DispatchKind,
  raw: unknown
) {
  const parsed = DispatchPayloads[kind].safeParse(raw)
  if (!parsed.success)
    throw new ControlError("bad_request", "That action isn't complete.")
  const payload = parsed.data as Record<string, unknown>
  return withUser(userId, async (tx) => {
    const [device] = await tx
      .select({ id: harnessDevices.id, revokedAt: harnessDevices.revokedAt })
      .from(harnessDevices)
      .where(and(eq(harnessDevices.id, deviceId), isNull(harnessDevices.revokedAt)))
    if (!device) throw new ControlError("no_device", "That computer isn't signed in.")
    const [info] = await tx.select().from(state).where(eq(state.deviceId, deviceId))
    if (!info?.polledAt || Date.now() - info.polledAt.getTime() > ONLINE_MS)
      throw new ControlError(
        "offline",
        "That computer isn't listening. Start kriya daemon on it."
      )
    const caps = (info.capabilities ?? {}) as Capabilities
    const projects = (info.projects ?? []).flatMap((p) => {
      const ok = DaemonProject.safeParse(p)
      return ok.success ? [ok.data] : []
    })
    if ("project" in payload && !projects.some((p) => p.id === payload.project))
      throw new ControlError("no_project", "That folder isn't one this computer offers.")
    if (kind === "run" && payload.mode === "full" && !caps.fullAccess)
      throw new ControlError(
        "not_allowed",
        "Full access from Kriya is off on that computer (kriya daemon --allow-full-access)."
      )
    if (kind === "serve_start" && !caps.serve)
      throw new ControlError(
        "not_allowed",
        "Serving from Kriya is off on that computer (kriya daemon --allow-serve)."
      )
    if ((kind === "handoff" || kind === "pull") && !caps.handoff)
      throw new ControlError(
        "not_allowed",
        "That computer can't hand off or pull right now."
      )
    if (kind === "handoff" || kind === "pull") {
      const project = projects.find((p) => p.id === payload.project)
      if (!project?.git)
        throw new ControlError("no_git", "Handoff and pull need a git repository.")
    }
    if (kind === "rule_confirm" || kind === "rule_dismiss") {
      const listed = (info.rules ?? []).some(
        (r) =>
          (r as { project?: string; n?: number; status?: string }).project ===
            payload.project &&
          (r as { n?: number }).n === payload.n &&
          (kind === "rule_dismiss" || (r as { status?: string }).status === "proposed")
      )
      if (!listed)
        throw new ControlError(
          "no_rule",
          "That rule isn't listed on the computer any more."
        )
    }
    const [{ recent }] = await tx
      .select({ recent: sql<number>`count(*)::int` })
      .from(dispatches)
      .where(sql`${dispatches.createdAt} > now() - interval '10 minutes'`)
    if (recent >= QUEUE_LIMIT)
      throw new ControlError("rate_limited", "Too many actions; wait a few minutes.")
    // Exactly the four columns the person may set (the column grant): never a
    // status, result, expiry or time of their own
    const inserted = await tx.execute(sql`
      insert into kriya.harness_dispatches (user_id, device_id, kind, payload)
      values (${userId}, ${deviceId}, ${kind}, ${JSON.stringify(payload)}::jsonb)
      returning id`)
    return rowsOf<{ id: string }>(inserted)[0].id
  })
}

/** The person stops an action: a queued one at once, a running one through its computer */
export async function cancel(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .select({ status: dispatches.status })
      .from(dispatches)
      .where(eq(dispatches.id, id))
    if (!row) throw new ControlError("not_found", "That action isn't there.")
    if (row.status === "queued")
      await tx
        .update(dispatches)
        .set({ status: "canceled", finishedAt: new Date() })
        .where(and(eq(dispatches.id, id), eq(dispatches.status, "queued")))
    else if (row.status === "claimed" || row.status === "running")
      await tx
        .update(dispatches)
        .set({ status: "canceling" })
        .where(
          and(eq(dispatches.id, id), inArray(dispatches.status, ["claimed", "running"]))
        )
    else throw new ControlError("finished", "That action has already finished.")
  })
}

/** Everything the Control Center shows, as the person */
export async function controlCenter(userId: string) {
  return withUser(userId, async (tx) => {
    const devices = await tx
      .select({
        id: harnessDevices.id,
        name: harnessDevices.name,
        platform: harnessDevices.platform,
        clientVersion: harnessDevices.clientVersion,
        daemonVersion: state.daemonVersion,
        capabilities: state.capabilities,
        projects: state.projects,
        rules: state.rules,
        polledAt: state.polledAt,
      })
      .from(harnessDevices)
      .leftJoin(state, eq(state.deviceId, harnessDevices.id))
      .where(isNull(harnessDevices.revokedAt))
      .orderBy(desc(harnessDevices.lastUsedAt))
    const recent = await tx
      .select({
        id: dispatches.id,
        deviceId: dispatches.deviceId,
        kind: dispatches.kind,
        payload: dispatches.payload,
        status: dispatches.status,
        result: dispatches.result,
        createdAt: dispatches.createdAt,
        finishedAt: dispatches.finishedAt,
      })
      .from(dispatches)
      .orderBy(desc(dispatches.createdAt))
      .limit(20)
    const live = await tx
      .select({
        id: runs.id,
        deviceId: runs.deviceId,
        source: runs.source,
        kind: runs.kind,
        mode: runs.mode,
        switches: runs.switches,
        project: runs.project,
        status: runs.status,
        exitCode: runs.exitCode,
        startedAt: runs.startedAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .orderBy(desc(runs.updatedAt))
      .limit(20)
    const now = Date.now()
    return {
      devices: devices.map((d) => ({
        ...d,
        online: !!d.polledAt && now - d.polledAt.getTime() <= ONLINE_MS,
        projects: (d.projects ?? []).flatMap((p) => {
          const ok = DaemonProject.safeParse(p)
          return ok.success ? [ok.data] : []
        }),
      })),
      dispatches: recent,
      runs: live.map((r) => ({
        ...r,
        lost: r.status === "running" && now - r.updatedAt.getTime() > RUN_LOST_MS,
      })),
    }
  })
}
export type ControlCenterData = Awaited<ReturnType<typeof controlCenter>>
