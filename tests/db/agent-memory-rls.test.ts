import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// Memory v2 tables and columns (20261101000000_memory_v2.sql): scopes,
// history, search, and who can reach the new tables.

let pg: TestDb
let alice: string
let bob: string

async function seed(user: string, tag: string) {
  await asUser(pg, user, async (tx) => {
    for (const n of [1, 2]) {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
        [`agent-${tag}${n}`, user]
      )
    }
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
      [`thread-${tag}`, user, `agent-${tag}1`]
    )
    // Shared (no agent) and private to agent 1
    await tx.query(
      "insert into kriya.memories (id, user_id, agent_id, content) values ($1, $2, null, 'Studies at JNTU Hyderabad'), ($3, $2, $4, 'Prefers short answers')",
      [`shared-${tag}`, user, `private-${tag}`, `agent-${tag}1`]
    )
  })
}

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await seed(alice, "a")
  await seed(bob, "b")
})

// What one agent of the person loads: shared notes plus its own
const scopeOf = (tx: Pick<TestDb, "query">, agentId: string) =>
  tx
    .query<{ id: string }>(
      "select id from kriya.memories where agent_id is null or agent_id = $1 order by id",
      [agentId]
    )
    .then((r) => r.rows.map((row) => row.id))

describe("memory v2 scopes (AT-RLS-MEM-01)", () => {
  it("shows shared notes to every agent of the person and private ones to their agent only", async () => {
    const [first, second] = await asUser(pg, alice, async (tx) => [
      await scopeOf(tx, "agent-a1"),
      await scopeOf(tx, "agent-a2"),
    ])
    expect(first).toEqual(["private-a", "shared-a"])
    expect(second).toEqual(["shared-a"])
  })

  it("hides another person's shared notes and refuses to change them", async () => {
    const result = await asUser(pg, alice, async (tx) => {
      const seen = await tx.query(
        "select id from kriya.memories where user_id = $1 or id = 'shared-b'",
        [bob]
      )
      const updated = await tx.query(
        "update kriya.memories set content = 'x' where id = 'shared-b'"
      )
      const deleted = await tx.query("delete from kriya.memories where id = 'shared-b'")
      return [seen.rows.length, updated.affectedRows, deleted.affectedRows]
    })
    expect(result).toEqual([0, 0, 0])
  })

  it("refuses a shared note written under someone else's id", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.memories (id, user_id, agent_id, content) values ('evil', $1, null, 'x')",
          [bob]
        )
      )
    ).rejects.toThrow(/row-level security/)
  })
})

describe("memory v2 columns", () => {
  it("gives existing notes the switch-off defaults", async () => {
    const { rows } = await pg.query(
      "select kind, trust, importance, pinned, archived, invalid_at, use_count from kriya.memories where id = 'private-a'"
    )
    expect(rows[0]).toEqual({
      kind: "fact",
      trust: "trusted",
      importance: 2,
      pinned: false,
      archived: false,
      invalid_at: null,
      use_count: 0,
    })
  })

  it("keeps one current value per single-valued slot, many for slot[]", async () => {
    const insert = (id: string, slot: string) =>
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.memories (id, user_id, agent_id, content, kind, slot) values ($1, $2, null, $1, 'profile', $3)",
          [id, alice, slot]
        )
      )
    await insert("course-1", "profile.course")
    await expect(insert("course-2", "profile.course")).rejects.toThrow(/unique/)
    await insert("skill-1", "profile.skills[]")
    await insert("skill-2", "profile.skills[]")
    // Superseding frees the slot
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.memories set invalid_at = now() where id = 'course-1'")
    )
    await insert("course-2", "profile.course")
  })

  it("rejects malformed slots, kinds and sources", async () => {
    const bad = [
      ["slot", "'Profile Course'"],
      ["kind", "'secret'"],
      ["source", "'model'"],
      ["importance", "4"],
    ]
    for (const [column, value] of bad) {
      await expect(
        pg.query(
          `insert into kriya.memories (id, user_id, content, ${column}) values ('bad', $1, 'x', ${value})`,
          [alice]
        )
      ).rejects.toThrow(/check constraint/)
    }
    await pg.query(
      "insert into kriya.memories (id, user_id, content, source) values ('derived-1', $1, 'merged', 'derived')",
      [alice]
    )
  })

  it("keeps history: deleting the newer note clears superseded_by, not the row", async () => {
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.memories (id, user_id, content) values ('old', $1, 'Rent is 12000'), ('new', $1, 'Rent is 14000')",
        [alice]
      )
      await tx.query(
        "update kriya.memories set invalid_at = now(), superseded_by = 'new' where id = 'old'"
      )
      await tx.query("delete from kriya.memories where id = 'new'")
    })
    const { rows } = await pg.query<{ user_id: string; superseded_by: string | null }>(
      "select user_id, superseded_by from kriya.memories where id = 'old'"
    )
    expect(rows).toEqual([{ user_id: alice, superseded_by: null }])
  })

  it("can't point superseded_by at another person's note", async () => {
    await expect(
      pg.query(
        "update kriya.memories set superseded_by = 'shared-b' where id = 'shared-a'"
      )
    ).rejects.toThrow(/foreign key/)
  })
})

describe("memory search (AT-MEM-08)", () => {
  it("matches romanised Telugu and Hindi, native scripts and slots with 'simple'", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query(
        `insert into kriya.memories (id, user_id, content, slot) values
          ('te', $1, 'Amma ki Sunday phone cheyali', null),
          ('hi', $1, 'मुझे हिंदी में जवाब चाहिए', null),
          ('ml', $1, 'నాకు తెలుగులో సమాధానం కావాలి', null),
          ('en', $1, 'Client Ravi pays within 15 days', 'contact.ravi')`,
        [alice]
      )
    )
    const search = (q: string) =>
      asUser(pg, alice, (tx) =>
        tx.query<{ id: string }>(
          "select id from kriya.memories where search @@ to_tsquery('simple', $1) order by id",
          [q]
        )
      ).then((r) => r.rows.map((row) => row.id))
    expect(await search("cheyali")).toEqual(["te"])
    expect(await search("हिंदी")).toEqual(["hi"])
    expect(await search("తెలుగులో")).toEqual(["ml"])
    expect(await search("ravi")).toEqual(["en"])
    // 'simple' doesn't stem: "pay" is not "pays"
    expect(await search("pay")).toEqual([])
    expect(await search("cheyali | ravi | हिंदी")).toEqual(["en", "hi", "te"])
  })
})

describe("memory v2 tables", () => {
  it("lets a person read only their own thread summaries and never write them", async () => {
    await pg.query(
      `insert into kriya.thread_summaries (id, user_id, thread_id, covers_through, summary, chars)
       values ('s-a', $1, 'thread-a', now(), '{}', 2), ('s-b', $2, 'thread-b', now(), '{}', 2)`,
      [alice, bob]
    )
    const seen = await asUser(pg, alice, (tx) =>
      tx.query<{ id: string }>("select id from kriya.thread_summaries")
    )
    expect(seen.rows.map((r) => r.id)).toEqual(["s-a"])
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.thread_summaries (id, user_id, thread_id, covers_through, summary, chars) values ('x', $1, 'thread-a', now(), '{}', 2)",
          [alice]
        )
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("caps a summary at 3200 characters and deletes it with its thread", async () => {
    await expect(
      pg.query(
        "insert into kriya.thread_summaries (id, user_id, thread_id, covers_through, summary, chars) values ('big', $1, 'thread-a', now(), '{}', 3201)",
        [alice]
      )
    ).rejects.toThrow(/check constraint/)
    await pg.query("delete from kriya.threads where id = 'thread-b'")
    const { rows } = await pg.query(
      "select 1 from kriya.thread_summaries where id = 's-b'"
    )
    expect(rows).toEqual([])
  })

  it("keeps maintenance jobs away from the person's session", async () => {
    await pg.query(
      "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1, 'thread_summary', 'thread-a')",
      [alice]
    )
    await expect(
      asUser(pg, alice, (tx) => tx.query("select * from kriya.maintenance_jobs"))
    ).rejects.toThrow(/permission denied/)
  })

  it("allows one open maintenance job per kind and ref", async () => {
    await expect(
      pg.query(
        "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1, 'thread_summary', 'thread-a')",
        [alice]
      )
    ).rejects.toThrow(/unique/)
    await pg.query(
      "update kriya.maintenance_jobs set status = 'done' where ref = 'thread-a'"
    )
    await pg.query(
      "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1, 'thread_summary', 'thread-a')",
      [alice]
    )
  })

  it("shows resource usage to its owner only, read-only, and refuses negatives", async () => {
    await pg.query(
      `insert into kriya.resource_usage (request_key, user_id, kind, quantity, cost_micro_usd)
       values ('k-a', $1, 'maintenance_model', 900, null), ('k-b', $2, 'maintenance_model', 50, 12)`,
      [alice, bob]
    )
    const seen = await asUser(pg, alice, (tx) =>
      tx.query<{ request_key: string }>("select request_key from kriya.resource_usage")
    )
    expect(seen.rows.map((r) => r.request_key)).toEqual(["k-a"])
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.resource_usage set quantity = 0 where request_key = 'k-a'")
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      pg.query(
        "insert into kriya.resource_usage (request_key, user_id, kind, quantity) values ('neg', $1, 'web_fetch', -1)",
        [alice]
      )
    ).rejects.toThrow(/check constraint/)
  })
})
