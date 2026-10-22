import { and, eq, gt, like } from "drizzle-orm"

import { withUser, type Tx } from "@/db"
import {
  connections,
  goals,
  mandates,
  tasks,
  toolExecutions,
  type ConnectionProvider,
} from "@/db/schema"

// Whether a connected account still works (G1, GOOGLE_CONNECTIVITY §3.2),
// derived from the person's own tool runs; kriya.connections isn't touched.
// Read as the person, so another person's runs never count.

export type Health = "ok" | "needs_reconnect"

// The start of the message lib/connectors.ts throws when a token is dead
// (`reconnect()`); tests/operator/google-g1.test.ts pins it
const NAMES: Record<ConnectionProvider, string> = {
  google: "Google",
  notion: "Notion",
  github: "GitHub",
  meta: "Instagram",
}
const stopped = (provider: ConnectionProvider) =>
  like(toolExecutions.error, `${NAMES[provider]} access has stopped working.%`)

// A failed run with that message, finished after the connection was last
// written (a reconnect or a refresh moves updated_at past it)
const failedSince = (provider: ConnectionProvider, since: Date) =>
  and(
    eq(toolExecutions.status, "failed"),
    stopped(provider),
    gt(toolExecutions.finishedAt, since)
  )

export async function connectionHealth(userId: string) {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ provider: connections.provider, updatedAt: connections.updatedAt })
      .from(connections)
    const health: Partial<Record<ConnectionProvider, Health>> = {}
    for (const row of rows) {
      const [failed] = await tx
        .select({ id: toolExecutions.id })
        .from(toolExecutions)
        .where(failedSince(row.provider, row.updatedAt))
        .limit(1)
      health[row.provider] = failed ? "needs_reconnect" : "ok"
    }
    return health
  })
}

// Titles of active jobs whose own thread hit a dead Google connection since
// it was last connected; empty when Google isn't connected at all
export async function jobsNeedGoogle(userId: string, tx?: Tx) {
  const read = async (t: Tx) => {
    const [google] = await t
      .select({ updatedAt: connections.updatedAt })
      .from(connections)
      .where(eq(connections.provider, "google"))
    if (!google) return []
    const rows = await t
      .selectDistinct({ title: mandates.title })
      .from(mandates)
      .innerJoin(goals, eq(goals.id, mandates.goalId))
      .innerJoin(tasks, eq(tasks.threadId, goals.threadId))
      .innerJoin(toolExecutions, eq(toolExecutions.taskId, tasks.id))
      .where(
        and(
          eq(mandates.status, "active"),
          failedSince("google", google.updatedAt),
          eq(toolExecutions.userId, userId)
        )
      )
    return rows.map((row) => row.title).sort()
  }
  return tx ? read(tx) : withUser(userId, read)
}
