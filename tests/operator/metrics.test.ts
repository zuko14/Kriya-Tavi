import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { log } from "@/lib/log"
import { reviewMandates } from "@/lib/operator/loop"
import { operatorMetrics } from "@/lib/operator/metrics"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Operator metrics (O8, TEST_AND_EVALUATION §2). OT-MET-01: OM1–OM8 on
// seeded rows equal the values worked out by hand below. OT-SEC-03: the
// numbers carry no personal data, and the loop logs job ids only.

let pg: TestDb
let user: string
const SECRET_TITLE = "Chase Asha Rao for invoice 12"
const PIN = "asha.rao@example.com"

const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)

async function job(id: string, status: string, closedDaysAgo = 0) {
  await q("insert into kriya.threads (id, user_id, agent_id) values ($1, $2, 'a1')", [
    `t-${id}`,
    user,
  ])
  await q(
    "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ($1, $2, 'a1', $3, 'g')",
    [`g-${id}`, user, `t-${id}`]
  )
  await q(
    `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by)
     values ($1, $2, 'a1', $3, 'o', '[{"id":"c1","text":"t","evidence":{"kind":"person_confirmed"}}]',
             now() + interval '7 days', 'agent')`,
    [id, user, SECRET_TITLE]
  )
  if (status === "declined") {
    await q("update kriya.mandates set status = 'declined' where id = $1", [id])
    return
  }
  await q(
    "update kriya.mandates set status = 'active', goal_id = $2, approved_at = now() - interval '45 days' where id = $1",
    [id, `g-${id}`]
  )
  if (status !== "active")
    await q(
      `update kriya.mandates set status = $2,
         closed_at = case when $2 in ('completed','expired','revoked','closed')
           then now() - make_interval(days => $3) end where id = $1`,
      [id, status, closedDaysAgo]
    )
}

async function task(thread: string, charge?: [number | null, string]) {
  const { rows } = await q(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{"messageId":"m","agentId":"a1","channel":"schedule"}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded')
     returning id`,
    [user, thread]
  )
  const id = (rows[0] as { id: string }).id
  if (charge)
    await q(
      `insert into kriya.charges (task_id, user_id, status, charge_micro_inr, plan_id, cost_basis, markup_bps)
       values ($1, $2, $3, $4, 'free', 'provider', 0)`,
      [id, user, charge[1], charge[0]]
    )
  return id
}

async function run(
  taskId: string,
  call: string,
  input: unknown,
  verified: boolean,
  grant: string | null
) {
  await q(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, input, status, verification, grant_id)
     values ($1, $2, 1, $3, 'gmail_draft', true, $4, 'succeeded', $5, $6)`,
    [
      taskId,
      user,
      call,
      JSON.stringify(input),
      JSON.stringify({
        status: verified ? "verified" : "failed",
        method: "api_readback",
        evidence: [],
      }),
      grant,
    ]
  )
}

async function approval(id: string, thread: string, waitedSeconds: number | null) {
  await q(
    `insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title, expires_at, created_at, status, decided_at)
     values ($1, $2, $3, 'gmail_draft', 'R3', 'Save a draft', now() + interval '1 day',
             now() - make_interval(secs => $4), $5,
             -- the same clock as created_at, so the wait is exact
             case when $5 = 'pending' then null else now() end)`,
    [
      id,
      user,
      thread,
      waitedSeconds ?? 60,
      waitedSeconds === null ? "pending" : "approved",
    ]
  )
}

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await q(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
    [user]
  )
  await job("m1", "completed")
  await job("m2", "expired")
  await job("m3", "active")
  await job("m4", "needs_person")
  await job("m5", "declined")
  await job("m6", "completed", 40) // outside the 30-day window
  await q(
    "insert into kriya.threads (id, user_id, agent_id) values ('t-chat', $1, 'a1')",
    [user]
  )

  // OM2: two job-thread records (one with an unconfirmed claim) + one in a job, one outside
  for (const [thread, unconfirmed] of [
    ["t-m1", [{ claim: "Sent", reason: "no run" }]],
    ["t-m1", []],
    ["t-m3", []],
    ["t-chat", [{ claim: "x", reason: "y" }]],
  ] as const)
    await q(
      `insert into kriya.episodes (user_id, thread_id, unconfirmed, seq, hash)
       values ($1, $2, $3, (select coalesce(max(seq), 0) + 1 from kriya.episodes where user_id = $1), 'h')`,
      [user, thread, JSON.stringify(unconfirmed)]
    )

  // OM3 + OM7: one grant; three granted runs (one failed check, one outside its pins)
  const { rows } = await q(
    `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
     values ($1, 'm3', 'gmail_draft', $2, 5, now() + interval '7 days') returning id`,
    [user, JSON.stringify({ to: [PIN] })]
  )
  const grant = (rows[0] as { id: string }).id
  const k1 = await task("t-m1", [2_000_000, "final"])
  await task("t-m1", [500_000, "estimated"])
  await task("t-m1", [null, "unpriced"])
  const draft = (to: string, subject: string) => ({ to: [to], subject, body: "Hi" })
  await run(k1, "c1", draft(PIN, "A"), true, grant)
  await run(k1, "c2", draft(PIN, "B"), false, grant)
  await run(k1, "c3", draft("z@evil.example", "C"), true, grant)
  // The same draft again, not under a grant: a duplicate side effect
  await run(k1, "c4", draft(PIN, "A"), true, null)

  // OM4/OM5: waited 100 s and 300 s, one pending, one outside any job
  await approval("ap1", "t-m1", 100)
  await approval("ap2", "t-m1", 300)
  await approval("ap3", "t-m3", null)
  await approval("ap4", "t-chat", 50)
})

describe("operator metrics on seeded rows (OT-MET-01)", () => {
  it("equal the hand-computed values for the last 30 days", async () => {
    const m = await operatorMetrics(30)
    // m1 completed and m2 expired in the window; m5 declined and m6 too old
    expect(m.om1).toEqual({ completed: 1, ended: 2 })
    expect(m.om2).toEqual({ unconfirmed: 1, records: 3 })
    expect(m.om3).toEqual({ failedChecks: 1, outsidePins: 1, granted: 3 })
    expect(m.om4).toEqual({ n: 2, p50Seconds: 100, p95Seconds: 300 })
    // ap1–ap3 across m1–m4 (each open at some point in the window)
    expect(m.om5).toEqual({ approvals: 3, jobs: 4 })
    expect(m.om6).toEqual({
      completed: 1,
      finalMicroInr: 2_000_000,
      estimatedMicroInr: 500_000,
      unpricedRuns: 1,
    })
    expect(m.om7).toEqual({ duplicates: 1 })
    expect(m.om8).toEqual({ needsPerson: 1, open: 2 })
    expect(m.statuses).toMatchObject({
      completed: 2,
      expired: 1,
      active: 1,
      needs_person: 1,
      declined: 1,
    })
    expect(m.grants).toEqual([{ tool: "gmail_draft", grants: 1, uses: 0, maxUses: 5 }])
  })

  it("narrows to the window: 7 days still sees today's rows", async () => {
    const m = await operatorMetrics(7)
    expect(m.om1).toEqual({ completed: 1, ended: 2 })
  })
})

describe("no personal data (OT-SEC-03)", () => {
  it("the metrics hold numbers and tool names only", async () => {
    const text = JSON.stringify(await operatorMetrics(30))
    expect(text).not.toContain(SECRET_TITLE)
    expect(text).not.toContain(PIN)
    expect(text).not.toContain("evil.example")
  })

  it("a failing job review is logged by id, without its title", async () => {
    await q(
      `update kriya.mandates set criteria = '[{"id":"c1","text":"?"}]' where id = 'm3'`
    )
    const spy = vi.spyOn(log, "error").mockImplementation(() => {})
    await reviewMandates()
    const logged = JSON.stringify(spy.mock.calls)
    spy.mockRestore()
    expect(logged).toContain("m3")
    expect(logged).not.toContain(SECRET_TITLE)
    expect(logged).not.toContain(PIN)
  })
})
