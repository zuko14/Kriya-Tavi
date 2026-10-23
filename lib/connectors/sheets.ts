import { ConnectorError, jsonOf, providerFetch, readBack } from "@/lib/connectors"

// Google Sheets (A8) on the person's Google connection, with the opt-in
// `spreadsheets` scope. Values are written RAW, never USER_ENTERED, so text
// read from mail or the web can't become a formula (=IMPORTXML and friends
// would send the sheet's contents elsewhere); numbers go as JSON numbers, so
// RAW stores them as numbers that sum. Every write reads its range back
// unformatted. No Undo: rows may have shifted since (K3).

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/
const READ_ROWS = 500

type Cell = string | number
type Values = { range?: string; values?: Cell[][] }

async function sheets<T>(
  userId: string,
  url: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await providerFetch(userId, "google", url, init)
  if (response.status === 403) {
    throw new ConnectorError(
      "Google refused this: the spreadsheet isn't shared with the person, or Sheets access wasn't granted. They can add Sheets in Account → Connected accounts."
    )
  }
  if (response.status === 404) throw new ConnectorError("That spreadsheet wasn't found.")
  return jsonOf<T>(response, "The Sheets request")
}

const valuesUrl = (id: string, range: string, suffix = "") =>
  `${SHEETS}/${id}/values/${encodeURIComponent(range)}${suffix}`

// Google leaves out trailing empty cells and rows when it reads a range
const trimmed = (rows: Cell[][]) => {
  const out = rows.map((row) => {
    const r = [...row]
    while (r.length && r.at(-1) === "") r.pop()
    return r
  })
  while (out.length && out.at(-1)!.length === 0) out.pop()
  return out
}
export const sameCells = (a: Cell[][], b: Cell[][]) =>
  JSON.stringify(trimmed(a)) === JSON.stringify(trimmed(b))

const link = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`

export async function sheetsRead(
  userId: string,
  { spreadsheetId, range }: { spreadsheetId: string; range: string }
) {
  const data = await sheets<Values>(userId, valuesUrl(spreadsheetId, range))
  const rows = data.values ?? []
  return {
    range: data.range ?? range,
    rows: rows.slice(0, READ_ROWS),
    ...(rows.length > READ_ROWS && { truncated: rows.length }),
  }
}

async function check(
  userId: string,
  spreadsheetId: string,
  range: string,
  rows: Cell[][]
) {
  const back = await sheets<Values>(
    userId,
    valuesUrl(spreadsheetId, range, "?valueRenderOption=UNFORMATTED_VALUE")
  )
  return readBack(
    sameCells(back.values ?? [], rows),
    [
      { kind: "url", value: link(spreadsheetId) },
      { kind: "provider_id", value: range },
    ],
    `Read back from Google Sheets: ${range} holds these values.`
  )
}

export async function sheetsAppend(
  userId: string,
  { spreadsheetId, range, rows }: { spreadsheetId: string; range: string; rows: Cell[][] }
) {
  const data = await sheets<{
    updates?: { updatedRange?: string; updatedRows?: number }
  }>(
    userId,
    valuesUrl(
      spreadsheetId,
      range,
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"
    ),
    { method: "POST", body: { values: rows } }
  )
  const updated = data.updates?.updatedRange
  if (!updated) throw new ConnectorError("Google didn't say where the rows went.")
  return {
    range: updated,
    rows: data.updates?.updatedRows ?? rows.length,
    verification: await check(userId, spreadsheetId, updated, rows),
  }
}

export async function sheetsUpdate(
  userId: string,
  { spreadsheetId, range, rows }: { spreadsheetId: string; range: string; rows: Cell[][] }
) {
  const data = await sheets<{ updatedRange?: string }>(
    userId,
    valuesUrl(spreadsheetId, range, "?valueInputOption=RAW"),
    { method: "PUT", body: { range, values: rows } }
  )
  const updated = data.updatedRange ?? range
  return {
    range: updated,
    verification: await check(userId, spreadsheetId, updated, rows),
  }
}

/* ─────────────────────────── new spreadsheets ───────────────────── */

export const COLUMN_TYPES = ["text", "date", "amount", "number", "percent"] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]
export const CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const
const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£" } as const
// Letters, digits, spaces and plain punctuation: no quotes or `!`, so a tab
// name is always a safe A1 prefix
export const TAB_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _&().,-]{0,49}$/u

type Tab = { name: string; columns: { name: string; type: ColumnType }[] }

const WIDTH: Record<ColumnType, number> = {
  text: 220,
  date: 110,
  amount: 130,
  number: 110,
  percent: 100,
}
const HEADER_BG = { red: 0.89, green: 0.91, blue: 0.98 }
const BAND = { red: 0.97, green: 0.97, blue: 0.99 }
const WHITE = { red: 1, green: 1, blue: 1 }

const numberFormat = (type: ColumnType, currency?: (typeof CURRENCIES)[number]) =>
  type === "amount"
    ? { type: "CURRENCY", pattern: `${currency ? SYMBOL[currency] : ""}#,##0.00` }
    : type === "number"
      ? { type: "NUMBER", pattern: "#,##0.##" }
      : type === "percent"
        ? { type: "PERCENT", pattern: "0.##%" }
        : type === "date"
          ? { type: "DATE", pattern: "yyyy-mm-dd" }
          : { type: "TEXT" }

// A spreadsheet laid out for record keeping: a bold, shaded, frozen header
// row, column widths and number formats by type, amounts right-aligned and
// alternating row colours. Headers are string values, never formulas.
export async function sheetsCreate(
  userId: string,
  {
    title,
    tabs,
    currency,
  }: { title: string; tabs: Tab[]; currency?: (typeof CURRENCIES)[number] }
) {
  const created = await sheets<{ spreadsheetId?: string; spreadsheetUrl?: string }>(
    userId,
    SHEETS,
    {
      method: "POST",
      body: {
        properties: { title },
        sheets: tabs.map((tab, sheetId) => ({
          properties: {
            sheetId,
            title: tab.name,
            gridProperties: {
              rowCount: 1000,
              columnCount: tab.columns.length,
              frozenRowCount: 1,
            },
          },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: tab.columns.map((column) => ({
                    userEnteredValue: { stringValue: column.name },
                    userEnteredFormat: {
                      textFormat: { bold: true },
                      backgroundColor: HEADER_BG,
                      horizontalAlignment: column.type === "text" ? "LEFT" : "CENTER",
                      verticalAlignment: "MIDDLE",
                      wrapStrategy: "WRAP",
                    },
                  })),
                },
              ],
              columnMetadata: tab.columns.map((column) => ({
                pixelSize: WIDTH[column.type],
              })),
            },
          ],
        })),
      },
    }
  )
  const id = created.spreadsheetId
  if (!id) throw new ConnectorError("Google didn't return the new spreadsheet.")
  // Formats for the body rows. The spreadsheet exists by now, so a failure
  // here is reported, not thrown: the person still gets its link.
  let formatted = true
  try {
    await sheets(userId, `${SHEETS}/${id}:batchUpdate`, {
      method: "POST",
      body: {
        requests: tabs.flatMap((tab, sheetId) => [
          ...tab.columns.map((column, index) => ({
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1,
                startColumnIndex: index,
                endColumnIndex: index + 1,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: numberFormat(column.type, currency),
                  horizontalAlignment: column.type === "text" ? "LEFT" : "RIGHT",
                  verticalAlignment: "MIDDLE",
                },
              },
              fields:
                "userEnteredFormat(numberFormat,horizontalAlignment,verticalAlignment)",
            },
          })),
          {
            addBanding: {
              bandedRange: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: tab.columns.length,
                },
                rowProperties: {
                  headerColor: HEADER_BG,
                  firstBandColor: WHITE,
                  secondBandColor: BAND,
                },
              },
            },
          },
        ]),
      },
    })
  } catch {
    formatted = false
  }
  const back = await sheets<{ valueRanges?: Values[] }>(
    userId,
    `${SHEETS}/${id}/values:batchGet?${tabs
      .map((tab) => `ranges=${encodeURIComponent(`'${tab.name}'!1:1`)}`)
      .join("&")}`
  )
  const same = tabs.every((tab, i) =>
    sameCells(back.valueRanges?.[i]?.values ?? [], [tab.columns.map((c) => c.name)])
  )
  return {
    spreadsheetId: id,
    url: created.spreadsheetUrl ?? link(id),
    tabs: tabs.map((tab) => tab.name),
    ...(!formatted && {
      note: "The spreadsheet was made but Google refused the column formats; it works, only plainer.",
    }),
    verification: readBack(
      same && formatted,
      [
        { kind: "url", value: link(id) },
        { kind: "provider_id", value: id },
      ],
      same
        ? `Read back from Google Sheets: ${tabs.length} tab(s) with the approved headers${formatted ? ", formatted" : "; the formats weren't applied"}.`
        : "Read back from Google Sheets: the headers differ from the approved ones."
    ),
  }
}

/* ─────────────────────────────── totals ─────────────────────────── */

const TOTAL_ROWS = 50_000
const SKIPPED_SHOWN = 20
// Google's date serial numbers count days from 1899-12-30
const SERIAL_EPOCH = Date.UTC(1899, 11, 30)

// An amount in hundredths, or null. Accepts what people type: ₹1,200.50,
// -45, (45.00), 1200. Numbers are the cell's own value (UNFORMATTED_VALUE).
export function toCents(value: Cell | undefined): bigint | null {
  if (typeof value === "number") {
    // Cells hold at most a few decimals; rounding the float to hundredths is exact for them
    return Number.isFinite(value) ? BigInt(Math.round(value * 100)) : null
  }
  if (typeof value !== "string") return null
  let text = value.replace(/[\s,₹$€£]|Rs\.?|INR|USD/gi, "")
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-")
  text = text.replace(/^[(-]+|\)$/g, "")
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))
  return negative ? -cents : cents
}

// yyyy-mm-dd, from a date cell's serial number or ISO text; anything else
// (23/10/2026 could be either order) is null rather than a guess
export function toIsoDate(value: Cell | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(SERIAL_EPOCH + Math.floor(value) * 86_400_000)
      .toISOString()
      .slice(0, 10)
  }
  if (typeof value !== "string") return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

export const formatCents = (cents: bigint) => {
  const sign = cents < 0n ? "-" : ""
  const abs = cents < 0n ? -cents : cents
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`
}

const key = (value: Cell | undefined) =>
  String(value ?? "")
    .trim()
    .toLowerCase()

// Sums a column by code, never by the model: optionally by month or by
// another column, within dates, for rows where a column equals a value
export async function sheetsTotal(
  userId: string,
  input: {
    spreadsheetId: string
    sheet: string
    amount: string
    date?: string
    by?: string
    from?: string
    to?: string
    where?: { column: string; equals: string }
  }
) {
  const data = await sheets<Values>(
    userId,
    valuesUrl(
      input.spreadsheetId,
      `'${input.sheet}'`,
      "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER"
    )
  )
  const [header = [], ...body] = data.values ?? []
  const column = (name: string) => {
    const index = header.findIndex((cell) => key(cell) === key(name))
    if (index < 0) {
      throw new ConnectorError(
        `No column "${name}" in ${input.sheet}. Its columns: ${header.map(String).join(", ") || "none"}.`
      )
    }
    return index
  }
  const byMonth = input.by?.toLowerCase() === "month"
  if ((byMonth || input.from || input.to) && !input.date) {
    throw new ConnectorError("Name the date column to total by month or between dates.")
  }
  const amountAt = column(input.amount)
  const dateAt = input.date ? column(input.date) : null
  const byAt = input.by && !byMonth ? column(input.by) : null
  const whereAt = input.where ? column(input.where.column) : null

  let total = 0n
  let counted = 0
  const groups = new Map<string, { total: bigint; rows: number }>()
  const skipped: { row: number; reason: string }[] = []
  body.slice(0, TOTAL_ROWS).forEach((row, i) => {
    const rowNumber = i + 2
    if (row.every((cell) => cell === "" || cell == null)) return
    if (whereAt !== null && key(row[whereAt]) !== key(input.where!.equals)) return
    let day: string | null = null
    if (dateAt !== null) {
      day = toIsoDate(row[dateAt])
      if (!day && (byMonth || input.from || input.to)) {
        skipped.push({ row: rowNumber, reason: "date isn't yyyy-mm-dd" })
        return
      }
      if (day && ((input.from && day < input.from) || (input.to && day > input.to)))
        return
    }
    const cents = toCents(row[amountAt])
    if (cents === null) {
      skipped.push({ row: rowNumber, reason: "amount isn't a number" })
      return
    }
    total += cents
    counted++
    const group = byMonth
      ? day!.slice(0, 7)
      : byAt !== null
        ? String(row[byAt] ?? "").trim() || "(blank)"
        : null
    if (group !== null) {
      const g = groups.get(group) ?? { total: 0n, rows: 0 }
      g.total += cents
      g.rows++
      groups.set(group, g)
    }
  })
  return {
    sheet: input.sheet,
    rows: counted,
    total: formatCents(total),
    ...(groups.size > 0 && {
      groups: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, g]) => ({ group: name, total: formatCents(g.total), rows: g.rows })),
    }),
    ...(skipped.length > 0 && {
      skipped: skipped.length,
      skippedRows: skipped.slice(0, SKIPPED_SHOWN),
    }),
    ...(body.length > TOTAL_ROWS && { truncated: body.length }),
  }
}
