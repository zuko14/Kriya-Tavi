import fs from "node:fs"

import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createRadarTools } from "@/lib/agent/tools"
import { reminderTimes } from "@/lib/radar/extract"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// AS-RAD (TEST_AND_EVALUATION §4): 15 scripted deadlines through the real
// obligation_add tool: from official pages, Gmail notices and the person,
// with exact, paraphrased and wrong quotes, and month-end and year-end
// lead times. Each scenario states by hand whether code must mark it
// verified and when its reminders fall (IST). Target: 15/15.

const IST = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)

type Case = {
  id: string
  what: string
  source: "official_page" | "gmail" | "person"
  read: string // what the tool or the person said
  quote: string
  dueAt: string
  verified: boolean
  reminders: string[] // IST dates for lead days 7 and 1
}

const PAGE =
  "NEET-PG 2027: Applications open till 31 January 2027, 11:59 PM. Correction window: 03/02/2027 to 05/02/2027."
const MAIL =
  "Dear customer, your two-wheeler policy expires on 1st March 2027. Renew before 28 February 2027 to keep your no-claim bonus."
const GST = "GSTR-3B for October 2026 is due on 20.11.2026 for monthly filers."

const CASES: Case[] = [
  {
    id: "AS-RAD-01",
    what: "official page, exact quote",
    source: "official_page",
    read: PAGE,
    quote: "Applications open till 31 January 2027",
    dueAt: "2027-01-31T23:59:00+05:30",
    verified: true,
    reminders: ["2027-01-24", "2027-01-30"],
  },
  {
    id: "AS-RAD-02",
    what: "official page, numeric date",
    source: "official_page",
    read: PAGE,
    quote: "Correction window: 03/02/2027 to 05/02/2027",
    dueAt: "2027-02-05T23:59:00+05:30",
    verified: true,
    reminders: ["2027-01-29", "2027-02-04"],
  },
  {
    id: "AS-RAD-03",
    what: "official page, paraphrase",
    source: "official_page",
    read: PAGE,
    quote: "Applications close end of January 2027",
    dueAt: "2027-01-31T23:59:00+05:30",
    verified: false,
    reminders: ["2027-01-24", "2027-01-30"],
  },
  {
    id: "AS-RAD-04",
    what: "official page, wrong day for the quote",
    source: "official_page",
    read: PAGE,
    quote: "Applications open till 31 January 2027",
    dueAt: "2027-01-30T23:59:00+05:30",
    verified: false,
    reminders: ["2027-01-23", "2027-01-29"],
  },
  {
    id: "AS-RAD-05",
    what: "GST notice, dotted date",
    source: "official_page",
    read: GST,
    quote: "GSTR-3B for October 2026 is due on 20.11.2026",
    dueAt: "2026-11-20T23:59:00+05:30",
    verified: true,
    reminders: ["2026-11-13", "2026-11-19"],
  },
  {
    id: "AS-RAD-06",
    what: "Gmail notice, ordinal date",
    source: "gmail",
    read: MAIL,
    quote: "your two-wheeler policy expires on 1st March 2027",
    dueAt: "2027-03-01T00:00:00+05:30",
    verified: true,
    reminders: ["2027-02-22", "2027-02-28"],
  },
  {
    id: "AS-RAD-07",
    what: "Gmail notice, month end (Feb, not leap)",
    source: "gmail",
    read: MAIL,
    quote: "Renew before 28 February 2027",
    dueAt: "2027-02-28T23:59:00+05:30",
    verified: true,
    reminders: ["2027-02-21", "2027-02-27"],
  },
  {
    id: "AS-RAD-08",
    what: "Gmail quote not in the mail",
    source: "gmail",
    read: MAIL,
    quote: "policy expires on 2 March 2027",
    dueAt: "2027-03-02T00:00:00+05:30",
    verified: false,
    reminders: ["2027-02-23", "2027-03-01"],
  },
  {
    id: "AS-RAD-09",
    what: "person's own words",
    source: "person",
    read: "Rent is due on 5 November 2026.",
    quote: "Rent is due on 5 November 2026.",
    dueAt: "2026-11-05T10:00:00+05:30",
    verified: true,
    reminders: ["2026-10-29", "2026-11-04"],
  },
  {
    id: "AS-RAD-10",
    what: "person, year end",
    source: "person",
    read: "My passport expires on 1 January 2027",
    quote: "My passport expires on 1 January 2027",
    dueAt: "2027-01-01T00:00:00+05:30",
    verified: true,
    reminders: ["2026-12-25", "2026-12-31"],
  },
  {
    id: "AS-RAD-11",
    what: "person, quote they didn't say",
    source: "person",
    read: "Remind me about the fee",
    quote: "Fee due on 10 December 2026",
    dueAt: "2026-12-10T10:00:00+05:30",
    verified: false,
    reminders: ["2026-12-03", "2026-12-09"],
  },
  {
    id: "AS-RAD-12",
    what: "page text claimed as the person's",
    source: "person",
    read: "ok",
    quote: "Applications open till 31 January 2027",
    dueAt: "2027-01-31T23:59:00+05:30",
    verified: false,
    reminders: ["2027-01-24", "2027-01-30"],
  },
  {
    id: "AS-RAD-13",
    what: "due just after midnight IST (UTC still the day before)",
    source: "person",
    read: "Exam form closes on 1 December 2026, 00:30.",
    quote: "Exam form closes on 1 December 2026",
    dueAt: "2026-12-01T00:30:00+05:30",
    verified: true,
    reminders: ["2026-11-24", "2026-11-30"],
  },
  {
    id: "AS-RAD-14",
    what: "leap-year month end",
    source: "person",
    read: "Fees by 29 February 2028",
    quote: "Fees by 29 February 2028",
    dueAt: "2028-02-29T17:00:00+05:30",
    verified: true,
    reminders: ["2028-02-22", "2028-02-28"],
  },
  {
    id: "AS-RAD-15",
    what: "a quote with no date in it",
    source: "official_page",
    read: PAGE,
    quote: "NEET-PG 2027",
    dueAt: "2027-01-31T23:59:00+05:30",
    verified: false,
    reminders: ["2027-01-24", "2027-01-30"],
  },
]

let pg: TestDb
let user: string
const results: { id: string; ok: boolean }[] = []

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

afterAll(() => {
  const summary = {
    suite: "AS-RAD",
    n: results.length,
    passed: results.filter((r) => r.ok).length,
  }
  console.info(JSON.stringify(summary))
  if (process.env.KRIYA_EVAL_OUT)
    fs.writeFileSync(
      process.env.KRIYA_EVAL_OUT,
      JSON.stringify({ summary, results }, null, 2)
    )
})

describe("AS-RAD", () => {
  it.each(CASES)("$id $what", async (c) => {
    const messages: ModelMessage[] =
      c.source === "person"
        ? [{ role: "user", content: c.read }]
        : [
            { role: "user", content: "Track this deadline" },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "c",
                  toolName: c.source === "gmail" ? "gmail_read" : "web_fetch",
                  output: { type: "json", value: { text: c.read } },
                },
              ],
            },
          ]
    const tools = createRadarTools(
      { current: () => ({ id: "a1" }) as schema.Agent, userId: user, threadId: "t1" },
      { radar: true, facts: false }
    )
    const result = (await tools.obligation_add!.execute!(
      {
        kind: "other",
        title: c.what,
        dueAt: c.dueAt,
        quote: c.quote,
        sourceKind: c.source,
        sourceRef: c.source === "person" ? "person" : `ref-${c.id}`,
      } as never,
      { toolCallId: c.id, messages } as never
    )) as { verified: boolean }
    const reminders = reminderTimes(new Date(c.dueAt), [7, 1]).map(IST)
    const ok =
      result.verified === c.verified &&
      JSON.stringify(reminders) === JSON.stringify(c.reminders)
    results.push({ id: c.id, ok })
    expect(result.verified).toBe(c.verified)
    expect(reminders).toEqual(c.reminders)
  })

  it("15/15", () => {
    expect(results).toHaveLength(15)
    expect(results.every((r) => r.ok)).toBe(true)
  })
})
