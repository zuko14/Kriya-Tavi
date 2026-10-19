import fs from "node:fs"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { gstinCheckChar } from "@/lib/gst"
import {
  addEntries,
  computeInvoice,
  confirmEntries,
  summarize,
  voidEntry,
  type Bill,
} from "@/lib/ledger"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// AS-LED (TEST_AND_EVALUATION §4): 25 scripted bills, duplicates,
// summaries and an invoice, through lib/ledger.ts on PGlite. Every
// expected amount is worked out by hand in the comments, not by the code
// under test. Metric L1 = ledger arithmetic errors: a stored total that
// isn't its parts plus round-off, or any amount that differs from the hand
// value. Target 0. L2 (extraction accuracy) needs a model on real-style
// bills and isn't measured here. KRIYA_EVAL_OUT=<file> writes the result.

const g = (first14: string) => first14 + gstinCheckChar(first14)
const KA = g("29ABCDE1234F1Z")
const MH = g("27PQRST6789K1Z")
const DL = g("07LMNOP4321Q1Z")
const CH = g("04FGHIJ5678L1Z")
const typo = (gstin: string) => gstin.slice(0, 14) + (gstin[14] === "A" ? "B" : "A")

type Want = {
  status: "draft" | "needs_review"
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess?: number
  roundOff: number
  total: number
  reason?: string
}

type BillCase = { id: string; what: string; bill: Bill; state?: string; want: Want }

const line = (amountPaise: number, taxRateBps?: number) => ({
  description: "Item",
  amountPaise,
  ...(taxRateBps !== undefined && { taxRateBps }),
})

const BILLS: BillCase[] = [
  // Clean bills (Karnataka supplier, the person in Karnataka)
  {
    id: "AS-LED-01",
    what: "18 % intra-state",
    bill: {
      date: "2026-10-02",
      gstin: KA,
      documentNo: "C1",
      category: "Power",
      lines: [line(100_000, 1800)],
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      totalPaise: 118_000,
    },
    // 9 % of ₹1,000 = ₹90 each
    want: {
      status: "draft",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
    },
  },
  {
    id: "AS-LED-02",
    what: "5 % intra-state",
    bill: {
      date: "2026-10-03",
      gstin: KA,
      documentNo: "C2",
      category: "Food",
      lines: [line(240_000, 500)],
      totalPaise: 252_000,
    },
    // 2.5 % of ₹2,400 = ₹60 each
    want: {
      status: "draft",
      taxable: 240_000,
      cgst: 6_000,
      sgst: 6_000,
      igst: 0,
      roundOff: 0,
      total: 252_000,
    },
  },
  {
    id: "AS-LED-03",
    what: "12 %, two lines, odd paise",
    bill: {
      date: "2026-10-04",
      gstin: KA,
      documentNo: "C3",
      category: "Office",
      lines: [line(50_000, 1200), line(25_050, 1200)],
      totalPaise: 84_056,
    },
    // 6 % of ₹500 = ₹30; 6 % of ₹250.50 = ₹15.03; each tax ₹45.03
    want: {
      status: "draft",
      taxable: 75_050,
      cgst: 4_503,
      sgst: 4_503,
      igst: 0,
      roundOff: 0,
      total: 84_056,
    },
  },
  {
    id: "AS-LED-04",
    what: "28 %, rounding up",
    bill: {
      date: "2026-10-05",
      gstin: KA,
      documentNo: "C4",
      category: "Office",
      lines: [line(199_999, 2800)],
      totalPaise: 255_999,
    },
    // 14 % of ₹1,999.99 = ₹279.9986 → ₹280.00 each
    want: {
      status: "draft",
      taxable: 199_999,
      cgst: 28_000,
      sgst: 28_000,
      igst: 0,
      roundOff: 0,
      total: 255_999,
    },
  },
  {
    id: "AS-LED-05",
    what: "exempt (0 %)",
    bill: {
      date: "2026-10-06",
      gstin: KA,
      documentNo: "C5",
      category: "Food",
      lines: [line(75_000, 0)],
      totalPaise: 75_000,
    },
    want: {
      status: "draft",
      taxable: 75_000,
      cgst: 0,
      sgst: 0,
      igst: 0,
      roundOff: 0,
      total: 75_000,
    },
  },
  // Photographed bills: the extractor wasn't sure
  {
    id: "AS-LED-06",
    what: "unsure of the total",
    bill: {
      date: "2026-10-07",
      gstin: KA,
      documentNo: "P1",
      lines: [line(100_000, 1800)],
      totalPaise: 118_000,
      confidence: { totalPaise: 0.7 },
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "Kriya isn't sure it read the total right.",
    },
  },
  {
    id: "AS-LED-07",
    what: "unsure of the GSTIN",
    bill: {
      date: "2026-10-07",
      gstin: KA,
      documentNo: "P2",
      lines: [line(100_000, 1800)],
      totalPaise: 118_000,
      confidence: { gstin: 0.5 },
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "Kriya isn't sure it read the GSTIN right.",
    },
  },
  {
    id: "AS-LED-08",
    what: "misread value before tax",
    bill: {
      date: "2026-10-08",
      gstin: KA,
      documentNo: "P3",
      lines: [line(100_000, 1800)],
      taxablePaise: 10_000,
      totalPaise: 118_000,
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "The lines add up to ₹1,000.00; the bill says ₹100.00 before tax.",
    },
  },
  // Missing or wrong GSTIN
  {
    id: "AS-LED-09",
    what: "tax without a GSTIN",
    bill: {
      date: "2026-10-09",
      documentNo: "G1",
      lines: [line(100_000)],
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      totalPaise: 118_000,
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "Tax is charged but the bill has no valid GSTIN.",
    },
  },
  {
    id: "AS-LED-10",
    what: "small shop, no GSTIN, no tax",
    bill: {
      date: "2026-10-09",
      documentNo: "G2",
      category: "Food",
      taxablePaise: 30_000,
      totalPaise: 30_000,
    },
    want: {
      status: "draft",
      taxable: 30_000,
      cgst: 0,
      sgst: 0,
      igst: 0,
      roundOff: 0,
      total: 30_000,
    },
  },
  {
    id: "AS-LED-11",
    what: "GSTIN with a wrong last character",
    bill: {
      date: "2026-10-10",
      gstin: typo(KA),
      documentNo: "G3",
      lines: [line(100_000, 1800)],
      totalPaise: 118_000,
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "Look it up on the GST portal.",
    },
  },
  // Inter-state and Union territory
  {
    id: "AS-LED-12",
    what: "inter-state 18 %",
    bill: {
      date: "2026-10-11",
      gstin: MH,
      documentNo: "I1",
      category: "Software",
      lines: [line(100_000, 1800)],
      totalPaise: 118_000,
    },
    want: {
      status: "draft",
      taxable: 100_000,
      cgst: 0,
      sgst: 0,
      igst: 18_000,
      roundOff: 0,
      total: 118_000,
    },
  },
  {
    id: "AS-LED-13",
    what: "inter-state 5 %, odd paise",
    bill: {
      date: "2026-10-12",
      gstin: DL,
      documentNo: "I2",
      category: "Software",
      lines: [line(33_333, 500)],
      totalPaise: 35_000,
    },
    // 5 % of ₹333.33 = ₹16.6665 → ₹16.67
    want: {
      status: "draft",
      taxable: 33_333,
      cgst: 0,
      sgst: 0,
      igst: 1_667,
      roundOff: 0,
      total: 35_000,
    },
  },
  {
    id: "AS-LED-14",
    what: "inter-state billed as CGST/SGST",
    bill: {
      date: "2026-10-13",
      gstin: MH,
      documentNo: "I3",
      lines: [line(100_000, 1800)],
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      totalPaise: 118_000,
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 0,
      sgst: 0,
      igst: 18_000,
      roundOff: 0,
      total: 118_000,
      reason: "CGST on the bill is ₹90.00; its rates give ₹0.00.",
    },
  },
  {
    id: "AS-LED-15",
    what: "within a Union territory (UTGST)",
    state: "04",
    bill: {
      date: "2026-10-14",
      gstin: CH,
      documentNo: "U1",
      category: "Rent",
      lines: [line(100_000, 1800)],
      totalPaise: 118_000,
    },
    want: {
      status: "draft",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
    },
  },
  // Round-off
  {
    id: "AS-LED-16",
    what: "round-off up",
    bill: {
      date: "2026-10-15",
      gstin: KA,
      documentNo: "R1",
      category: "Power",
      lines: [line(99_960, 1800)],
      totalPaise: 118_000,
    },
    // 9 % of ₹999.60 = ₹89.964 → ₹89.96 each; 99,960 + 17,992 = 1,17,952 → +48
    want: {
      status: "draft",
      taxable: 99_960,
      cgst: 8_996,
      sgst: 8_996,
      igst: 0,
      roundOff: 48,
      total: 118_000,
    },
  },
  {
    id: "AS-LED-17",
    what: "round-off down",
    bill: {
      date: "2026-10-16",
      gstin: KA,
      documentNo: "R2",
      category: "Power",
      lines: [line(100_030, 1800)],
      totalPaise: 118_000,
    },
    // 9 % of ₹1,000.30 = ₹90.027 → ₹90.03 each; 1,00,030 + 18,006 = 1,18,036 → −36
    want: {
      status: "draft",
      taxable: 100_030,
      cgst: 9_003,
      sgst: 9_003,
      igst: 0,
      roundOff: -36,
      total: 118_000,
    },
  },
  {
    id: "AS-LED-18",
    what: "total off by ₹2",
    bill: {
      date: "2026-10-17",
      gstin: KA,
      documentNo: "R3",
      lines: [line(100_000, 1800)],
      totalPaise: 118_200,
    },
    want: {
      status: "needs_review",
      taxable: 100_000,
      cgst: 9_000,
      sgst: 9_000,
      igst: 0,
      roundOff: 0,
      total: 118_000,
      reason: "the bill says ₹1,182.00",
    },
  },
  {
    id: "AS-LED-19",
    what: "28 % with cess",
    bill: {
      date: "2026-10-18",
      gstin: KA,
      documentNo: "R4",
      category: "Vehicle",
      lines: [line(100_000, 2800)],
      cessPaise: 12_000,
      totalPaise: 140_000,
    },
    want: {
      status: "draft",
      taxable: 100_000,
      cgst: 14_000,
      sgst: 14_000,
      igst: 0,
      cess: 12_000,
      roundOff: 0,
      total: 140_000,
    },
  },
]

const results: { id: string; ok: boolean; l1: number; note?: string }[] = []
let pg: TestDb
let user: string

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  await pg.query("update kriya.plans set ledger_enabled = true where id = 'free'")
  user = await createUser(pg)
})

afterAll(() => {
  const out = process.env.KRIYA_EVAL_OUT
  const l1 = results.reduce((a, r) => a + r.l1, 0)
  const summary = {
    suite: "AS-LED",
    n: results.length,
    passed: results.filter((r) => r.ok).length,
    L1: l1,
  }
  console.info(JSON.stringify(summary))
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2))
})

const row = async (id: string) =>
  (
    await pg.query<Record<string, string | null>>(
      `select status, taxable_paise::text t, cgst_paise::text c, sgst_paise::text s, igst_paise::text i,
              cess_paise::text x, round_off_paise::text r, total_paise::text total, review_reasons::text reasons
       from kriya.ledger_entries where id = $1`,
      [id]
    )
  ).rows[0]

const added: { id: string; date: string; category: string | null; want: Want }[] = []

describe("AS-LED", () => {
  it.each(BILLS)("$id $what", async ({ id, bill, state, want }) => {
    const { added: rows } = await addEntries(user, [bill], {
      createdBy: "agent",
      stateCode: state ?? "29",
    })
    const r = await row(rows[0].id)
    const got = [r.t, r.c, r.s, r.i, r.x, r.r, r.total].map(Number)
    const hand = [
      want.taxable,
      want.cgst,
      want.sgst,
      want.igst,
      want.cess ?? 0,
      want.roundOff,
      want.total,
    ]
    // L1: the stored total isn't its parts, or any amount isn't the hand value
    const l1 =
      (got[6] !== got[0] + got[1] + got[2] + got[3] + got[4] + got[5] ? 1 : 0) +
      hand.filter((v, i) => v !== got[i]).length
    const ok =
      l1 === 0 &&
      r.status === want.status &&
      (!want.reason || r.reasons!.includes(want.reason))
    results.push({ id, ok, l1 })
    added.push({ id: rows[0].id, date: bill.date, category: bill.category ?? null, want })
    expect(got).toEqual(hand)
    expect(r.status).toBe(want.status)
    if (want.reason) expect(r.reasons).toContain(want.reason)
  })

  it("AS-LED-20 the same bill twice is caught", async () => {
    const again = await addEntries(user, [BILLS[0].bill], {
      createdBy: "agent",
      stateCode: "29",
    })
    const ok = again.added.length === 0 && again.duplicates.length === 1
    results.push({ id: "AS-LED-20", ok, l1: 0 })
    expect(ok).toBe(true)
  })

  it("AS-LED-21 the same number from another vendor isn't a duplicate", async () => {
    const other = await addEntries(
      user,
      [{ ...BILLS[0].bill, gstin: MH, date: "2026-09-30" }],
      { createdBy: "agent", stateCode: "29" }
    )
    const ok = other.added.length === 1
    results.push({ id: "AS-LED-21", ok, l1: 0 })
    expect(ok).toBe(true)
  })

  it("AS-LED-22 after voiding, the bill can be entered again", async () => {
    const extra = await addEntries(
      user,
      [{ ...BILLS[0].bill, documentNo: "V1", date: "2026-09-29" }],
      { createdBy: "agent", stateCode: "29" }
    )
    await voidEntry(user, extra.added[0].id)
    const again = await addEntries(
      user,
      [{ ...BILLS[0].bill, documentNo: "V1", date: "2026-09-29" }],
      { createdBy: "agent", stateCode: "29" }
    )
    const ok = again.added.length === 1
    results.push({ id: "AS-LED-22", ok, l1: 0 })
    expect(ok).toBe(true)
  })

  it("AS-LED-23 summary by category equals the hand totals of confirmed October drafts", async () => {
    const drafts = added.filter((a) => a.want.status === "draft")
    await confirmEntries(
      user,
      drafts.map((d) => d.id)
    )
    const got = await summarize(
      user,
      { from: "2026-10-01", to: "2026-10-31" },
      "category"
    )
    // Hand totals per category from the `want` values above
    const hand = new Map<string, number[]>()
    for (const d of drafts) {
      const key = d.category ?? "Uncategorised"
      const w = d.want
      const prev = hand.get(key) ?? [0, 0, 0, 0, 0, 0]
      hand.set(key, [
        prev[0] + 1,
        prev[1] + w.taxable,
        prev[2] + w.cgst,
        prev[3] + w.sgst,
        prev[4] + w.igst,
        prev[5] + w.total,
      ])
    }
    let l1 = 0
    for (const s of got) {
      const h = hand.get(s.key)!
      const values = [
        s.entries,
        s.taxablePaise,
        s.cgstPaise,
        s.sgstPaise,
        s.igstPaise,
        s.totalPaise,
      ]
      l1 += values.filter((v, i) => v !== h[i]).length
    }
    l1 += Math.abs(got.length - hand.size)
    results.push({ id: "AS-LED-23", ok: l1 === 0, l1 })
    expect(l1).toBe(0)
    // Power: C1 1,180 + R1 1,180 + R2 1,180 = ₹3,540.00
    expect(got.find((s) => s.key === "Power")?.totalPaise).toBe(354_000)
  })

  it("AS-LED-24 entries needing review, voided ones and other months aren't counted", async () => {
    const all = await summarize(user, { from: "2026-09-01", to: "2026-10-31" })
    // September has only drafts (AS-LED-21) and a void; nothing confirmed
    const october = await summarize(user, { from: "2026-10-01", to: "2026-10-31" })
    const ok = JSON.stringify(all) === JSON.stringify(october)
    results.push({ id: "AS-LED-24", ok, l1: ok ? 0 : 1 })
    expect(ok).toBe(true)
  })

  it("AS-LED-25 invoice amounts and taxes", () => {
    const c = computeInvoice({
      supplier: { name: "Studio", state_code: "29" },
      client: { name: "Client", state_code: "29" },
      items: [
        // 3 × ₹1,250.00 = ₹3,750.00 at 18 %: ₹337.50 each
        { description: "Logo", qtyMilli: 3_000, ratePaise: 125_000, taxRateBps: 1800 },
        // 0.5 × ₹999.99 = ₹499.995 → ₹500.00 at 5 %: ₹12.50 each
        { description: "Edit", qtyMilli: 500, ratePaise: 99_999, taxRateBps: 500 },
      ],
    })
    const hand = {
      taxablePaise: 425_000,
      cgstPaise: 35_000,
      sgstPaise: 35_000,
      igstPaise: 0,
      totalPaise: 495_000,
    }
    const l1 = (Object.keys(hand) as (keyof typeof hand)[]).filter(
      (k) => c[k] !== hand[k]
    ).length
    results.push({ id: "AS-LED-25", ok: l1 === 0, l1 })
    expect(c).toMatchObject(hand)
  })

  it("L1 = 0 over all 25", () => {
    expect(results).toHaveLength(25)
    expect(results.reduce((a, r) => a + r.l1, 0)).toBe(0)
    expect(results.every((r) => r.ok)).toBe(true)
  })
})
