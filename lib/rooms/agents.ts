import { and, eq, isNull, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { roomAgents, rooms, type Task } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { pingRoom } from "@/lib/rooms/realtime"

// What the web (mentions, Share) and the worker (runTask, the relay) share
// about agents in rooms (track R, R4). No server-only marker: the worker
// loads it, and plain Node refuses that marker.

// RF-04: agents in rooms need episodes, which only agents.inbox writes
export async function roomAgentsOn() {
  return (
    (await getSetting("rooms.enabled")) === "on" &&
    (await getSetting("rooms.agents")) === "on" &&
    (await getSetting("agents.inbox")) === "on"
  )
}

// A line from Kriya in the room ("Lekha is working…"); returns its seq.
// Server-written (privileged) after the caller's own check, scoped by room
export async function postSystemLine(
  roomId: string,
  body: string,
  parts: Record<string, unknown> = {}
) {
  const [row] = rowsOf<{ seq: string | number }>(
    await privileged.execute(
      sql`insert into kriya.room_messages (room_id, author_kind, body, parts)
          values (${roomId}, 'system', ${body}, ${JSON.stringify(parts)}::jsonb)
          returning seq`
    )
  )
  const seq = Number(row.seq)
  await pingRoom(roomId, seq)
  return seq
}

// An agent's message, with its owner as user_id (the table's rule); the
// caller has checked that the owner allowed it to reach the room
export async function postAgentMessage(message: {
  roomId: string
  ownerId: string
  agentId: string
  body: string
  parts?: Record<string, unknown>
  taskId?: string | null
}) {
  const [row] = rowsOf<{ seq: string | number }>(
    await privileged.execute(
      sql`insert into kriya.room_messages (room_id, author_kind, user_id, agent_id, body, parts, task_id)
          values (${message.roomId}, 'agent', ${message.ownerId}, ${message.agentId},
                  ${clip(message.body)}, ${JSON.stringify(message.parts ?? {})}::jsonb,
                  ${message.taskId ?? null})
          returning seq`
    )
  )
  const seq = Number(row.seq)
  await pingRoom(message.roomId, seq)
  return seq
}

// A removed member's agents leave with them. Server-written, called only
// after the removal passed RLS and the member guard; scoped to that room
// and person
export async function removeAgentsOf(roomId: string, ownerId: string) {
  await privileged
    .update(roomAgents)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(roomAgents.roomId, roomId),
        eq(roomAgents.ownerId, ownerId),
        isNull(roomAgents.removedAt)
      )
    )
}

// Stop agents (R6, RD-12): any member pauses the room's agents for ten
// minutes (check_room_invocation refuses while paused). Server-written: the
// rooms update policy is for owners and admins, and this is every member's;
// the caller checked membership first. Returns the end of the pause
export async function pauseAgents(roomId: string) {
  const [row] = rowsOf<{ until: string | Date }>(
    await privileged.execute(
      sql`update kriya.rooms set agents_paused_until = now() + interval '10 minutes'
          where id = ${roomId} and status = 'active'
          returning agents_paused_until as until`
    )
  )
  return row ? new Date(row.until) : null
}

// room_messages.body holds at most 8,000 characters
export const clip = (text: string) =>
  text.length <= 8000 ? text : `${text.slice(0, 7999)}…`

// The room a bridge thread serves, if the agent is still in it, its owner
// still a member and the room active: the room belt and prompt (runTask)
export async function roomOfTask(task: Pick<Task, "userId" | "threadId" | "agentId">) {
  const [row] = await privileged
    .select({
      roomId: roomAgents.roomId,
      agentId: roomAgents.agentId,
      title: rooms.title,
      allowConnectors: roomAgents.allowConnectors,
    })
    .from(roomAgents)
    .innerJoin(rooms, eq(rooms.id, roomAgents.roomId))
    .where(
      and(
        eq(roomAgents.bridgeThreadId, task.threadId),
        eq(roomAgents.ownerId, task.userId),
        isNull(roomAgents.removedAt),
        eq(rooms.status, "active"),
        sql`exists (select 1 from kriya.room_members m
                    where m.room_id = ${roomAgents.roomId} and m.user_id = ${roomAgents.ownerId}
                      and m.left_at is null)`
      )
    )
  return row ?? null
}
