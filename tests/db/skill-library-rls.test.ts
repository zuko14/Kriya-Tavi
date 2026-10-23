import fs from "node:fs"
import path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261202000000_skill_library.sql: an agent's skill assignments are covered
// by the agents policies, the activation trail is the person's own to read
// and only the worker writes it, and the migration rolls back and reapplies.

let pg: TestDb
let alice: string
let bob: string
let task: string

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await asUser(pg, alice, async (tx) => {
    await tx.query(
      `insert into kriya.agents (id, user_id, name, role, glyph, skills)
       values ('a1', $1, 'A', 'r', 'g', '{"auto":true,"on":["task-planning"]}')`,
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
  // As the worker does (privileged)
  await pg.query(
    `insert into kriya.skill_activations (task_id, attempt, user_id, agent_id, skill_id, version, status, mode, reason, chars)
     values ($1, 1, $2, 'a1', 'task-planning', '1.0.0', 'active', 'auto', 'Your message mentions "plan"', 900),
            ($1, 1, $2, 'a1', 'gst-invoices', '1.0.0', 'skipped', null, 'Not used: no ledger', 0)`,
    [task, alice]
  )
})

describe("skill library tables", () => {
  it("another person can't read or change an agent's skills", async () => {
    const seen = await asUser(pg, bob, (tx) =>
      tx.query("select skills from kriya.agents where id = 'a1'")
    )
    expect(seen.rows).toEqual([])
    await asUser(pg, bob, (tx) =>
      tx.query(
        `update kriya.agents set skills = '{"auto":false,"on":[]}' where id = 'a1'`
      )
    )
    const { rows } = await pg.query<{ skills: unknown }>(
      "select skills from kriya.agents where id = 'a1'"
    )
    expect(rows[0].skills).toEqual({ auto: true, on: ["task-planning"] })
  })

  it("the person changes their own agent's skills; only an object fits", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query(
        `update kriya.agents set skills = '{"auto":false,"on":[]}' where id = 'a1'`
      )
    )
    const { rows } = await pg.query<{ skills: unknown }>(
      "select skills from kriya.agents where id = 'a1'"
    )
    expect(rows[0].skills).toEqual({ auto: false, on: [] })
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(`update kriya.agents set skills = '["task-planning"]' where id = 'a1'`)
      )
    ).rejects.toThrow()
  })

  it("the person reads their own activations; another person sees none", async () => {
    const own = await asUser(pg, alice, (tx) =>
      tx.query("select skill_id, status from kriya.skill_activations order by skill_id")
    )
    expect(own.rows).toEqual([
      { skill_id: "gst-invoices", status: "skipped" },
      { skill_id: "task-planning", status: "active" },
    ])
    const other = await asUser(pg, bob, (tx) =>
      tx.query("select 1 from kriya.skill_activations")
    )
    expect(other.rows).toEqual([])
  })

  it("nobody but the worker writes the activation trail", async () => {
    for (const sql of [
      `insert into kriya.skill_activations (task_id, attempt, user_id, agent_id, skill_id, version, status, mode, reason)
       values ('${task}', 2, '${alice}', 'a1', 'github-workflow', '1.0.0', 'active', 'manual', 'x')`,
      "update kriya.skill_activations set outcome = 'succeeded'",
      "delete from kriya.skill_activations",
    ]) {
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow()
    }
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.skill_activations"
    )
    expect(rows[0].n).toBe(2)
  })

  it("rejects malformed rows: a bad id, an active row without a mode", async () => {
    await expect(
      pg.query(
        `insert into kriya.skill_activations (task_id, attempt, user_id, agent_id, skill_id, version, status, mode, reason)
         values ($1, 3, $2, 'a1', '../x', '1.0.0', 'skipped', null, 'x')`,
        [task, alice]
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.skill_activations (task_id, attempt, user_id, agent_id, skill_id, version, status, mode, reason)
         values ($1, 3, $2, 'a1', 'task-planning', '1.0.0', 'active', null, 'x')`,
        [task, alice]
      )
    ).rejects.toThrow()
  })

  it("rolls back and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const db = await createTestDb()
    await db.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261202000000')"
    )
    const added = async () =>
      (
        await db.query(
          `select relname from pg_class where relname = 'skill_activations'
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'agents' and column_name = 'skills'`
        )
      ).rows.length
    expect(await added()).toBe(2)
    await db.exec(read("rollback", "20261202000000_skill_library.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await db.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261202000000'"
    )
    expect(rows).toEqual([])
    await db.exec(read("migrations", "20261202000000_skill_library.sql"))
    expect(await added()).toBe(2)
  })
})
