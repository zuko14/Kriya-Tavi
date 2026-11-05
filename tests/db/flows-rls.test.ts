import { getTableConfig } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, it } from "vitest"

import { flowNodeRuns, flowRuns, flows, flowVersions } from "@/db/schema"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// Flows in SQL (track S; SECURITY_AND_RELIABILITY S3, S15). ST-RLS: a person
// reads and edits only their own flows, appends versions and never changes
// one, and writes no run rows. Another person reaches nothing. Transitions
// follow kriya.allowed_transitions. Down + up is in migrations.test.ts.

let pg: TestDb
let alice: string
let bob: string

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const denied = (run: () => Promise<unknown>) =>
  run().then(
    () => "allowed",
    () => "denied"
  )
const hash = "a".repeat(64)

beforeEach(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await pg.query(
    "insert into kriya.flows (id, user_id, name, draft) values ('f1', $1, 'F', '{}')",
    [alice]
  )
  await pg.query(
    `insert into kriya.flow_versions (flow_id, version, user_id, graph, hash) values ('f1', 1, $1, '{}', $2)`,
    [alice, hash]
  )
  await pg.query(
    `insert into kriya.flow_runs (id, user_id, flow_id, version, deadline_at) values ('r1', $1, 'f1', 1, now() + interval '1 day')`,
    [alice]
  )
  await pg.query(
    `insert into kriya.flow_node_runs (id, user_id, run_id, node_id, status) values ('n1', $1, 'r1', 'a', 'running')`,
    [alice]
  )
})

describe("ST-RLS: flow rows", () => {
  it("the schema mirrors the SQL", async () => {
    for (const table of [flows, flowVersions, flowRuns, flowNodeRuns]) {
      const { name, columns } = getTableConfig(table)
      const { rows } = await pg.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'kriya' and table_name = $1",
        [name]
      )
      expect(rows.map((r) => r.column_name).sort(), name).toEqual(
        columns.map((c) => snake(c.name)).sort()
      )
    }
  })

  it("the person reads their own; another person sees nothing", async () => {
    const counts = (user: string) =>
      asUser(pg, user, async (tx) => ({
        flows: (await tx.query("select id from kriya.flows")).rows.length,
        versions: (await tx.query("select version from kriya.flow_versions")).rows.length,
        runs: (await tx.query("select id from kriya.flow_runs")).rows.length,
        nodes: (await tx.query("select id from kriya.flow_node_runs")).rows.length,
      }))
    expect(await counts(alice)).toEqual({ flows: 1, versions: 1, runs: 1, nodes: 1 })
    expect(await counts(bob)).toEqual({ flows: 0, versions: 0, runs: 0, nodes: 0 })
  })

  it("the person edits their own flow, not someone else's, and never its owner", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.flows set name = 'G' where id = 'f1'")
    )
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.flows set name = 'H' where id = 'f1'")
    )
    const { rows } = await pg.query<{ name: string }>(
      "select name from kriya.flows where id = 'f1'"
    )
    expect(rows[0].name).toBe("G")
    expect(
      await denied(() =>
        asUser(pg, alice, (tx) =>
          tx.query("update kriya.flows set user_id = $1 where id = 'f1'", [bob])
        )
      )
    ).toBe("denied")
    expect(
      await denied(() =>
        asUser(pg, bob, (tx) =>
          tx.query(
            "insert into kriya.flows (id, user_id, name, draft) values ('x', $1, 'X', '{}')",
            [alice]
          )
        )
      )
    ).toBe("denied")
  })

  it("nobody can delete a flow through their session", async () => {
    expect(
      await denied(() =>
        asUser(pg, alice, (tx) => tx.query("delete from kriya.flows where id = 'f1'"))
      )
    ).toBe("denied")
  })

  it("S15: a version is appended, never changed, by anyone", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query(
        `insert into kriya.flow_versions (flow_id, version, user_id, graph, hash) values ('f1', 2, $1, '{}', $2)`,
        [alice, hash]
      )
    )
    expect(
      await denied(() =>
        asUser(pg, alice, (tx) =>
          tx.query("update kriya.flow_versions set note = 'x' where version = 1")
        )
      )
    ).toBe("denied")
    // Not even the server
    await expect(
      pg.query("update kriya.flow_versions set note = 'x' where version = 1")
    ).rejects.toThrow(/never changes/)
    expect(
      await denied(() =>
        asUser(pg, bob, (tx) =>
          tx.query(
            `insert into kriya.flow_versions (flow_id, version, user_id, graph, hash) values ('f1', 3, $1, '{}', $2)`,
            [bob, hash]
          )
        )
      )
    ).toBe("denied")
  })

  it("only the server writes runs and node runs", async () => {
    for (const query of [
      "update kriya.flow_runs set status = 'completed' where id = 'r1'",
      "update kriya.flow_node_runs set status = 'done', port = 'approved' where id = 'n1'",
      `insert into kriya.flow_node_runs (id, user_id, run_id, node_id, status) values ('n2', '${alice}', 'r1', 'b', 'done')`,
      `insert into kriya.flow_runs (id, user_id, flow_id, version, deadline_at) values ('r2', '${alice}', 'f1', 1, now())`,
    ])
      await asUser(pg, alice, (tx) => tx.query(query)).catch(() => {})
    const { rows: run } = await pg.query<{ status: string }>(
      "select status from kriya.flow_runs"
    )
    const { rows: node } = await pg.query<{ status: string }>(
      "select status from kriya.flow_node_runs"
    )
    expect(run).toEqual([{ status: "queued" }])
    expect(node).toEqual([{ status: "running" }])
  })

  it("statuses move only along the allowed transitions", async () => {
    await expect(
      pg.query("update kriya.flow_runs set status = 'completed' where id = 'r1'")
    ).rejects.toThrow()
    await pg.query("update kriya.flow_runs set status = 'running' where id = 'r1'")
    await pg.query("update kriya.flow_runs set status = 'completed' where id = 'r1'")
    await expect(
      pg.query("update kriya.flow_runs set status = 'running' where id = 'r1'")
    ).rejects.toThrow()
    await pg.query("update kriya.flow_node_runs set status = 'done' where id = 'n1'")
    await expect(
      pg.query("update kriya.flow_node_runs set status = 'running' where id = 'n1'")
    ).rejects.toThrow()
  })

  it("a duplicate node run is refused, so one decision can't run twice", async () => {
    await expect(
      pg.query(
        `insert into kriya.flow_node_runs (id, user_id, run_id, node_id, status) values ('n2', $1, 'r1', 'a', 'running')`,
        [alice]
      )
    ).rejects.toThrow()
  })

  it("a run can't point at another person's version", async () => {
    await expect(
      pg.query(
        `insert into kriya.flow_runs (id, user_id, flow_id, version, deadline_at) values ('r9', $1, 'f1', 1, now())`,
        [bob]
      )
    ).rejects.toThrow()
  })

  it("a huge draft is refused", async () => {
    await expect(
      pg.query("update kriya.flows set draft = $1 where id = 'f1'", [
        JSON.stringify({
          x: Array.from({ length: 40000 }, (_, i) => `${i}-${Math.random()}`),
        }),
      ])
    ).rejects.toThrow()
  })
})
