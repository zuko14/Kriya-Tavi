import { and, desc, eq, inArray, isNull } from "drizzle-orm"

import { withUser } from "@/db"
import {
  charges,
  deliveryChecks,
  episodes,
  grants,
  mandates,
  threads,
  toolExecutions,
} from "@/db/schema"
import { recheckBy, recheckTarget } from "@/lib/delivery/rules"

// "What I did" records (A3) for the thread view, Home and the goal page,
// read as the person (withUser): their own records only.

export const threadHref = (thread: {
  id: string
  agentId: string | null
  squadId: string | null
}) =>
  thread.squadId
    ? `/s/${thread.squadId}/${thread.id}`
    : `/a/${thread.agentId}/${thread.id}`

const columns = {
  id: episodes.id,
  taskId: episodes.taskId,
  threadId: episodes.threadId,
  seq: episodes.seq,
  hash: episodes.hash,
  done: episodes.done,
  unconfirmed: episodes.unconfirmed,
  checks: episodes.checks,
  titles: episodes.titles,
  createdAt: episodes.createdAt,
  deletedAt: episodes.deletedAt,
  // The receipt shows what the task cost and how sure that number is (K1)
  chargeMicroInr: charges.chargeMicroInr,
  chargeStatus: charges.status,
}

export async function episodesForTasks(userId: string, taskIds: string[]) {
  if (taskIds.length === 0) return []
  return withUser(userId, (tx) =>
    tx
      .select(columns)
      .from(episodes)
      .leftJoin(charges, eq(charges.taskId, episodes.taskId))
      .where(inArray(episodes.taskId, taskIds))
  )
}

export type EpisodeView = Awaited<ReturnType<typeof episodesForTasks>>[number]

// O4: the job whose standing grant answered each run, so a person sees which
// actions they didn't approve one by one. Read at view time; receipts are
// unchanged (ARCHITECTURE §5).
export async function jobsForExecutions(userId: string, executionIds: string[]) {
  if (executionIds.length === 0) return {}
  const rows = await withUser(userId, (tx) =>
    tx
      .select({ executionId: toolExecutions.id, title: mandates.title })
      .from(toolExecutions)
      .innerJoin(grants, eq(grants.id, toolExecutions.grantId))
      .innerJoin(mandates, eq(mandates.id, grants.mandateId))
      .where(inArray(toolExecutions.id, executionIds))
  )
  return Object.fromEntries(rows.map((row) => [row.executionId, row.title]))
}

// N2 (ND-03): the later checks of these tasks' runs, as the person (row
// security: their own only), for deliveryOf. Newest first.
export async function deliveryForTasks(userId: string, taskIds: string[]) {
  if (taskIds.length === 0) return []
  return withUser(userId, (tx) =>
    tx
      .select({
        taskId: deliveryChecks.taskId,
        executionId: deliveryChecks.executionId,
        kind: deliveryChecks.kind,
        status: deliveryChecks.status,
        checkedAt: deliveryChecks.checkedAt,
      })
      .from(deliveryChecks)
      .where(inArray(deliveryChecks.taskId, taskIds))
      .orderBy(desc(deliveryChecks.checkedAt))
  )
}

// N3: runs still waiting for their one late re-check, with the time by which
// it will have happened ("Kriya will check again by …"). Same rule as the
// worker step (lib/delivery/rules.ts), read as the person.
export async function recheckDue(
  userId: string,
  executionIds: string[],
  now = new Date()
) {
  if (executionIds.length === 0) return []
  const { runs, done } = await withUser(userId, async (tx) => ({
    runs: await tx
      .select({
        id: toolExecutions.id,
        toolName: toolExecutions.toolName,
        input: toolExecutions.input,
        verification: toolExecutions.verification,
        undo: toolExecutions.undo,
        finishedAt: toolExecutions.finishedAt,
      })
      .from(toolExecutions)
      .where(
        and(
          inArray(toolExecutions.id, executionIds),
          eq(toolExecutions.sideEffect, true),
          eq(toolExecutions.status, "succeeded")
        )
      ),
    done: await tx
      .select({ id: deliveryChecks.executionId })
      .from(deliveryChecks)
      .where(
        and(
          inArray(deliveryChecks.executionId, executionIds),
          eq(deliveryChecks.kind, "recheck")
        )
      ),
  }))
  const checked = new Set(done.map((row) => row.id))
  return runs.flatMap((run) => {
    const by = recheckBy(run.finishedAt, now)
    return by && !checked.has(run.id) && recheckTarget(run)
      ? [{ executionId: run.id, by: by.toISOString() }]
      : []
  })
}

export async function recentEpisodes(userId: string, limit = 20) {
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        ...columns,
        thread: { id: threads.id, agentId: threads.agentId, squadId: threads.squadId },
      })
      .from(episodes)
      .innerJoin(threads, eq(threads.id, episodes.threadId))
      .leftJoin(charges, eq(charges.taskId, episodes.taskId))
      .where(isNull(episodes.deletedAt))
      .orderBy(desc(episodes.createdAt))
      .limit(limit)
  )
  return rows.map(({ thread, ...episode }) => ({ ...episode, href: threadHref(thread) }))
}

export async function goalEpisodes(userId: string, goalId: string, limit = 20) {
  return withUser(userId, (tx) =>
    tx
      .select(columns)
      .from(episodes)
      .leftJoin(charges, eq(charges.taskId, episodes.taskId))
      .where(and(eq(episodes.goalId, goalId), isNull(episodes.deletedAt)))
      .orderBy(desc(episodes.createdAt))
      .limit(limit)
  )
}
