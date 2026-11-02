import { asc, desc, eq, gt, isNull, ne, sql, sum, and } from "drizzle-orm"

import { withUser } from "@/db"
import { getSetting } from "@/lib/config"
import {
  agents,
  harnessApprovalRequests,
  harnessDevices,
  harnessSessions,
  harnessUsage,
  threads,
  workspaces,
} from "@/db/schema"

// Reads for Kriya Harness screens (UX_SPEC §1), as the person (RLS and the
// column grants: token_hash is never selected, and couldn't be).

const MONTH = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`

// Account → Devices: signed-in devices with their agent and this month's
// spend; the mirror choice is offered only while harness.mirror is on (H6)
export async function listDevices(userId: string) {
  const mirrorAvailable = (await getSetting("harness.mirror")) === "on"
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: harnessDevices.id,
        name: harnessDevices.name,
        platform: harnessDevices.platform,
        clientVersion: harnessDevices.clientVersion,
        mirror: harnessDevices.mirror,
        lastUsedAt: harnessDevices.lastUsedAt,
        agentName: agents.name,
      })
      .from(harnessDevices)
      .leftJoin(agents, eq(agents.id, harnessDevices.agentId))
      .where(isNull(harnessDevices.revokedAt))
      .orderBy(desc(harnessDevices.lastUsedAt))
    const spend = await tx
      .select({
        deviceId: harnessUsage.deviceId,
        micro: sum(
          sql`coalesce(${harnessUsage.chargeMicroInr}, ${harnessUsage.reservedMicroInr})`
        ).mapWith(Number),
      })
      .from(harnessUsage)
      .where(
        and(ne(harnessUsage.status, "failed"), sql`${harnessUsage.createdAt} >= ${MONTH}`)
      )
      .groupBy(harnessUsage.deviceId)
    return rows.map((row) => ({
      ...row,
      mirrorAvailable,
      spentMicroInr: spend.find((s) => s.deviceId === row.id)?.micro ?? 0,
    }))
  })
}

export type DeviceRow = Awaited<ReturnType<typeof listDevices>>[number]

// The connect page's agent picker
export async function agentChoices(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .orderBy(asc(agents.createdAt))
  )
}

// The Kriya Harness page (owner 2026-11-02): sessions mirrored from the
// person's computers, their open workspaces (cloud, or their own machine
// through kriya serve), and device approvals waiting, all as the person
export async function harnessHome(userId: string) {
  return withUser(userId, async (tx) => {
    const sessions = await tx
      .select({
        id: harnessSessions.id,
        threadId: harnessSessions.threadId,
        project: harnessSessions.project,
        deviceName: harnessDevices.name,
        platform: harnessDevices.platform,
        agentId: threads.agentId,
        squadId: threads.squadId,
        title: threads.title,
        preview: threads.preview,
        activeAt: threads.activeAt,
      })
      .from(harnessSessions)
      .innerJoin(threads, eq(threads.id, harnessSessions.threadId))
      .innerJoin(harnessDevices, eq(harnessDevices.id, harnessSessions.deviceId))
      .orderBy(desc(threads.activeAt))
      .limit(20)
    const cloud = await tx
      .select({
        id: workspaces.id,
        threadId: workspaces.threadId,
        agentId: threads.agentId,
        squadId: threads.squadId,
        title: threads.title,
        repo: workspaces.repo,
        baseRef: workspaces.baseRef,
        provider: workspaces.provider,
        status: workspaces.status,
        changes: workspaces.changes,
        closing: sql<boolean>`${workspaces.closeRequestedAt} is not null`,
        activeAt: workspaces.lastActiveAt,
      })
      .from(workspaces)
      .innerJoin(threads, eq(threads.id, workspaces.threadId))
      .where(ne(workspaces.status, "closed"))
      .orderBy(desc(workspaces.lastActiveAt))
      .limit(20)
    // The Inbox's rule (HD-08): pending, unexpired, from a signed-in device
    const approvals = await tx
      .select({
        id: harnessApprovalRequests.id,
        tool: harnessApprovalRequests.tool,
        summary: harnessApprovalRequests.summary,
        input: harnessApprovalRequests.input,
        cwd: harnessApprovalRequests.cwd,
        deviceName: harnessDevices.name,
        expiresAt: harnessApprovalRequests.expiresAt,
      })
      .from(harnessApprovalRequests)
      .innerJoin(harnessDevices, eq(harnessDevices.id, harnessApprovalRequests.deviceId))
      .where(
        and(
          eq(harnessApprovalRequests.status, "pending"),
          gt(harnessApprovalRequests.expiresAt, sql`now()`),
          isNull(harnessDevices.revokedAt)
        )
      )
      .orderBy(desc(harnessApprovalRequests.createdAt))
      .limit(20)
    return { sessions, cloud, approvals }
  })
}

export type HarnessHome = Awaited<ReturnType<typeof harnessHome>>
