import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { reviewMandates } from "@/lib/operator/loop"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// The responsibility loop (O6, ARCHITECTURE §7, OD-07): no model, only rows.
// OT-LOOP-01 expiry; OT-LOOP-02 the stuck rule; OT-LOOP-03 completion from
// the verdict; OT-LOOP-04 one bad job never stops the pass, and the batch
// limit holds.

let pg: TestDb
let user: string

const q = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await pg.query<T>(query, params)).rows
const job = async (id = "m1") =>
  (
    await q<Record<string, unknown>>("select * from kriya.mandates where id = $1", [id])
  )[0]

// An active job on its own goal and thread, with a grant and two schedules
async function seed(id = "m1", criteria?: unknown) {
  const thread = `t-${id}`
  const goal = `g-${id}`
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, 'a1')",
    [thread, user]
  )
  await pg.query(
    "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ($1, $2, 'a1', $3, 'Collect')",
    [goal, user, thread]
  )
  await pg.query(
    `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by)
     values ($1, $2, 'a1', 'Collect', 'Get paid', $3, now() + interval '7 days', 'agent')`,
    [
      id,
      user,
      JSON.stringify(
        criteria ?? [
          { id: "c1", text: "Client agreed", evidence: { kind: "person_confirmed" } },
        ]
      ),
    ]
  )
  await pg.query(
    "update kriya.mandates set status = 'active', goal_id = $2, approved_at = now() - interval '3 days' where id = $1",
    [id, goal]
  )
  await pg.query(
    `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
     values ($1, $2, 'gmail_draft', '{"to":["a@example.com"]}', 3, now() + interval '7 days')`,
    [user, id]
  )
  for (const [sid, kind, rule] of [
    [`k-${id}`, "once", { freq: "once", startAt: new Date().toISOString() }],
    [`s-${id}`, "recurring", { freq: "daily", at: "10:00" }],
  ] as const)
    await pg.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at)
       values ($1, $2, 'a1', $3, $4, $5, 'Check in', $6, now() + interval '1 day', now() - interval '3 days')`,
      [sid, user, thread, goal, kind, JSON.stringify(rule)]
    )
}

// A check-in run that made a task, finished or not
async function run(id = "m1", hoursAgo: number, status = "succeeded") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{"messageId":"m","agentId":"a1","channel":"schedule"}', 'free', 'budget', now() + interval '1 hour', 10, 1000, $3)
     returning id`,
    [user, `t-${id}`, status]
  )
  await pg.query(
    `insert into kriya.schedule_runs (schedule_id, user_id, due_at, task_id, outcome)
     values ($1, $2, now() - make_interval(hours => $3), $4, 'enqueued')`,
    [`s-${id}`, user, hoursAgo, rows[0].id]
  )
}

const statuses = (id = "m1") =>
  q<{ kind: string; status: string; pause_reason: string | null }>(
    "select kind, status, pause_reason from kriya.schedules where goal_id = $1 order by kind",
    [`g-${id}`]
  )

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Lekha', 'r', 'g')",
    [user]
  )
  await seed()
})

describe("expiry (OT-LOOP-01)", () => {
  it("past its due time: expired, grants expired, schedules ended, verdict kept", async () => {
    await pg.query("update kriya.mandates set due_at = now() - interval '1 second'")
    expect(await reviewMandates()).toMatchObject({ expired: 1 })
    const expired = await job()
    expect(expired.status).toBe("expired")
    expect(expired.closed_at).not.toBeNull()
    expect(expired.verdict).toEqual([{ id: "c1", met: false, refs: [], by: null }])
    expect(await q("select status from kriya.grants")).toEqual([{ status: "expired" }])
    expect((await statuses()).map((s) => s.status)).toEqual(["ended", "ended"])
    expect(await q("select status from kriya.goals")).toEqual([{ status: "abandoned" }])
    // The same tick again changes nothing
    const before = await job()
    expect(await reviewMandates()).toMatchObject({ expired: 0, reviewed: 0 })
    expect(await job()).toEqual(before)
  })
})

describe("the stuck rule (OT-LOOP-02)", () => {
  it("two finished check-ins with nothing new and nothing waiting: needs you", async () => {
    await run("m1", 30)
    await run("m1", 6)
    expect(await reviewMandates()).toMatchObject({ stuck: 1 })
    const stuck = await job()
    expect(stuck.status).toBe("needs_person")
    expect(stuck.status_reason).toMatch(/2 check-ins/)
    expect(await statuses()).toEqual([
      { kind: "once", status: "paused", pause_reason: "mandate" },
      { kind: "recurring", status: "paused", pause_reason: "mandate" },
    ])
    // Grants stay; they just don't match while the job isn't active
    expect(await q("select status from kriya.grants")).toEqual([{ status: "active" }])
    expect(await reviewMandates()).toMatchObject({ stuck: 0 })
  })

  it("one run, a run still going, or runs before the last evidence don't count", async () => {
    await run("m1", 30)
    await run("m1", 6, "running")
    expect(await reviewMandates()).toMatchObject({ stuck: 0 })
    await pg.query(
      "update kriya.mandates set last_evidence_at = now() - interval '2 hours'"
    )
    await run("m1", 1)
    expect(await reviewMandates()).toMatchObject({ stuck: 0 })
    expect((await job()).status).toBe("active")
  })

  it("an approval waiting for the person means it isn't stuck", async () => {
    await run("m1", 30)
    await run("m1", 6)
    await pg.query(
      `insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title, expires_at)
       values ('ap1', $1, 't-m1', 'gmail_draft', 'R3', 'Save a draft', now() + interval '1 day')`,
      [user]
    )
    expect(await reviewMandates()).toMatchObject({ stuck: 0 })
    expect((await job()).status).toBe("active")
  })
})

describe("crews (O11, CREW_EXECUTION §5.4)", () => {
  it("a crew part waiting for the person's approval means it isn't stuck", async () => {
    process.env.KRIYA_OPERATOR_CREWS = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    try {
      await run("m1", 30)
      await run("m1", 6)
      await pg.query(
        "insert into kriya.threads (id, user_id, agent_id) values ('part', $1, 'a1')",
        [user]
      )
      await pg.query(
        `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, deadline_at)
         values ('r1', $1, 't-m1', 'a1', 's1', 'm1', now() + interval '1 day')`,
        [user]
      )
      await pg.query(
        `insert into kriya.crew_parts (id, user_id, run_id, key, agent_id, thread_id, brief, status)
         values ('p1', $1, 'r1', 'drafts', 'a1', 'part', 'Draft', 'waiting')`,
        [user]
      )
      await pg.query(
        `insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title, expires_at)
         values ('ap1', $1, 'part', 'gmail_draft', 'R3', 'Save a draft', now() + interval '1 day')`,
        [user]
      )
      expect(await reviewMandates()).toMatchObject({ stuck: 0 })
      expect((await job()).status).toBe("active")
    } finally {
      delete process.env.KRIYA_OPERATOR_CREWS
      ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    }
  })
})

describe("completion (OT-LOOP-03)", () => {
  it("every line met: completed, goal achieved, grants revoked, schedules ended", async () => {
    await pg.query("update kriya.mandates set confirmed = '{c1}'")
    expect(await reviewMandates()).toMatchObject({ completed: 1 })
    const done = await job()
    expect(done.status).toBe("completed")
    expect(done.verdict).toEqual([{ id: "c1", met: true, refs: [], by: "person" }])
    expect(await q("select status from kriya.goals")).toEqual([{ status: "achieved" }])
    expect(await q("select status from kriya.grants")).toEqual([{ status: "revoked" }])
    expect((await statuses()).map((s) => s.status)).toEqual(["ended", "ended"])
  })

  it("a paused job isn't completed until the person resumes it", async () => {
    await pg.query("update kriya.mandates set confirmed = '{c1}', status = 'paused'")
    expect(await reviewMandates()).toMatchObject({ completed: 0 })
    expect((await job()).status).toBe("paused")
  })
})

describe("the ₹ budget", () => {
  it("a check-in paused by the goal's budget pauses the job", async () => {
    await pg.query(
      "update kriya.schedules set status = 'paused', pause_reason = 'budget', next_run_at = null where kind = 'recurring'"
    )
    expect(await reviewMandates()).toMatchObject({ paused: 1 })
    expect(await job()).toMatchObject({
      status: "paused",
      status_reason: expect.stringMatching(/budget/),
    })
  })
})

describe("the pass (OT-LOOP-04)", () => {
  it("one bad job is logged and skipped; the rest are reviewed", async () => {
    // Criteria Kriya can't read make the verdict throw
    await seed("m0", [{ id: "c1", text: "?" }])
    await seed("m2")
    await pg.query("update kriya.mandates set confirmed = '{c1}'")
    const result = await reviewMandates()
    expect(result).toMatchObject({ failed: 1, completed: 2 })
    expect((await job("m0")).status).toBe("active")
  })

  it("reviews at most the batch limit per tick", async () => {
    await seed("m2")
    await seed("m3")
    await pg.query("update kriya.mandates set confirmed = '{c1}'")
    expect(await reviewMandates(new Date(), 2)).toMatchObject({
      reviewed: 2,
      completed: 2,
    })
    expect(await reviewMandates(new Date(), 2)).toMatchObject({ completed: 1 })
  })
})
