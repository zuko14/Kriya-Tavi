import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { setGoalBudget, setGoalStatus } from "@/lib/goals"
import { setScheduleCap, setScheduleStatus } from "@/lib/schedules"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The person's own controls behind actions/goals.ts, actions/schedules.ts
// and actions/quotes.ts: only they resume a schedule or close a goal
// without evidence, a paused or closed goal stops its schedules, and
// another person's goal or schedule isn't found.

let pg: TestDb
let alice: string
let bob: string

const row = async (table: string, id: string) =>
  (
    await pg.query<Record<string, unknown>>(
      `select * from kriya.${table} where id = $1`,
      [id]
    )
  ).rows[0]

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  await asUser(pg, alice, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [alice]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [alice]
    )
    await tx.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, 'a1', 't1', 'GATE')",
      [alice]
    )
    await tx.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at, status, pause_reason)
       values ('s1', $1, 'a1', 't1', 'g1', 'recurring', 'p', '{"freq":"daily","at":"09:00"}', null, now(), 'paused', 'limit'),
              ('s2', $1, 'a1', 't1', 'g1', 'recurring', 'p', '{"freq":"daily","at":"09:00"}', now() + interval '1 day', now(), 'active', null)`,
      [alice]
    )
  })
})

describe("schedules", () => {
  it("the person resumes a paused schedule at its next time", async () => {
    await withUser(alice, (tx) => setScheduleStatus(tx, "s1", "active"))
    const s1 = await row("schedules", "s1")
    expect(s1).toMatchObject({ status: "active", pause_reason: null })
    expect((s1.next_run_at as Date).getTime()).toBeGreaterThan(Date.now())
  })

  it("pause and end stop the next run", async () => {
    await withUser(alice, (tx) => setScheduleStatus(tx, "s2", "paused"))
    expect(await row("schedules", "s2")).toMatchObject({
      status: "paused",
      pause_reason: "person",
      next_run_at: null,
    })
    await withUser(alice, (tx) => setScheduleStatus(tx, "s2", "ended"))
    await expect(
      withUser(alice, (tx) => setScheduleStatus(tx, "s2", "active"))
    ).rejects.toThrow(/has ended/)
  })

  it("sets and clears a ₹ cap per run", async () => {
    await withUser(alice, (tx) => setScheduleCap(tx, "s2", 5_000_000))
    expect((await row("schedules", "s2")).cap_micro_inr).toBe(5_000_000)
    await withUser(alice, (tx) => setScheduleCap(tx, "s2", null))
    expect((await row("schedules", "s2")).cap_micro_inr).toBeNull()
  })

  it("another person's schedule isn't found", async () => {
    await expect(
      withUser(bob, (tx) => setScheduleStatus(tx, "s1", "active"))
    ).rejects.toThrow(/No schedule/)
    await expect(withUser(bob, (tx) => setScheduleCap(tx, "s1", 1))).rejects.toThrow(
      /No schedule/
    )
  })
})

describe("goals", () => {
  it("pausing a goal pauses its running schedules; resuming leaves them to the person", async () => {
    await withUser(alice, (tx) => setGoalStatus(tx, "g1", "paused"))
    expect(await row("schedules", "s2")).toMatchObject({
      status: "paused",
      pause_reason: "goal",
    })
    await withUser(alice, (tx) => setGoalStatus(tx, "g1", "active"))
    expect((await row("goals", "g1")).status).toBe("active")
    expect((await row("schedules", "s2")).status).toBe("paused")
  })

  it("the person may close a goal as achieved without evidence; its schedules end", async () => {
    await withUser(alice, (tx) => setGoalStatus(tx, "g1", "achieved"))
    expect((await row("goals", "g1")).closed_at).toBeInstanceOf(Date)
    expect((await row("schedules", "s1")).status).toBe("ended")
    expect((await row("schedules", "s2")).status).toBe("ended")
  })

  it("sets a monthly ₹ budget, and another person's goal isn't found", async () => {
    await withUser(alice, (tx) => setGoalBudget(tx, "g1", 100_000_000))
    expect((await row("goals", "g1")).monthly_budget_micro_inr).toBe(100_000_000)
    await expect(
      withUser(bob, (tx) => setGoalStatus(tx, "g1", "abandoned"))
    ).rejects.toThrow(/No goal/)
  })
})
