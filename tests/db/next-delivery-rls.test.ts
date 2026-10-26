import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270101000000_next_platform.sql: delivery re-checks are the person's own
// to read, written only by the worker for the run's own person, never
// changed; tool runs carry an optional risk class (NT-DB-03, ND-22).

let pg: TestDb
let alice: string
let bob: string
let task: string
let run: string

beforeAll(async () => {
  pg = await createTestDb()
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
  })
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [alice]
  )
  task = rows[0].id
  // As the runner does (privileged)
  const { rows: runs } = await pg.query<{ id: string }>(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, risk)
     values ($1, $2, 1, 'c1', 'calendar_create_event', true, null) returning id`,
    [task, alice]
  )
  run = runs[0].id
  await pg.query(
    `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status, evidence)
     values ($1, $2, $3, 'recheck', 'verified', '[{"kind":"provider_id","value":"ev1"}]')`,
    [alice, task, run]
  )
})

describe("NT-DB-03 delivery checks", () => {
  it("the person reads their own checks; another person sees none", async () => {
    const own = await asUser(pg, alice, (tx) =>
      tx.query("select kind, status from kriya.delivery_checks")
    )
    expect(own.rows).toEqual([{ kind: "recheck", status: "verified" }])
    const other = await asUser(pg, bob, (tx) =>
      tx.query("select 1 from kriya.delivery_checks")
    )
    expect(other.rows).toEqual([])
  })

  it("a person's session can't write, change or remove a check", async () => {
    for (const sql of [
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ('${alice}', '${task}', '${run}', 'mcp_readback', 'verified')`,
      "update kriya.delivery_checks set status = 'failed'",
      "delete from kriya.delivery_checks",
    ]) {
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow()
    }
    const { rows } = await pg.query("select status from kriya.delivery_checks")
    expect(rows).toEqual([{ status: "verified" }])
  })

  it("one check per run and kind; the worker can't change one either", async () => {
    await expect(
      pg.query(
        `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
         values ($1, $2, $3, 'recheck', 'gone')`,
        [alice, task, run]
      )
    ).rejects.toThrow()
    await expect(
      pg.query("update kriya.delivery_checks set status = 'gone'")
    ).rejects.toThrow(/never changed/)
    // A different kind for the same run is a new row
    await pg.query(
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ($1, $2, $3, 'mcp_readback', 'unverified')`,
      [alice, task, run]
    )
  })

  it("a check belongs to its run's person and task", async () => {
    await expect(
      pg.query(
        `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
         values ($1, $2, $3, 'recheck', 'verified')`,
        [bob, task, run]
      )
    ).rejects.toThrow(/run's person and task/)
  })

  it("rejects an unknown status or evidence that isn't a list", async () => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name)
       values ($1, $2, 1, 'c2', 'gmail_draft') returning id`,
      [task, alice]
    )
    for (const [status, evidence] of [
      ["done", "[]"],
      ["verified", "{}"],
    ]) {
      await expect(
        pg.query(
          `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status, evidence)
           values ($1, $2, $3, 'recheck', $4, $5)`,
          [alice, task, rows[0].id, status, evidence]
        )
      ).rejects.toThrow()
    }
  })

  it("deleting the task removes its checks", async () => {
    await pg.query("delete from kriya.tasks where id = $1", [task])
    const { rows } = await pg.query("select 1 from kriya.delivery_checks")
    expect(rows).toEqual([])
  })
})

describe("tool_executions.risk (ND-22)", () => {
  it("is null for built-in runs and only ever a risk class", async () => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [alice]
    )
    const insert = (risk: string | null) =>
      pg.query(
        `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, risk)
         values ($1, $2, 1, gen_random_uuid()::text, 'mcp_tracker_get_item', $3)`,
        [rows[0].id, alice, risk]
      )
    await insert(null)
    await insert("R0")
    await expect(insert("R9")).rejects.toThrow()
  })
})
