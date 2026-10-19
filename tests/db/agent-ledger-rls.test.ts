import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261111000000_ledger.sql: totals checked in SQL (AT-LED-01), the same
// bill can't be entered twice (AT-LED-04), invoice numbers are consecutive
// and never reused (AT-LED-07, the SQL side), every disallowed transition
// raises (AT-TR-01 for ledger entries and invoices), and each person sees
// only their own rows (AT-RLS-A). The plan must have the ledger on.

let pg: TestDb
let alice: string
let bob: string

const entry = (
  user: string,
  fields: Record<string, unknown> = {},
  run: (sql: string, params: unknown[]) => Promise<unknown> = (sql, params) =>
    asUser(pg, user, (tx) => tx.query(sql, params))
) => {
  const row = {
    kind: "expense",
    entry_date: "2026-10-05",
    counterparty: "Fixture Power Ltd",
    taxable_paise: 100_000,
    cgst_paise: 9_000,
    sgst_paise: 9_000,
    total_paise: 118_000,
    created_by: "user",
    ...fields,
  }
  const columns = Object.keys(row)
  return run(
    `insert into kriya.ledger_entries (user_id, ${columns.join(", ")}) values ($1, ${columns
      .map((_, i) => `$${i + 2}`)
      .join(", ")}) returning id`,
    [user, ...Object.values(row)]
  ) as Promise<{ rows: { id: string }[] }>
}

const invoice = async (user: string) =>
  (
    await asUser(pg, user, (tx) =>
      tx.query<{ id: string }>(
        `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, cgst_paise, sgst_paise, total_paise, issue_date)
         values ($1, '{"name":"Studio","state_code":"29"}', '{"name":"Client","state_code":"29"}', '29',
                 '[{"description":"Design","qty_milli":1000,"rate_paise":100000,"tax_rate_bps":1800}]',
                 100000, 9000, 9000, 118000, '2026-10-18') returning id`,
        [user]
      )
    )
  ).rows[0].id

const issue = (user: string, id: string) =>
  asUser(pg, user, (tx) =>
    tx.query<{ number: number; number_text: string; fy: string; status: string }>(
      "select number, number_text, fy, status from kriya.issue_invoice($1)",
      [id]
    )
  ).then((r) => r.rows[0])

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await pg.query("update kriya.plans set ledger_enabled = true where id = 'free'")
})

describe("plan", () => {
  it("refuses entries and invoices while the plan has no ledger", async () => {
    await pg.query("update kriya.plans set ledger_enabled = false where id = 'free'")
    await expect(entry(alice)).rejects.toThrow(/ledger isn't on this plan/)
    await expect(invoice(alice)).rejects.toThrow(/ledger isn't on this plan/)
    await pg.query("update kriya.plans set ledger_enabled = true where id = 'free'")
  })
})

describe("AT-LED-01 totals are checked in SQL", () => {
  it("accepts a total equal to its parts plus round-off", async () => {
    await entry(alice, { round_off_paise: 0 })
    await entry(alice, {
      taxable_paise: 84_746,
      cgst_paise: 7_627,
      sgst_paise: 7_627,
      round_off_paise: 0,
      total_paise: 100_000,
    })
  })

  it("rejects a total off by one paisa, a round-off over ₹1, and CGST with IGST", async () => {
    await expect(entry(alice, { total_paise: 118_001 })).rejects.toThrow(
      /ledger_entries_check/
    )
    await expect(
      entry(alice, { round_off_paise: 101, total_paise: 118_101 })
    ).rejects.toThrow(/round_off_paise_check/)
    await expect(
      entry(alice, { igst_paise: 18_000, total_paise: 136_000 })
    ).rejects.toThrow(/ledger_entries_check/)
  })

  it("an invoice's total is checked the same way", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, total_paise)
           values ($1, '{}', '{}', '29', '[{}]', 100000, 100001)`,
          [alice]
        )
      )
    ).rejects.toThrow(/invoices_check/)
  })
})

describe("AT-LED-04 duplicate bills", () => {
  it("the same GSTIN and bill number can't be entered twice, unless voided", async () => {
    const gstin = { counterparty_gstin: "29ABCDE1234F1Z5", document_no: "INV-778" }
    const first = await entry(bob, gstin)
    await expect(entry(bob, gstin)).rejects.toThrow(/ledger_entries_document_idx/)
    // Another person's identical bill is theirs
    await entry(alice, gstin)
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.ledger_entries set status = 'void' where id = $1", [
        first.rows[0].id,
      ])
    )
    await entry(bob, gstin)
  })
})

describe("AT-LED-07 invoice numbers (SQL)", () => {
  it("are consecutive per series and FY, never reused, at most 16 characters", async () => {
    const carol = await createUser(pg)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push(await invoice(carol))
    // Issued in a shuffled order: numbers follow the order of issuing
    const issued: { number: number; number_text: string; fy: string }[] = []
    for (const id of [...ids].reverse()) issued.push(await issue(carol, id))
    expect(issued.map((i) => i.number)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    )
    expect(issued[0]).toMatchObject({ number_text: "INV/26-27/001", fy: "2026-27" })
    expect(issued.every((i) => i.number_text.length <= 16)).toBe(true)
    // Issuing again returns the same number
    expect((await issue(carol, ids[19])).number).toBe(1)
    // An issued invoice can't be deleted (its number stays used) or changed
    await asUser(pg, carol, (tx) =>
      tx.query("delete from kriya.invoices where id = $1", [ids[0]])
    )
    const { rows } = await pg.query("select 1 from kriya.invoices where id = $1", [
      ids[0],
    ])
    expect(rows).toHaveLength(1)
    await expect(
      asUser(pg, carol, (tx) =>
        tx.query(
          "update kriya.invoices set number = 99, number_text = 'X' where id = $1",
          [ids[0]]
        )
      )
    ).rejects.toThrow(/can't be changed/)
    await expect(
      asUser(pg, carol, (tx) =>
        tx.query(
          "update kriya.invoices set total_paise = 1, taxable_paise = 1, cgst_paise = 0, sgst_paise = 0 where id = $1",
          [ids[0]]
        )
      )
    ).rejects.toThrow(/can't be changed/)
    // A void invoice keeps its number; the next one doesn't reuse it
    await asUser(pg, carol, (tx) =>
      tx.query("update kriya.invoices set status = 'void' where id = $1", [ids[0]])
    )
    expect((await issue(carol, await invoice(carol))).number).toBe(21)
  })

  it("numbers start again in a new financial year", async () => {
    const dave = await createUser(pg)
    const march = await invoice(dave)
    await asUser(pg, dave, (tx) =>
      tx.query("update kriya.invoices set issue_date = '2027-03-31' where id = $1", [
        march,
      ])
    )
    const april = await invoice(dave)
    await asUser(pg, dave, (tx) =>
      tx.query("update kriya.invoices set issue_date = '2027-04-01' where id = $1", [
        april,
      ])
    )
    expect(await issue(dave, march)).toMatchObject({ number: 1, fy: "2026-27" })
    expect(await issue(dave, april)).toMatchObject({
      number: 1,
      fy: "2027-28",
      number_text: "INV/27-28/001",
    })
  })
})

describe("AT-TR-01 ledger entries and invoices", () => {
  const ENTRY_DENIED: [string, string][] = [
    ["confirmed", "draft"],
    ["confirmed", "needs_review"],
    ["void", "draft"],
    ["void", "confirmed"],
    ["needs_review", "void"],
  ]

  it.each(ENTRY_DENIED)("ledger entry %s → %s raises", async (from, to) => {
    const { rows } = await entry(alice, {}, (sql, params) => pg.query(sql, params))
    const id = rows[0].id
    // Walk it to `from` along allowed steps, as the server
    if (from === "confirmed" || from === "void")
      await pg.query(
        "update kriya.ledger_entries set status = 'confirmed', confirmed_at = now() where id = $1",
        [id]
      )
    if (from === "void")
      await pg.query("update kriya.ledger_entries set status = 'void' where id = $1", [
        id,
      ])
    if (from === "needs_review")
      await pg.query(
        "update kriya.ledger_entries set status = 'needs_review' where id = $1",
        [id]
      )
    await expect(
      pg.query("update kriya.ledger_entries set status = $2 where id = $1", [id, to])
    ).rejects.toThrow(/can't go from|can only be voided/)
  })

  it.each([
    ["draft", "paid"],
    ["draft", "void"],
    ["paid", "issued"],
    ["void", "issued"],
    ["paid", "void"],
  ])("invoice %s → %s raises", async (from, to) => {
    const id = await invoice(alice)
    if (from !== "draft") await issue(alice, id)
    if (from === "paid" || from === "void")
      await pg.query("update kriya.invoices set status = $2 where id = $1", [id, from])
    await expect(
      pg.query("update kriya.invoices set status = $2 where id = $1", [id, to])
    ).rejects.toThrow(/can't go from|check/)
  })

  it("a confirmed entry's amounts can't change", async () => {
    const { rows } = await entry(alice)
    await pg.query(
      "update kriya.ledger_entries set status = 'confirmed', confirmed_at = now() where id = $1",
      [rows[0].id]
    )
    await expect(
      pg.query(
        "update kriya.ledger_entries set taxable_paise = 1, cgst_paise = 0, sgst_paise = 0, total_paise = 1 where id = $1",
        [rows[0].id]
      )
    ).rejects.toThrow(/can only be voided/)
  })
})

describe("AT-RLS-A ledger tables", () => {
  it("entries are born draft or needing review, never confirmed", async () => {
    await expect(
      entry(alice, { status: "confirmed", confirmed_at: new Date().toISOString() })
    ).rejects.toThrow(/row-level security/)
  })

  it("another person finds, changes and deletes nothing", async () => {
    const { rows } = await entry(alice, { counterparty: "Only Alice" })
    const id = rows[0].id
    const seen = await asUser(pg, bob, (tx) =>
      tx.query("select id from kriya.ledger_entries where id = $1", [id])
    )
    expect(seen.rows).toEqual([])
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.ledger_entries set counterparty = 'Bob' where id = $1", [id])
    )
    await asUser(pg, bob, (tx) =>
      tx.query("delete from kriya.ledger_entries where id = $1", [id])
    )
    const { rows: after } = await pg.query(
      "select counterparty from kriya.ledger_entries where id = $1",
      [id]
    )
    expect(after).toEqual([{ counterparty: "Only Alice" }])

    const inv = await invoice(alice)
    await expect(issue(bob, inv)).rejects.toThrow(/invoice not found/)
    const series = await asUser(pg, bob, (tx) =>
      tx.query("select * from kriya.invoice_series")
    )
    expect(series.rows).toEqual([])
  })

  it("claim checks are written by the server and read only by their person", async () => {
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('cc', $1, 'A', 'r', 'g')",
      [alice]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('cct', $1, 'cc')",
      [alice]
    )
    const { rows } = await pg.query<{ id: string }>(
      "insert into kriya.episodes (user_id, thread_id, seq, hash) values ($1, 'cct', 99, 'h') returning id",
      [alice]
    )
    await pg.query(
      "insert into kriya.claim_checks (user_id, episode_id, sentence, verdict, model) values ($1, $2, 's', 'supported', 'm')",
      [alice, rows[0].id]
    )
    const own = await asUser(pg, alice, (tx) =>
      tx.query("select * from kriya.claim_checks")
    )
    expect(own.rows).toHaveLength(1)
    const other = await asUser(pg, bob, (tx) =>
      tx.query("select * from kriya.claim_checks")
    )
    expect(other.rows).toEqual([])
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.claim_checks (user_id, episode_id, sentence, verdict, model) values ($1, $2, 't', 'supported', 'm')",
          [alice, rows[0].id]
        )
      )
    ).rejects.toThrow(/permission denied/)
  })
})
