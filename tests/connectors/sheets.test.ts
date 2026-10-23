import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  formatCents,
  sheetsAppend,
  sheetsCreate,
  sheetsTotal,
  TAB_NAME,
  toCents,
  toIsoDate,
} from "@/lib/connectors/sheets"

import { connectedUser, serve } from "./fixtures"

// Creating a formatted spreadsheet and totalling one in code. Fixtures are
// written from the Sheets v4 documented shapes; no live call is made.

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
const API = "https://sheets.googleapis.com/v4/spreadsheets"
// Request bodies are deep JSON; any keeps the assertions readable
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

let userId: string
beforeAll(async () => {
  ;({ userId } = await connectedUser(["google"]))
})
afterEach(() => vi.unstubAllGlobals())

const EXPENSES = {
  name: "Expenses",
  columns: [
    { name: "Date", type: "date" as const },
    { name: "Description", type: "text" as const },
    { name: "Category", type: "text" as const },
    { name: "Amount", type: "amount" as const },
  ],
}

describe("sheets_create", () => {
  it("makes a frozen, formatted header and verifies it by reading it back", async () => {
    const calls = serve([
      {
        method: "POST",
        url: new RegExp(`^${esc(API)}$`),
        body: { spreadsheetId: SHEET_ID, spreadsheetUrl: "https://docs.google.com/x" },
      },
      { method: "POST", url: new RegExp(`${SHEET_ID}:batchUpdate$`), body: {} },
      {
        url: new RegExp(`${SHEET_ID}/values:batchGet\\?ranges=`),
        body: {
          valueRanges: [{ values: [["Date", "Description", "Category", "Amount"]] }],
        },
      },
    ])
    const result = await sheetsCreate(userId, {
      title: "Company expenses 2026",
      tabs: [EXPENSES],
      currency: "INR",
    })
    const sheet = (calls[0].body as { sheets: Record<string, Json>[] }).sheets[0]
    expect(sheet.properties.gridProperties.frozenRowCount).toBe(1)
    const header = sheet.data[0].rowData[0].values
    expect(header[0].userEnteredValue).toEqual({ stringValue: "Date" })
    expect(header[0].userEnteredFormat.textFormat.bold).toBe(true)
    const requests = (calls[1].body as { requests: Record<string, Json>[] }).requests
    const amount = requests[3].repeatCell
    expect(amount.cell.userEnteredFormat.numberFormat).toEqual({
      type: "CURRENCY",
      pattern: "₹#,##0.00",
    })
    expect(amount.cell.userEnteredFormat.horizontalAlignment).toBe("RIGHT")
    expect(requests.some((r) => "addBanding" in r)).toBe(true)
    expect(decodeURIComponent(calls[2].url)).toContain("'Expenses'!1:1")
    expect(result).toMatchObject({ spreadsheetId: SHEET_ID, tabs: ["Expenses"] })
    expect(result.verification.status).toBe("verified")
  })

  it("still returns the new sheet when the formats are refused, as unverified", async () => {
    serve([
      {
        method: "POST",
        url: new RegExp(`^${esc(API)}$`),
        body: { spreadsheetId: SHEET_ID },
      },
      { method: "POST", url: /:batchUpdate$/, status: 400, body: { error: "bad" } },
      {
        url: /values:batchGet/,
        body: {
          valueRanges: [{ values: [["Date", "Description", "Category", "Amount"]] }],
        },
      },
    ])
    const result = await sheetsCreate(userId, { title: "T", tabs: [EXPENSES] })
    expect(result.spreadsheetId).toBe(SHEET_ID)
    expect(result.note).toMatch(/formats/)
    expect(result.verification.status).toBe("failed")
  })

  it("tab names can't carry quotes or ranges", () => {
    expect(TAB_NAME.test("Expenses 2026")).toBe(true)
    expect(TAB_NAME.test("Bills & dues (Q3)")).toBe(true)
    expect(TAB_NAME.test("x'!A1")).toBe(false)
    expect(TAB_NAME.test("=SUM(A1)")).toBe(false)
  })
})

describe("numbers go to Sheets as numbers", () => {
  it("appends a numeric amount as a JSON number and reads back unformatted", async () => {
    const rows = [["2026-10-01", "Office rent", "Rent", 45000]]
    const calls = serve([
      {
        method: "POST",
        url: /:append\?/,
        body: { updates: { updatedRange: "Expenses!A2:D2", updatedRows: 1 } },
      },
      { url: /UNFORMATTED_VALUE$/, body: { values: rows } },
    ])
    const result = await sheetsAppend(userId, {
      spreadsheetId: SHEET_ID,
      range: "Expenses",
      rows,
    })
    expect(calls[0].body).toEqual({ values: rows })
    expect(result.verification.status).toBe("verified")
  })
})

describe("sheets_total", () => {
  const values = [
    ["Date", "Description", "Category", "Amount"],
    ["2026-09-28", "Hosting", "Software", 1200.5],
    [46296, "Rent", "Rent", 45000], // serial for 2026-10-01
    ["2026-10-05", "Tea", "Office", "₹1,250.75"],
    ["2026-10-09", "Refund", "Software", "(200)"],
    ["05/10/2026", "Courier", "Office", 300],
    ["2026-10-12", "Snacks", "Office", "about 500"],
    ["", "", "", ""],
  ]
  const answer = () =>
    serve([{ url: /UNFORMATTED_VALUE&dateTimeRenderOption/, body: { values } }])

  it("totals by month in exact hundredths and reports rows it couldn't read", async () => {
    answer()
    const result = await sheetsTotal(userId, {
      spreadsheetId: SHEET_ID,
      sheet: "Expenses",
      amount: "amount",
      date: "Date",
      by: "month",
    })
    expect(result.groups).toEqual([
      { group: "2026-09", total: "1200.50", rows: 1 },
      { group: "2026-10", total: "46050.75", rows: 3 },
    ])
    expect(result.total).toBe("47251.25")
    expect(result.skipped).toBe(2)
    expect(result.skippedRows).toEqual([
      { row: 6, reason: "date isn't yyyy-mm-dd" },
      { row: 7, reason: "amount isn't a number" },
    ])
  })

  it("filters by dates and a column, groups by category", async () => {
    answer()
    const result = await sheetsTotal(userId, {
      spreadsheetId: SHEET_ID,
      sheet: "Expenses",
      amount: "Amount",
      date: "Date",
      by: "Category",
      from: "2026-10-01",
      to: "2026-10-31",
      where: { column: "category", equals: "software" },
    })
    expect(result.total).toBe("-200.00")
    expect(result.groups).toEqual([{ group: "Software", total: "-200.00", rows: 1 }])
  })

  it("names the columns when one is missing", async () => {
    answer()
    await expect(
      sheetsTotal(userId, { spreadsheetId: SHEET_ID, sheet: "Expenses", amount: "Cost" })
    ).rejects.toThrow(/Its columns: Date, Description, Category, Amount/)
  })

  it("needs a date column for months", async () => {
    answer()
    await expect(
      sheetsTotal(userId, {
        spreadsheetId: SHEET_ID,
        sheet: "Expenses",
        amount: "Amount",
        by: "month",
      })
    ).rejects.toThrow(/date column/)
  })

  it("parses amounts and dates without guessing", () => {
    expect(toCents(19.99)).toBe(1999n)
    expect(toCents("Rs. 1,00,000")).toBe(10_000_000n)
    expect(toCents("-45.5")).toBe(-4550n)
    expect(toCents("12.345")).toBeNull()
    expect(toCents("")).toBeNull()
    expect(toIsoDate(46296)).toBe("2026-10-01")
    expect(toIsoDate("2026-10-23T10:00")).toBe("2026-10-23")
    expect(toIsoDate("23/10/2026")).toBeNull()
    expect(formatCents(-5n)).toBe("-0.05")
  })
})
