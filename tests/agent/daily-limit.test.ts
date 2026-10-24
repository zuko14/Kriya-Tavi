import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn, TurnError } from "@/lib/agent/queue"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The plan's daily task limit holds inside the transaction that inserts the
// task, not only in the check before it: when that check read a stale count
// (a burst of parallel requests), the insert still refuses.

const stale = vi.hoisted(() => ({ on: false }))

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))
// The check before the insert, as a parallel request would have seen it
vi.mock("@/lib/entitlements", async (original) => {
  const real = await original<typeof import("@/lib/entitlements")>()
  return {
    ...real,
    usageSummary: async (userId: string) => {
      const usage = await real.usageSummary(userId)
      return stale.on ? { ...usage, tasksToday: 0 } : usage
    },
  }
})

let pg: TestDb
let user: string

const turn = (threadId: string) =>
  enqueueTurn({
    userId: user,
    threadId,
    message: {
      id: `m-${threadId}`,
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    } as KriyaMessage,
    idempotencyKey: `k-${threadId}`,
  })

const taskCount = async () =>
  (await pg.query<{ n: number }>("select count(*)::int as n from kriya.tasks")).rows[0].n

beforeEach(async () => {
  stale.on = false
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await pg.query("update kriya.plans set max_tasks_per_day = 2")
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'r', 'g')",
      [user]
    )
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, 'a1')",
        [id, user]
      )
    }
  })
})

describe("the daily task limit at insert", () => {
  it("refuses a task over the limit even when the earlier check saw room", async () => {
    await turn("t1")
    await turn("t2")
    stale.on = true
    await expect(turn("t3")).rejects.toMatchObject({
      code: "daily_limit",
      status: 402,
    })
    await expect(turn("t3")).rejects.toBeInstanceOf(TurnError)
    expect(await taskCount()).toBe(2)
  })

  it("lets a burst of parallel requests through only up to the limit", async () => {
    stale.on = true
    const results = await Promise.allSettled(
      ["t1", "t2", "t3", "t4", "t5"].map((id) => turn(id))
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
    expect(
      results.filter(
        (r) => r.status === "rejected" && (r.reason as TurnError).code === "daily_limit"
      )
    ).toHaveLength(3)
    expect(await taskCount()).toBe(2)
  })
})
