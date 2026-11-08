import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm"

import { withUser } from "@/db"
import {
  agents,
  approvals,
  crewParts,
  crewRuns,
  harnessApprovalRequests,
  harnessDevices,
  mandates,
  messages,
  roomDisclosures,
  rooms,
  skills,
  tasks,
  threads,
} from "@/db/schema"
import { textOf } from "@/lib/agent/messages"
import { getSetting } from "@/lib/config"
import { joinedGlyph } from "@/lib/glyph"
import { crewsOn } from "@/lib/operator/crew-threads"
import { roomAgentsOn } from "@/lib/rooms/agents"
import type { KriyaMessage } from "@/lib/agent/tools"
import { notesToReview } from "@/lib/memory/person"
import { describeStep, MAX_SKILL_FAILURES } from "@/lib/skills"
import { threadHref } from "@/queries/episodes"
import { jobsNeedGoogle } from "@/queries/connections"
import { editCards } from "@/queries/editing"
import { inboxJobs } from "@/queries/mandates"
import { waitingGates } from "@/queries/flows"

// The Inbox (A3, UX_SPEC §3): what's waiting for the person. Approvals come
// from the index the worker writes; questions are background runs whose
// reply ends by asking something nobody has answered yet; memories are
// notes saved after an agent read outside content.

// Scheduled runs this recent can still be waiting on an answer
const QUESTION_DAYS = 14

const lastSentence = (text: string) =>
  text
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .at(-1) ?? ""

export async function getInbox(userId: string) {
  // Track S: its own read, outside the transaction below; off = not queried
  const flowGates = await waitingGates(userId)
  // O3: jobs to review and jobs that need the person; off = not queried
  const jobsOn = (await getSetting("operator.mandates")) === "on"
  // O11: a crew part's approval names its job; off = not queried
  const crews = jobsOn && (await crewsOn())
  // Track R (R4): replies waiting for "Share in room"; off = not queried
  const roomsOn = await roomAgentsOn()
  // Track H (H5): devices' requests waiting for an answer; off = not queried
  const harnessOn = (await getSetting("harness.api")) === "on"
  // Track E (ED15): cards from a computer; off = not queried
  const choicesOn = (await getSetting("editing.review")) === "on"
  const foundOn = (await getSetting("editing.watchFolders")) === "on"
  const edit =
    choicesOn || foundOn
      ? await editCards(
          userId,
          choicesOn && foundOn ? "all" : choicesOn ? "choices" : "found"
        )
      : []
  return withUser(userId, async (tx) => {
    const waiting = await tx
      .select({
        id: approvals.id,
        threadId: approvals.threadId,
        toolName: approvals.toolName,
        riskClass: approvals.riskClass,
        title: approvals.title,
        preview: approvals.preview,
        createdAt: approvals.createdAt,
        expiresAt: approvals.expiresAt,
        agentName: agents.name,
        agentGlyph: agents.glyph,
        agentRole: agents.role,
        thread: { id: threads.id, agentId: threads.agentId, squadId: threads.squadId },
      })
      .from(approvals)
      .innerJoin(threads, eq(threads.id, approvals.threadId))
      .leftJoin(tasks, eq(tasks.id, approvals.taskId))
      // The agent that asked, else the thread's own agent
      .leftJoin(
        agents,
        eq(agents.id, sql`coalesce(${tasks.agentId}, ${threads.agentId})`)
      )
      .where(and(eq(approvals.status, "pending"), gt(approvals.expiresAt, sql`now()`)))
      .orderBy(desc(approvals.createdAt))

    const background = await tx
      .selectDistinct({
        id: threads.id,
        agentId: threads.agentId,
        squadId: threads.squadId,
        title: threads.title,
      })
      .from(tasks)
      .innerJoin(threads, eq(threads.id, tasks.threadId))
      .where(
        and(
          sql`${tasks.input} ->> 'channel' = 'schedule'`,
          gt(tasks.createdAt, sql`now() - make_interval(days => ${QUESTION_DAYS})`)
        )
      )
      .limit(20)
    const questions = []
    for (const thread of background) {
      const [last] = await tx
        .select()
        .from(messages)
        .where(eq(messages.threadId, thread.id))
        .orderBy(desc(messages.createdAt))
        .limit(1)
      if (last?.role !== "assistant") continue
      const ask = lastSentence(textOf({ parts: last.parts } as KriyaMessage))
      if (!ask.endsWith("?")) continue
      questions.push({
        threadId: thread.id,
        threadTitle: thread.title,
        question: ask.slice(0, 300),
        askedAt: last.createdAt,
        href: threadHref(thread),
      })
    }

    // A9: drafts to approve, and approved skills that stopped matching
    const skillRows = await tx
      .select()
      .from(skills)
      .where(
        or(
          eq(skills.status, "draft"),
          and(eq(skills.status, "approved"), gte(skills.failures, MAX_SKILL_FAILURES))
        )
      )
      .orderBy(desc(skills.createdAt))
      .limit(20)

    const partThreads = crews ? waiting.map((a) => a.threadId) : []
    const jobOfPart = new Map(
      partThreads.length
        ? (
            await tx
              .select({ threadId: crewParts.threadId, title: mandates.title })
              .from(crewParts)
              .innerJoin(crewRuns, eq(crewRuns.id, crewParts.runId))
              .innerJoin(mandates, eq(mandates.id, crewRuns.mandateId))
              .where(inArray(crewParts.threadId, partThreads))
          ).map((row) => [row.threadId, row.title])
        : []
    )

    return {
      approvals: waiting.map(({ thread, agentRole, ...approval }) => ({
        ...approval,
        agentGlyph: joinedGlyph(approval.agentGlyph, agentRole),
        href: threadHref(thread),
        jobTitle: jobOfPart.get(approval.threadId) ?? null,
      })),
      questions,
      flowGates,
      editCards: edit,
      memories: await notesToReview(tx),
      skills: skillRows.map((s) => ({
        id: s.id,
        version: s.version,
        name: s.name,
        description: s.description,
        kind: s.status === "draft" ? ("draft" as const) : ("review" as const),
        maxRisk: s.maxRisk,
        site: s.siteDomain,
        slots: s.slots,
        steps: s.steps.map(describeStep),
      })),
      ...(jobsOn && { jobs: await inboxJobs(tx) }),
      // G1: active jobs whose thread hit a dead Google connection
      googleStopped: jobsOn ? await jobsNeedGoogle(userId, tx) : [],
      // RD-06: the person's own (RLS), in rooms they're still in
      disclosures: roomsOn
        ? await tx
            .select({
              id: roomDisclosures.id,
              roomId: roomDisclosures.roomId,
              roomTitle: rooms.title,
              agentName: agents.name,
              agentGlyph: agents.glyph,
              agentRole: agents.role,
              body: roomDisclosures.body,
              createdAt: roomDisclosures.createdAt,
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
            .where(eq(roomDisclosures.status, "pending"))
            .orderBy(desc(roomDisclosures.createdAt))
            .limit(50)
            .then((rows) =>
              rows.map(({ agentRole, ...row }) => ({
                ...row,
                agentGlyph: joinedGlyph(row.agentGlyph, agentRole),
              }))
            )
        : [],
      // HD-08: the person's own (RLS), pending, unexpired, from a signed-in device
      harnessApprovals: harnessOn
        ? await tx
            .select({
              id: harnessApprovalRequests.id,
              tool: harnessApprovalRequests.tool,
              summary: harnessApprovalRequests.summary,
              input: harnessApprovalRequests.input,
              cwd: harnessApprovalRequests.cwd,
              deviceName: harnessDevices.name,
              createdAt: harnessApprovalRequests.createdAt,
              expiresAt: harnessApprovalRequests.expiresAt,
            })
            .from(harnessApprovalRequests)
            .innerJoin(
              harnessDevices,
              eq(harnessDevices.id, harnessApprovalRequests.deviceId)
            )
            .where(
              and(
                eq(harnessApprovalRequests.status, "pending"),
                gt(harnessApprovalRequests.expiresAt, sql`now()`),
                // A signed-out device can't collect the answer
                isNull(harnessDevices.revokedAt)
              )
            )
            .orderBy(desc(harnessApprovalRequests.createdAt))
            .limit(50)
        : [],
    }
  })
}

export type Inbox = Awaited<ReturnType<typeof getInbox>>

export async function inboxCount(userId: string) {
  const inbox = await getInbox(userId)
  return (
    inbox.approvals.length +
    inbox.questions.length +
    inbox.memories.length +
    inbox.skills.length +
    (inbox.jobs ? inbox.jobs.review.length + inbox.jobs.needs.length : 0) +
    inbox.disclosures.length +
    inbox.harnessApprovals.length +
    inbox.flowGates.length +
    inbox.editCards.length
  )
}
