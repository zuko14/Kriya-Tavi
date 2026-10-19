import { and, desc, eq, gt, gte, or, sql } from "drizzle-orm"

import { withUser } from "@/db"
import { agents, approvals, messages, skills, tasks, threads } from "@/db/schema"
import { textOf } from "@/lib/agent/messages"
import type { KriyaMessage } from "@/lib/agent/tools"
import { notesToReview } from "@/lib/memory/person"
import { describeStep, MAX_SKILL_FAILURES } from "@/lib/skills"
import { threadHref } from "@/queries/episodes"

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

    return {
      approvals: waiting.map(({ thread, ...approval }) => ({
        ...approval,
        href: threadHref(thread),
      })),
      questions,
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
    inbox.skills.length
  )
}
