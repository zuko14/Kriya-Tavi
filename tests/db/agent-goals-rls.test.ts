import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261101000003_goals_schedules.sql: goals, schedules, their runs,
// approvals and episodes belong to one person (AT-RLS-A*), status changes
// follow kriya.allowed_transitions (AT-TR-01), schedules exist only once
// approved (AT-SCH-05), and an episode never changes except by the person's
// content-clearing delete (AT-RCP-02).

let pg: TestDb
let alice: string
let bob: string
let taskId: string

async function seed(user: string, tag: string) {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
      [`agent-${tag}`, user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3), ($4, $2, $3)",
      [`thread-${tag}`, user, `agent-${tag}`, `goal-thread-${tag}`]
    )
    await tx.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ($1, $2, $3, $4, 'Crack GATE')",
      [`goal-${tag}`, user, `agent-${tag}`, `goal-thread-${tag}`]
    )
    await tx.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at)
       values ($1, $2, $3, $4, $5, 'recurring', 'Plan my week', '{"freq":"weekly","at":"09:00","days":[1]}', now(), now())`,
      [`schedule-${tag}`, user, `agent-${tag}`, `goal-thread-${tag}`, `goal-${tag}`]
    )
  })
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user, `thread-${tag}`]
  )
  const task = rows[0].id
  await pg.query(
    "insert into kriya.schedule_runs (schedule_id, user_id, due_at, outcome) values ($1, $2, now(), 'claimed')",
    [`schedule-${tag}`, user]
  )
  await pg.query(
    `insert into kriya.approvals (id, user_id, thread_id, task_id, tool_name, risk_class, title)
     values ($1, $2, $3, $4, 'calendar_create_event', 'R3', 'Add Dentist to Calendar')`,
    [`appr-${tag}`, user, `thread-${tag}`, task]
  )
  await pg.query(
    `insert into kriya.episodes (user_id, task_id, thread_id, done, titles, seq, hash)
     values ($1, $2, $3, '[{"tool":"x"}]', 'Did x', 1, 'h1')`,
    [user, task, `thread-${tag}`]
  )
  return task
}

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  taskId = await seed(alice, "a")
  await seed(bob, "b")
})

const TABLES = ["goals", "schedules", "schedule_runs", "approvals", "episodes"]

describe("ownership (AT-RLS-A*)", () => {
  it("a person sees only their own rows in every new table", async () => {
    for (const table of TABLES) {
      const { rows } = await asUser(pg, alice, (tx) =>
        tx.query<{ user_id: string }>(`select user_id from kriya.${table}`)
      )
      expect(rows.length, table).toBe(1)
      expect(rows[0].user_id, table).toBe(alice)
    }
  })

  it("another person's goals and schedules can't be changed or deleted", async () => {
    await asUser(pg, bob, async (tx) => {
      for (const table of ["goals", "schedules"]) {
        const updated = await tx.query(`update kriya.${table} set updated_at = now()`)
        expect(updated.affectedRows, table).toBe(1)
      }
      await tx.query("delete from kriya.goals where user_id = $1", [alice])
      await tx.query("delete from kriya.schedules where user_id = $1", [alice])
    })
    const { rows } = await pg.query(
      "select 1 from kriya.goals where user_id = $1 union all select 1 from kriya.schedules where user_id = $1",
      [alice]
    )
    expect(rows).toHaveLength(2)
  })

  it("runs, approvals and episodes are written by the worker only", async () => {
    for (const sql of [
      `insert into kriya.schedule_runs (schedule_id, user_id, due_at, outcome) values ('schedule-a', '${alice}', now() + interval '1 day', 'claimed')`,
      `insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title) values ('x', '${alice}', 'thread-a', 'gmail_draft', 'R3', 't')`,
      "update kriya.approvals set status = 'approved'",
      `insert into kriya.episodes (user_id, thread_id, seq, hash) values ('${alice}', 'thread-a', 9, 'h')`,
      "delete from kriya.episodes",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("the person can read the verification of their tool runs", async () => {
    await pg.query(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, verification)
       values ($1, $2, 1, 'c1', 'schedule_create', '{"status":"verified"}')`,
      [taskId, alice]
    )
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query<{ verification: unknown }>(
        "select verification from kriya.tool_executions"
      )
    )
    expect(rows).toEqual([{ verification: { status: "verified" } }])
  })

  it("plans carry conservative goal and schedule limits", async () => {
    const { rows } = await pg.query(
      "select max_goals, max_schedules, min_schedule_interval_minutes from kriya.plans where id = 'free'"
    )
    expect(rows).toEqual([
      { max_goals: 3, max_schedules: 3, min_schedule_interval_minutes: 1440 },
    ])
  })
})

describe("schedules need approval (AT-SCH-05)", () => {
  it("refuses a schedule without approved_at", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule)
           values ('s-x', $1, 'agent-a', 'thread-a', 'once', 'p', '{"freq":"once"}')`,
          [alice]
        )
      )
    ).rejects.toThrow(/approved_at/)
  })
})

describe("status transitions (AT-TR-01)", () => {
  const STATES: Record<string, { table: string; id: string; states: string[] }> = {
    goal: {
      table: "goals",
      id: "goal-a",
      states: ["active", "paused", "achieved", "abandoned"],
    },
    schedule: {
      table: "schedules",
      id: "schedule-a",
      states: ["active", "paused", "ended"],
    },
    approval: {
      table: "approvals",
      id: "appr-a",
      states: ["pending", "approved", "declined", "expired"],
    },
  }

  it("raises on every transition that isn't allowed, for every entity", async () => {
    const { rows: allowed } = await pg.query<{
      entity: string
      from_status: string
      to_status: string
    }>("select entity, from_status, to_status from kriya.allowed_transitions")
    const ok = new Set(allowed.map((r) => `${r.entity}:${r.from_status}:${r.to_status}`))
    // A3's own entities; later phases add theirs (skills, A9) and test them
    expect(allowed.filter((r) => r.entity in STATES)).toHaveLength(13)

    for (const [entity, { table, id, states }] of Object.entries(STATES)) {
      for (const from of states) {
        for (const to of states) {
          if (from === to) continue
          // Put the row in `from` with the guard off, then try the move
          await pg.exec(`alter table kriya.${table} disable trigger ${table}_transition`)
          await pg.query(`update kriya.${table} set status = $1 where id = $2`, [
            from,
            id,
          ])
          await pg.exec(`alter table kriya.${table} enable trigger ${table}_transition`)
          const change = pg.query(`update kriya.${table} set status = $1 where id = $2`, [
            to,
            id,
          ])
          if (ok.has(`${entity}:${from}:${to}`)) await change
          else await expect(change, `${entity} ${from}→${to}`).rejects.toThrow(/can't go/)
        }
      }
    }
  })
})

describe("episodes are immutable (AT-RCP-02)", () => {
  const update = (sql: string) => asUser(pg, alice, (tx) => tx.query(sql))

  it("refuses any edit to the record or its chain", async () => {
    await expect(update(`update kriya.episodes set done = '[]'`)).rejects.toThrow(
      /immutable/
    )
    await expect(
      update(`update kriya.episodes set titles = 'I did more'`)
    ).rejects.toThrow(/immutable/)
    await expect(update(`update kriya.episodes set hash = 'forged'`)).rejects.toThrow(
      /permission denied/
    )
    // The worker can't rewrite it either
    await expect(
      pg.query("update kriya.episodes set done = '[]' where user_id = $1", [alice])
    ).rejects.toThrow(/immutable/)
  })

  it("allows only the person's delete, which clears the content and keeps the chain", async () => {
    await expect(
      update(`update kriya.episodes set deleted_at = now()`),
      "a delete that keeps the content"
    ).rejects.toThrow(/immutable/)
    await update(
      `update kriya.episodes set deleted_at = now(), done = '[]', unconfirmed = '[]', checks = '[]', titles = null, summary = null`
    )
    const { rows } = await pg.query(
      "select seq, hash, done, titles from kriya.episodes where user_id = $1",
      [alice]
    )
    expect(rows).toEqual([{ seq: 1, hash: "h1", done: [], titles: null }])
    await expect(update(`update kriya.episodes set deleted_at = null`)).rejects.toThrow(
      /immutable/
    )
  })

  it("lets the worker fill an empty summary once, and nothing else", async () => {
    await pg.query("update kriya.episodes set summary = 'Booked it' where user_id = $1", [
      bob,
    ])
    await expect(
      pg.query("update kriya.episodes set summary = 'Changed' where user_id = $1", [bob])
    ).rejects.toThrow(/immutable/)
    // The person can't write a summary
    await expect(
      asUser(pg, bob, (tx) => tx.query("update kriya.episodes set summary = 'x'"))
    ).rejects.toThrow(/immutable/)
  })
})
