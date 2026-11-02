"use server"

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { nanoid } from "nanoid"
import { z } from "zod"

import { rowsOf, withUser, type Tx } from "@/db"
import {
  agents,
  personBlocks,
  roomAgents,
  roomDisclosures,
  roomGoalItems,
  roomGoals,
  roomInvites,
  roomNotes,
  roomMembers,
  roomMessages,
  rooms,
} from "@/db/schema"
import { appUrl, requireOwner, requireUser } from "@/lib/auth"
import { audit } from "@/lib/owner"
import { allow, clientIp } from "@/lib/rate-limit"
import { cancelThreadTask } from "@/lib/agent/queue"
import {
  pauseAgents,
  postAgentMessage,
  postSystemLine,
  removeAgentsOf,
  roomAgentsOn,
} from "@/lib/rooms/agents"
import { conduct } from "@/lib/rooms/conductor"
import {
  hashInviteToken,
  newInviteToken,
  roomLimit,
  roomsEnabled,
} from "@/lib/rooms/core"
import { invokeMentions, MAX_AGENT_MENTIONS } from "@/lib/rooms/invoke"
import { dropGoal, recomputeGoal } from "@/lib/rooms/goals"
import { closeReport } from "@/lib/rooms/moderation"
import { roomNames } from "@/lib/rooms/names"
import { episodeOf, markVerified, type ProofCard } from "@/lib/rooms/proof"
import { pingRoom } from "@/lib/rooms/realtime"

// The room core (track R, R2; RD-11, RD-18): people create rooms, invite
// through links, join, leave, remove members, post and mark what they've
// read. Inserts are written out in SQL because the column grants allow only
// the columns they name. Everything goes through withUser, so the membership policies of
// kriya.room_* decide what each person may see and change; joining goes
// only through kriya.join_room(). With rooms.enabled off every action
// answers "Room not found." before touching a room table (RT-REG-01).
// R4 adds agents: a person adds, removes and sets the policy of their own
// agents, mentions ask them, and Share / Discard answers a held reply. The
// server's own writes (system lines, agent messages, invocations) happen
// in lib/rooms, after these actions' checks, never here.

const id = z.uuid()
const NOT_FOUND = { error: "Room not found." }
const INVALID = { error: "That request wasn't valid." }
const TOO_MANY = { error: "Too many requests. Wait a little and try again." }
const BAD_INVITE = { error: "This invite link isn't valid any more. Ask for a new one." }

// The plain words for kriya.join_room's and the member guard's refusals
const REFUSALS: [RegExp, string][] = [
  [/this invite is not valid/, BAD_INVITE.error],
  [/this invite is used up/, "This invite link has been used up. Ask for a new one."],
  [/this room is full/, "This room is full."],
  [/this room is archived/, "This room is archived."],
  [/you were removed from this room/, "You were removed from this room."],
  [/the room owner stays in the room/, "The room's owner can't leave or be removed."],
]

function refusal(error: unknown) {
  const text = `${error} ${(error as { cause?: unknown })?.cause}`
  const match = REFUSALS.find(([pattern]) => pattern.test(text))
  if (match) return { error: match[1] }
  throw error
}

class OverRoomLimit extends Error {}

async function overRoomLimit(tx: Tx, userId: string) {
  const max = await roomLimit("rooms.maxPerPerson")
  const [row] = await tx
    .select({ n: count() })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(
      and(
        eq(roomMembers.userId, userId),
        isNull(roomMembers.leftAt),
        eq(rooms.status, "active")
      )
    )
  return row.n > max ? max : null
}

const roomLimitError = (max: number) => ({
  error: `You can be in at most ${max} ${max === 1 ? "room" : "rooms"}. Leave one first.`,
})

const createSchema = z.object({
  title: z.string().trim().min(1).max(80),
  topic: z.string().trim().max(500).optional(),
})

export async function createRoom(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return INVALID
  try {
    const roomId = await withUser(user.id, async (tx) => {
      const [room] = rowsOf<{ id: string }>(
        await tx.execute(
          sql`insert into kriya.rooms (created_by, title, topic)
              values (${user.id}, ${parsed.data.title}, ${parsed.data.topic || null})
              returning id`
        )
      )
      // Counted after the insert, in the same transaction, so the new room counts
      const max = await overRoomLimit(tx, user.id)
      if (max !== null) throw new OverRoomLimit(String(max))
      return room.id
    })
    return { ok: true as const, roomId }
  } catch (error) {
    if (error instanceof OverRoomLimit) return roomLimitError(Number(error.message))
    throw error
  }
}

const inviteSchema = z.object({
  roomId: id,
  maxUses: z.number().int().min(1).max(25).default(10),
})

// An owner or admin of an active room makes an invite link. The token is
// shown once, in the link; only its hash is stored
export async function createInvite(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await allow(`rooms:invite:${user.id}`, 20, 86_400))) return TOO_MANY
  const days = await roomLimit("rooms.inviteDays")
  const { token, hash } = newInviteToken()
  const invite = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ role: sql<string | null>`kriya.room_role(${rooms.id})` })
      .from(rooms)
      .where(and(eq(rooms.id, parsed.data.roomId), eq(rooms.status, "active")))
    if (!room || (room.role !== "owner" && room.role !== "admin")) return null
    const [row] = rowsOf<{ id: string; expires_at: string | Date }>(
      await tx.execute(
        sql`insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
            values (${parsed.data.roomId}, ${user.id}, ${hash}, ${parsed.data.maxUses},
                    now() + make_interval(days => ${days}))
            returning id, expires_at`
      )
    )
    return row
  })
  if (!invite) return NOT_FOUND
  return {
    ok: true as const,
    inviteId: invite.id,
    url: `${appUrl()}/rooms/join/${token}`,
    expiresAt: new Date(invite.expires_at).toISOString(),
  }
}

export async function revokeInvite(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, inviteId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  // RLS lets only the room's owner and admins see or revoke its invites
  const revoked = await withUser(user.id, (tx) =>
    tx
      .update(roomInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(roomInvites.id, parsed.data.inviteId),
          eq(roomInvites.roomId, parsed.data.roomId),
          isNull(roomInvites.revokedAt)
        )
      )
      .returning({ id: roomInvites.id })
  )
  return revoked.length ? { ok: true as const } : { error: "Invite not found." }
}

// Joining through an invite link's token (/rooms/join/<token>)
export async function joinRoom(token: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  if (!(await allow(`rooms:join:ip:${await clientIp()}`, 10, 3600))) return TOO_MANY
  const parsed = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .safeParse(token)
  if (!parsed.success) return BAD_INVITE
  const maxHumans = await roomLimit("rooms.maxHumans")
  try {
    const roomId = await withUser(user.id, async (tx) => {
      // R9 (RD-18): blocked people can't invite you, either way round
      const [block] = rowsOf<{ b: string | null }>(
        await tx.execute(
          sql`select kriya.invite_blocked(${hashInviteToken(parsed.data)}) as b`
        )
      )
      if (block?.b === "joiner") throw new BlockedInvite()
      if (block?.b === "maker") throw new Error("this invite is not valid")
      const [row] = rowsOf<{ room_id: string }>(
        await tx.execute(
          sql`select kriya.join_room(${hashInviteToken(parsed.data)}, ${maxHumans}) as room_id`
        )
      )
      // Joining again while a member adds nothing, so only a new room can go over
      const max = await overRoomLimit(tx, user.id)
      if (max !== null) throw new OverRoomLimit(String(max))
      return row.room_id
    })
    return { ok: true as const, roomId }
  } catch (error) {
    if (error instanceof OverRoomLimit) return roomLimitError(Number(error.message))
    if (error instanceof BlockedInvite) {
      return {
        error:
          "You blocked the person who made this invite. Unblock them in Rooms to join.",
      }
    }
    return refusal(error)
  }
}

class BlockedInvite extends Error {}

export async function leaveRoom(roomId: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = id.safeParse(roomId)
  if (!parsed.success) return INVALID
  try {
    const left = await withUser(user.id, async (tx) => {
      // The person's agents leave with them (R4)
      await tx
        .update(roomAgents)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(roomAgents.roomId, parsed.data),
            eq(roomAgents.ownerId, user.id),
            isNull(roomAgents.removedAt)
          )
        )
      return tx
        .update(roomMembers)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(roomMembers.roomId, parsed.data),
            eq(roomMembers.userId, user.id),
            isNull(roomMembers.leftAt)
          )
        )
        .returning({ roomId: roomMembers.roomId })
    })
    return left.length ? { ok: true as const } : NOT_FOUND
  } catch (error) {
    return refusal(error)
  }
}

// An owner or admin makes another member an admin, or a member again. RLS
// filters the update for anyone else; nobody becomes or replaces the owner
export async function setMemberRole(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z
    .object({ roomId: id, userId: id, role: z.enum(["admin", "member"]) })
    .safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId, userId, role } = parsed.data
  if (userId === user.id) return { error: "Member not found." }
  try {
    const result = await withUser(user.id, async (tx) => {
      const [target] = await tx
        .select({ role: roomMembers.role })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, userId),
            isNull(roomMembers.leftAt)
          )
        )
      if (!target) return "missing"
      if (target.role === "owner") return "owner"
      const changed = await tx
        .update(roomMembers)
        .set({ role })
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, userId),
            isNull(roomMembers.leftAt)
          )
        )
        .returning({ userId: roomMembers.userId })
      return changed.length ? "ok" : "missing"
    })
    if (result === "owner") return { error: "The room's owner keeps their role." }
    return result === "ok" ? { ok: true as const } : { error: "Member not found." }
  } catch (error) {
    return refusal(error)
  }
}

// An owner or admin removes someone else; they can't join again (join_room).
// The member guard refuses removing the owner and anyone acting as another
export async function removeMember(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, userId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId, userId } = parsed.data
  if (userId === user.id) return { error: "Member not found." }
  try {
    const result = await withUser(user.id, async (tx) => {
      const [target] = await tx
        .select({ role: roomMembers.role })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, userId),
            isNull(roomMembers.leftAt)
          )
        )
      if (!target) return "missing"
      if (target.role === "owner") return "owner"
      // RLS filters out the update unless the caller is an owner or admin
      const removed = await tx
        .update(roomMembers)
        .set({ leftAt: new Date(), removedBy: user.id })
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
        .returning({ userId: roomMembers.userId })
      return removed.length ? "ok" : "missing"
    })
    if (result === "owner") return { error: "The room's owner can't be removed." }
    if (result !== "ok") return { error: "Member not found." }
    // Their agents leave with them (R4), after the removal above passed RLS
    await removeAgentsOf(roomId, userId)
    return { ok: true as const }
  } catch (error) {
    return refusal(error)
  }
}

const agentId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

const postSchema = z.object({
  roomId: id,
  body: z.string().trim().min(1).max(8000),
  // Agents the person picked with @ (R4), by id; at most three are asked
  mentions: z.array(agentId).max(10).optional(),
  // People picked with @, told through the in-app notifier (PX-03)
  people: z.array(id).max(10).optional(),
  // An agent's message with a proof card this one answers (R5)
  replyTo: id.optional(),
})

// A person's message, as themselves (the insert policy allows nothing else);
// the database numbers it. Mentions of the room's agents are stored by id
// and, with rooms.agents on, asked after the commit (lib/rooms/invoke.ts)
export async function postMessage(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = postSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await allow(`rooms:post:${user.id}`, 30, 60))) return TOO_MANY
  const asking = parsed.data.mentions?.length ? await roomAgentsOn() : false
  const result = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ status: rooms.status })
      .from(rooms)
      .where(
        and(eq(rooms.id, parsed.data.roomId), sql`kriya.is_room_member(${rooms.id})`)
      )
    if (!room) return NOT_FOUND
    if (room.status !== "active") return { error: "This room is archived." }
    // Only agents active in this room count as mentions
    const mentioned = asking
      ? (
          await tx
            .select({ agentId: roomAgents.agentId })
            .from(roomAgents)
            .where(
              and(
                eq(roomAgents.roomId, parsed.data.roomId),
                inArray(roomAgents.agentId, parsed.data.mentions!),
                isNull(roomAgents.removedAt)
              )
            )
        )
          .map((row) => row.agentId)
          .sort(
            (a, b) => parsed.data.mentions!.indexOf(a) - parsed.data.mentions!.indexOf(b)
          )
          .slice(0, MAX_AGENT_MENTIONS)
      : []
    // Only active members, never the person themselves
    const people = parsed.data.people?.length
      ? (
          await tx
            .select({ userId: roomMembers.userId })
            .from(roomMembers)
            .where(
              and(
                eq(roomMembers.roomId, parsed.data.roomId),
                inArray(roomMembers.userId, parsed.data.people),
                isNull(roomMembers.leftAt)
              )
            )
        )
          .map((row) => row.userId)
          .filter((userId) => userId !== user.id)
      : []
    // A reply goes only to a card in this room
    if (parsed.data.replyTo) {
      const [card] = await tx
        .select({ id: roomMessages.id })
        .from(roomMessages)
        .where(
          and(
            eq(roomMessages.id, parsed.data.replyTo),
            eq(roomMessages.roomId, parsed.data.roomId),
            eq(roomMessages.authorKind, "agent"),
            isNull(roomMessages.deletedAt),
            sql`${roomMessages.parts} ? 'proof'`
          )
        )
      if (!card) return { error: "That card isn't in this room any more." }
    }
    const mentions = [
      ...mentioned.map((agent) => ({ kind: "agent", id: agent })),
      ...people.map((person) => ({ kind: "person", id: person })),
    ]
    const parts = {
      ...(mentions.length > 0 && { mentions }),
      ...(parsed.data.replyTo && { replyTo: parsed.data.replyTo }),
    }
    const [message] = rowsOf<{ id: string; seq: string | number }>(
      await tx.execute(
        sql`insert into kriya.room_messages (room_id, author_kind, user_id, body, parts)
            values (${parsed.data.roomId}, 'human', ${user.id}, ${parsed.data.body},
                    ${JSON.stringify(parts)}::jsonb)
            returning id, seq`
      )
    )
    const seq = Number(message.seq)
    // Your own message is read
    await tx
      .update(roomMembers)
      .set({ lastReadSeq: sql`greatest(${roomMembers.lastReadSeq}, ${seq}::bigint)` })
      .where(
        and(eq(roomMembers.roomId, parsed.data.roomId), eq(roomMembers.userId, user.id))
      )
    return { ok: true as const, messageId: message.id, seq, mentioned }
  })
  if (!("ok" in result)) return result
  const { mentioned, ...posted } = result
  // After the commit: a content-free ping (RD-10); it never fails the post
  await pingRoom(parsed.data.roomId, posted.seq)
  // Then the agents it asks; refusals are system lines, never an error here
  if (mentioned.length > 0) {
    await invokeMentions({
      roomId: parsed.data.roomId,
      messageId: posted.messageId,
      seq: posted.seq,
      requester: user.id,
      request: parsed.data.body,
      agentIds: mentioned,
    })
  }
  return posted
}

/* ───────────────────────── agents in rooms (R4) ───────────────────── */

const AGENTS_OFF = { error: "Agents aren't available in rooms." }

// A person adds one of their own agents: a bridge thread in their account
// ("Room · <title>") where its room requests run, and a room_agents row
// (RD-03). Adding it again after removing it reuses its bridge thread
export async function addRoomAgent(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  if (!(await roomAgentsOn())) return AGENTS_OFF
  const parsed = z.object({ roomId: id, agentId }).safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId } = parsed.data
  const max = await roomLimit("rooms.maxAgents")
  const result = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ title: rooms.title, status: rooms.status })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), sql`kriya.is_room_member(${rooms.id})`))
    if (!room) return NOT_FOUND
    if (room.status !== "active") return { error: "This room is archived." }
    // RLS: only the person's own agents
    const [agent] = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, user.id)))
    if (!agent) return { error: "Agent not found." }
    const [existing] = await tx
      .select({ removedAt: roomAgents.removedAt, ownerId: roomAgents.ownerId })
      .from(roomAgents)
      .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agent.id)))
    if (existing && !existing.removedAt) return { ok: true as const, added: null }
    const [active] = await tx
      .select({ n: count() })
      .from(roomAgents)
      .where(and(eq(roomAgents.roomId, roomId), isNull(roomAgents.removedAt)))
    if (active.n >= max) {
      return { error: `A room can have at most ${max} agents.` }
    }
    if (existing) {
      await tx
        .update(roomAgents)
        .set({ removedAt: null })
        .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agent.id)))
    } else {
      const threadId = nanoid(12)
      await tx.execute(
        sql`insert into kriya.threads (id, user_id, agent_id, title)
            values (${threadId}, ${user.id}, ${agent.id}, ${`Room · ${room.title}`})`
      )
      await tx.execute(
        sql`insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id)
            values (${roomId}, ${agent.id}, ${user.id}, ${threadId})`
      )
    }
    return { ok: true as const, added: agent.name }
  })
  if (!("ok" in result)) return result
  if (result.added) {
    const names = await roomNames([{ userId: user.id, agentId: null }])
    await postSystemLine(
      roomId,
      `${names.person(user.id)} added ${result.added} to the room.`
    )
  }
  return { ok: true as const }
}

export async function removeRoomAgent(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, agentId }).safeParse(input)
  if (!parsed.success) return INVALID
  // RLS: only the agent's owner changes its row
  const removed = await withUser(user.id, (tx) =>
    tx
      .update(roomAgents)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(roomAgents.roomId, parsed.data.roomId),
          eq(roomAgents.agentId, parsed.data.agentId),
          eq(roomAgents.ownerId, user.id),
          isNull(roomAgents.removedAt)
        )
      )
      .returning({ agentId: roomAgents.agentId })
  )
  if (!removed.length) return { error: "Agent not found." }
  const names = await roomNames([{ userId: user.id, agentId: parsed.data.agentId }])
  await postSystemLine(
    parsed.data.roomId,
    `${names.agent(user.id, parsed.data.agentId)} left the room.`
  )
  return { ok: true as const }
}

// Who may ask the agent (RD-04): only its owner, or the room's members up
// to a daily cap in whole rupees that SQL enforces. And whether the owner's
// connected accounts are on its belt in this room (RD-05)
const policySchema = z.object({
  roomId: id,
  agentId,
  invoke: z.enum(["owner_only", "members"]),
  dailyCapRupees: z.number().int().min(1).max(100_000).optional(),
  allowConnectors: z.boolean(),
})

export async function setRoomAgentPolicy(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = policySchema.safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId, invoke, dailyCapRupees, allowConnectors } = parsed.data
  if (invoke === "members" && !dailyCapRupees) {
    return { error: "Set a daily limit before letting others ask your agent." }
  }
  const changed = await withUser(user.id, (tx) =>
    tx
      .update(roomAgents)
      .set({
        invoke,
        // Money is integers: whole rupees to micro-INR
        ...(dailyCapRupees && { dailyCapMicroInr: dailyCapRupees * 1_000_000 }),
        allowConnectors,
      })
      .where(
        and(
          eq(roomAgents.roomId, roomId),
          eq(roomAgents.agentId, parsed.data.agentId),
          eq(roomAgents.ownerId, user.id),
          isNull(roomAgents.removedAt)
        )
      )
      .returning({ agentId: roomAgents.agentId })
  )
  if (!changed.length) return { error: "Agent not found." }
  return { ok: true as const }
}

// Share in room (RD-06): the owner posts exactly the reply that was held,
// as their agent, if the room, their membership and the agent are still
// there. Only the owner can answer (RLS on room_disclosures)
export async function shareDisclosure(disclosureId: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = id.safeParse(disclosureId)
  if (!parsed.success) return INVALID
  const held = await withUser(user.id, async (tx) => {
    const [row] = await tx
      .select({
        roomId: roomDisclosures.roomId,
        agentId: roomDisclosures.agentId,
        taskId: roomDisclosures.taskId,
        body: roomDisclosures.body,
        parts: roomDisclosures.parts,
      })
      .from(roomDisclosures)
      .where(
        and(
          eq(roomDisclosures.id, parsed.data),
          eq(roomDisclosures.ownerId, user.id),
          eq(roomDisclosures.status, "pending")
        )
      )
    if (!row) return null
    // The room through the membership policies: gone for a person who left
    const [place] = await tx
      .select({ status: rooms.status })
      .from(rooms)
      .innerJoin(
        roomAgents,
        and(
          eq(roomAgents.roomId, rooms.id),
          eq(roomAgents.agentId, row.agentId),
          eq(roomAgents.ownerId, user.id),
          isNull(roomAgents.removedAt)
        )
      )
      .where(and(eq(rooms.id, row.roomId), sql`kriya.is_room_member(${rooms.id})`))
    if (!place || place.status !== "active") return "gone" as const
    await tx
      .update(roomDisclosures)
      .set({ status: "shared", answeredAt: new Date() })
      .where(eq(roomDisclosures.id, parsed.data))
    return row
  })
  if (!held) return { error: "This reply isn't waiting to be shared any more." }
  if (held === "gone") {
    return {
      error: "That room or your agent isn't there any more, so it can't be shared.",
    }
  }
  // Server-written as the agent after the owner's own answer passed RLS,
  // with the card that was held with it (R5)
  const proof = held.parts.proof as ProofCard | undefined
  const seq = await postAgentMessage({
    roomId: held.roomId,
    ownerId: user.id,
    agentId: held.agentId,
    body: held.body ?? "",
    parts: { disclosureId: parsed.data, ...(proof && { proof }) },
    taskId: held.taskId,
  })
  // A shared reply to a card can verify it, as a posted one does
  const verifies = held.parts.verifies
  if (typeof verifies === "string" && held.taskId) {
    const names = await roomNames([{ userId: user.id, agentId: held.agentId }])
    await markVerified({
      roomId: held.roomId,
      cardMessageId: verifies,
      verifier: (await episodeOf(held.taskId))?.done ?? [],
      agentId: held.agentId,
      agentName: names.agent(user.id, held.agentId),
      ownerName: names.person(user.id),
    })
  }
  // R6: the agents the shared reply names take their turns, as for a posted one
  const invocationId = held.parts.invocationId
  await conduct({
    roomId: held.roomId,
    invocationId: typeof invocationId === "string" ? invocationId : null,
    agentId: held.agentId,
    ownerId: user.id,
    text: held.body ?? "",
    seq,
  })
  return { ok: true as const }
}

// Stop agents (R6, RD-12): any member pauses every agent in the room for
// ten minutes (no follow-ons, no new requests), and the person's own agents
// stop what they're doing here. Other owners' running tasks are theirs to
// stop: nobody acts in another person's account
export async function stopAgents(roomId: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  if (!(await roomAgentsOn())) return AGENTS_OFF
  const parsed = id.safeParse(roomId)
  if (!parsed.success) return INVALID
  if (!(await allow(`rooms:stop:${user.id}`, 10, 3600))) return TOO_MANY
  // Membership through RLS, and the person's own agents' bridge threads
  const mine = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ status: rooms.status })
      .from(rooms)
      .where(and(eq(rooms.id, parsed.data), sql`kriya.is_room_member(${rooms.id})`))
    if (!room || room.status !== "active") return null
    return tx
      .select({ bridge: roomAgents.bridgeThreadId })
      .from(roomAgents)
      .where(
        and(
          eq(roomAgents.roomId, parsed.data),
          eq(roomAgents.ownerId, user.id),
          isNull(roomAgents.removedAt)
        )
      )
  })
  if (!mine) return NOT_FOUND
  const until = await pauseAgents(parsed.data)
  if (!until) return NOT_FOUND
  for (const { bridge } of mine) await cancelThreadTask(user.id, bridge)
  const names = await roomNames([{ userId: user.id, agentId: null }])
  await postSystemLine(
    parsed.data,
    `${names.person(user.id)} stopped the agents for 10 minutes.`,
    { kind: "stopped" }
  )
  return { ok: true as const, until: until.toISOString() }
}

/* ──────────────────────────── notes (R8) ───────────────────────────── */

// RD-14: members add notes as themselves; an agent's note waits for a
// member's confirmation (as themselves) before agents see it; a person
// deletes only their own note. RLS and the column grants enforce each
const NOTE_NOT_FOUND = { error: "Note not found." }

export async function addRoomNote(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z
    .object({ roomId: id, body: z.string().trim().min(1).max(1000) })
    .safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await allow(`rooms:note:${user.id}`, 30, 3600))) return TOO_MANY
  const added = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ status: rooms.status })
      .from(rooms)
      .where(
        and(eq(rooms.id, parsed.data.roomId), sql`kriya.is_room_member(${rooms.id})`)
      )
    if (!room || room.status !== "active") return false
    // Written out in SQL: the column grants allow only these columns
    await tx.execute(
      sql`insert into kriya.room_notes (room_id, body, author_kind, user_id)
          values (${parsed.data.roomId}, ${parsed.data.body}, 'human', ${user.id})`
    )
    return true
  })
  return added ? { ok: true as const } : NOT_FOUND
}

export async function confirmRoomNote(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, noteId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  const confirmed = await withUser(user.id, (tx) =>
    tx
      .update(roomNotes)
      .set({ confirmedBy: user.id, confirmedAt: new Date() })
      .where(
        and(
          eq(roomNotes.id, parsed.data.noteId),
          eq(roomNotes.roomId, parsed.data.roomId),
          eq(roomNotes.authorKind, "agent"),
          isNull(roomNotes.confirmedBy),
          isNull(roomNotes.deletedAt)
        )
      )
      .returning({ id: roomNotes.id })
  )
  return confirmed.length ? { ok: true as const } : NOTE_NOT_FOUND
}

export async function deleteRoomNote(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, noteId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  const deleted = await withUser(user.id, (tx) =>
    tx
      .update(roomNotes)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(roomNotes.id, parsed.data.noteId),
          eq(roomNotes.roomId, parsed.data.roomId),
          eq(roomNotes.authorKind, "human"),
          eq(roomNotes.userId, user.id),
          isNull(roomNotes.deletedAt)
        )
      )
      .returning({ id: roomNotes.id })
  )
  return deleted.length ? { ok: true as const } : NOTE_NOT_FOUND
}

/* ──────────────────────────── goals (R7) ───────────────────────────── */

// RD-13: members set goals with items; an item closes with a verified
// action on a proof card in the room, or a member's own confirmation ("no
// proof"). The database checks both (room_goal_items_guard); the goal's
// state is computed by lib/rooms/goals.ts after each change
const goalText = z.string().trim().min(1).max(300)
const GOAL_REFUSED = {
  error: "Only a verified action on a proof card in this room can close it.",
}
const GOAL_NOT_FOUND = { error: "Goal not found." }

async function goalLimit(userId: string) {
  return allow(`rooms:goal:${userId}`, 60, 60)
}

export async function createGoal(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z
    .object({
      roomId: id,
      title: z.string().trim().min(1).max(120),
      items: z.array(goalText).min(1).max(20),
    })
    .safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await goalLimit(user.id))) return TOO_MANY
  const { roomId, title, items } = parsed.data
  const goalId = await withUser(user.id, async (tx) => {
    const [room] = await tx
      .select({ status: rooms.status })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), sql`kriya.is_room_member(${rooms.id})`))
    if (!room || room.status !== "active") return null
    // Written out in SQL: the column grants allow only these columns
    const [goal] = rowsOf<{ id: string }>(
      await tx.execute(
        sql`insert into kriya.room_goals (room_id, title, created_by)
            values (${roomId}, ${title}, ${user.id}) returning id`
      )
    )
    for (const [position, text] of items.entries())
      await tx.execute(
        sql`insert into kriya.room_goal_items (goal_id, room_id, text, position, created_by)
            values (${goal.id}, ${roomId}, ${text}, ${position}, ${user.id})`
      )
    return goal.id
  })
  if (!goalId) return NOT_FOUND
  const names = await roomNames([{ userId: user.id, agentId: null }])
  await postSystemLine(roomId, `${names.person(user.id)} set a goal: “${title}”.`, {
    kind: "goal",
    goalId,
  })
  return { ok: true as const, goalId }
}

export async function addGoalItem(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, goalId: id, text: goalText }).safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await goalLimit(user.id))) return TOO_MANY
  const { roomId, goalId, text } = parsed.data
  const added = await withUser(user.id, async (tx) => {
    const [goal] = await tx
      .select({ status: roomGoals.status })
      .from(roomGoals)
      .where(and(eq(roomGoals.id, goalId), eq(roomGoals.roomId, roomId)))
    if (!goal || goal.status === "dropped") return false
    const [{ n }] = await tx
      .select({ n: count() })
      .from(roomGoalItems)
      .where(eq(roomGoalItems.goalId, goalId))
    if (n >= 20) return false
    await tx.execute(
      sql`insert into kriya.room_goal_items (goal_id, room_id, text, position, created_by)
          values (${goalId}, ${roomId}, ${text}, ${n}, ${user.id})`
    )
    return true
  })
  if (!added) return GOAL_NOT_FOUND
  await recomputeGoal(roomId, goalId)
  return { ok: true as const }
}

const itemSchema = z.object({ roomId: id, itemId: id })

// Close an item with proof (a card's verified action) or, without proof, by
// one's own confirmation; or reopen it. The guard refuses anything else
async function changeItem(
  input: unknown,
  change:
    | { kind: "proof"; messageId: string; index: number }
    | { kind: "confirm" }
    | { kind: "reopen" }
) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = itemSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await goalLimit(user.id))) return TOO_MANY
  const { roomId, itemId } = parsed.data
  let item: { goalId: string; text: string } | undefined
  try {
    ;[item] = await withUser(user.id, (tx) =>
      tx
        .update(roomGoalItems)
        .set(
          change.kind === "proof"
            ? {
                proofMessageId: change.messageId,
                proofItem: change.index,
                confirmedBy: null,
              }
            : change.kind === "confirm"
              ? { confirmedBy: user.id, proofMessageId: null, proofItem: null }
              : { confirmedBy: null, proofMessageId: null, proofItem: null }
        )
        .where(and(eq(roomGoalItems.id, itemId), eq(roomGoalItems.roomId, roomId)))
        .returning({ goalId: roomGoalItems.goalId, text: roomGoalItems.text })
    )
  } catch (error) {
    if (/not allowed/.test(`${error} ${(error as { cause?: unknown })?.cause}`))
      return GOAL_REFUSED
    throw error
  }
  if (!item) return { error: "Item not found." }
  const names = await roomNames([{ userId: user.id, agentId: null }])
  const who = names.person(user.id)
  await postSystemLine(
    roomId,
    change.kind === "proof"
      ? `${who} closed “${item.text}” with a verified action on a proof card.`
      : change.kind === "confirm"
        ? `${who} confirmed “${item.text}” without proof.`
        : `${who} reopened “${item.text}”.`,
    { kind: "goal", goalId: item.goalId }
  )
  await recomputeGoal(roomId, item.goalId)
  return { ok: true as const }
}

export async function closeGoalItemWithProof(input: unknown) {
  const parsed = z
    .object({ messageId: id, index: z.number().int().min(0).max(100) })
    .safeParse(input)
  if (!parsed.success) return INVALID
  return changeItem(input, { kind: "proof", ...parsed.data })
}

export async function confirmGoalItem(input: unknown) {
  return changeItem(input, { kind: "confirm" })
}

export async function reopenGoalItem(input: unknown) {
  return changeItem(input, { kind: "reopen" })
}

export async function removeGoalItem(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = itemSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const removed = await withUser(user.id, (tx) =>
    tx
      .delete(roomGoalItems)
      .where(
        and(
          eq(roomGoalItems.id, parsed.data.itemId),
          eq(roomGoalItems.roomId, parsed.data.roomId)
        )
      )
      .returning({ goalId: roomGoalItems.goalId })
  )
  if (!removed.length) return { error: "Item not found." }
  await recomputeGoal(parsed.data.roomId, removed[0].goalId)
  return { ok: true as const }
}

// The room's owner or an admin, or whoever set the goal, drops it
export async function dropRoomGoal(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, goalId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId, goalId } = parsed.data
  const allowed = await withUser(user.id, async (tx) => {
    const [goal] = await tx
      .select({
        createdBy: roomGoals.createdBy,
        role: sql<string | null>`kriya.room_role(${roomGoals.roomId})`,
      })
      .from(roomGoals)
      .where(and(eq(roomGoals.id, goalId), eq(roomGoals.roomId, roomId)))
    return (
      !!goal &&
      (goal.createdBy === user.id || goal.role === "owner" || goal.role === "admin")
    )
  })
  if (!allowed) return GOAL_NOT_FOUND
  const names = await roomNames([{ userId: user.id, agentId: null }])
  return (await dropGoal(roomId, goalId, names.person(user.id)))
    ? { ok: true as const }
    : GOAL_NOT_FOUND
}

// Discard: nothing reaches the room
export async function discardDisclosure(disclosureId: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = id.safeParse(disclosureId)
  if (!parsed.success) return INVALID
  const discarded = await withUser(user.id, (tx) =>
    tx
      .update(roomDisclosures)
      .set({ status: "discarded", answeredAt: new Date() })
      .where(
        and(
          eq(roomDisclosures.id, parsed.data),
          eq(roomDisclosures.ownerId, user.id),
          eq(roomDisclosures.status, "pending")
        )
      )
      .returning({ id: roomDisclosures.id })
  )
  if (!discarded.length)
    return { error: "This reply isn't waiting to be shared any more." }
  return { ok: true as const }
}

// A person deletes their own message: its text is hidden from everyone
// (readMessages), its place in the room stays
export async function deleteMessage(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, messageId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  // RLS and the grant allow exactly deleted_at on one's own human messages
  const deleted = await withUser(user.id, (tx) =>
    tx
      .update(roomMessages)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(roomMessages.id, parsed.data.messageId),
          eq(roomMessages.roomId, parsed.data.roomId),
          eq(roomMessages.userId, user.id),
          isNull(roomMessages.deletedAt)
        )
      )
      .returning({ id: roomMessages.id })
  )
  return deleted.length ? { ok: true as const } : { error: "Message not found." }
}

// The owner or an admin archives a room: it stays readable, takes no messages
export async function archiveRoom(roomId: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = id.safeParse(roomId)
  if (!parsed.success) return INVALID
  // The update policy lets only the room's owner and admins through
  const archived = await withUser(user.id, (tx) =>
    tx
      .update(rooms)
      .set({ status: "archived" })
      .where(and(eq(rooms.id, parsed.data), eq(rooms.status, "active")))
      .returning({ id: rooms.id })
  )
  return archived.length ? { ok: true as const } : NOT_FOUND
}

/* ─────────────────────── block and report (R9) ─────────────────────── */

// RD-18: a person blocks someone they share a room with (their own list,
// RLS), and unblocks anyone on it. Blocking keeps the other out of rooms
// through invites either way round, stops them asking the blocker's agents
// and collapses their messages for the blocker
export async function blockPerson(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ userId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  if (parsed.data.userId === user.id) return { error: "You can't block yourself." }
  if (!(await allow(`rooms:block:${user.id}`, 30, 3600))) return TOO_MANY
  const blocked = await withUser(user.id, async (tx) => {
    // RLS shows members only of rooms the person is in
    const [shared] = await tx
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(eq(roomMembers.userId, parsed.data.userId))
      .limit(1)
    if (!shared) return false
    await tx.execute(
      sql`insert into kriya.person_blocks (blocker_id, blocked_id)
          values (${user.id}, ${parsed.data.userId}) on conflict do nothing`
    )
    return true
  })
  return blocked ? { ok: true as const } : { error: "Member not found." }
}

export async function unblockPerson(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ userId: id }).safeParse(input)
  if (!parsed.success) return INVALID
  const removed = await withUser(user.id, (tx) =>
    tx
      .delete(personBlocks)
      .where(
        and(
          eq(personBlocks.blockerId, user.id),
          eq(personBlocks.blockedId, parsed.data.userId)
        )
      )
      .returning({ blockedId: personBlocks.blockedId })
  )
  return removed.length ? { ok: true as const } : { error: "Not blocked." }
}

// The same list as components/rooms/report-dialog.tsx and the table's check
const REPORT_REASONS = ["spam", "harassment", "unsafe", "private_info", "other"] as const

// A member reports the room or one of its messages to the Kriya owner
// console. The database copies the message (room_reports_fill) and allows
// one open report per person and message
export async function reportRoom(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z
    .object({
      roomId: id,
      messageId: id.optional(),
      reason: z.enum(REPORT_REASONS),
      note: z.string().trim().max(500).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return INVALID
  if (!(await allow(`rooms:report:${user.id}`, 10, 86_400))) return TOO_MANY
  const { roomId, messageId, reason, note } = parsed.data
  try {
    const reported = await withUser(user.id, async (tx) => {
      const [room] = await tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.id, roomId), sql`kriya.is_room_member(${rooms.id})`))
      if (!room) return false
      await tx.execute(
        sql`insert into kriya.room_reports (room_id, message_id, reporter_id, reason, note)
            values (${roomId}, ${messageId ?? null}, ${user.id}, ${reason}, ${note || null})`
      )
      return true
    })
    return reported ? { ok: true as const } : NOT_FOUND
  } catch (error) {
    const text = `${error} ${(error as { cause?: unknown })?.cause}`
    if (/room_reports_once|duplicate key/.test(text)) {
      return { error: "You've already reported this. Kriya will look at it." }
    }
    if (/not in this room/.test(text)) return { error: "Message not found." }
    throw error
  }
}

// The Kriya owner closes a report as reviewed or dismissed, or archives the
// reported room (it stays readable to its members and takes no messages;
// the room's own owner can't undo it). Owner-only, audited
export async function reviewRoomReport(input: unknown) {
  const owner = await requireOwner()
  const parsed = z
    .object({ reportId: id, outcome: z.enum(["reviewed", "dismissed", "archive"]) })
    .safeParse(input)
  if (!parsed.success) return INVALID
  const { reportId, outcome } = parsed.data
  if (!(await closeReport(owner.id, reportId, outcome))) {
    return { error: "That report isn't open any more." }
  }
  await audit(owner.id, `room_report.${outcome}`, { type: "room_report", id: reportId })
  revalidatePath("/owner/rooms")
  return { ok: true as const }
}

// The sidebar's and palette's way to know rooms exist (RT-UI-01): null with
// rooms.enabled off, before any room query; otherwise the unread count
export async function roomsEntry() {
  const user = await requireUser()
  if (!(await roomsEnabled())) return null
  const [row] = await withUser(user.id, (tx) =>
    tx
      .select({
        unread: sql<number>`coalesce(sum(greatest(${rooms.lastSeq} - ${roomMembers.lastReadSeq}, 0)), 0)::int`,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.userId, user.id), isNull(roomMembers.leftAt)))
  )
  return { unread: Number(row?.unread ?? 0) }
}

// Moves the person's read marker forward, never past the room's last message
export async function markRead(input: unknown) {
  const user = await requireUser()
  if (!(await roomsEnabled())) return NOT_FOUND
  const parsed = z.object({ roomId: id, seq: z.number().int().min(0) }).safeParse(input)
  if (!parsed.success) return INVALID
  const { roomId, seq } = parsed.data
  const marked = await withUser(user.id, (tx) =>
    tx
      .update(roomMembers)
      .set({
        lastReadSeq: sql`greatest(${roomMembers.lastReadSeq}, least(${seq}::bigint, (select r.last_seq from kriya.rooms r where r.id = ${roomId})))`,
      })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, user.id),
          isNull(roomMembers.leftAt)
        )
      )
      .returning({ roomId: roomMembers.roomId })
  )
  return marked.length ? { ok: true as const } : NOT_FOUND
}
