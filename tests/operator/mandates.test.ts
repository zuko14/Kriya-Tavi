import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { PERSON_ONLY_WRITES, TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import { MAX_OPEN_PROPOSALS, proposeMandate } from "@/lib/operator/mandates"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Job proposals (O3, TOOLS_AND_CONTRACTS §1.1) on PGlite. OT-MND-01: every
// refusal the contract lists. OT-MND-02: a valid proposal is only a row;
// nothing is granted, scheduled or started. OT-POL-01: the new tools write
// nothing only the person may write.

let pg: TestDb
let alice: string
let bob: string

const env = (user = alice, taskId = "00000000-0000-4000-8000-000000000001") => ({
  userId: user,
  threadId: user === alice ? "t1" : "tb",
  taskId,
  agentId: user === alice ? "a1" : "b1",
})

const valid = (extra: Record<string, unknown> = {}) => ({
  title: "Get 2 overdue invoices paid",
  objective: "Remind each client by email and chase until paid.",
  criteria: [
    {
      text: "A reminder draft for each client",
      evidence: { kind: "tool_verified", tool: "gmail_draft", atLeast: 2 },
    },
    { text: "The client said yes", evidence: { kind: "person_confirmed" } },
  ],
  grants: [
    {
      tool: "gmail_draft",
      pins: { to: [" Client@Example.com ", "other@example.com"] },
      maxUses: 6,
      why: "Reminder drafts",
    },
  ],
  dueInDays: 14,
  ...extra,
})

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from kriya.${table}`)).rows[0]
    .n

let numbered = 0
const invoice = async (user: string, status = "issued") => {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, cgst_paise, sgst_paise, total_paise, issue_date)
     values ($1, '{"name":"Studio","state_code":"29"}', '{"name":"Client","state_code":"29"}', '29',
             '[{"description":"Design","qty_milli":1000,"rate_paise":100000,"tax_rate_bps":1800}]',
             100000, 9000, 9000, 118000, '2026-10-18') returning id`,
    [user]
  )
  // Issued and later invoices carry their permanent number
  if (status !== "draft")
    await pg.query(
      `update kriya.invoices set status = $2, fy = '2026-27', number = $3, number_text = $4
       where id = $1`,
      [rows[0].id, status, ++numbered, `INV/${numbered}`]
    )
  return rows[0].id
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  // Invoices need a plan with the ledger
  await pg.query("update kriya.plans set ledger_enabled = true")
  for (const [user, agent, thread] of [
    [alice, "a1", "t1"],
    [bob, "b1", "tb"],
  ]) {
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Lekha', 'r', 'g')",
        [agent, user]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
        [thread, user, agent]
      )
    })
  }
})

describe("refusals (OT-MND-01)", () => {
  const refused = async (input: unknown, field: RegExp) => {
    const result = await proposeMandate(env(), input)
    expect(result, JSON.stringify(result)).toHaveProperty("error")
    if (!("error" in result)) return
    expect(Object.keys(result.fields).join(" "), result.error).toMatch(field)
    expect(await count("mandates")).toBe(0)
  }

  it("a tool that isn't grantable", () =>
    refused(
      valid({
        grants: [{ tool: "github_comment", pins: { repo: "x/y" }, maxUses: 1, why: "w" }],
      }),
      /grants\.0\.tool/
    ))

  it("an R4 tool or propose_call, whatever the pins", async () => {
    for (const tool of [
      "instagram_publish",
      "propose_call",
      "schedule_create",
      "browser_click",
    ])
      await refused(
        valid({ grants: [{ tool, pins: { to: ["a@b.co"] }, maxUses: 1, why: "w" }] }),
        /grants\.0\.tool/
      )
  })

  it("a missing pin, an unknown pin, or an empty recipient list", async () => {
    await refused(
      valid({
        grants: [
          {
            tool: "sheets_update",
            pins: { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW" },
            maxUses: 1,
            why: "w",
          },
        ],
      }),
      /grants\.0\.pins/
    )
    await refused(
      valid({
        grants: [
          {
            tool: "gmail_draft",
            pins: { to: ["a@b.co"], bcc: ["x@y.co"] },
            maxUses: 1,
            why: "w",
          },
        ],
      }),
      /grants\.0\.pins/
    )
    await refused(
      valid({
        grants: [{ tool: "gmail_draft", pins: { to: [] }, maxUses: 1, why: "w" }],
      }),
      /grants\.0\.pins/
    )
  })

  it("maxUses 51, dueInDays 31, a check-in more often than daily", async () => {
    await refused(
      valid({
        grants: [
          { tool: "gmail_draft", pins: { to: ["a@b.co"] }, maxUses: 51, why: "w" },
        ],
      }),
      /grants\.0\.maxUses/
    )
    await refused(valid({ dueInDays: 31 }), /dueInDays/)
    await refused(valid({ checkIn: { freq: "interval", everyMinutes: 60 } }), /checkIn/)
  })

  it("an unknown evidence kind, or a tool_verified criterion that can never be met", async () => {
    await refused(
      valid({ criteria: [{ text: "Vibes", evidence: { kind: "model_says_so" } }] }),
      /criteria\.0\.evidence/
    )
    await refused(
      valid({
        criteria: [
          { text: "Searched", evidence: { kind: "tool_verified", tool: "gmail_search" } },
        ],
      }),
      /criteria\.0\.evidence/
    )
    await refused(
      valid({
        criteria: [
          { text: "Paid", evidence: { kind: "tool_verified", tool: "pay_now" } },
        ],
      }),
      /criteria\.0\.evidence/
    )
  })

  it("another person's invoice, a draft invoice, or invoice_paid with none listed", async () => {
    const paid = { text: "Paid", evidence: { kind: "invoice_paid" } }
    await refused(
      valid({ criteria: [paid], subjects: { invoices: [await invoice(bob)] } }),
      /subjects\.invoices/
    )
    await refused(
      valid({
        criteria: [paid],
        subjects: { invoices: [await invoice(alice, "draft")] },
      }),
      /subjects\.invoices/
    )
    await refused(valid({ criteria: [paid] }), /subjects\.invoices/)
  })

  it(`more than ${MAX_OPEN_PROPOSALS} open proposals`, async () => {
    for (let i = 0; i < MAX_OPEN_PROPOSALS; i++) {
      const result = await proposeMandate(env(), valid({ title: `Job ${i}` }))
      expect(result).toHaveProperty("mandateId")
    }
    const result = await proposeMandate(env(), valid({ title: "One too many" }))
    expect(result).toHaveProperty("error")
    expect(await count("mandates")).toBe(MAX_OPEN_PROPOSALS)
  })
})

describe("a valid proposal (OT-MND-02)", () => {
  it("is only a proposed row: no goal, grant or schedule, nothing approved", async () => {
    const invoiceId = await invoice(alice)
    const result = await proposeMandate(
      env(),
      valid({
        budgetInr: 500,
        checkIn: { freq: "daily", at: "09:30" },
        subjects: { invoices: [invoiceId] },
      })
    )
    if (!("mandateId" in result)) throw new Error(JSON.stringify(result))
    expect(result.quote).toBeNull()
    expect(result.note).toMatch(/can't approve it/)
    const { rows } = await pg.query<Record<string, unknown>>(
      "select * from kriya.mandates where id = $1",
      [result.mandateId]
    )
    expect(rows[0]).toMatchObject({
      user_id: alice,
      status: "proposed",
      proposed_by: "agent",
      origin_thread_id: "t1",
      agent_id: "a1",
      goal_id: null,
      approved_at: null,
      budget_micro_inr: 500000000,
      check_in: { freq: "daily", at: "09:30" },
      subjects: { invoices: [invoiceId] },
      task_id: "00000000-0000-4000-8000-000000000001",
    })
    // Criteria get ids from code; recipients are normalised
    expect(rows[0].criteria).toEqual([
      expect.objectContaining({
        id: "c1",
        evidence: expect.objectContaining({ kind: "tool_verified" }),
      }),
      expect.objectContaining({ id: "c2", evidence: { kind: "person_confirmed" } }),
    ])
    expect(rows[0].proposed_grants).toEqual([
      {
        tool: "gmail_draft",
        pins: { to: ["client@example.com", "other@example.com"] },
        maxUses: 6,
        why: "Reminder drafts",
      },
    ])
    for (const table of ["goals", "grants", "grant_uses", "schedules", "tasks"])
      expect(await count(table), table).toBe(0)
  })

  it("is one proposal when the same task proposes the same title twice", async () => {
    const first = await proposeMandate(env(), valid())
    const again = await proposeMandate(env(), valid())
    expect(again).toEqual(first)
    expect(await count("mandates")).toBe(1)
    // Another task's proposal is its own
    await proposeMandate(env(alice, "00000000-0000-4000-8000-000000000002"), valid())
    expect(await count("mandates")).toBe(2)
  })

  it("lives only in its own person's data", async () => {
    const result = await proposeMandate(env(), valid())
    if (!("mandateId" in result)) throw new Error(JSON.stringify(result))
    const seen = await asUser(pg, bob, (tx) => tx.query("select id from kriya.mandates"))
    expect(seen.rows).toEqual([])
  })
})

describe("the new tools and the person's columns (OT-POL-01)", () => {
  it("are classed R1/R0, write only proposals, and aren't grantable", () => {
    expect(TOOL_CLASSES.mandate_propose).toBe("R1")
    expect(TOOL_CLASSES.mandate_status).toBe("R0")
    expect(TOOL_WRITES.mandate_propose).toEqual(["mandates+"])
    expect(TOOL_WRITES.mandate_status).toEqual([])
    expect(CAPABILITIES.mandate_propose.grantable).toBe(false)
    expect(CAPABILITIES.mandate_status.grantable).toBe(false)
  })

  it("job decisions, ticks, grants and grant uses are the person's alone", () => {
    for (const write of [
      "mandates.status:active",
      "mandates.status:declined",
      "mandates.status:revoked",
      "mandates.status:closed",
      "mandates.confirmed",
      "grants",
      "grant_uses",
    ])
      expect(PERSON_ONLY_WRITES).toContain(write)
  })
})

describe("module boundaries (CHANGE_IMPACT §4)", () => {
  it("lib/operator imports no next/*, connectors, secrets, browser or voice code", () => {
    const dir = path.join(process.cwd(), "lib", "operator")
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf8")
      const imports = [...source.matchAll(/from "([^"]+)"|import\("([^"]+)"\)/g)].map(
        (m) => m[1] ?? m[2]
      )
      for (const name of imports)
        expect(name, `${file}: ${name}`).not.toMatch(
          /^next(\/|$)|^@\/lib\/(connectors|secrets|browser|voice)(\/|$)/
        )
    }
  })
})
