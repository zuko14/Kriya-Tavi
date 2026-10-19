import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { PERSON_ONLY_WRITES, TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import {
  factFromText,
  FACT_TARGETS,
  lookupFacts,
  recordFactFetch,
  runFactJob,
  type FactTarget,
} from "@/lib/facts"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// The public facts commons (K6). AT-FCT-01: the allow-list holds through
// the fact job too. AT-FCT-02: the quote is the page's own words.
// AT-FCT-03: served only after two agreeing fetches an hour apart.
// AT-FCT-04: no write path from a person's task. Pages are fixtures.

const GATE: FactTarget = {
  key: "exam.gate.2027.registration_close",
  url: "https://gate.example.gov.in/dates",
  pattern: /registration closes on (?<value>\d{1,2} [A-Z][a-z]+ \d{4})/,
}
const PAGE = (date: string) =>
  `GATE 2027\nOnline registration closes on ${date}.\nApplication fee details below.`

let pg: TestDb
let user: string
const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h))

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

describe("AT-FCT-02 the quote is the page's own words", () => {
  it("value and quote come from the text; nothing when the pattern isn't there", () => {
    expect(factFromText(GATE, PAGE("10 October 2026"))).toEqual({
      value: "10 October 2026",
      quote: "registration closes on 10 October 2026",
    })
    expect(factFromText(GATE, "Registration has closed.")).toBeNull()
  })
})

describe("AT-FCT-03 two agreeing fetches at least an hour apart", () => {
  it("isn't served after one fetch, nor after a second one too soon", async () => {
    expect(await recordFactFetch(GATE, PAGE("10 October 2026"), at(0))).toBe("added")
    expect(await lookupFacts(user, { key: GATE.key })).toEqual([])
    expect(await recordFactFetch(GATE, PAGE("10 October 2026"), at(0.5))).toBe("too_soon")
    expect(await lookupFacts(user, { key: GATE.key })).toEqual([])
  })

  it("is served after the second agreeing fetch, with its source and date", async () => {
    await recordFactFetch(
      GATE,
      PAGE("10 October 2026"),
      new Date(Date.now() - 2 * 3600_000)
    )
    expect(await recordFactFetch(GATE, PAGE("10 October 2026"))).toBe("confirmed")
    const [fact] = await lookupFacts(user, { query: "gate registration" })
    expect(fact).toMatchObject({
      value: "10 October 2026",
      quote: "registration closes on 10 October 2026",
      source_url: "https://gate.example.gov.in/dates",
    })
    expect(fact.note).toMatch(/^Read from gate\.example\.gov\.in on /)
  })

  it("a changed value starts again at one confirmation and stops being served", async () => {
    await recordFactFetch(
      GATE,
      PAGE("10 October 2026"),
      new Date(Date.now() - 3 * 3600_000)
    )
    await recordFactFetch(
      GATE,
      PAGE("10 October 2026"),
      new Date(Date.now() - 2 * 3600_000)
    )
    expect(await lookupFacts(user, { key: GATE.key })).toHaveLength(1)
    expect(await recordFactFetch(GATE, PAGE("17 October 2026"))).toBe("changed")
    expect(await lookupFacts(user, { key: GATE.key })).toEqual([])
  })
})

describe("AT-FCT-01 the allow-list holds in the fact job too", () => {
  it("a look-alike domain is rejected by the database", async () => {
    const lookalike = {
      ...GATE,
      key: "exam.gate.lookalike",
      url: "https://gate-2027-info.in/dates",
    }
    expect(await recordFactFetch(lookalike, PAGE("10 October 2026"))).toBe("rejected")
    const { rows } = await pg.query("select 1 from kriya.public_facts")
    expect(rows).toEqual([])
  })
})

describe("AT-FCT-04 no write path from a person's task", () => {
  it("no tool writes facts or is classed to; facts_lookup only reads", () => {
    expect(PERSON_ONLY_WRITES).toContain("public_facts")
    for (const [tool, writes] of Object.entries(TOOL_WRITES)) {
      expect(
        writes.filter((w) => w.startsWith("public_facts")),
        tool
      ).toEqual([])
    }
    expect(TOOL_CLASSES.facts_lookup).toBe("R0")
  })

  it("agent tools never import the fact writer", () => {
    const tools = fs.readFileSync(path.join(process.cwd(), "lib/agent/tools.ts"), "utf8")
    expect(tools).not.toMatch(/recordFactFetch|runFactJob/)
    expect(tools).toMatch(/import \{ lookupFacts \} from "@\/lib\/facts"/)
  })

  it("the fact job only fetches the owner's listed targets (none by default)", async () => {
    expect(FACT_TARGETS).toEqual([])
    const asked: string[] = []
    const results = await runFactJob({
      targets: [GATE],
      fetch: async (url) => {
        asked.push(url)
        return PAGE("10 October 2026")
      },
    })
    expect(asked).toEqual([GATE.url])
    expect(results).toEqual([{ key: GATE.key, outcome: "added" }])
    // Within the refresh time nothing is fetched again
    expect(await runFactJob({ targets: [GATE], fetch: async () => PAGE("x") })).toEqual(
      []
    )
  })
})
