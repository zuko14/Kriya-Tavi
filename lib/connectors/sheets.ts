import { ConnectorError, jsonOf, providerFetch, readBack } from "@/lib/connectors"

// Google Sheets (A8) on the person's Google connection, with the opt-in
// `spreadsheets` scope. Values are written RAW, never USER_ENTERED, so text
// read from mail or the web can't become a formula (=IMPORTXML and friends
// would send the sheet's contents elsewhere). Every write reads its range
// back. No Undo: rows may have shifted since (K3).

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/
const READ_ROWS = 500

type Values = { range?: string; values?: string[][] }

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
const trimmed = (rows: string[][]) => {
  const out = rows.map((row) => {
    const r = [...row]
    while (r.length && r.at(-1) === "") r.pop()
    return r
  })
  while (out.length && out.at(-1)!.length === 0) out.pop()
  return out
}
export const sameCells = (a: string[][], b: string[][]) =>
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
  rows: string[][]
) {
  const back = await sheets<Values>(userId, valuesUrl(spreadsheetId, range))
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
  {
    spreadsheetId,
    range,
    rows,
  }: { spreadsheetId: string; range: string; rows: string[][] }
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
  {
    spreadsheetId,
    range,
    rows,
  }: { spreadsheetId: string; range: string; rows: string[][] }
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
