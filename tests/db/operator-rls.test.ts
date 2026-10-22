import { getTableConfig } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, it } from "vitest"

import { grants, grantUses, MANDATE_STATUSES, mandates } from "@/db/schema"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// Jobs and standing grants in SQL (track O, O2; docs/operator/
// DATA_MODEL_AND_STATE_MACHINES.md §6). OT-DB-01 isolation, OT-DB-02
// transitions and who may make them, OT-DB-03 consume_grant, OT-DB-04 only
// the server may call it, OT-DB-05 the person's grant edits are reduce-only,
// OT-DB-07 the tool lock. OT-DB-06 (down + up) is in migrations.test.ts.

let pg: TestDb
let alice: string
let bob: string

const CRITERIA = JSON.stringify([
  {
    id: "c1",
    text: "A draft per client",
    evidence: { kind: "tool_verified", tool: "gmail_draft" },
  },
])
const PINS = JSON.stringify({ to: ["client@example.com"] })

// A proposal, as the agent's tool makes it: through the person's session
// `extra`: one more column and its SQL value, e.g. ["status", "'active'"]
const propose = (
  user: string,
  id: string,
  thread = "t1",
  [column, value]: [string?, string?] = []
) =>
  asUser(pg, user, (tx) =>
    tx.query(
      `insert into kriya.mandates (id, user_id, origin_thread_id, title, objective,
         criteria, due_at, proposed_by${column ? `, ${column}` : ""})
       values ($1, $2, $3, 'Collect', 'Get paid', $4, now() + interval '10 days', 'agent'
         ${column ? `, ${value}` : ""})`,
      [id, user, thread, CRITERIA]
    )
  )

// Server-side (privileged) helpers: the worker and the person's actions
const setStatus = (id: string, status: string) =>
  pg.query("update kriya.mandates set status = $2 where id = $1", [id, status])
const activeWithGrant = async (maxUses = 2) => {
  await propose(alice, "m1")
  await pg.query(
    "update kriya.mandates set status = 'active', goal_id = 'g1' where id = 'm1'"
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
     values ($1, 'm1', 'gmail_draft', $2, $3, now() + interval '10 days') returning id`,
    [alice, PINS, maxUses]
  )
  return rows[0].id
}
const consume = (grant: string, call: string, user = alice) =>
  pg
    .query<{ ok: boolean }>(
      "select kriya.consume_grant($1, $2, gen_random_uuid(), $3) as ok",
      [user, grant, call]
    )
    .then((r) => r.rows[0].ok)
const grantRow = (id: string) =>
  pg
    .query<{ uses: number; status: string }>(
      "select uses, status from kriya.grants where id = $1",
      [id]
    )
    .then((r) => r.rows[0])

beforeEach(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  for (const user of [alice, bob]) {
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Lekha', 'r', 'g')",
        [`a-${user}`, user]
      )
    })
  }
  await asUser(pg, alice, async (tx) => {
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, $2), ('tg', $1, $2)",
      [alice, `a-${alice}`]
    )
    await tx.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, $2, 'tg', 'Collect')",
      [alice, `a-${alice}`]
    )
  })
  await asUser(pg, bob, (tx) =>
    tx.query("insert into kriya.threads (id, user_id, agent_id) values ('tb', $1, $2)", [
      bob,
      `a-${bob}`,
    ])
  )
})

describe("isolation (OT-DB-01)", () => {
  it("a person proposes into their own thread; another person sees and changes nothing", async () => {
    const grant = await activeWithGrant()
    expect(await consume(grant, "call-1")).toBe(true)
    const seen = await asUser(pg, bob, async (tx) => ({
      mandates: (await tx.query("select 1 from kriya.mandates")).rows.length,
      grants: (await tx.query("select 1 from kriya.grants")).rows.length,
      uses: (await tx.query("select 1 from kriya.grant_uses")).rows.length,
      changed: (await tx.query("update kriya.mandates set status = 'declined'"))
        .affectedRows,
    }))
    expect(seen).toEqual({ mandates: 0, grants: 0, uses: 0, changed: 0 })
  })

  it("nobody can propose as someone else, or into someone else's thread", async () => {
    await propose(bob, "mine", "tb")
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query(
          `insert into kriya.mandates (id, user_id, origin_thread_id, title, objective, criteria, due_at, proposed_by)
           values ('mx', $1, 't1', 'x', 'x', $2, now() + interval '1 day', 'agent')`,
          [alice, CRITERIA]
        )
      )
    ).rejects.toThrow()
    await expect(propose(bob, "my", "t1")).rejects.toThrow()
  })

  it("a proposal can't arrive active, approved, linked or with a verdict", async () => {
    await propose(alice, "plain")
    for (const extra of [
      ["status", "'active'"],
      ["goal_id", "'g1'"],
      ["approved_at", "now()"],
      ["verdict", "'[]'"],
      ["confirmed", "'{c1}'"],
    ] as [string, string][]) {
      await expect(
        propose(alice, `m-${extra[0]}`, "t1", extra),
        extra[0]
      ).rejects.toThrow()
    }
  })

  it("the person reads their own job, grants and uses", async () => {
    const grant = await activeWithGrant()
    expect(await consume(grant, "call-1")).toBe(true)
    const seen = await asUser(pg, alice, async (tx) => ({
      mandates: (await tx.query("select 1 from kriya.mandates")).rows.length,
      grants: (await tx.query("select 1 from kriya.grants")).rows.length,
      uses: (await tx.query("select 1 from kriya.grant_uses")).rows.length,
    }))
    expect(seen).toEqual({ mandates: 1, grants: 1, uses: 1 })
  })

  it("rejects due dates beyond 30 days and out-of-range criteria", async () => {
    await propose(alice, "fine")
    await expect(
      pg.query(
        `insert into kriya.mandates (id, user_id, origin_thread_id, title, objective, criteria, due_at, proposed_by)
         values ('m9', $1, 't1', 'x', 'x', $2, now() + interval '31 days', 'agent')`,
        [alice, CRITERIA]
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.mandates (id, user_id, origin_thread_id, title, objective, criteria, due_at, proposed_by)
         values ('m8', $1, 't1', 'x', 'x', '[]', now() + interval '1 day', 'agent')`,
        [alice]
      )
    ).rejects.toThrow()
  })

  it("deleting the chat it was proposed in keeps an active job (OF-14); deleting its goal unlinks it", async () => {
    await propose(alice, "m1")
    await pg.query(
      "update kriya.mandates set status = 'active', goal_id = 'g1' where id = 'm1'"
    )
    await pg.query("delete from kriya.threads where id = 't1'")
    await pg.query("delete from kriya.goals where id = 'g1'")
    const { rows } = await pg.query(
      "select status, origin_thread_id, goal_id from kriya.mandates where id = 'm1'"
    )
    expect(rows).toEqual([{ status: "active", origin_thread_id: null, goal_id: null }])
  })

  it("tool_executions has the nullable grant_id column", async () => {
    const { rows } = await pg.query(
      `select is_nullable from information_schema.columns
       where table_schema = 'kriya' and table_name = 'tool_executions' and column_name = 'grant_id'`
    )
    expect(rows).toEqual([{ is_nullable: "YES" }])
  })
})

describe("transitions (OT-DB-02)", () => {
  const ALLOWED: [string, string][] = [
    ["proposed", "active"],
    ["proposed", "declined"],
    ["active", "needs_person"],
    ["needs_person", "active"],
    ["active", "paused"],
    ["paused", "active"],
    ["active", "completed"],
    ["needs_person", "completed"],
    ["active", "expired"],
    ["needs_person", "expired"],
    ["paused", "expired"],
    ["active", "revoked"],
    ["needs_person", "revoked"],
    ["paused", "revoked"],
    ["active", "closed"],
    ["needs_person", "closed"],
    ["paused", "closed"],
  ]

  it("allows exactly the listed mandate transitions", async () => {
    const statuses = [
      "proposed",
      "declined",
      "active",
      "needs_person",
      "paused",
      "completed",
      "expired",
      "revoked",
      "closed",
    ]
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue
        await pg.query("delete from kriya.mandates")
        await propose(alice, "m1")
        // Reach `from` by the shortest allowed path, as the server would
        const path: Record<string, string[]> = {
          proposed: [],
          declined: ["declined"],
          active: ["active"],
          needs_person: ["active", "needs_person"],
          paused: ["active", "paused"],
          completed: ["active", "completed"],
          expired: ["active", "expired"],
          revoked: ["active", "revoked"],
          closed: ["active", "closed"],
        }
        for (const step of path[from]) await setStatus("m1", step)
        const ok = await setStatus("m1", to).then(
          () => true,
          () => false
        )
        const allowed = ALLOWED.some(([f, t]) => f === from && t === to)
        expect(ok, `${from} → ${to}`).toBe(allowed)
      }
    }
  })

  it("the person's session can't make the worker's moves", async () => {
    await propose(alice, "m1")
    const asAlice = (status: string) =>
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.mandates set status = $1 where id = 'm1'", [status])
      )
    await asAlice("active")
    await expect(asAlice("needs_person")).rejects.toThrow()
    await expect(asAlice("completed")).rejects.toThrow()
    await expect(asAlice("expired")).rejects.toThrow()
    await asAlice("paused")
    await asAlice("active")
    await asAlice("revoked")
    const { rows } = await pg.query("select status from kriya.mandates where id = 'm1'")
    expect(rows).toEqual([{ status: "revoked" }])
  })

  it("grants: active may become revoked, exhausted or expired; nothing comes back", async () => {
    const grant = await activeWithGrant()
    const set = (status: string) =>
      pg.query("update kriya.grants set status = $2 where id = $1", [grant, status])
    await set("revoked")
    for (const back of ["active", "exhausted", "expired"]) {
      await expect(set(back), back).rejects.toThrow()
    }
  })
})

describe("consume_grant (OT-DB-03)", () => {
  it("spends one use per tool call, the same call again is free, and stops at the limit", async () => {
    const grant = await activeWithGrant(2)
    expect(await consume(grant, "call-1")).toBe(true)
    expect(await consume(grant, "call-1")).toBe(true)
    expect(await grantRow(grant)).toEqual({ uses: 1, status: "active" })
    expect(await consume(grant, "call-2")).toBe(true)
    expect(await grantRow(grant)).toEqual({ uses: 2, status: "exhausted" })
    expect(await consume(grant, "call-3")).toBe(false)
    expect(await grantRow(grant)).toEqual({ uses: 2, status: "exhausted" })
  })

  it("refuses a revoked or expired grant, a job that isn't active, and another person", async () => {
    const grant = await activeWithGrant(5)
    expect(await consume(grant, "c", bob)).toBe(false)
    await pg.query("update kriya.mandates set status = 'paused' where id = 'm1'")
    expect(await consume(grant, "c1")).toBe(false)
    await pg.query("update kriya.mandates set status = 'active' where id = 'm1'")
    await pg.query(
      "update kriya.grants set expires_at = now() - interval '1 second' where id = $1",
      [grant]
    )
    expect(await consume(grant, "c2")).toBe(false)
    await pg.query(
      "update kriya.grants set expires_at = now() + interval '1 day', status = 'revoked' where id = $1",
      [grant]
    )
    expect(await consume(grant, "c3")).toBe(false)
    expect((await grantRow(grant)).uses).toBe(0)
  })

  it("gives exactly max_uses yeses to many calls at once", async () => {
    const grant = await activeWithGrant(3)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => consume(grant, `call-${i}`))
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(await grantRow(grant)).toEqual({ uses: 3, status: "exhausted" })
  })
})

describe("who may spend a grant (OT-DB-04)", () => {
  it("the person's session can't call consume_grant", async () => {
    const grant = await activeWithGrant()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select kriya.consume_grant($1, $2, gen_random_uuid(), 'x')", [
          alice,
          grant,
        ])
      )
    ).rejects.toThrow(/permission denied/)
  })
})

describe("the person's grant edits are reduce-only (OT-DB-05)", () => {
  it("lowers max_uses and revokes; can't raise, un-revoke, exhaust or touch uses", async () => {
    const grant = await activeWithGrant(5)
    const asAlice = (set: string) =>
      asUser(pg, alice, (tx) =>
        tx.query(`update kriya.grants set ${set} where id = $1`, [grant])
      )
    await asAlice("max_uses = 3")
    await expect(asAlice("max_uses = 9")).rejects.toThrow()
    await expect(asAlice("status = 'exhausted'")).rejects.toThrow()
    await expect(asAlice("uses = 0")).rejects.toThrow()
    await asAlice("status = 'revoked', revoked_at = now()")
    await expect(asAlice("status = 'active'")).rejects.toThrow()
    expect(await grantRow(grant)).toEqual({ uses: 0, status: "revoked" })
  })
})

describe("the tool lock (OT-DB-07)", () => {
  it("stores grants only for the four grantable tools", async () => {
    await activeWithGrant()
    for (const tool of [
      "github_comment",
      "instagram_publish",
      "propose_call",
      "browser_click",
    ]) {
      await expect(
        pg.query(
          `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
           values ($1, 'm1', $2, '{}', 1, now() + interval '1 day')`,
          [alice, tool]
        ),
        tool
      ).rejects.toThrow()
    }
    await expect(
      pg.query(
        `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
         values ($1, 'm1', 'gmail_draft', $2, 51, now() + interval '1 day')`,
        [alice, PINS]
      )
    ).rejects.toThrow()
  })
})

describe("db/schema.ts mirrors the migration", () => {
  it("has the same columns as the tables", async () => {
    const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    for (const table of [mandates, grants, grantUses]) {
      const { name, columns } = getTableConfig(table)
      const { rows } = await pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'kriya' and table_name = $1 order by 1`,
        [name]
      )
      expect(columns.map((c) => snake(c.name)).sort(), name).toEqual(
        rows.map((r) => r.column_name)
      )
    }
  })

  it("lists the statuses the SQL check allows", async () => {
    const { rows } = await pg.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'kriya.mandates'::regclass and pg_get_constraintdef(oid) like '%status = ANY%'`
    )
    const allowed = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(allowed).toEqual([...MANDATE_STATUSES].sort())
  })
})
