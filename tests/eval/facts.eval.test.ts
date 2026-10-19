import fs from "node:fs"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { lookupFacts, recordFactFetch, type FactTarget } from "@/lib/facts"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// AS-FCT (TEST_AND_EVALUATION §4): 20 scripted fact-job histories on
// PGlite: official pages with changing dates, conflicting fetches, fetches
// too close together, look-alike domains, retraction and expiry. Truth is
// what the page said on two agreeing fetches an hour apart, else nothing.
// Metric F1 = facts served that aren't the truth (or served when nothing
// should be). Target 0. A person's task writing a fact is covered by
// AT-FCT-04 (no write path exists to script). KRIYA_EVAL_OUT writes results.

type Fetch = { hoursAgo: number; date: string }
type Scenario = {
  id: string
  what: string
  url?: string
  fetches: Fetch[]
  retract?: boolean
  ttlDays?: number
  truth: string | null
}

const OFFICIAL = "https://exam.example.gov.in/dates"
const S = (
  id: string,
  what: string,
  fetches: Fetch[],
  truth: string | null,
  extra: Partial<Scenario> = {}
): Scenario => ({
  id,
  what,
  fetches,
  truth,
  ...extra,
})
const f = (hoursAgo: number, date = "10 October 2026"): Fetch => ({ hoursAgo, date })

const SCENARIOS: Scenario[] = [
  S("AS-FCT-01", "two agreeing fetches 2 h apart", [f(3), f(1)], "10 October 2026"),
  S("AS-FCT-02", "one fetch only", [f(1)], null),
  S("AS-FCT-03", "second fetch 30 min later", [f(1), f(0.5)], null),
  S("AS-FCT-04", "exactly an hour apart", [f(2), f(1)], "10 October 2026"),
  S("AS-FCT-05", "three agreeing fetches", [f(5), f(3), f(1)], "10 October 2026"),
  S(
    "AS-FCT-06",
    "conflicting fetches",
    [f(3, "10 October 2026"), f(1, "12 October 2026")],
    null
  ),
  S(
    "AS-FCT-07",
    "date moved, then confirmed",
    [f(6), f(4), f(3, "17 October 2026"), f(1, "17 October 2026")],
    "17 October 2026"
  ),
  S(
    "AS-FCT-08",
    "date moved once at the end",
    [f(6), f(4), f(1, "17 October 2026")],
    null
  ),
  S(
    "AS-FCT-09",
    "flip-flopping page",
    [f(6), f(4, "12 October 2026"), f(2), f(0.5, "12 October 2026")],
    null
  ),
  S("AS-FCT-10", "look-alike domain gate-2027-info.in", [f(3), f(1)], null, {
    url: "https://gate-2027-info.in/dates",
  }),
  S("AS-FCT-11", "allow-listed suffix inside another domain", [f(3), f(1)], null, {
    url: "https://gov.in.example.com/dates",
  }),
  S("AS-FCT-12", "domain ending in 'gov.in' without the dot", [f(3), f(1)], null, {
    url: "https://examplegov.in/dates",
  }),
  S("AS-FCT-13", "nic.in subdomain", [f(3), f(1)], "10 October 2026", {
    url: "https://results.example.nic.in/dates",
  }),
  S("AS-FCT-14", "retracted by the owner", [f(3), f(1)], null, { retract: true }),
  S("AS-FCT-15", "expired", [f(3), f(1)], null, { ttlDays: 0 }),
  S(
    "AS-FCT-16",
    "pattern missing on the page",
    [
      { hoursAgo: 3, date: "" },
      { hoursAgo: 1, date: "" },
    ],
    null
  ),
  S(
    "AS-FCT-17",
    "pattern missing once, then two agreeing",
    [{ hoursAgo: 5, date: "" }, f(3), f(1)],
    "10 October 2026"
  ),
  S(
    "AS-FCT-18",
    "two fetches 55 min apart, then a third",
    [f(2), f(1.1), f(0.05)],
    "10 October 2026"
  ),
  S(
    "AS-FCT-19",
    "state government page",
    [f(3, "1 November 2026"), f(1, "1 November 2026")],
    "1 November 2026",
    { url: "https://scholarships.example.gov.in/last-date" }
  ),
  S("AS-FCT-20", "plain-http link to an official page", [f(3), f(1)], null, {
    url: "http://exam.example.gov.in/dates",
  }),
]

const PAGE = (date: string) =>
  date
    ? `Notice\nOnline registration closes on ${date}.\nHelpdesk: 9am to 5pm`
    : "Notice\nDates will be announced soon."

let pg: TestDb
let user: string
const results: { id: string; ok: boolean; f1: number }[] = []

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

afterAll(() => {
  const summary = {
    suite: "AS-FCT",
    n: results.length,
    passed: results.filter((r) => r.ok).length,
    F1: results.reduce((a, r) => a + r.f1, 0),
  }
  console.info(JSON.stringify(summary))
  if (process.env.KRIYA_EVAL_OUT)
    fs.writeFileSync(
      process.env.KRIYA_EVAL_OUT,
      JSON.stringify({ summary, results }, null, 2)
    )
})

describe("AS-FCT", () => {
  it.each(SCENARIOS)("$id $what", async (s) => {
    const key = `eval.${s.id.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
    const target: FactTarget = {
      key,
      url: s.url ?? OFFICIAL,
      pattern: /registration closes on (?<value>\d{1,2} [A-Z][a-z]+ \d{4})/,
      ttlDays: s.ttlDays,
    }
    for (const fetch of s.fetches) {
      // An http URL never even reaches the database writer in the job; it
      // would be refused by the URL check anyway
      if (!target.url.startsWith("https://")) continue
      await recordFactFetch(
        target,
        PAGE(fetch.date),
        new Date(Date.now() - fetch.hoursAgo * 3_600_000)
      )
    }
    if (s.retract) {
      await pg.query(
        "update kriya.public_facts set retracted_at = now() where key = $1",
        [key]
      )
    }
    const served = (await lookupFacts(user, { key }))[0]?.value ?? null
    const f1 = served !== null && served !== s.truth ? 1 : 0
    const ok = served === s.truth
    results.push({ id: s.id, ok, f1 })
    expect(served).toBe(s.truth)
  })

  it("F1 = 0 over all 20", () => {
    expect(results).toHaveLength(20)
    expect(results.reduce((a, r) => a + r.f1, 0)).toBe(0)
  })
})
