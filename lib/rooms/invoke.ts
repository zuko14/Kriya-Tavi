import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import {
  agents,
  approvals,
  personBlocks,
  roomAgents,
  roomMessages,
  rooms,
} from "@/db/schema"
import { enqueueRoomTurn, TurnError } from "@/lib/agent/queue"
import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"
import { postSystemLine, roomAgentsOn } from "@/lib/rooms/agents"
import { bridgeMessage } from "@/lib/rooms/context"
import { roomNames } from "@/lib/rooms/names"
import { confirmedNotes } from "@/lib/rooms/notes"
import { cardRequest, type ProofCard } from "@/lib/rooms/proof"

// Mentions become agent turns (track R, R4; CONVERSATION_PROTOCOL §2,
// RD-03, RD-04, RD-08). Code decides, never a model: the agent must be in
// the room with its owner still a member, and kriya.check_room_invocation
// must allow the requester (owner, or the members policy under the daily
// cap; one request at a time; the room not paused). Allowed → a task in the
// owner's account, in the agent's bridge thread, charged to the owner.
// Refused → a plain system line, no task. Called after the person's message
// is committed; with rooms.agents off it does nothing.

export const MAX_AGENT_MENTIONS = 3

// Queued invocations a crash left without a task close after this long
const STALE_QUEUED = "10 minutes"

const REFUSAL: Record<string, (agent: string, owner: string) => string> = {
  owner_only: (agent, owner) => `${agent} answers only to ${owner}.`,
  over_cap: (agent) => `${agent} has reached today's limit for this room.`,
  busy: (agent) => `${agent} is still working on the last request.`,
  approval: (agent, owner) => `${agent} is waiting for ${owner} to approve an action.`,
  paused: () => "Agents are paused in this room for now.",
  agent_not_in_room: (agent) => `${agent} isn't in this room any more.`,
  not_member: () => "Only members of this room can ask its agents.",
  // R9: the owner blocked the requester; the line doesn't say so
  blocked: (agent) => `${agent} can't take this request.`,
  // The owner's plan limits or Kriya being unavailable: no detail about the
  // owner's account reaches the room (RD-17)
  unavailable: (agent) => `${agent} can't take requests right now. Try again later.`,
}

type Outcome = { agentId: string; status: "dispatched" | "refused" | "failed" }

export async function invokeMentions({
  roomId,
  messageId,
  seq,
  requester,
  request,
  agentIds,
  chain,
}: {
  roomId: string
  // The person's message that mentions the agents, already committed; for
  // a follow-on, the message that started the chain
  messageId: string
  // The room is quoted up to (not including) this message
  seq: number
  // The person, or for a follow-on the person who started the chain: the
  // agents' policies are checked against them (RT-CND-03)
  requester: string
  request: string
  // Validated against the room's agents by the caller, at most three
  agentIds: string[]
  // R6: a follow-on from the conductor: its depth, and the asking agent
  chain?: { depth: number; asker: string }
}): Promise<Outcome[]> {
  if (agentIds.length === 0 || !(await roomAgentsOn())) return []
  const [room] = await privileged
    .select({ title: rooms.title, status: rooms.status })
    .from(rooms)
    .where(eq(rooms.id, roomId))
  if (!room || room.status !== "active") return []
  const members = await privileged
    .select({
      agentId: roomAgents.agentId,
      ownerId: roomAgents.ownerId,
      bridge: roomAgents.bridgeThreadId,
      name: agents.name,
      ownerIn: sql<boolean>`exists (select 1 from kriya.room_members m
        where m.room_id = ${roomAgents.roomId} and m.user_id = ${roomAgents.ownerId}
          and m.left_at is null)`,
    })
    .from(roomAgents)
    .innerJoin(
      agents,
      and(eq(agents.id, roomAgents.agentId), eq(agents.userId, roomAgents.ownerId))
    )
    .where(
      and(
        eq(roomAgents.roomId, roomId),
        inArray(roomAgents.agentId, agentIds.slice(0, MAX_AGENT_MENTIONS)),
        isNull(roomAgents.removedAt)
      )
    )
  const names = await roomNames([
    { userId: requester, agentId: null },
    ...members.map((m) => ({ userId: m.ownerId, agentId: null })),
  ])

  const answered = await cardRepliedTo(roomId, messageId)
  const depth = chain?.depth ?? 0
  const outcomes: Outcome[] = []
  for (const agent of members) {
    const owner = names.person(agent.ownerId)
    const refuse = async (reason: string, status: "refused" | "failed" = "refused") => {
      await privileged.execute(
        sql`insert into kriya.room_invocations
              (room_id, agent_id, owner_id, requested_by, message_id, chain_depth, status, reason)
            values (${roomId}, ${agent.agentId}, ${agent.ownerId}, ${requester},
                    ${messageId}, ${depth}, ${status}, ${reason})`
      )
      await postSystemLine(
        roomId,
        (REFUSAL[reason] ?? REFUSAL.unavailable)(agent.name, owner)
      )
      outcomes.push({ agentId: agent.agentId, status })
    }
    try {
      if (!agent.ownerIn) {
        await refuse("agent_not_in_room")
        continue
      }
      await closeEnded(roomId, agent.agentId)
      // RD-08: an action waiting for the owner's approval is the request still open
      const [waiting] = await privileged
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.userId, agent.ownerId),
            eq(approvals.threadId, agent.bridge),
            eq(approvals.status, "pending"),
            sql`${approvals.expiresAt} > now()`
          )
        )
        .limit(1)
      if (waiting) {
        await refuse("approval")
        continue
      }
      // R9 (RD-18): nobody the owner blocked asks their agents
      const [block] = await privileged
        .select({ id: personBlocks.blockedId })
        .from(personBlocks)
        .where(
          and(
            eq(personBlocks.blockerId, agent.ownerId),
            eq(personBlocks.blockedId, requester)
          )
        )
      if (block) {
        await refuse("blocked")
        continue
      }
      const [check] = rowsOf<{ reason: string }>(
        await privileged.execute(
          sql`select kriya.check_room_invocation(${roomId}, ${agent.agentId}, ${requester},
                (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
              ) as reason`
        )
      )
      if (check.reason !== "ok") {
        await refuse(check.reason)
        continue
      }
      // Queued first: it holds the agent's one request (RD-08) while the task is made
      const [invocation] = rowsOf<{ id: string }>(
        await privileged.execute(
          sql`insert into kriya.room_invocations
                (room_id, agent_id, owner_id, requested_by, message_id, chain_depth, status)
              values (${roomId}, ${agent.agentId}, ${agent.ownerId}, ${requester},
                      ${messageId}, ${depth}, 'queued')
              returning id`
        )
      )
      const prompt = bridgeMessage({
        title: room.title,
        // A follow-on names the asking agent (CONVERSATION_PROTOCOL §7)
        requester: chain ? chain.asker : names.person(requester),
        byOwner: !chain && requester === agent.ownerId,
        recent: await recentLines(roomId, seq),
        // R8: members' notes and agents' notes a member confirmed
        notes: await confirmedNotes(roomId),
        // R5: a reply to a card asks the agent to check the card's claims
        request: answered
          ? `${request}\n\n${cardRequest(answered.agentName, answered.proof)}`
          : request,
      })
      try {
        const task = await enqueueRoomTurn({
          userId: agent.ownerId,
          threadId: agent.bridge,
          agentId: agent.agentId,
          prompt,
          invocationId: invocation.id,
          roomId,
          requestedBy: requester,
        })
        await privileged.execute(
          sql`update kriya.room_invocations set status = 'dispatched', task_id = ${task.id}
              where id = ${invocation.id}`
        )
        await postSystemLine(roomId, `${agent.name} is working…`)
        outcomes.push({ agentId: agent.agentId, status: "dispatched" })
      } catch (error) {
        if (!(error instanceof TurnError)) throw error
        const busy = error.status === 409
        await privileged.execute(
          sql`update kriya.room_invocations
              set status = ${busy ? "refused" : "failed"}, reason = ${busy ? "busy" : error.code}
              where id = ${invocation.id}`
        )
        await postSystemLine(
          roomId,
          (busy ? REFUSAL.busy : REFUSAL.unavailable)(agent.name, owner)
        )
        outcomes.push({ agentId: agent.agentId, status: busy ? "refused" : "failed" })
      }
    } catch (error) {
      // One agent's failure never loses the person's message or the others
      log.error("rooms: invocation failed", { roomId, agentId: agent.agentId, error })
    }
  }
  return outcomes
}

// Invocations whose task has already ended without the relay closing them
// (expired in the queue, failed by recovery) stop holding the agent's slot
async function closeEnded(roomId: string, agentId: string) {
  await privileged.execute(
    sql`update kriya.room_invocations i
        set status = case when t.status = 'succeeded' then 'done' else 'failed' end
        from kriya.tasks t
        where i.task_id = t.id and i.room_id = ${roomId} and i.agent_id = ${agentId}
          and i.status in ('queued', 'dispatched')
          and t.status in ('succeeded', 'failed', 'canceled')`
  )
  await privileged.execute(
    sql`update kriya.room_invocations set status = 'failed', reason = 'stale'
        where room_id = ${roomId} and agent_id = ${agentId} and status = 'queued'
          and task_id is null and created_at < now() - ${STALE_QUEUED}::interval`
  )
}

// The room as the agent sees it: the last rooms.contextMessages messages
// before the request, people's and agents', oldest first
async function recentLines(roomId: string, beforeSeq: number) {
  const limit = Number(await getSetting("rooms.contextMessages"))
  const rows = await privileged
    .select({
      userId: roomMessages.userId,
      agentId: roomMessages.agentId,
      body: roomMessages.body,
    })
    .from(roomMessages)
    .where(
      and(
        eq(roomMessages.roomId, roomId),
        lt(roomMessages.seq, beforeSeq),
        isNull(roomMessages.deletedAt),
        ne(roomMessages.authorKind, "system")
      )
    )
    .orderBy(desc(roomMessages.seq))
    .limit(limit)
  const names = await roomNames(rows)
  return rows.reverse().map((row) => ({
    name: row.agentId ? names.agent(row.userId, row.agentId) : names.person(row.userId),
    ...(row.agentId && { owner: names.person(row.userId) }),
    text: row.body ?? "",
  }))
}

// The card the person's message replied to (R5), with its agent's name
async function cardRepliedTo(roomId: string, messageId: string) {
  const [row] = rowsOf<{ user_id: string; agent_id: string; proof: ProofCard }>(
    await privileged.execute(
      sql`select c.user_id, c.agent_id, c.parts -> 'proof' as proof
          from kriya.room_messages m
          join kriya.room_messages c
            on c.id = (m.parts ->> 'replyTo')::uuid and c.room_id = m.room_id
          where m.id = ${messageId} and m.room_id = ${roomId}
            and c.author_kind = 'agent' and c.deleted_at is null
            and c.parts ? 'proof'`
    )
  )
  if (!row) return null
  const names = await roomNames([{ userId: row.user_id, agentId: row.agent_id }])
  return { agentName: names.agent(row.user_id, row.agent_id), proof: row.proof }
}
