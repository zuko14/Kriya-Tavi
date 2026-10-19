import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { claimDueSchedules, recoverClaimedRuns, runDue } from "@/lib/schedules"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The scheduler on a real Postgres: a due schedule is claimed once per due
// time (AT-SCH-02), then enqueued through queue.ts's prepare(), so a busy
// thread is skipped (AT-SCH-03) and a person over their limits gets the
// schedule paused with the reason (AT-SCH-04, AT-SCH-08). A crash between
// the two steps is recovered exactly once (AT-SCH-07), a goal's ₹ cap
// pauses its schedules (AT-QUO-03), and a run's ₹ cap becomes the task's
// budget (AT-QUO-02). Every claimed run ends with an outcome (R1).

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

let pg: TestDb
let user: string

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

async function schedule(
  id: string,
  over: { thread?: string; goal?: string; capMicroInr?: number; maxRuns?: number } = {}
) {
  await asUser(pg, user, (tx) =>
    tx.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at, cap_micro_inr, max_runs)
       values ($1, $2, 'a1', $3, $4, 'recurring', 'Plan my week', '{"freq":"daily","at":"09:00"}', $5, now(), $6, $7)`,
      [
        id,
        user,
        over.thread ?? "t1",
        over.goal ?? null,
        minutesAgo(1),
        over.capMicroInr ?? null,
        over.maxRuns ?? null,
      ]
    )
  )
}

async function runs() {
  const { rows } = await pg.query<{
    schedule_id: string
    outcome: string
    task_id: string
  }>("select schedule_id, outcome, task_id from kriya.schedule_runs order by schedule_id")
  return rows
}

async function scheduleRow(id: string) {
  const { rows } = await pg.query<{
    status: string
    pause_reason: string | null
    next_run_at: Date | null
    runs: number
  }>(
    "select status, pause_reason, next_run_at, runs from kriya.schedules where id = $1",
    [id]
  )
  return rows[0]
}

async function tick() {
  for (const run of await claimDueSchedules()) await runDue(run)
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  delete process.env.KRIYA_FX_USD_INR
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Disha', 'Study', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1'), ('t2', $1, 'a1')",
      [user]
    )
  })
})

describe("claiming (AT-SCH-02)", () => {
  it("claims a due run once, even with two workers at the same moment", async () => {
    await schedule("s1")
    const [first, second] = await Promise.all([claimDueSchedules(), claimDueSchedules()])
    expect(first.length + second.length).toBe(1)
    expect(await runs()).toEqual([
      { schedule_id: "s1", outcome: "claimed", task_id: null },
    ])
    // The next run is tomorrow (or later today) at 09:00 IST, never in the past
    const row = await scheduleRow("s1")
    expect(row.next_run_at!.getTime()).toBeGreaterThan(Date.now())
    expect(row.runs).toBe(1)
    expect(await claimDueSchedules()).toEqual([])
  })

  it("skips times missed while the worker was down instead of replaying them", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule, next_run_at, approved_at)
         values ('s1', $1, 'a1', 't1', 'recurring', 'Check', '{"freq":"interval","everyMinutes":60}', now() - interval '5 hours', now())`,
        [user]
      )
    )
    expect(await claimDueSchedules()).toHaveLength(1)
    expect((await scheduleRow("s1")).next_run_at!.getTime()).toBeGreaterThan(Date.now())
    expect(await claimDueSchedules()).toEqual([])
  })

  it("ends a schedule after its last run", async () => {
    await schedule("s1", { maxRuns: 1 })
    await tick()
    expect(await scheduleRow("s1")).toMatchObject({ status: "ended", next_run_at: null })
  })
})

describe("enqueueing through prepare() (AT-SCH-03, 04, 08)", () => {
  it("writes the prompt as a scheduled message and queues an ordinary task", async () => {
    await schedule("s1")
    await tick()
    const [run] = await runs()
    expect(run.outcome).toBe("enqueued")
    const { rows: tasks } = await pg.query<{
      input: schema.TaskInput
      idempotency_key: string
      cost_budget_micro_usd: number
    }>(
      "select input, idempotency_key, cost_budget_micro_usd from kriya.tasks where id = $1",
      [run.task_id]
    )
    expect(tasks[0].input).toMatchObject({ channel: "schedule", scheduleId: "s1" })
    expect(tasks[0].idempotency_key).toMatch(/^schedule:s1:/)
    // No ₹ cap: the plan's own per-task budget
    expect(tasks[0].cost_budget_micro_usd).toBe(50_000)
    const { rows: messages } = await pg.query<{
      role: string
      parts: unknown
      metadata: unknown
    }>("select role, parts, metadata from kriya.messages where thread_id = 't1'")
    expect(messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Plan my week" }],
        metadata: { channel: "schedule", scheduleId: "s1" },
      },
    ])
  })

  it("skips a fire into a thread that's already busy, and keeps the schedule", async () => {
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000)`,
      [user]
    )
    await schedule("s1")
    await tick()
    expect((await runs())[0].outcome).toBe("skipped_active")
    expect((await scheduleRow("s1")).status).toBe("active")
  })

  it("pauses the schedule with a reason when the person is over a limit", async () => {
    await pg.query("update kriya.plans set max_tasks_per_day = 0 where id = 'free'")
    await schedule("s1")
    await tick()
    expect((await runs())[0].outcome).toBe("skipped_limit")
    expect(await scheduleRow("s1")).toMatchObject({
      status: "paused",
      pause_reason: "limit",
      next_run_at: null,
    })
  })
})

describe("recovery (AT-SCH-07)", () => {
  it("enqueues a run left claimed by a crash exactly once", async () => {
    await schedule("s1")
    expect(await claimDueSchedules()).toHaveLength(1)
    // The worker died before enqueueing; the claim is now old
    await pg.query(
      "update kriya.schedule_runs set created_at = now() - interval '3 minutes'"
    )
    const [a, b] = await Promise.all([recoverClaimedRuns(), recoverClaimedRuns()])
    expect(a + b).toBeGreaterThanOrEqual(1)
    const { rows } = await pg.query("select 1 from kriya.tasks where thread_id = 't1'")
    expect(rows).toHaveLength(1)
    expect((await runs())[0].outcome).toBe("enqueued")
    // Nothing left in "claimed" (R1: every fire is accounted for)
    expect(await recoverClaimedRuns()).toBe(0)
  })

  it("leaves a fresh claim alone", async () => {
    await schedule("s1")
    await claimDueSchedules()
    expect(await recoverClaimedRuns()).toBe(0)
    expect((await runs())[0].outcome).toBe("claimed")
  })
})

describe("₹ caps (K2)", () => {
  it("pauses a goal's schedules once its monthly cap is spent (AT-QUO-03)", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.goals (id, user_id, agent_id, thread_id, title, monthly_budget_micro_inr) values ('g1', $1, 'a1', 't2', 'GATE', 5000000)",
        [user]
      )
    )
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, 't2', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
      [user]
    )
    await pg.query(
      "insert into kriya.charges (user_id, task_id, plan_id, cost_basis, markup_bps, charge_micro_inr, status) values ($1, $2, 'free', 'provider', 10000, 5000000, 'final')",
      [user, rows[0].id]
    )
    await schedule("s1", { thread: "t2", goal: "g1" })
    await tick()
    expect((await runs())[0].outcome).toBe("skipped_budget")
    expect(await scheduleRow("s1")).toMatchObject({
      status: "paused",
      pause_reason: "budget",
    })
  })

  it("turns a run's ₹ cap into the task budget with the owner's rate (AT-QUO-02)", async () => {
    process.env.KRIYA_FX_USD_INR = "84.25"
    // ₹1 at 84.25 and 1× markup: 1,000,000 × 10^8 / (842,500 × 10,000)
    await schedule("s1", { capMicroInr: 1_000_000 })
    await tick()
    const { rows } = await pg.query<{ cost_budget_micro_usd: number }>(
      "select cost_budget_micro_usd from kriya.tasks"
    )
    expect(rows).toEqual([{ cost_budget_micro_usd: 11_869 }])
  })
})
