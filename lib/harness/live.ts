import { and, asc, desc, eq, gt, lt } from "drizzle-orm"
import type { z } from "zod"

import { privileged, withUser } from "@/db"
import {
  harnessDevices,
  harnessLiveEvents as events,
  harnessLiveSessions as sessions,
} from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import type { LiveReportRequest } from "@/lib/harness/contract"

// Remote Control (REMOTE_CONTROL.md): a session's live stream. Device writes
// are privileged, always scoped by the device's person and the device; the
// person's reads go through withUser (RLS). This text is shown to the person
// only: it never reaches an agent's context.

// Newest kept per session
export const LIVE_KEEP = 3000
// The client reports at least every 30 s while on; silent this long, it's lost
const LOST_MS = 2 * 60_000

export async function recordLive(
  device: DeviceUser,
  body: z.infer<typeof LiveReportRequest>
) {
  const values = {
    remote: body.remote,
    state: body.state,
    updatedAt: new Date(),
    ...(body.title && { title: body.title }),
    ...(body.project && { project: body.project }),
  }
  const [session] = await privileged
    .insert(sessions)
    .values({
      userId: device.id,
      deviceId: device.deviceId,
      deviceSessionId: body.deviceSessionId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [sessions.deviceId, sessions.deviceSessionId],
      set: values,
      // A device id is unique, so this only ever matches the device's own row
      setWhere: eq(sessions.userId, device.id),
    })
    .returning({ id: sessions.id })
  if (!session || !body.events.length) return
  await privileged
    .insert(events)
    .values(
      body.events.map(({ seq, at, kind, ...data }) => ({
        sessionId: session.id,
        userId: device.id,
        seq,
        kind,
        data,
        at: new Date(at),
      }))
    )
    .onConflictDoNothing()
  const newest = Math.max(...body.events.map((event) => event.seq))
  if (newest >= LIVE_KEEP)
    await privileged
      .delete(events)
      .where(
        and(eq(events.sessionId, session.id), lt(events.seq, newest - LIVE_KEEP + 1))
      )
}

async function readSessions(userId: string, id?: string) {
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        id: sessions.id,
        title: sessions.title,
        project: sessions.project,
        remote: sessions.remote,
        state: sessions.state,
        updatedAt: sessions.updatedAt,
        device: harnessDevices.name,
      })
      .from(sessions)
      .innerJoin(harnessDevices, eq(harnessDevices.id, sessions.deviceId))
      .where(id ? eq(sessions.id, id) : undefined)
      .orderBy(desc(sessions.remote), desc(sessions.updatedAt))
      .limit(20)
  )
  const now = Date.now()
  return rows.map((row) => ({
    ...row,
    lost: row.remote && row.state !== "ended" && now - row.updatedAt.getTime() > LOST_MS,
  }))
}

export const liveSessions = (userId: string) => readSessions(userId)

export type LiveSession = Awaited<ReturnType<typeof liveSessions>>[number]

// One session and its events after `after`; null when it isn't this person's
export async function liveFeed(userId: string, id: string, after: number) {
  const [session] = await readSessions(userId, id)
  if (!session) return null
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        seq: events.seq,
        kind: events.kind,
        data: events.data,
        at: events.at,
      })
      .from(events)
      .where(and(eq(events.sessionId, id), gt(events.seq, after)))
      .orderBy(asc(events.seq))
      .limit(500)
  )
  return { session, events: rows }
}

export type LiveFeed = NonNullable<Awaited<ReturnType<typeof liveFeed>>>
