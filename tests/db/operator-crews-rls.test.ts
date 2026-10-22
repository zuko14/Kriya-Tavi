import { getTableConfig } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, it } from "vitest"

import { CREW_PART_STATUSES, crewParts, crewRuns } from "@/db/schema"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// Crew rows in SQL (track O, O11; CREW_EXECUTION.md §3). OT-CREW-10: the
// person reads only their own runs and parts and writes none; another
// person reaches neither the rows nor the part threads. Transitions follow
// kriya.allowed_transitions. Down + up is in migrations.test.ts.

let pg: TestDb
let alice: string
let bob: string

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const denied = (run: () => Promise<unknown>) =>
  run().then(
    () => "allowed",
    () => "denied"
  )

beforeEach(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g'), ('a2', $1, 'R', 'r', 'g')",
    [alice]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ('lead', $1, 'a1'), ('part', $1, 'a2')",
    [alice]
  )
  await pg.query(
    `insert into kriya.mandates (id, user_id, title, objective, criteria, due_at, proposed_by, status)
     values ('m1', $1, 'Collect', 'Get paid', '[{"id":"c1","text":"x","evidence":{"kind":"person_confirmed"}}]',
       now() + interval '5 days', 'agent', 'active')`,
    [alice]
  )
  // The worker (privileged) writes both
  await pg.query(
    `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, deadline_at)
     values ('r1', $1, 'lead', 'a1', 's1', 'm1', now() + interval '1 day')`,
    [alice]
  )
  await pg.query(
    `insert into kriya.crew_parts (id, user_id, run_id, key, agent_id, thread_id, brief)
     values ('p1', $1, 'r1', 'drafts', 'a2', 'part', 'Draft the reminders')`,
    [alice]
  )
})

describe("crew rows (OT-CREW-10)", () => {
  it("the person reads their own; another person sees nothing", async () => {
    const mine = await asUser(pg, alice, async (tx) => ({
      runs: (await tx.query("select id from kriya.crew_runs")).rows,
      parts: (await tx.query("select id from kriya.crew_parts")).rows,
    }))
    expect(mine).toEqual({ runs: [{ id: "r1" }], parts: [{ id: "p1" }] })
    const theirs = await asUser(pg, bob, async (tx) => ({
      runs: (await tx.query("select id from kriya.crew_runs")).rows,
      parts: (await tx.query("select id from kriya.crew_parts")).rows,
      threads: (await tx.query("select id from kriya.threads where id = 'part'")).rows,
      messages: (await tx.query("select 1 from kriya.messages where thread_id = 'part'"))
        .rows,
    }))
    expect(theirs).toEqual({ runs: [], parts: [], threads: [], messages: [] })
  })

  it("no client role inserts, updates or deletes a crew row", async () => {
    for (const user of [alice, bob]) {
      expect(
        await denied(() =>
          asUser(pg, user, (tx) =>
            tx.query(
              `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, deadline_at)
               values ('r2', $1, 'lead', 'a1', 's1', 'm1', now())`,
              [user]
            )
          )
        )
      ).toBe("denied")
      expect(
        await denied(() =>
          asUser(pg, user, (tx) =>
            tx.query(
              `insert into kriya.crew_parts (id, user_id, run_id, key, agent_id, thread_id, brief)
               values ('p2', $1, 'r1', 'x', 'a2', 'lead', 'x')`,
              [user]
            )
          )
        )
      ).toBe("denied")
    }
    // An update or delete either fails or reaches no row
    for (const sql of [
      "update kriya.crew_parts set status = 'done', result = 'forged'",
      "update kriya.crew_runs set status = 'joining'",
      "delete from kriya.crew_parts",
      "delete from kriya.crew_runs",
    ]) {
      await asUser(pg, alice, (tx) => tx.query(sql)).catch(() => {})
    }
    const { rows } = await pg.query(
      "select r.status as run, p.status as part, p.result from kriya.crew_runs r join kriya.crew_parts p on p.run_id = r.id"
    )
    expect(rows).toEqual([{ run: "running", part: "waiting", result: null }])
  })

  it("transitions follow the table; one open crew per job", async () => {
    const move = (status: string) =>
      denied(() => pg.query("update kriya.crew_parts set status = $1", [status]))
    expect(await move("done")).toBe("denied")
    expect(await move("queued")).toBe("allowed")
    expect(await move("done")).toBe("allowed")
    expect(await move("working")).toBe("denied")
    expect(
      await denied(() =>
        pg.query(
          `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, round, deadline_at)
           values ('r2', $1, 'lead', 'a1', 's1', 'm1', 2, now())`,
          [alice]
        )
      )
    ).toBe("denied")
    expect(
      await denied(() => pg.query("update kriya.crew_runs set status = 'joined'"))
    ).toBe("denied")
  })

  it("the Drizzle tables match the SQL", async () => {
    for (const table of [crewRuns, crewParts]) {
      const { name, columns } = getTableConfig(table)
      const { rows } = await pg.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'kriya' and table_name = $1",
        [name]
      )
      expect(columns.map((c) => snake(c.name)).sort(), name).toEqual(
        rows.map((r) => r.column_name).sort()
      )
    }
    const { rows } = await pg.query<{ s: string }>(
      "select distinct to_status as s from kriya.allowed_transitions where entity = 'crew_part' union select distinct from_status from kriya.allowed_transitions where entity = 'crew_part'"
    )
    expect(rows.map((r) => r.s).sort()).toEqual([...CREW_PART_STATUSES].sort())
  })
})
