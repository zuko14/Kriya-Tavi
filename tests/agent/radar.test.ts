import fs from "node:fs"
import path from "node:path"

import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createRadarTools } from "@/lib/agent/tools"
import { PERSON_ONLY_WRITES, TOOL_WRITES } from "@/lib/agent/policy"
import {
  checkObligation,
  dateInQuote,
  reminderChannel,
  reminderTimes,
} from "@/lib/radar/extract"
import { markMissed, markObligation, upcomingObligations } from "@/lib/radar/obligations"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Kriya Radar (K4). AT-RAD-01: no date without a verbatim quote that holds
// it. AT-RAD-02: lead times in IST across month and year ends. AT-RAD-03:
// templates hold no dates. AT-RAD-04: reminders only by phone (voice) or in
// Kriya. Plus: only the person closes a deadline; the worker marks missed.

const NOTICE =
  "Important dates: Online registration for GATE 2027 closes on 10 October 2026 (Saturday). Late fee window ends 17 October 2026."

let pg: TestDb
let user: string

const tools = () =>
  createRadarTools(
    { current: () => ({ id: "a1" }) as schema.Agent, userId: user, threadId: "t1" },
    { radar: true, facts: true }
  )

// The conversation the tool sees: a web page read, and the person's words
const conversation = (
  personSaid = "My bike insurance ends on 5 March 2027."
): ModelMessage[] => [
  { role: "user", content: personSaid },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "web_fetch",
        output: {
          type: "json",
          value: { url: "https://gate.example.ac.in", markdown: NOTICE },
        },
      },
    ],
  },
]

const add = (input: Record<string, unknown>, id = "call-1", messages = conversation()) =>
  tools().obligation_add!.execute!(
    {
      kind: "exam_registration",
      title: "GATE registration",
      sourceKind: "official_page",
      sourceRef: "https://gate.example.ac.in/dates",
      ...input,
    } as never,
    { toolCallId: id, messages } as never
  ) as unknown as Promise<{
    verified: boolean
    reasons?: string[]
    obligationId: string | null
  }>

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

describe("AT-RAD-01 no date without a verbatim quote", () => {
  it("a quote found word for word, holding the date, is verified", async () => {
    const r = await add({
      dueAt: "2026-10-10T23:59:00+05:30",
      quote: "registration for GATE 2027 closes on 10 October 2026",
    })
    expect(r).toMatchObject({ verified: true })
    expect(r.reasons).toBeUndefined()
  })

  it("a paraphrase, an invented quote, or a quote without the date is not", async () => {
    const paraphrase = await add(
      { dueAt: "2026-10-10T23:59:00+05:30", quote: "GATE registration ends 10 Oct" },
      "c2"
    )
    expect(paraphrase.verified).toBe(false)
    expect(paraphrase.reasons).toContain(
      "The quote wasn't found word for word in the source."
    )
    const wrongDate = await add(
      { dueAt: "2026-10-11T23:59:00+05:30", quote: "closes on 10 October 2026" },
      "c3"
    )
    expect(wrongDate.reasons).toEqual(["The quote doesn't contain the due date."])
    const { rows } = await pg.query<{ verified: boolean }>(
      "select quote, verified from kriya.obligations order by created_at"
    )
    // Stored, but marked: the Radar shows "Not verified"
    expect(rows.map((r) => r.verified)).toEqual([false, false])
  })

  it("the person's own words count only as their words", async () => {
    const own = await add(
      {
        kind: "vehicle_renewal",
        title: "Bike insurance",
        sourceKind: "person",
        sourceRef: "person",
        dueAt: "2027-03-05T09:00:00+05:30",
        quote: "My bike insurance ends on 5 March 2027.",
      },
      "c4"
    )
    expect(own.verified).toBe(true)
    // A page's text isn't the person's words
    const notTheirs = await add(
      {
        sourceKind: "person",
        sourceRef: "person",
        dueAt: "2026-10-10T23:59:00+05:30",
        quote: "closes on 10 October 2026",
      },
      "c5"
    )
    expect(notTheirs.verified).toBe(false)
  })

  it("recognises the common ways Indian notices write a date", () => {
    const due = new Date("2026-10-10T18:00:00+05:30")
    for (const q of [
      "Last date: 10 October 2026",
      "last date is 10th Oct, 2026",
      "closes October 10, 2026",
      "on 10/10/2026",
      "on 10-10-2026",
      "on 10.10.2026",
      "deadline 2026-10-10",
    ]) {
      expect(dateInQuote(due, q), q).toBe(true)
    }
    for (const q of [
      "on 1/10/2026",
      "on 10 October 2025",
      "on 110/10/2026",
      "on 10 November 2026",
    ]) {
      expect(dateInQuote(due, q), q).toBe(false)
    }
    // A 23:30 UTC moment is the next day in India
    expect(dateInQuote(new Date("2026-10-09T23:30:00Z"), "on 10 October 2026")).toBe(true)
    expect(checkObligation({ dueAt: due, quote: "x" }, []).verified).toBe(false)
  })
})

describe("AT-RAD-02 lead times in IST across month and year ends", () => {
  const ist = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d)

  it("7 and 1 days before, at 9:00 India time", () => {
    expect(reminderTimes(new Date("2026-03-03T10:00:00+05:30"), [7, 1]).map(ist)).toEqual(
      ["2026-02-24, 09:00", "2026-03-02, 09:00"]
    )
    expect(reminderTimes(new Date("2027-01-01T00:30:00+05:30"), [7, 1]).map(ist)).toEqual(
      ["2026-12-25, 09:00", "2026-12-31, 09:00"]
    )
    // Due 1 March in a leap year: 7 days before is 23 February
    expect(reminderTimes(new Date("2028-03-01T12:00:00+05:30"), [7, 1]).map(ist)).toEqual(
      ["2028-02-23, 09:00", "2028-02-29, 09:00"]
    )
  })

  it("uses the Indian calendar day even when UTC is still the day before", () => {
    // 1 Nov 00:15 IST is 31 Oct in UTC
    expect(reminderTimes(new Date("2026-11-01T00:15:00+05:30"), [1]).map(ist)).toEqual([
      "2026-10-31, 09:00",
    ])
  })
})

describe("AT-RAD-03 templates contain no dates", () => {
  it("the templates file has no date in any common form", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/radar/templates.ts"),
      "utf8"
    )
    const months =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i
    expect(source).not.toMatch(months)
    expect(source).not.toMatch(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b20\d\d-\d\d-\d\d\b/)
  })
})

describe("AT-RAD-04 reminders only by phone (voice) or in Kriya", () => {
  it("the channel is in-app until voice reminders are live", () => {
    expect(reminderChannel()).toBe("in_app")
    expect(reminderChannel(true)).toBe("voice_call")
  })

  it("no Radar code reaches any other channel", () => {
    const files = [
      "lib/radar/extract.ts",
      "lib/radar/obligations.ts",
      "lib/radar/templates.ts",
      "actions/radar.ts",
      "app/(workspace)/radar/page.tsx",
    ]
    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8").toLowerCase()
      // `.push(` is an array method, not a channel
      expect(source, file).not.toMatch(
        /(?<![.\w])(push|sms|whatsapp|e-?mail|nodemailer|resend|twilio)\b/
      )
    }
  })
})

describe("closing deadlines", () => {
  it("only the person marks done or dismissed; the worker marks missed", async () => {
    await add(
      { dueAt: "2026-10-10T23:59:00+05:30", quote: "closes on 10 October 2026" },
      "c6"
    )
    await add(
      {
        dueAt: "2026-10-17T23:59:00+05:30",
        quote: "Late fee window ends 17 October 2026",
      },
      "c7"
    )
    expect(PERSON_ONLY_WRITES).toEqual(
      expect.arrayContaining(["obligations.status:done", "obligations.status:dismissed"])
    )
    expect(TOOL_WRITES.obligation_add).toEqual(["obligations+"])
    const [first, second] = await upcomingObligations(user)
    expect(await markObligation(user, first.id, "dismissed")).toBe(true)
    expect(await markObligation(user, first.id, "done")).toBe(false)
    expect(await markMissed(new Date("2026-10-20T00:00:00+05:30"))).toBe(1)
    expect(await markObligation(user, second.id, "dismissed")).toBe(false)
    expect(await markObligation(user, second.id, "done")).toBe(true)
    const other = await createUser(pg)
    expect(await markObligation(other, second.id, "done")).toBe(false)
  })
})
