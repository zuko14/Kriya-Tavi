import { and, desc, eq, inArray, isNull } from "drizzle-orm"

import { withUser } from "@/db"
import { charges, episodes, threads } from "@/db/schema"

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
