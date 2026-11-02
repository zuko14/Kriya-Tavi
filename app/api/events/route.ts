import { and, eq, gt, isNull, ne, sql } from "drizzle-orm"

import { withUser } from "@/db"
import {
  agents,
  harnessApprovalRequests,
  harnessDevices,
  roomDisclosures,
  roomMessages,
  rooms,
  tasks,
  threads,
} from "@/db/schema"
import { authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { joinedGlyph } from "@/lib/glyph"
import { previewText, type KriyaEvent } from "@/lib/events"
import { roomAgentsOn } from "@/lib/rooms/agents"
import { roomsEnabled } from "@/lib/rooms/core"
import { roomNames } from "@/lib/rooms/names"

// A server-sent event stream of the person's tasks starting and finishing,
// and (PX-03, behind track R's switches) room mentions and replies waiting
// for Share in room, and (behind harness.api) Kriya Harness approval
// requests, for notifications. Tasks run in the worker, so this follows the tasks
// table (through RLS) rather than an in-process event bus.

const POLL_MS = 3_000
const MAX_MS = 10 * 60_000

export async function GET(request: Request) {
  const user = await authenticate()
  if (!user) return new Response("Sign in to continue.", { status: 401 })

  const encoder = new TextEncoder()
  // A little behind now, so clock skew between server and database can't hide a change
  let since = new Date(Date.now() - 10_000)
  // Status last sent per task, so each change is announced once
  const announced = new Map<string, string>()

  const poll = async () => {
    const rows = await withUser(user.id, (tx) =>
      tx
        .select({
          id: tasks.id,
          status: tasks.status,
          error: tasks.error,
          threadId: tasks.threadId,
          updatedAt: tasks.updatedAt,
          startedAt: tasks.startedAt,
          finishedAt: tasks.finishedAt,
          squadId: threads.squadId,
          preview: threads.preview,
          agentId: agents.id,
          name: agents.name,
          glyph: agents.glyph,
          role: agents.role,
        })
        .from(tasks)
        .innerJoin(threads, eq(threads.id, tasks.threadId))
        .leftJoin(agents, eq(agents.id, tasks.agentId))
        .where(and(eq(tasks.userId, user.id), gt(tasks.updatedAt, since)))
        .orderBy(tasks.updatedAt)
        .limit(50)
    )
    const events: KriyaEvent[] = []
    for (const row of rows) {
      if (row.updatedAt > since) since = row.updatedAt
      const kind =
        row.status === "queued" || row.status === "running" ? "started" : "finished"
      if (announced.get(row.id) === kind) continue
      announced.set(row.id, kind)
      const common = {
        threadId: row.threadId,
        href: row.squadId
          ? `/s/${row.squadId}/${row.threadId}`
          : `/a/${row.agentId}/${row.threadId}`,
        name: row.name ?? "Your agent",
        glyph: joinedGlyph(row.glyph, row.role) ?? "",
      }
      if (kind === "started") events.push({ ...common, type: "turn-started" })
      // A task the person stopped needs no news
      else if (row.status !== "canceled") {
        events.push({
          ...common,
          type: "turn-finished",
          preview: previewText(row.preview ?? ""),
          ok: row.status === "succeeded",
          ...(row.error && { error: row.error }),
          durationMs:
            row.finishedAt && row.startedAt
              ? row.finishedAt.getTime() - row.startedAt.getTime()
              : 0,
        })
      }
    }
    return [...events, ...(await roomEvents()), ...(await harnessEvents())]
  }

  // PX-03 (track H, H5): a device's approval request, naming the tool and
  // the device, never the input or summary. Through RLS; off = not queried
  let harnessSince = since
  const harnessEvents = async (): Promise<KriyaEvent[]> => {
    if ((await getSetting("harness.api")) !== "on") return []
    const asked = await withUser(user.id, (tx) =>
      tx
        .select({
          id: harnessApprovalRequests.id,
          tool: harnessApprovalRequests.tool,
          createdAt: harnessApprovalRequests.createdAt,
          deviceId: harnessDevices.id,
          device: harnessDevices.name,
        })
        .from(harnessApprovalRequests)
        .innerJoin(
          harnessDevices,
          eq(harnessDevices.id, harnessApprovalRequests.deviceId)
        )
        .where(
          and(
            gt(harnessApprovalRequests.createdAt, harnessSince),
            eq(harnessApprovalRequests.status, "pending")
          )
        )
        .orderBy(harnessApprovalRequests.createdAt)
        .limit(20)
    )
    for (const row of asked)
      if (row.createdAt > harnessSince) harnessSince = row.createdAt
    return asked.map((a) => ({
      type: "harness-approval",
      threadId: a.id,
      href: "/inbox",
      name: a.device,
      glyph: `harness-${a.deviceId}`,
      tool: a.tool,
    }))
  }

  // PX-03 (track R): mentions of the person in rooms (rooms.enabled) and
  // agents' replies waiting for their "Share in room" (rooms.agents).
  // Through RLS, like the tasks above; off = not queried
  let roomSince = since
  const roomEvents = async (): Promise<KriyaEvent[]> => {
    if (!(await roomsEnabled())) return []
    const shareOn = await roomAgentsOn()
    const { mentions, held } = await withUser(user.id, async (tx) => ({
      mentions: await tx
        .select({
          roomId: roomMessages.roomId,
          room: rooms.title,
          userId: roomMessages.userId,
          body: roomMessages.body,
          createdAt: roomMessages.createdAt,
        })
        .from(roomMessages)
        .innerJoin(rooms, eq(rooms.id, roomMessages.roomId))
        .where(
          and(
            gt(roomMessages.createdAt, roomSince),
            eq(roomMessages.authorKind, "human"),
            ne(roomMessages.userId, user.id),
            isNull(roomMessages.deletedAt),
            sql`${roomMessages.parts} -> 'mentions' @> ${JSON.stringify([{ kind: "person", id: user.id }])}::jsonb`
          )
        )
        .orderBy(roomMessages.createdAt)
        .limit(20),
      held: shareOn
        ? await tx
            .select({
              id: roomDisclosures.id,
              roomId: roomDisclosures.roomId,
              room: rooms.title,
              createdAt: roomDisclosures.createdAt,
              name: agents.name,
              glyph: agents.glyph,
              role: agents.role,
            })
            .from(roomDisclosures)
            .innerJoin(rooms, eq(rooms.id, roomDisclosures.roomId))
            .innerJoin(
              agents,
              and(
                eq(agents.id, roomDisclosures.agentId),
                eq(agents.userId, roomDisclosures.ownerId)
              )
            )
            .where(
              and(
                gt(roomDisclosures.createdAt, roomSince),
                eq(roomDisclosures.status, "pending")
              )
            )
            .orderBy(roomDisclosures.createdAt)
            .limit(20)
        : [],
    }))
    for (const row of [...mentions, ...held])
      if (row.createdAt > roomSince) roomSince = row.createdAt
    // Writers' display names, only for these rooms' messages (RF-08)
    const names = await roomNames(
      mentions.map((m) => ({ userId: m.userId, agentId: null }))
    )
    return [
      ...mentions.map((m): KriyaEvent => ({
        type: "room-mention",
        threadId: m.roomId,
        href: `/rooms/${m.roomId}`,
        name: names.person(m.userId),
        glyph: `room-${m.roomId}`,
        room: m.room,
        preview: previewText(m.body ?? ""),
      })),
      ...held.map((d): KriyaEvent => ({
        type: "room-disclosure",
        threadId: d.roomId,
        href: "/inbox",
        name: d.name,
        glyph: joinedGlyph(d.glyph, d.role) ?? "",
        room: d.room,
      })),
    ]
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text))
      const opened = Date.now()
      send("retry: 3000\n\n")
      // The browser reconnects after MAX_MS, keeping connections short-lived
      while (!request.signal.aborted && Date.now() - opened < MAX_MS) {
        try {
          for (const event of await poll()) send(`data: ${JSON.stringify(event)}\n\n`)
          send(": keep-alive\n\n")
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      try {
        controller.close()
      } catch {}
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
