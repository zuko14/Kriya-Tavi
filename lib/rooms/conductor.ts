import { and, eq, inArray, isNull } from "drizzle-orm"

import { privileged } from "@/db"
import { agents, roomAgents, roomInvocations, roomMessages } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { postSystemLine } from "@/lib/rooms/agents"
import { invokeMentions, MAX_AGENT_MENTIONS } from "@/lib/rooms/invoke"
import { roomNames } from "@/lib/rooms/names"

// The conductor (track R, R6; RD-12, CONVERSATION_PROTOCOL §7): after an
// agent's reply reaches the room, the room's agents it names with @ take a
// follow-on turn, decided by code, never by a model. Only while the chain
// that one person's message started is under rooms.agentTurnBudget; never
// the agent that just spoke; never when the reply repeats one earlier in
// the chain; and only when the named agent's policy allows the person who
// started the chain (check_room_invocation, which also honours Stop
// agents). Called by the relay (posted replies) and by Share in room.
// No server-only marker: the worker runs it.

// What a reply says, without who it's addressed to or how it's spaced
export function normalizeReply(text: string) {
  return text
    .toLowerCase()
    .replace(/@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

// Room agents named as @Name in the text: whole names, a name two agents
// share is skipped (it can't say which), the speaking agent left out
export function namedAgents(
  text: string,
  roster: { agentId: string; name: string }[],
  speaker: string
) {
  const count = new Map<string, number>()
  for (const a of roster)
    count.set(a.name.toLowerCase(), (count.get(a.name.toLowerCase()) ?? 0) + 1)
  const named = roster.filter((a) => {
    if (a.agentId === speaker || count.get(a.name.toLowerCase())! > 1) return false
    const escaped = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(
      text
    )
  })
  return named.slice(0, MAX_AGENT_MENTIONS)
}

export async function conduct({
  roomId,
  invocationId,
  agentId,
  ownerId,
  text,
  seq,
}: {
  roomId: string
  // The invocation the reply answered (its chain's first message, depth
  // and the person who started it)
  invocationId: string | null
  agentId: string
  ownerId: string
  text: string
  // The reply's place in the room: the follow-on quotes the room up to it
  seq: number
}) {
  if (!invocationId) return []
  const [step] = await privileged
    .select({
      messageId: roomInvocations.messageId,
      requestedBy: roomInvocations.requestedBy,
      depth: roomInvocations.chainDepth,
    })
    .from(roomInvocations)
    .where(and(eq(roomInvocations.id, invocationId), eq(roomInvocations.roomId, roomId)))
  // A chain whose first message or person is gone ends here
  if (!step?.messageId || !step.requestedBy) return []

  const roster = await privileged
    .select({ agentId: roomAgents.agentId, name: agents.name })
    .from(roomAgents)
    .innerJoin(
      agents,
      and(eq(agents.id, roomAgents.agentId), eq(agents.userId, roomAgents.ownerId))
    )
    .where(and(eq(roomAgents.roomId, roomId), isNull(roomAgents.removedAt)))
  const named = namedAgents(text, roster, agentId)
  if (named.length === 0) return []

  // RT-CND-01: one person's message sets off at most this many agent turns
  const budget = Number(await getSetting("rooms.agentTurnBudget"))
  if (step.depth + 2 > budget) {
    await postSystemLine(
      roomId,
      `Agents reached the limit of ${budget} turns for one message. Ask again to carry on.`,
      { kind: "chain-end" }
    )
    return []
  }

  // RT-CND-02: a reply that repeats one earlier in the chain ends it
  const chain = await privileged
    .select({ body: roomMessages.body })
    .from(roomMessages)
    .where(
      and(
        eq(roomMessages.roomId, roomId),
        eq(roomMessages.authorKind, "agent"),
        inArray(
          roomMessages.taskId,
          privileged
            .select({ taskId: roomInvocations.taskId })
            .from(roomInvocations)
            .where(
              and(
                eq(roomInvocations.roomId, roomId),
                eq(roomInvocations.messageId, step.messageId)
              )
            )
        )
      )
    )
  const said = normalizeReply(text)
  const repeats =
    chain.filter((m) => m.body !== null && normalizeReply(m.body) === said).length > 1
  if (repeats) {
    await postSystemLine(roomId, "Agents stopped: they were repeating each other.", {
      kind: "chain-end",
    })
    return []
  }

  const names = await roomNames([{ userId: ownerId, agentId }])
  return invokeMentions({
    roomId,
    messageId: step.messageId,
    seq,
    requester: step.requestedBy,
    request: text,
    agentIds: named.map((a) => a.agentId),
    chain: {
      depth: step.depth + 1,
      asker: `${names.agent(ownerId, agentId)}, ${names.person(ownerId)}'s agent`,
    },
  })
}
