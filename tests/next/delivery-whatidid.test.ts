import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// NT-DLV-03 (ND-03, ND-23): whatIDid returns `delivery` only with
// next.delivery and agents.inbox both on; with next.delivery off the answer
// is exactly today's, and a later check by someone else changes nothing.

const session = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("server-only", () => ({}))

import { whatIDid } from "@/actions/inbox"

const EXECUTION = "00000000-0000-4000-8000-000000000001"
let pg: TestDb
let alice: string
let bob: string
let task: string

const reset = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
const settings = (inbox: boolean, delivery: boolean, recheck = false) => {
  if (inbox) process.env.KRIYA_AGENTS_INBOX = "on"
  else delete process.env.KRIYA_AGENTS_INBOX
  if (delivery) process.env.KRIYA_NEXT_DELIVERY = "on"
  else delete process.env.KRIYA_NEXT_DELIVERY
  if (recheck) process.env.KRIYA_NEXT_RECHECK = "on"
  else delete process.env.KRIYA_NEXT_RECHECK
  reset()
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  session.user = alice
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
    [alice]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
    [alice]
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
    [alice]
  )
  task = rows[0].id
  await pg.query(
    `insert into kriya.tool_executions (id, task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status)
     values ($1, $2, $3, 1, 'c1', 'calendar_create_event', true, 'succeeded')`,
    [EXECUTION, task, alice]
  )
  await pg.query(
    `insert into kriya.episodes (user_id, task_id, thread_id, unconfirmed, seq, hash)
     values ($1, $2, 't1', $3, 1, 'h1')`,
    [
      alice,
      task,
      JSON.stringify([
        {
          claim: 'Added "Exam" to your calendar',
          reason: "Ran, but wasn't checked afterwards.",
          executionId: EXECUTION,
        },
      ]),
    ]
  )
  await pg.query(
    `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status, checked_at)
     values ($1, $2, $3, 'recheck', 'verified', '2026-10-24T10:36:00Z')`,
    [alice, task, EXECUTION]
  )
})
afterEach(() => {
  settings(false, false)
})

describe("NT-DLV-03 whatIDid and next.delivery", () => {
  it("off: the records are today's, with no delivery key", async () => {
    settings(true, false)
    const answer = await whatIDid([task])
    expect(answer.records).toHaveLength(1)
    expect(answer.records[0]).not.toHaveProperty("delivery")
    expect(answer.records[0].unconfirmed).toHaveLength(1)
  })

  it("on: delivery is added and nothing else changes", async () => {
    settings(true, false)
    const before = await whatIDid([task])
    settings(true, true)
    const after = await whatIDid([task])
    expect(after.records[0].delivery).toEqual({
      status: "delivered",
      laterVerified: [{ executionId: EXECUTION, checkedAt: "2026-10-24T10:36:00.000Z" }],
      gone: [],
    })
    const stripped = after.records.map((record) => {
      const rest: Record<string, unknown> = { ...record }
      delete rest.delivery
      return rest
    })
    expect(stripped).toEqual(before.records)
    expect({ ...after, records: undefined }).toEqual({ ...before, records: undefined })
  })

  it("the inbox off: nothing, whatever next.delivery says", async () => {
    settings(false, true)
    expect(await whatIDid([task])).toEqual({ receipts: false, records: [] })
  })

  it("a check by someone else on the same run doesn't resolve it", async () => {
    await pg.query("delete from kriya.delivery_checks")
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('b1', $1, 'B', 'r', 'g')",
      [bob]
    )
    // Not possible by the table's own trigger; the person's scoped read is the guard
    await expect(
      pg.query(
        `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
         values ($1, $2, $3, 'recheck', 'verified')`,
        [bob, task, EXECUTION]
      )
    ).rejects.toThrow(/belongs to its run/)
    settings(true, true)
    const answer = await whatIDid([task])
    expect(answer.records[0].delivery?.status).toBe("not_confirmed")
  })

  it("N3: 'will check again by' only with next.recheck on (and next.delivery), for a run still waiting", async () => {
    // The run is unconfirmed, finished 5 minutes ago and not checked yet
    await pg.query("delete from kriya.delivery_checks")
    await pg.query(
      `update kriya.tool_executions
       set input = $2, verification = $3, finished_at = now() - interval '5 minutes' where id = $1`,
      [
        EXECUTION,
        JSON.stringify({ title: "Exam", start: "2026-10-30T10:00:00+05:30" }),
        JSON.stringify({
          status: "unverified",
          method: "api_readback",
          evidence: [{ kind: "provider_id", value: "evt12345abc" }],
        }),
      ]
    )
    settings(true, true, false)
    expect((await whatIDid([task])).records[0].delivery).not.toHaveProperty("due")
    settings(true, false, true)
    expect((await whatIDid([task])).records[0]).not.toHaveProperty("delivery")
    settings(true, true, true)
    const waiting = (await whatIDid([task])).records[0].delivery
    expect(waiting?.status).toBe("not_confirmed")
    expect(waiting?.due).toHaveLength(1)
    expect(waiting?.due?.[0].executionId).toBe(EXECUTION)
    // Once its check is in, nothing is due any more
    await pg.query(
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ($1, $2, $3, 'recheck', 'verified')`,
      [alice, task, EXECUTION]
    )
    const done = (await whatIDid([task])).records[0].delivery
    expect(done).toMatchObject({ status: "delivered", due: [] })
  })
})
