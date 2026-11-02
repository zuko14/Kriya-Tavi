import { drizzle } from "drizzle-orm/pglite"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { setFileStoreForTests } from "@/lib/files"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// A PGlite database with one person, for TaskWorkspace and tool tests:
// workspace minutes on the free plan, a runner secret, and no real bucket.
export async function cloudDb() {
  const pg: TestDb = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  setFileStoreForTests(null)
  process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
  await pg.query("update kriya.plans set workspace_minutes = 600")
  const user = await createUser(pg)

  // A task in its own thread; the thread's earlier task has finished
  async function task(tag: string, userId = user) {
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
      [`agent-${tag}`, userId]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3) on conflict do nothing",
      [`thread-${tag}`, userId, `agent-${tag}`]
    )
    await pg.query(
      "update kriya.tasks set status = 'succeeded' where thread_id = $1 and status in ('queued', 'running')",
      [`thread-${tag}`]
    )
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, agent_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, $2, $3, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [userId, `thread-${tag}`, `agent-${tag}`]
    )
    return { id: rows[0].id, userId, threadId: `thread-${tag}`, agentId: `agent-${tag}` }
  }

  return { pg, user, task }
}
