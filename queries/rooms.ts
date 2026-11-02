import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"

import { privileged, rowsOf, withUser } from "@/db"
import {
  agents,
  charges,
  personBlocks,
  profiles,
  roomReports,
  roomAgents,
  roomGoalItems,
  roomGoals,
  roomInvites,
  roomMembers,
  roomNotes,
  roomMessages,
  rooms,
} from "@/db/schema"
import { joinedGlyph } from "@/lib/glyph"
import { roomAgentsOn } from "@/lib/rooms/agents"
import { roomsEnabled } from "@/lib/rooms/core"
import { roomNames } from "@/lib/rooms/names"
import type { ProofCard } from "@/lib/rooms/proof"

// Reads for rooms (track R, R2, R3), through withUser: the membership
// policies decide what a person sees, so a non-member, or someone who left
// or was removed, gets nothing. Privileged reads come only after that check
// and only for that room: members' and agents' display names and glyphs,
// and the agents' spend today (RD-17: the amount to the owner, to others
// only "limit reached"). With rooms.enabled off no room query runs
// (RT-REG-01).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The person's active rooms, most recently active first, with what's unread
export async function listRooms(userId: string) {
  if (!(await roomsEnabled())) return []
  return withUser(userId, (tx) =>
    tx
      .select({
        id: rooms.id,
        title: rooms.title,
        status: rooms.status,
        role: roomMembers.role,
        lastSeq: rooms.lastSeq,
        lastReadSeq: roomMembers.lastReadSeq,
        updatedAt: rooms.updatedAt,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.userId, userId), isNull(roomMembers.leftAt)))
      .orderBy(desc(rooms.updatedAt))
  )
}

// A room, its active members and the person's role; null unless they're in it
export async function getRoom(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomsEnabled())) return null
  const found = await withUser(userId, async (tx) => {
    const [room] = await tx
      .select({
        id: rooms.id,
        title: rooms.title,
        topic: rooms.topic,
        status: rooms.status,
        createdBy: rooms.createdBy,
        lastSeq: rooms.lastSeq,
        // R6: Stop agents' pause, while it lasts
        agentsPausedUntil: sql<
          string | null
        >`case when ${rooms.agentsPausedUntil} > now() then ${rooms.agentsPausedUntil} end`,
        role: sql<"owner" | "admin" | "member" | null>`kriya.room_role(${rooms.id})`,
      })
      .from(rooms)
      .where(eq(rooms.id, roomId))
    if (!room?.role) return null
    const members = await tx
      .select({
        userId: roomMembers.userId,
        role: roomMembers.role,
        joinedAt: roomMembers.joinedAt,
      })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), isNull(roomMembers.leftAt)))
      .orderBy(asc(roomMembers.joinedAt))
    // R9: the people the reader blocked (RLS: their own list), whose
    // messages and agents' messages the room collapses for them
    const blocked = (
      await tx.select({ id: personBlocks.blockedId }).from(personBlocks)
    ).map((b) => b.id)
    const { role, ...rest } = room
    return { room: rest, role, members, blocked }
  })
  if (!found) return null
  // Profiles are owner-only, so members' names are read through privileged,
  // after RLS above proved the reader is in the room, and only for the
  // room's active members (RF-08): their display name and nothing else
  const ids = found.members.map((m) => m.userId)
  const names = new Map(
    (
      await privileged
        .select({ id: profiles.id, name: profiles.displayName })
        .from(profiles)
        .where(inArray(profiles.id, ids))
    ).map((p) => [p.id, p.name])
  )
  return {
    ...found,
    members: found.members.map((m) => ({ ...m, name: names.get(m.userId) || "Member" })),
  }
}

export type RoomPage = NonNullable<Awaited<ReturnType<typeof getRoom>>>
export type RoomMessage = Awaited<ReturnType<typeof readMessages>>[number]
export type RoomRow = Awaited<ReturnType<typeof listRooms>>[number]
export type InviteRow = Awaited<ReturnType<typeof listInvites>>[number]

// Messages after `after` (the polling cursor), oldest first; deleted ones
// keep their place without their text. Agent messages carry the agent's
// name, and the reader's own agents' messages their ₹ charge (RD-17: only
// the owner sees it, through the owner-only charges policy)
export async function readMessages(
  userId: string,
  roomId: string,
  { after = 0, limit = 100 }: { after?: number; limit?: number } = {}
) {
  if (!UUID.test(roomId) || !(await roomsEnabled())) return []
  const rows = await readRows(userId, roomId, after, limit)
  const agentRows = rows.filter((row) => row.agentId)
  const names = await roomNames(agentRows)
  const own = agentRows.flatMap((row) =>
    row.userId === userId && row.taskId ? [row.taskId] : []
  )
  const costs = new Map(
    own.length
      ? (
          await withUser(userId, (tx) =>
            tx
              .select({ taskId: charges.taskId, charge: charges.chargeMicroInr })
              .from(charges)
              .where(inArray(charges.taskId, own))
          )
        ).map((c) => [c.taskId, c.charge])
      : []
  )
  // Task ids stay on the server: they're the owner's
  return rows.map(({ taskId, ...row }) => ({
    ...row,
    agentName: row.agentId ? names.agent(row.userId, row.agentId) : null,
    cost: row.userId === userId && taskId ? (costs.get(taskId) ?? null) : null,
  }))
}

// The room's agents for its page (R4): each with its owner, who may ask
// it, and whether others hit today's limit; the reader's own agents also
// carry their policy and what others' requests cost today (RD-17)
export async function roomAgentsFor(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomAgentsOn())) return []
  // Through RLS: nothing unless the reader is an active member
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        agentId: roomAgents.agentId,
        ownerId: roomAgents.ownerId,
        invoke: roomAgents.invoke,
        dailyCapMicroInr: roomAgents.dailyCapMicroInr,
        allowConnectors: roomAgents.allowConnectors,
      })
      .from(roomAgents)
      .where(and(eq(roomAgents.roomId, roomId), isNull(roomAgents.removedAt)))
      .orderBy(asc(roomAgents.addedAt))
  )
  if (rows.length === 0) return []
  // Others' requests today, the sum check_room_invocation compares with the
  // cap. Charges are owner-only, so it is read through privileged for these
  // agents of this room only; the amount goes to the owner, the rest of
  // the room learns only whether the limit is reached
  const spent = new Map(
    rowsOf<{ agent_id: string; spent: string | number }>(
      await privileged.execute(
        sql`select i.agent_id, coalesce(sum(c.charge_micro_inr), 0) as spent
            from kriya.room_invocations i
            join kriya.room_agents a on a.room_id = i.room_id and a.agent_id = i.agent_id
            join kriya.charges c on c.task_id = i.task_id
            where i.room_id = ${roomId}
              and i.requested_by is distinct from a.owner_id
              and i.created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
            group by i.agent_id`
      )
    ).map((row) => [row.agent_id, Number(row.spent)])
  )
  // R6: who is working on a request right now (for "Stop agents")
  const working = new Set(
    rowsOf<{ agent_id: string }>(
      await privileged.execute(
        sql`select distinct i.agent_id from kriya.room_invocations i
            join kriya.tasks t on t.id = i.task_id
            where i.room_id = ${roomId} and i.status in ('queued', 'dispatched')
              and t.status in ('queued', 'running')`
      )
    ).map((row) => row.agent_id)
  )
  const names = await roomNames(
    rows.map((row) => ({ userId: row.ownerId, agentId: row.agentId }))
  )
  // Agents are owner-only: their glyph, like their name, for the room's agents only
  const glyphs = await privileged
    .select({
      id: agents.id,
      userId: agents.userId,
      glyph: agents.glyph,
      role: agents.role,
    })
    .from(agents)
    .where(
      inArray(
        agents.id,
        rows.map((r) => r.agentId)
      )
    )
  // The role avatar where the agent has no glyph of its own (joinedGlyph)
  const glyph = new Map(
    glyphs.map((g) => [`${g.userId}:${g.id}`, joinedGlyph(g.glyph, g.role)])
  )
  return rows.map((row) => {
    const today = spent.get(row.agentId) ?? 0
    const mine = row.ownerId === userId
    return {
      agentId: row.agentId,
      name: names.agent(row.ownerId, row.agentId),
      glyph: glyph.get(`${row.ownerId}:${row.agentId}`) ?? row.agentId,
      ownerId: row.ownerId,
      ownerName: names.person(row.ownerId),
      invoke: row.invoke,
      mine,
      working: working.has(row.agentId),
      limitReached:
        row.invoke === "members" &&
        row.dailyCapMicroInr !== null &&
        today >= row.dailyCapMicroInr,
      // The owner's alone (RD-17)
      policy: mine
        ? {
            dailyCapMicroInr: row.dailyCapMicroInr,
            allowConnectors: row.allowConnectors,
            spentTodayMicroInr: today,
          }
        : null,
    }
  })
}

// The reader's own agents not yet in the room, for "Add to room"
export async function myAgentsToAdd(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomAgentsOn())) return []
  return withUser(userId, (tx) =>
    tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        sql`not exists (select 1 from kriya.room_agents a
          where a.room_id = ${roomId} and a.agent_id = ${agents.id} and a.removed_at is null)`
      )
      .orderBy(asc(agents.name))
  )
}

// The room's goals (R7), newest first, each with its items in order and how
// each closed: the card's verified action and its agent, or who confirmed
// it without proof. Through RLS: nothing unless the reader is a member
export async function goalsFor(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomsEnabled())) return []
  const { goals, items, cards } = await withUser(userId, async (tx) => {
    const goals = await tx
      .select({
        id: roomGoals.id,
        title: roomGoals.title,
        status: roomGoals.status,
        createdBy: roomGoals.createdBy,
        createdAt: roomGoals.createdAt,
      })
      .from(roomGoals)
      .where(eq(roomGoals.roomId, roomId))
      .orderBy(desc(roomGoals.createdAt))
    const items = goals.length
      ? await tx
          .select({
            id: roomGoalItems.id,
            goalId: roomGoalItems.goalId,
            text: roomGoalItems.text,
            position: roomGoalItems.position,
            proofMessageId: roomGoalItems.proofMessageId,
            proofItem: roomGoalItems.proofItem,
            confirmedBy: roomGoalItems.confirmedBy,
            closedAt: roomGoalItems.closedAt,
          })
          .from(roomGoalItems)
          .where(eq(roomGoalItems.roomId, roomId))
          .orderBy(asc(roomGoalItems.position), asc(roomGoalItems.createdAt))
      : []
    const proofIds = items.flatMap((i) => (i.proofMessageId ? [i.proofMessageId] : []))
    const cards = proofIds.length
      ? await tx
          .select({
            id: roomMessages.id,
            userId: roomMessages.userId,
            agentId: roomMessages.agentId,
            parts: roomMessages.parts,
          })
          .from(roomMessages)
          .where(and(eq(roomMessages.roomId, roomId), inArray(roomMessages.id, proofIds)))
      : []
    return { goals, items, cards }
  })
  const names = await roomNames([
    ...items.flatMap((i) =>
      i.confirmedBy ? [{ userId: i.confirmedBy, agentId: null }] : []
    ),
    ...cards.map((c) => ({ userId: c.userId, agentId: c.agentId })),
  ])
  const card = new Map(cards.map((c) => [c.id, c]))
  return goals.map((goal) => ({
    ...goal,
    mine: goal.createdBy === userId,
    items: items
      .filter((i) => i.goalId === goal.id)
      .map((i) => {
        const proof = i.proofMessageId ? card.get(i.proofMessageId) : undefined
        const done = (proof?.parts.proof as ProofCard | undefined)?.done[
          i.proofItem ?? -1
        ]
        return {
          id: i.id,
          text: i.text,
          closed: proof
            ? {
                proof: {
                  title: done?.title ?? "A verified action",
                  agent: names.label(proof),
                },
              }
            : i.confirmedBy
              ? { confirmedBy: names.person(i.confirmedBy) }
              : null,
        }
      }),
  }))
}

export type RoomGoal = Awaited<ReturnType<typeof goalsFor>>[number]

// The room's notes (R8), newest first, without deleted ones: who wrote each
// (a person, or an agent and its owner) and, for an agent's, who confirmed it
export async function notesFor(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomsEnabled())) return []
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        id: roomNotes.id,
        body: roomNotes.body,
        authorKind: roomNotes.authorKind,
        userId: roomNotes.userId,
        agentId: roomNotes.agentId,
        confirmedBy: roomNotes.confirmedBy,
        createdAt: roomNotes.createdAt,
      })
      .from(roomNotes)
      .where(and(eq(roomNotes.roomId, roomId), isNull(roomNotes.deletedAt)))
      .orderBy(desc(roomNotes.createdAt))
      .limit(100)
  )
  const names = await roomNames([
    ...rows,
    ...rows.flatMap((r) =>
      r.confirmedBy ? [{ userId: r.confirmedBy, agentId: null }] : []
    ),
  ])
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    agent: r.authorKind === "agent",
    by: names.label(r),
    mine: r.authorKind === "human" && r.userId === userId,
    // An agent's note counts once a member confirmed it; a person's always
    confirmedBy: r.confirmedBy ? names.person(r.confirmedBy) : null,
    createdAt: r.createdAt,
  }))
}

export type RoomNote = Awaited<ReturnType<typeof notesFor>>[number]

// The people the person blocked (R9), for Rooms' "Blocked" list: their
// display names through privileged after RLS returned the person's own rows
export async function blockedPeople(userId: string) {
  if (!(await roomsEnabled())) return []
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ userId: personBlocks.blockedId, at: personBlocks.createdAt })
      .from(personBlocks)
      .orderBy(desc(personBlocks.createdAt))
  )
  if (!rows.length) return []
  const names = new Map(
    (
      await privileged
        .select({ id: profiles.id, name: profiles.displayName })
        .from(profiles)
        .where(
          inArray(
            profiles.id,
            rows.map((r) => r.userId)
          )
        )
    ).map((p) => [p.id, p.name])
  )
  return rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) || "Member" }))
}

export type BlockedPerson = Awaited<ReturnType<typeof blockedPeople>>[number]

// The owner console's rooms page (R9, RC-5). Call only after requireOwner():
// open reports first, then the latest closed ones, each with the copy the
// database made of the reported message; and the numbers to watch for
// scale (ARCHITECTURE §5, REALTIME §4). People by id, as other owner pages
export async function roomsOverview() {
  const reports = await privileged
    .select({
      id: roomReports.id,
      roomId: roomReports.roomId,
      roomTitle: rooms.title,
      roomStatus: rooms.status,
      reporterId: roomReports.reporterId,
      reason: roomReports.reason,
      note: roomReports.note,
      messageId: roomReports.messageId,
      authorKind: roomReports.messageAuthorKind,
      authorId: roomReports.messageUserId,
      agentId: roomReports.messageAgentId,
      body: roomReports.messageBody,
      status: roomReports.status,
      reviewedAt: roomReports.reviewedAt,
      createdAt: roomReports.createdAt,
    })
    .from(roomReports)
    .innerJoin(rooms, eq(rooms.id, roomReports.roomId))
    .orderBy(sql`${roomReports.status} = 'open' desc`, desc(roomReports.createdAt))
    .limit(100)
  const [counts] = rowsOf<{
    open_reports: number
    active_rooms: number
    messages_day: number
    busiest_day: number
    largest_room: number
    blocks: number
  }>(
    await privileged.execute(
      sql`select
            (select count(*)::int from kriya.room_reports where status = 'open') as open_reports,
            (select count(*)::int from kriya.rooms where status = 'active') as active_rooms,
            (select count(*)::int from kriya.room_messages
               where created_at > now() - interval '1 day') as messages_day,
            (select coalesce(max(n), 0)::int from (
               select count(*) as n from kriya.room_messages
                 where created_at > now() - interval '1 day' group by room_id) d) as busiest_day,
            (select coalesce(max(n), 0)::int from (
               select count(*) as n from kriya.room_members
                 where left_at is null group by room_id) m) as largest_room,
            (select count(*)::int from kriya.person_blocks) as blocks`
    )
  )
  return {
    reports,
    openReports: Number(counts.open_reports),
    activeRooms: Number(counts.active_rooms),
    messagesDay: Number(counts.messages_day),
    busiestDay: Number(counts.busiest_day),
    largestRoom: Number(counts.largest_room),
    blocks: Number(counts.blocks),
  }
}

export type RoomReport = Awaited<ReturnType<typeof roomsOverview>>["reports"][number]

// The card type, for the room page (client components import only types)
export type { ProofCard } from "@/lib/rooms/proof"

export type RoomAgent = Awaited<ReturnType<typeof roomAgentsFor>>[number]
export type MyAgent = Awaited<ReturnType<typeof myAgentsToAdd>>[number]

async function readRows(userId: string, roomId: string, after: number, limit: number) {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: roomMessages.id,
        seq: roomMessages.seq,
        authorKind: roomMessages.authorKind,
        userId: roomMessages.userId,
        agentId: roomMessages.agentId,
        body: roomMessages.body,
        parts: roomMessages.parts,
        taskId: roomMessages.taskId,
        deletedAt: roomMessages.deletedAt,
        createdAt: roomMessages.createdAt,
      })
      .from(roomMessages)
      .where(and(eq(roomMessages.roomId, roomId), gt(roomMessages.seq, after)))
      .orderBy(asc(roomMessages.seq))
      .limit(Math.min(Math.max(limit, 1), 200))
    return rows.map((row) => (row.deletedAt ? { ...row, body: null, parts: {} } : row))
  })
}

// The room's invites that still work, for its owner and admins (RLS;
// others get none)
export async function listInvites(userId: string, roomId: string) {
  if (!UUID.test(roomId) || !(await roomsEnabled())) return []
  return withUser(userId, (tx) =>
    tx
      .select({
        id: roomInvites.id,
        maxUses: roomInvites.maxUses,
        uses: roomInvites.uses,
        expiresAt: roomInvites.expiresAt,
        revokedAt: roomInvites.revokedAt,
        createdAt: roomInvites.createdAt,
      })
      .from(roomInvites)
      .where(
        and(
          eq(roomInvites.roomId, roomId),
          isNull(roomInvites.revokedAt),
          sql`${roomInvites.expiresAt} > now()`,
          sql`${roomInvites.uses} < ${roomInvites.maxUses}`
        )
      )
      .orderBy(desc(roomInvites.createdAt))
  )
}
