import { and, desc, eq, isNull, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import {
  approvals,
  memories,
  roomInvocations,
  type EpisodeAction,
  type Task,
} from "@/db/schema"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { loadMessages } from "@/lib/agent/messages"
import { PRIVATE_READ_TOOLS, type KriyaMessage } from "@/lib/agent/tools"
import { log } from "@/lib/log"
import {
  postAgentMessage,
  postSystemLine,
  roomAgentsOn,
  roomOfTask,
} from "@/lib/rooms/agents"
import { conduct } from "@/lib/rooms/conductor"
import { roomNames } from "@/lib/rooms/names"
import { buildCard, episodeOf, markVerified } from "@/lib/rooms/proof"

// How a room task's reply reaches the room (track R, R4; RD-06, ARCHITECTURE
// §3), called by runTask once the task has ended. Code decides: if the
// bridge thread ever brought the owner's private content into the model's
// context (a PRIVATE_READ_TOOLS or mcp_ tool, the privateContentSeen test),
// the reply waits in the owner's Inbox for "Share in room"; otherwise it is
// posted as the agent. A reply waiting for an approval says so; the
// approval's continuation task is relayed too. The reply carries its proof
// card, and a reply to a card may verify it (R5). Errors are logged by the
// caller and never fail the task.

type Status = "succeeded" | "failed" | "canceled"

// Tool parts in a saved UI message: "tool-<name>", or dynamic tools by name
type ToolPart = { type: string; toolName?: string; state?: string }
const toolNames = (message: Pick<KriyaMessage, "parts">) =>
  (message.parts as ToolPart[]).flatMap((part) =>
    part.type === "dynamic-tool" && part.toolName
      ? [part.toolName]
      : part.type.startsWith("tool-")
        ? [part.type.slice(5)]
        : []
  )

// Kriya itself, the web, the agent browser and cloud workspaces; any other
// system is the owner's own account, and a card naming its runs is private
// content too (RD-09: nothing from a private tool without the gate)
const PUBLIC_SYSTEMS = new Set(["kriya", "web", "browser", "workspace"])

// RD-06, widened: the reply is held for the owner when the bridge thread
// ever brought private content into the model's context (a private read
// or app tool), when a run on its card acted in the owner's accounts, or,
// where the owner allowed their accounts in this room, when the owner's
// memory notes were in the prompt or searched
async function isPrivate(
  task: Task,
  reply: KriyaMessage | null,
  allowConnectors: boolean,
  done: EpisodeAction[]
) {
  const history = await loadMessages(privileged, task.threadId)
  const names = [...history, ...(reply ? [reply] : [])].flatMap(toolNames)
  if (names.some((name) => PRIVATE_READ_TOOLS.has(name) || name.startsWith("mcp_")))
    return true
  if (
    done.some(
      (item) =>
        item.tool.startsWith("mcp_") ||
        !PUBLIC_SYSTEMS.has(CAPABILITIES[item.tool]?.system ?? "")
    )
  )
    return true
  if (!allowConnectors) return false
  if (names.includes("memory_search")) return true
  // Memory v2 lists the notes it showed; v1 shows all of the agent's notes
  const shown = reply?.metadata?.memoryIds
  if (Array.isArray(shown)) return shown.length > 0
  const [note] = await privileged
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.userId, task.userId),
        eq(memories.agentId, task.agentId ?? ""),
        isNull(memories.invalidAt),
        eq(memories.archived, false)
      )
    )
    .limit(1)
  return Boolean(note)
}

// A reply to a card (R5): the card the mentioning message replied to, in
// the same room
async function cardAnswered(invocationId: string, roomId: string) {
  const [row] = rowsOf<{ reply_to: string | null }>(
    await privileged.execute(
      sql`select m.parts ->> 'replyTo' as reply_to
          from kriya.room_invocations i
          join kriya.room_messages m on m.id = i.message_id
          where i.id = ${invocationId} and m.room_id = ${roomId}`
    )
  )
  return row?.reply_to ?? null
}

export async function relayToRoom(
  task: Task,
  reply: KriyaMessage | null,
  status: Status
) {
  const roomTask = task.input.channel === "room"
  const continuation =
    !roomTask && (task.idempotencyKey?.startsWith("approval:") ?? false)
  if (!roomTask && !continuation) return
  const on = await roomAgentsOn()
  // Off: an ordinary task's continuation reads no room table (RT-REG-01)
  if (continuation && !on) return

  // The invocation this task answers; an approval's continuation gets its
  // own row, so its charge counts toward the members' cap (RD-04)
  let invocationId: string | null = null
  if (roomTask) {
    const [row] = await privileged
      .select({ id: roomInvocations.id })
      .from(roomInvocations)
      .where(eq(roomInvocations.taskId, task.id))
    invocationId = row?.id ?? null
  }
  const room = await roomOfTask(task)
  if (continuation) {
    if (!room) return
    // Only an approval asked by a room task (or by an earlier continuation
    // of one) is relayed; the owner's own chat in the bridge thread isn't.
    // The key is approval:<threadId>:<approvalId> (enqueueApproval)
    const approvalId = task.idempotencyKey!.slice(`approval:${task.threadId}:`.length)
    const [last] = await privileged
      .select({
        requestedBy: roomInvocations.requestedBy,
        messageId: roomInvocations.messageId,
        chainDepth: roomInvocations.chainDepth,
      })
      .from(roomInvocations)
      .innerJoin(
        approvals,
        and(
          eq(approvals.taskId, roomInvocations.taskId),
          eq(approvals.threadId, task.threadId),
          eq(approvals.userId, task.userId),
          eq(approvals.id, approvalId)
        )
      )
      .where(
        and(
          eq(roomInvocations.roomId, room.roomId),
          eq(roomInvocations.agentId, room.agentId),
          eq(roomInvocations.ownerId, task.userId)
        )
      )
      .orderBy(desc(roomInvocations.createdAt))
      .limit(1)
    if (!last) return
    const [row] = rowsOf<{ id: string }>(
      await privileged.execute(
        sql`insert into kriya.room_invocations
              (room_id, agent_id, owner_id, requested_by, message_id, chain_depth, task_id, status)
            values (${room.roomId}, ${room.agentId}, ${task.userId}, ${last.requestedBy},
                    ${last.messageId}, ${last.chainDepth}, ${task.id}, 'dispatched')
            returning id`
      )
    )
    invocationId = row.id
  }

  const close = (to: "done" | "failed") =>
    invocationId
      ? privileged
          .update(roomInvocations)
          .set({ status: to })
          .where(eq(roomInvocations.id, invocationId))
      : null
  const outcome = status === "succeeded" ? "done" : "failed"
  // Switched off, or the agent, its owner or the room gone: nothing is posted
  if (!on || !room) {
    await close(outcome)
    return
  }

  const names = await roomNames([{ userId: task.userId, agentId: room.agentId }])
  const agent = names.agent(task.userId, room.agentId)
  const owner = names.person(task.userId)
  const text = reply
    ? reply.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n")
        .trim()
    : ""
  const waiting =
    reply?.parts.some((part) => (part as ToolPart).state === "approval-requested") ??
    false

  // The posted reply's place, for the conductor (R6)
  let postedSeq: number | null = null
  // While an action waits for approval the reply isn't finished: its
  // continuation posts the whole of it
  if (text && !waiting) {
    // R5: the card from the episode, and the card this reply answers, if any
    const episode = await episodeOf(task.id)
    const proof = buildCard(episode)
    const verifies = invocationId ? await cardAnswered(invocationId, room.roomId) : null
    const held = await isPrivate(task, reply, room.allowConnectors, episode?.done ?? [])
    if (held) {
      const [disclosure] = rowsOf<{ id: string }>(
        await privileged.execute(
          sql`insert into kriya.room_disclosures (room_id, owner_id, agent_id, task_id, body, parts)
              values (${room.roomId}, ${task.userId}, ${room.agentId}, ${task.id},
                      ${text.slice(0, 8000)},
                      ${JSON.stringify({ invocationId, ...(proof && { proof }), ...(verifies && { verifies }) })}::jsonb)
              returning id`
        )
      )
      await postSystemLine(
        room.roomId,
        `${agent} replied; waiting for ${owner} to share it.`,
        {
          kind: "waiting",
          disclosureId: disclosure.id,
        }
      )
    } else {
      postedSeq = await postAgentMessage({
        roomId: room.roomId,
        ownerId: task.userId,
        agentId: room.agentId,
        body: text,
        parts: proof ? { proof } : {},
        taskId: task.id,
      })
      if (verifies)
        await markVerified({
          roomId: room.roomId,
          cardMessageId: verifies,
          verifier: episode?.done ?? [],
          agentId: room.agentId,
          agentName: agent,
          ownerName: owner,
        })
    }
  }
  if (waiting) {
    await postSystemLine(
      room.roomId,
      `${agent} is waiting for ${owner} to approve an action.`
    )
  } else if (status === "canceled") {
    await postSystemLine(room.roomId, `${agent} stopped.`)
  } else if (status === "failed") {
    await postSystemLine(room.roomId, `${agent} couldn't finish this request.`)
  } else if (!text) {
    await postSystemLine(room.roomId, `${agent} finished without a reply.`)
  }
  await close(outcome)
  // R6: the agents this reply names take their turns, if the conductor allows
  if (postedSeq !== null && status === "succeeded")
    await conduct({
      roomId: room.roomId,
      invocationId,
      agentId: room.agentId,
      ownerId: task.userId,
      text,
      seq: postedSeq,
    })
  log.info("rooms: relayed", { taskId: task.id, roomId: room.roomId })
}
