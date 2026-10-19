import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { PERSON_ONLY_WRITES, TOOL_WRITES } from "@/lib/agent/policy"
import type { BrowserProvider } from "@/lib/browser/provider"
import { setBrowserProviderForTests } from "@/lib/browser/session"
import { objectPath, setFileStoreForTests, type FileStore } from "@/lib/files"
import { gstinCheckChar } from "@/lib/gst"
import {
  addEntries,
  computeInvoice,
  confirmEntries,
  createInvoiceDraft,
  editEntry,
  entriesCsv,
  exportPeriod,
  issueInvoice,
  reconcile,
  setInvoiceStatus,
  summarize,
  type Bill,
} from "@/lib/ledger"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// lib/ledger.ts (AD-16): code computes and reconciles every amount; the
// model's numbers only ever reach review reasons. AT-LED-02 end to end,
// AT-LED-04 through addEntries, AT-LED-05 summaries to the paisa, AT-LED-06
// only the person confirms, AT-LED-07 20 issues at once. Renderer and
// storage are in memory; all data is made up.

const gstin = (first14: string) => first14 + gstinCheckChar(first14)
const KA_VENDOR = gstin("29ABCDE1234F1Z") // Karnataka
const MH_VENDOR = gstin("27PQRST6789K1Z") // Maharashtra

let pg: TestDb
let alice: string
let bob: string
let objects: Map<string, Buffer>
let rendered: string[]

const bill = (extra: Partial<Bill> = {}): Bill => ({
  date: "2026-10-05",
  counterparty: "Fixture Power Ltd",
  gstin: KA_VENDOR,
  documentNo: "EB-1001",
  category: "Electricity",
  lines: [
    { description: "Electricity, September", amountPaise: 100_000, taxRateBps: 1800 },
  ],
  cgstPaise: 9_000,
  sgstPaise: 9_000,
  totalPaise: 118_000,
  ...extra,
})

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  await pg.query("update kriya.plans set ledger_enabled = true where id = 'free'")
  alice = await createUser(pg)
  bob = await createUser(pg)
  objects = new Map()
  rendered = []
  setFileStoreForTests({
    uploadUrl: async (p) => p,
    read: async (p) => objects.get(p) ?? null,
    write: async (p, b) => void objects.set(p, b),
    signedUrl: async (p) => p,
    remove: async (paths) => paths.forEach((p) => objects.delete(p)),
  } satisfies FileStore)
  setBrowserProviderForTests({
    renderPdf: async (html: string) => {
      rendered.push(html)
      return Buffer.from("%PDF-1.4\n%%EOF\n")
    },
  } as unknown as BrowserProvider)
})

afterEach(() => {
  setFileStoreForTests(undefined)
  setBrowserProviderForTests(null)
})

describe("reconcile", () => {
  it("a clean intra-state bill is a draft with code-computed taxes", () => {
    const r = reconcile(bill(), { stateCode: "29" })
    expect(r.status).toBe("draft")
    expect(r.reasons).toEqual([])
    expect(r.values).toMatchObject({
      taxablePaise: 100_000,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      igstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 118_000,
      placeOfSupply: "29",
    })
  })

  it("AT-LED-02: a bill from another State is IGST, and CGST on it is flagged", () => {
    const igst = reconcile(
      bill({
        gstin: MH_VENDOR,
        cgstPaise: undefined,
        sgstPaise: undefined,
        igstPaise: 18_000,
      }),
      { stateCode: "29" }
    )
    expect(igst).toMatchObject({
      status: "draft",
      values: { igstPaise: 18_000, cgstPaise: 0 },
    })
    const wrong = reconcile(bill({ gstin: MH_VENDOR }), { stateCode: "29" })
    expect(wrong.status).toBe("needs_review")
    expect(wrong.reasons).toContain("CGST on the bill is ₹90.00; its rates give ₹0.00.")
    // Code's numbers are what's stored
    expect(wrong.values).toMatchObject({ igstPaise: 18_000, cgstPaise: 0, sgstPaise: 0 })
  })

  it("uses the bill's total within ₹1 as round-off, and flags a bigger gap", () => {
    const rounded = reconcile(
      bill({
        lines: [{ description: "x", amountPaise: 99_960, taxRateBps: 1800 }],
        cgstPaise: undefined,
        sgstPaise: undefined,
        totalPaise: 118_000,
      }),
      { stateCode: "29" }
    )
    // 99,960 + 2 × 8,996 = 1,17,952 → round-off +48 paise
    expect(rounded).toMatchObject({
      status: "draft",
      values: { roundOffPaise: 48, totalPaise: 118_000 },
    })
    const off = reconcile(bill({ totalPaise: 128_000 }), { stateCode: "29" })
    expect(off.status).toBe("needs_review")
    expect(off.reasons).toContain(
      "Value before tax plus taxes is ₹1,180.00; the bill says ₹1,280.00."
    )
    expect(off.values).toMatchObject({ totalPaise: 118_000, roundOffPaise: 0 })
  })

  it("flags tax without a GSTIN, a doubtful GSTIN, lines that don't add up, and low confidence", () => {
    expect(reconcile(bill({ gstin: undefined }), { stateCode: "29" }).reasons).toContain(
      "Tax is charged but the bill has no valid GSTIN."
    )
    const typo = KA_VENDOR.slice(0, 14) + (KA_VENDOR[14] === "A" ? "B" : "A")
    expect(reconcile(bill({ gstin: typo }), { stateCode: "29" }).status).toBe(
      "needs_review"
    )
    expect(
      reconcile(bill({ taxablePaise: 90_000 }), { stateCode: "29" }).reasons
    ).toContain("The lines add up to ₹1,000.00; the bill says ₹900.00 before tax.")
    expect(
      reconcile(bill({ confidence: { totalPaise: 0.6, date: 0.99 } }), {
        stateCode: "29",
      }).reasons
    ).toEqual(["Kriya isn't sure it read the total right."])
  })

  it("labels Union territory tax UTGST", () => {
    const ch = gstin("04ABCDE1234F1Z")
    // No rates on the line: the stated taxes are checked against the states
    const r = reconcile(
      bill({
        gstin: ch,
        lines: [{ description: "Rent", amountPaise: 100_000 }],
        igstPaise: 18_000,
        cgstPaise: undefined,
        sgstPaise: undefined,
      }),
      { stateCode: "04" }
    )
    expect(r.reasons).toContain(
      "IGST on a supply within one State; expected CGST and UTGST."
    )
  })
})

describe("entries", () => {
  it("AT-LED-04: the same bill isn't added twice", async () => {
    const first = await addEntries(alice, [bill()], {
      createdBy: "agent",
      stateCode: "29",
    })
    expect(first.added).toHaveLength(1)
    const again = await addEntries(alice, [bill(), bill({ documentNo: "EB-1002" })], {
      createdBy: "agent",
      stateCode: "29",
    })
    expect(again.duplicates).toEqual([{ index: 0, existingId: first.added[0].id }])
    expect(again.added).toHaveLength(1)
  })

  it("AT-LED-06: entries are never born confirmed; the person confirms; no tool can", async () => {
    const { added } = await addEntries(
      alice,
      [bill(), bill({ documentNo: "EB-2", totalPaise: 128_000 })],
      { createdBy: "agent", stateCode: "29" }
    )
    const [clean, flagged] = added
    expect(flagged.status).toBe("needs_review")
    // Without a note only the clean draft is confirmed
    expect(await confirmEntries(alice, [clean.id, flagged.id])).toEqual([
      { id: clean.id },
    ])
    expect(await confirmEntries(alice, [flagged.id], "Checked the paper bill")).toEqual([
      { id: flagged.id },
    ])
    // Another person confirms nothing of Alice's
    expect(await confirmEntries(bob, [clean.id], "x")).toEqual([])
    // No agent tool writes the person-only status (AT-POL-07)
    expect(PERSON_ONLY_WRITES).toContain("ledger_entries.status:confirmed")
    // A tool may insert drafts (ledger_draft_entry: "ledger_entries+", born
    // draft or needs_review by the insert policy); none may change status
    for (const [tool, writes] of Object.entries(TOOL_WRITES)) {
      expect(
        writes.filter(
          (w) => w.startsWith("ledger_entries.") || w.startsWith("invoices.")
        ),
        tool
      ).toEqual([])
    }
  })

  it("editing reconciles again and can clear the review", async () => {
    const { added } = await addEntries(alice, [bill({ totalPaise: 128_000 })], {
      createdBy: "agent",
      stateCode: "29",
    })
    expect(await editEntry(alice, added[0].id, bill(), "29")).toEqual({
      id: added[0].id,
      status: "draft",
    })
  })
})

describe("AT-LED-05 summaries equal hand-computed totals", () => {
  it("counts confirmed entries in the period only, to the paisa", async () => {
    const dataset: Bill[] = [
      bill({ documentNo: "A1" }), // 1,000 + 90 + 90 = 1,180.00
      bill({
        documentNo: "A2",
        category: "Internet",
        lines: [{ description: "Fibre", amountPaise: 60_000, taxRateBps: 1800 }],
        cgstPaise: 5_400,
        sgstPaise: 5_400,
        totalPaise: 70_800,
      }),
      bill({
        documentNo: "A3",
        gstin: MH_VENDOR,
        category: "Internet",
        lines: [{ description: "Cloud", amountPaise: 33_333, taxRateBps: 1800 }],
        cgstPaise: undefined,
        sgstPaise: undefined,
        igstPaise: 6_000,
        totalPaise: 39_333,
      }),
      bill({ documentNo: "A4", date: "2026-11-01" }), // outside the period
      bill({ documentNo: "A5" }), // stays a draft
    ]
    const { added } = await addEntries(alice, dataset, {
      createdBy: "user",
      stateCode: "29",
    })
    await confirmEntries(
      alice,
      added.slice(0, 4).map((a) => a.id)
    )
    const byCategory = await summarize(
      alice,
      { from: "2026-10-01", to: "2026-10-31" },
      "category"
    )
    expect(byCategory).toEqual([
      {
        kind: "expense",
        key: "Electricity",
        entries: 1,
        taxablePaise: 100_000,
        cgstPaise: 9_000,
        sgstPaise: 9_000,
        igstPaise: 0,
        cessPaise: 0,
        totalPaise: 118_000,
      },
      {
        kind: "expense",
        key: "Internet",
        entries: 2,
        // 60,000 + 33,333; IGST 18 % of 33,333 = 5,999.94 → 6,000
        taxablePaise: 93_333,
        cgstPaise: 5_400,
        sgstPaise: 5_400,
        igstPaise: 6_000,
        cessPaise: 0,
        totalPaise: 110_133,
      },
    ])
    // Another person's summary is empty
    expect(await summarize(bob, { from: "2026-10-01", to: "2026-10-31" })).toEqual([])
  })
})

describe("invoices", () => {
  const input = {
    supplier: {
      name: "Fixture Studio",
      gstin: gstin("29ABCDE1234F1Z"),
      address: "Bengaluru",
      state_code: "29",
    },
    client: {
      name: "Client Pvt Ltd",
      gstin: MH_VENDOR,
      address: "Pune",
      state_code: "27",
    },
    items: [
      {
        description: "Design, hours",
        hsnSac: "998391",
        qtyMilli: 12_500,
        ratePaise: 150_000,
        taxRateBps: 1800,
      },
    ],
    issueDate: "2026-10-18",
  }

  it("computes amounts and taxes by code (inter-state → IGST)", () => {
    const c = computeInvoice(input)
    // 12.5 h × ₹1,500 = ₹18,750; IGST 18 % = ₹3,375
    expect(c).toMatchObject({
      taxablePaise: 1_875_000,
      igstPaise: 337_500,
      cgstPaise: 0,
      totalPaise: 2_212_500,
    })
  })

  it("AT-LED-07: 20 issued at once get 1…20 with no gap or repeat", async () => {
    const drafts = []
    for (let i = 0; i < 20; i++) drafts.push(await createInvoiceDraft(alice, input))
    const issued = await Promise.all(drafts.map((d) => issueInvoice(alice, d.id)))
    const numbers = issued.map((r) => r.invoice.number!).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(new Set(issued.map((r) => r.invoice.numberText)).size).toBe(20)
    expect(issued.every((r) => r.pdfFileId)).toBe(true)
  })

  it("issuing records the income, makes a tax-invoice PDF, and voiding removes the income", async () => {
    const draft = await createInvoiceDraft(alice, input)
    const { invoice, pdfFileId } = await issueInvoice(alice, draft.id)
    expect(invoice).toMatchObject({ status: "issued", numberText: "INV/26-27/001" })
    expect(objects.has(objectPath({ userId: alice, id: pdfFileId! }))).toBe(true)
    expect(rendered[0]).toContain("Tax invoice")
    expect(rendered[0]).toContain("Place of supply: Maharashtra (27)")
    expect(rendered[0]).toContain("₹22,125.00")
    expect(rendered[0]).toContain("Review with your CA")
    const { rows } = await pg.query<{ status: string; total_paise: string }>(
      "select status, total_paise::text from kriya.ledger_entries where id = $1",
      [invoice.ledgerEntryId]
    )
    expect(rows).toEqual([{ status: "draft", total_paise: "2212500" }])
    // Issuing again is harmless
    expect((await issueInvoice(alice, draft.id)).invoice.number).toBe(1)
    expect(await setInvoiceStatus(alice, draft.id, "void")).toMatchObject({
      status: "void",
    })
    const after = await pg.query<{ status: string }>(
      "select status from kriya.ledger_entries where id = $1",
      [invoice.ledgerEntryId]
    )
    expect(after.rows).toEqual([{ status: "void" }])
  })

  it("an issue without the renderer keeps the number and says why there's no PDF", async () => {
    setBrowserProviderForTests(null)
    const draft = await createInvoiceDraft(alice, input)
    const result = await issueInvoice(alice, draft.id)
    expect(result.invoice.status).toBe("issued")
    expect(result.pdfError).toMatch(/PDFs aren't available/)
  })
})

describe("export for the CA", () => {
  it("writes a CSV (formula-safe) and a PDF summary of confirmed entries", async () => {
    const { added } = await addEntries(
      alice,
      [bill({ counterparty: '=HYPERLINK("x")', documentNo: "B1" })],
      { createdBy: "user", stateCode: "29" }
    )
    await confirmEntries(alice, [added[0].id])
    const result = await exportPeriod(alice, { from: "2026-10-01", to: "2026-10-31" })
    expect(result).toMatchObject({
      csvFileId: expect.any(String),
      pdfFileId: expect.any(String),
    })
    const csv = objects
      .get(objectPath({ userId: alice, id: result.csvFileId }))!
      .toString()
    expect(csv.split("\r\n")[1]).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain("1180.00")
    expect(rendered.at(-1)).toContain("1 confirmed entries")
    expect(entriesCsv([]).trim().split(",")[0]).toBe("Date")
  })
})
