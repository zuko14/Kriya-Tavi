import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261101000002_browser.sql: browser sessions are visible only to their
// person, and plans.browser_minutes is enforced in SQL when a session opens
// (invariant 7), from this month's (IST) metered browser seconds.

let pg: TestDb
let alice: string
let bob: string

async function task(user: string, tag: string) {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
      [`agent-${tag}`, user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
      [`thread-${tag}`, user, `agent-${tag}`]
    )
  })
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user, `thread-${tag}`]
  )
  return rows[0].id
}

const open = (taskId: string) =>
  pg.query("select kriya.open_browser_session($1, $2, 'kriya-browser')", [
    randomUUID(),
    taskId,
  ])

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("browser sessions", () => {
  it("refuses to open while the plan has no browser minutes (the default)", async () => {
    const t = await task(alice, "a0")
    await expect(open(t)).rejects.toThrow(/browser minutes/)
  })

  it("opens within the plan's minutes and stops once they are used", async () => {
    await pg.query("update kriya.plans set browser_minutes = 2 where id = 'free'")
    const t = await task(alice, "a1")
    await open(t)
    // 90 s used this month: still under 120 s
    await pg.query(
      "insert into kriya.resource_usage (request_key, user_id, task_id, kind, quantity) values ('browser:x1', $1, $2, 'browser_seconds', 90)",
      [alice, t]
    )
    await open(t)
    await pg.query(
      "insert into kriya.resource_usage (request_key, user_id, task_id, kind, quantity) values ('browser:x2', $1, $2, 'browser_seconds', 30)",
      [alice, t]
    )
    await expect(open(t)).rejects.toThrow(/browser minutes/)
    // Another person's usage is theirs alone
    await open(await task(bob, "b1"))
  })

  it("a person sees only their own sessions and can't write them", async () => {
    const mine = await asUser(pg, alice, (tx) =>
      tx.query<{ user_id: string }>("select user_id from kriya.browser_sessions")
    )
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.every((r) => r.user_id === alice)).toBe(true)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.browser_sessions set status = 'closed'")
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("a person can't open sessions themselves", async () => {
    const t = await task(alice, "a2")
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select kriya.open_browser_session($1, $2, 'x')", [randomUUID(), t])
      )
    ).rejects.toThrow(/permission denied/)
  })
})
