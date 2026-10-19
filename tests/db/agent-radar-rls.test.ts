import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261113000000_radar_watch.sql: the facts allow-list is enforced by a
// trigger (AT-FCT-01), served facts are only confirmed, current and not
// retracted, obligations move only along their machine (AT-TR-01) and only
// the person marks them done or dismissed, and each person sees only their
// own rows (AT-RLS-A). A watch schedule must carry its config.

let pg: TestDb
let alice: string
let bob: string

const fact = (fields: Record<string, unknown> = {}) => {
  const row = {
    key: "exam.test.registration_close",
    value: "10 October 2026",
    quote: "Registration closes on 10 October 2026",
    source_url: "https://exam.example.gov.in/notice",
    source_domain: "exam.example.gov.in",
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    confirmations: 2,
    ...fields,
  }
  const columns = Object.keys(row)
  return pg.query(
    `insert into kriya.public_facts (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row)
  )
}

const obligation = (user: string, id: string, extra = "") =>
  asUser(pg, user, (tx) =>
    tx.query(
      `insert into kriya.obligations (id, user_id, kind, title, due_at, quote, source_kind, source_ref, read_at, verified ${extra ? ", status" : ""})
       values ($1, $2, 'exam_registration', 'GATE registration', '2026-10-10T18:29:00Z',
               'Registration closes on 10 October 2026', 'official_page', 'https://exam.example.gov.in/notice#' || $1, now(), true ${extra ? `, '${extra}'` : ""})`,
      [id, user]
    )
  )

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("AT-FCT-01 the allow-list is enforced by the database", () => {
  it("accepts an official domain and its subdomains", async () => {
    await fact()
    await fact({
      key: "a.b.c",
      source_url: "https://cbic.nic.in/x",
      source_domain: "cbic.nic.in",
    })
  })

  it("rejects look-alikes, mismatched hosts and plain http", async () => {
    for (const [url, domain] of [
      ["https://gate-2027-info.in/notice", "gate-2027-info.in"],
      ["https://gov.in.evil.example/notice", "gov.in.evil.example"],
      ["https://examplegov.in/notice", "examplegov.in"],
    ]) {
      await expect(
        fact({
          key: `k.${domain}`.slice(0, 60).replace(/[^a-z0-9_.-]/g, ""),
          source_url: url,
          source_domain: domain,
        })
      ).rejects.toThrow(/not an allowed official domain/)
    }
    await expect(
      fact({
        key: "k.mismatch",
        source_url: "https://evil.example/x",
        source_domain: "exam.example.gov.in",
      })
    ).rejects.toThrow(/don't match/)
    await expect(
      fact({ key: "k.http", source_url: "http://exam.example.gov.in/x" })
    ).rejects.toThrow(/don't match|public_facts_source_url_check/)
  })

  it("a value must appear in its quote", async () => {
    await expect(fact({ key: "k.value", value: "11 October 2026" })).rejects.toThrow(
      /public_facts_check/
    )
  })
})

describe("served facts", () => {
  it("sessions read only confirmed, current, unretracted facts and write none", async () => {
    await fact({ key: "served.once", confirmations: 1 })
    await fact({
      key: "served.expired",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    await fact({ key: "served.retracted", retracted_at: new Date().toISOString() })
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query<{ key: string }>(
        "select key from kriya.public_facts where key like 'served.%' or key = 'exam.test.registration_close' order by key"
      )
    )
    expect(rows.map((r) => r.key)).toEqual(["exam.test.registration_close"])
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "update kriya.public_facts set value = 'x' where key = 'exam.test.registration_close'"
        )
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, alice, (tx) => tx.query("select * from kriya.fact_sources"))
    ).rejects.toThrow(/permission denied/)
  })
})

describe("obligations", () => {
  it("are born upcoming; the person marks done or dismissed and can't change the date", async () => {
    await obligation(alice, "o1")
    await expect(obligation(alice, "o2", "done")).rejects.toThrow(/row-level security/)
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.obligations set status = 'done' where id = 'o1'")
    )
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.obligations set due_at = now() where id = 'o1'")
      )
    ).rejects.toThrow(/permission denied/)
  })

  it.each([
    ["done", "upcoming"],
    ["dismissed", "done"],
    ["missed", "dismissed"],
    ["upcoming", "upcoming_x"],
  ])("AT-TR-01 obligation %s → %s raises", async (from, to) => {
    const id = `t-${from}-${to}`
    await pg.query(
      `insert into kriya.obligations (id, user_id, kind, title, due_at, quote, source_kind, source_ref, read_at, verified)
       values ($1, $2, 'x', 't', now(), 'q', 'person', 'person', now(), true)`,
      [id, alice]
    )
    if (from !== "upcoming") {
      await pg.query("update kriya.obligations set status = $2 where id = $1", [id, from])
    }
    await expect(
      pg.query("update kriya.obligations set status = $2 where id = $1", [id, to])
    ).rejects.toThrow(/can't go from|check/)
  })

  it("another person finds and changes nothing", async () => {
    await obligation(alice, "o3")
    const seen = await asUser(pg, bob, (tx) =>
      tx.query("select id from kriya.obligations")
    )
    expect(seen.rows).toEqual([])
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.obligations set status = 'dismissed' where id = 'o3'")
    )
    await asUser(pg, bob, (tx) =>
      tx.query("delete from kriya.obligations where id = 'o3'")
    )
    const { rows } = await pg.query(
      "select status from kriya.obligations where id = 'o3'"
    )
    expect(rows).toEqual([{ status: "upcoming" }])
  })
})

describe("watchers", () => {
  it("a watch schedule needs its config, other kinds can't have one; state is read-only", async () => {
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('w', $1, 'A', 'r', 'g')",
        [alice]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ('wt', $1, 'w')",
        [alice]
      )
    })
    const schedule = (id: string, kind: string, watch: string | null) =>
      pg.query(
        `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule, approved_at, watch)
         values ($1, $2, 'w', 'wt', $3, 'p', '{"freq":"daily","at":"09:00"}', now(), $4)`,
        [id, alice, kind, watch]
      )
    await schedule("s1", "watch", JSON.stringify({ url: "https://example.org" }))
    await expect(schedule("s2", "watch", null)).rejects.toThrow(/schedules_watch_check/)
    await expect(
      schedule("s3", "recurring", JSON.stringify({ url: "https://example.org" }))
    ).rejects.toThrow(/schedules_watch_check/)
    await pg.query(
      "insert into kriya.watch_state (schedule_id, user_id) values ('s1', $1)",
      [alice]
    )
    expect(
      (await asUser(pg, alice, (tx) => tx.query("select * from kriya.watch_state"))).rows
    ).toHaveLength(1)
    expect(
      (await asUser(pg, bob, (tx) => tx.query("select * from kriya.watch_state"))).rows
    ).toEqual([])
    await expect(
      asUser(pg, alice, (tx) => tx.query("update kriya.watch_state set failures = 0"))
    ).rejects.toThrow(/permission denied/)
    // A run that found the page unchanged is a valid outcome
    await pg.query(
      "insert into kriya.schedule_runs (schedule_id, user_id, due_at, outcome) values ('s1', $1, now(), 'unchanged')",
      [alice]
    )
  })
})
