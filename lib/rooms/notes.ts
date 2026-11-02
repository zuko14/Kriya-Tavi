import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { roomNotes } from "@/db/schema"
import { postSystemLine } from "@/lib/rooms/agents"
import { roomNames } from "@/lib/rooms/names"

// Room notes (track R, R8; RD-14). Members' notes are theirs; an agent's
// note (room_note_add) is saved unconfirmed and joins the room's context
// for agents only once a member confirms it. Notes are never copied into
// anyone's personal memory. No server-only marker: the worker runs the tool.

// What an agent may add, per agent and room, in an hour
const AGENT_NOTES_PER_HOUR = 10
// The bridge message carries at most this many notes, newest first
export const CONTEXT_NOTES = 20

export async function addAgentNote({
  roomId,
  ownerId,
  agentId,
  body,
}: {
  roomId: string
  ownerId: string
  agentId: string
  body: string
}) {
  // The agent still in this room, its owner still a member, the room active
  const [link] = rowsOf<{ allow_connectors: boolean }>(
    await privileged.execute(
      sql`select a.allow_connectors from kriya.room_agents a
          join kriya.rooms r on r.id = a.room_id and r.status = 'active'
          where a.room_id = ${roomId} and a.agent_id = ${agentId} and a.owner_id = ${ownerId}
            and a.removed_at is null
            and exists (select 1 from kriya.room_members m
                        where m.room_id = a.room_id and m.user_id = a.owner_id and m.left_at is null)`
    )
  )
  if (!link) return { saved: false, message: "This agent isn't in that room any more." }
  // Where the owner allowed their accounts here, their private data (and
  // memory) may be in this conversation: a note would skip "Share in room"
  if (link.allow_connectors)
    return {
      saved: false,
      message:
        "Notes are off for you in this room, because your owner allowed their accounts here. Put it in your reply; your owner can share it.",
    }
  const [{ n }] = rowsOf<{ n: number }>(
    await privileged.execute(
      sql`select count(*)::int as n from kriya.room_notes
          where room_id = ${roomId} and agent_id = ${agentId} and user_id = ${ownerId}
            and created_at > now() - interval '1 hour'`
    )
  )
  if (n >= AGENT_NOTES_PER_HOUR)
    return { saved: false, message: "You've added enough notes to this room for now." }
  const [note] = rowsOf<{ id: string }>(
    await privileged.execute(
      sql`insert into kriya.room_notes (room_id, body, author_kind, user_id, agent_id)
          values (${roomId}, ${body}, 'agent', ${ownerId}, ${agentId}) returning id`
    )
  )
  const names = await roomNames([{ userId: ownerId, agentId }])
  await postSystemLine(
    roomId,
    `${names.agent(ownerId, agentId)} added a note; a member can confirm it in Notes.`,
    { kind: "note", noteId: note.id }
  )
  return {
    saved: true,
    noteId: note.id,
    status: "unconfirmed",
    message:
      "Saved for the room as unconfirmed. Agents see it only after a member confirms it.",
  }
}

// RT-NOTE-02: what the bridge message quotes: members' own notes and
// agents' notes a member confirmed, not deleted, newest first
export async function confirmedNotes(roomId: string) {
  const rows = await privileged
    .select({ body: roomNotes.body })
    .from(roomNotes)
    .where(
      and(
        eq(roomNotes.roomId, roomId),
        isNull(roomNotes.deletedAt),
        or(eq(roomNotes.authorKind, "human"), isNotNull(roomNotes.confirmedBy))
      )
    )
    .orderBy(desc(roomNotes.createdAt))
    .limit(CONTEXT_NOTES)
  return rows.map((r) => r.body)
}
