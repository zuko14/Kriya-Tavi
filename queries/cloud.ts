import { and, count, desc, eq, inArray, isNull, ne, sql, sum } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { resourceUsage, workspaces, workspaceSessions } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"

// Reads for cloud workspaces (track C, UX_SPEC): the strip at the top of a
// thread and the /usage line through withUser (RLS), the owner's overview
// through privileged. Never code, outputs or checkpoints: counts, status
// and times only.

// The IST month the plan's minutes count in, as open_workspace_session
const MONTH = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`

// This month's metered seconds plus the open sessions so far, and the plan's
// minutes (0: the plan has none)
export async function getCloudMinutes(userId: string) {
  const usedSeconds = await withUser(userId, async (tx) => {
    const [metered] = await tx
      .select({ s: sum(resourceUsage.quantity).mapWith(Number) })
      .from(resourceUsage)
      .where(
        and(
          eq(resourceUsage.userId, userId),
          eq(resourceUsage.kind, "workspace_seconds"),
          sql`${resourceUsage.createdAt} >= ${MONTH}`
        )
      )
    const [open] = await tx
      .select({
        s: sql<number>`coalesce(sum(extract(epoch from now() - ${workspaceSessions.openedAt})), 0)::int`,
      })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.status, "open"))
    return (metered?.s ?? 0) + Number(open?.s ?? 0)
  })
  const plan = await getPlan(userId)
  return { usedSeconds, limitMinutes: plan.workspaceMinutes }
}

// The thread's workspace for the strip, or null (none, or closed)
export async function getThreadWorkspace(userId: string, threadId: string) {
  const row = await withUser(userId, async (tx) => {
    const [found] = await tx
      .select({
        id: workspaces.id,
        repo: workspaces.repo,
        baseRef: workspaces.baseRef,
        baseSha: workspaces.baseSha,
        status: workspaces.status,
        changes: workspaces.changes,
        error: workspaces.error,
        closeRequestedAt: workspaces.closeRequestedAt,
        checkpointAt: workspaces.checkpointAt,
      })
      .from(workspaces)
      .where(and(eq(workspaces.threadId, threadId), ne(workspaces.status, "closed")))
      .orderBy(desc(workspaces.createdAt))
      .limit(1)
    return found ?? null
  })
  if (!row) return null
  const minutes = await getCloudMinutes(userId)
  return {
    id: row.id,
    repo: row.repo,
    baseRef: row.baseRef,
    shortSha: row.baseSha?.slice(0, 7) ?? null,
    status: row.status,
    changes: row.changes,
    error: row.error,
    closing: row.closeRequestedAt !== null || row.status === "closing",
    saved: row.checkpointAt !== null,
    usedMinutes: Math.floor(minutes.usedSeconds / 60),
    limitMinutes: minutes.limitMinutes,
  }
}

export type ThreadWorkspace = NonNullable<Awaited<ReturnType<typeof getThreadWorkspace>>>

// The owner's page: what runs now, this month's compute and its cost (only
// what the owner's rate priced; unpriced sessions are counted, never ₹0),
// and the latest workspaces by person id
export async function getCloudOverview() {
  const [byStatus, [month], [stored], rows] = await Promise.all([
    privileged
      .select({ status: workspaces.status, n: count() })
      .from(workspaces)
      .where(inArray(workspaces.status, ["running", "paused"]))
      .groupBy(workspaces.status),
    privileged
      .select({
        seconds: sum(resourceUsage.quantity).mapWith(Number),
        costMicroUsd: sum(resourceUsage.costMicroUsd).mapWith(Number),
        unpricedSessions: count(
          sql`case when ${resourceUsage.costMicroUsd} is null then 1 end`
        ),
      })
      .from(resourceUsage)
      .where(
        and(
          eq(resourceUsage.kind, "workspace_seconds"),
          sql`${resourceUsage.createdAt} >= ${MONTH}`
        )
      ),
    privileged
      .select({ bytes: sum(workspaces.checkpointBytes).mapWith(Number) })
      .from(workspaces)
      .where(and(ne(workspaces.status, "closed"), isNull(workspaces.closedAt))),
    privileged
      .select({
        id: workspaces.id,
        userId: workspaces.userId,
        repo: workspaces.repo,
        status: workspaces.status,
        lastActiveAt: workspaces.lastActiveAt,
        checkpointBytes: workspaces.checkpointBytes,
        seconds: sql<number>`coalesce((select sum(s.seconds) from kriya.workspace_sessions s where s.workspace_id = "workspaces"."id"), 0)::int`,
      })
      .from(workspaces)
      .orderBy(desc(workspaces.lastActiveAt))
      .limit(50),
  ])
  const statusCount = (status: string) =>
    byStatus.find((r) => r.status === status)?.n ?? 0
  return {
    running: statusCount("running"),
    paused: statusCount("paused"),
    maxRunning: Number.parseInt((await getSetting("cloud.maxRunning")) ?? "", 10) || 3,
    rateSet: Boolean(await getSetting("cloud.costMicroUsdPerHour")),
    month: {
      seconds: month?.seconds ?? 0,
      costMicroUsd: month?.costMicroUsd ?? 0,
      unpricedSessions: month?.unpricedSessions ?? 0,
    },
    storedBytes: stored?.bytes ?? 0,
    rows: rows.map((r) => ({ ...r, checkpointBytes: Number(r.checkpointBytes ?? 0) })),
  }
}
