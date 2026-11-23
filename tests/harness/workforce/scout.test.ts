import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W7 (docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md): the
// Scout's tables, spend reservation and one-unit-per-tick run, with a scripted
// page fetcher and a scripted model (no web, no model, no spend).
// WT-DB-01…03, WT-SC-01…09.

vi.mock("server-only", () => ({}))

import { NewScoutSource } from "@/lib/harness/scout/sources"
import {
  acceptedFindings,
  changedParagraphs,
  scoutStep,
  scoutTick,
  type ScoutDeps,
} from "@/lib/harness/scout/run"
import { resourceUsage } from "@/db/schema"

import { asUser, type TestDb } from "../../db/harness"
import { harnessDb, harnessEnv } from "../setup"

let pg: TestDb
let newUser: () => Promise<string>

const P1 =
  "React 20 deprecates the legacy context API; components should move to createContext before the next major release."
const P2 =
  "Server actions now require an explicit origin check, closing a cross-site request forgery vector in form posts."
const P3 =
  "Nothing else in this release changes behaviour for existing applications, and upgrades are drop-in."
const page = (...ps: string[]) => ps.join("\n\n")

let clock = new Date("2026-12-01T10:00:00Z")
const pages = new Map<string, string>()
const asked: string[] = []
let reply = "[]"
const deps: ScoutDeps = {
  now: () => clock,
  fetchPage: async (url) => {
    const text = pages.get(url)
    if (text === undefined) throw new Error("404")
    return text
  },
  ask: async ({ prompt }) => (
    asked.push(prompt),
    { text: reply, tokens: 900, costMicroUsd: 1234 }
  ),
}

const ticks = async (n: number) => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(await scoutTick(deps))
  return out
}
const reset = async () => {
  await pg.exec(
    "delete from kriya.harness_scout_findings; delete from kriya.harness_scout_snapshots; delete from kriya.harness_scout_runs; delete from kriya.harness_scout_sources; delete from kriya.resource_usage where kind in ('scout_model', 'web_fetch')"
  )
  asked.length = 0
  pages.clear()
  clock = new Date("2026-12-01T10:00:00Z")
}
const source = (url: string, discipline = "frontend") =>
  pg.query(
    `insert into kriya.harness_scout_sources (discipline, url, kind) values ($1, $2, 'changelog') returning id`,
    [discipline, url]
  )

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
  await pg.query(
    "insert into kriya.models (id, label, input_micro_usd_per_mtok, output_micro_usd_per_mtok) values ('test/budget', 'Budget', 1000000, 2000000) on conflict (id) do nothing"
  )
})
beforeEach(async () => {
  harnessEnv({
    KRIYA_HARNESS_SCOUT: "on",
    KRIYA_HARNESS_SCOUT_MONTHLY_INR: undefined,
    KRIYA_HARNESS_SCOUT_EVERY_DAYS: undefined,
    KRIYA_HARNESS_SCOUT_MAX_FINDINGS: undefined,
    KRIYA_FX_USD_INR: "84.0000",
    OPENROUTER_API_KEY: "upstream-key-not-real",
    OPENROUTER_DEFAULT_MODEL: "test/budget",
  })
  await reset()
})

describe("WT-DB: tables, policies and spend", () => {
  it("WT-DB-01: no client role reads or writes any Scout table", async () => {
    await source("https://example.org/notes")
    const user = await newUser()
    for (const table of [
      "harness_scout_sources",
      "harness_scout_runs",
      "harness_scout_snapshots",
      "harness_scout_findings",
    ]) {
      const seen = await asUser(pg, user, (tx) =>
        tx
          .query(`select * from kriya.${table}`)
          .then((r) => r.rows.length)
          .catch(() => "denied")
      )
      expect([0, "denied"], table).toContain(seen)
      const wrote = await asUser(pg, user, (tx) =>
        tx
          .query(`insert into kriya.harness_scout_runs (status) values ('done')`)
          .then(() => "wrote")
          .catch(() => "denied")
      )
      expect(wrote, table).toBe("denied")
    }
  })

  it("WT-DB-02: every resource kind in the schema is accepted, an unknown one refused", async () => {
    const kinds = resourceUsage.kind.enumValues
    expect(kinds).toContain("scout_model")
    for (const kind of kinds)
      await pg.query(
        "insert into kriya.resource_usage (request_key, kind, quantity) values ($1, $2, 1)",
        [`k:${kind}`, kind]
      )
    await expect(
      pg.query(
        "insert into kriya.resource_usage (request_key, kind, quantity) values ('k:x', 'nonsense', 1)"
      )
    ).rejects.toThrow()
    await pg.query("delete from kriya.resource_usage where request_key like 'k:%'")
  })

  it("WT-DB-03: reserve_scout_spend refuses a cap of 0, admits within the month's cap and refuses past it", async () => {
    const reserve = async (key: string, est: number, cap: number) =>
      (
        await pg.query<{ ok: boolean }>(
          "select kriya.reserve_scout_spend($1, $2, $3) as ok",
          [key, est, cap]
        )
      ).rows[0].ok
    expect(await reserve("r:0", 10, 0)).toBe(false)
    expect(await reserve("r:1", 600, 1000)).toBe(true)
    expect(await reserve("r:2", 600, 1000)).toBe(false)
    expect(await reserve("r:3", 400, 1000)).toBe(true)
    expect(
      (
        await pg.query(
          "select count(*)::int as n from kriya.resource_usage where kind = 'scout_model'"
        )
      ).rows[0]
    ).toEqual({ n: 2 })
  })
})

describe("WT-SC: the Scout's run", () => {
  it("WT-SC-01: off does nothing at all", async () => {
    harnessEnv({ KRIYA_HARNESS_SCOUT: undefined })
    expect(await scoutTick(deps)).toBe("off")
    expect(
      (await pg.query("select count(*)::int as n from kriya.harness_scout_runs")).rows[0]
    ).toEqual({ n: 0 })
  })

  it("WT-SC-02: a run starts once; a second start while it runs is refused by the lease", async () => {
    expect(await scoutTick(deps)).toBe("started")
    await expect(
      pg.query("insert into kriya.harness_scout_runs (status) values ('running')")
    ).rejects.toThrow()
  })

  it("WT-SC-03: with a ₹0 budget it reads and compares pages, one per tick, and never calls a model", async () => {
    await source("https://a.example/notes")
    await source("https://b.example/notes")
    pages.set("https://a.example/notes", page(P1, P3))
    pages.set("https://b.example/notes", page(P2))
    expect(await ticks(6)).toEqual([
      "started",
      "fetched: fetched",
      "skipped: no scout budget",
      "fetched: fetched",
      "skipped: no scout budget",
      "finished",
    ])
    expect(asked).toEqual([])
    expect(
      (
        await pg.query(
          "select count(*)::int as n from kriya.resource_usage where kind = 'web_fetch'"
        )
      ).rows[0]
    ).toEqual({ n: 2 })
    expect(
      (
        await pg.query(
          "select count(*)::int as n from kriya.resource_usage where kind = 'scout_model'"
        )
      ).rows[0]
    ).toEqual({ n: 0 })
    // Not due again until scoutEveryDays have passed
    expect(await scoutTick(deps)).toBe("idle")
  })

  it("WT-SC-04: with a budget, one model call per changed page; only findings whose quote is word for word in the text are kept; the cost is settled", async () => {
    harnessEnv({
      KRIYA_HARNESS_SCOUT: "on",
      KRIYA_HARNESS_SCOUT_MONTHLY_INR: "500",
      KRIYA_FX_USD_INR: "84.0000",
      OPENROUTER_API_KEY: "upstream-key-not-real",
      OPENROUTER_DEFAULT_MODEL: "test/budget",
    })
    await source("https://a.example/notes")
    pages.set("https://a.example/notes", page(P1, P2))
    reply = JSON.stringify([
      {
        discipline: "frontend",
        kind: "deprecation",
        claim: "Legacy context is deprecated",
        quote: "React 20 deprecates the legacy context API",
      },
      {
        discipline: "security",
        kind: "vulnerability_class",
        claim: "Invented",
        quote: "Server actions are now perfectly safe in all cases",
      },
      {
        discipline: "frontend",
        kind: "practice",
        claim: "Bad shape",
        quote: "x",
        extra: true,
      },
    ])
    const out = await ticks(3)
    expect(out).toEqual(["started", "fetched: fetched", "distilled: 1 finding(s)"])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/Changed text \(untrusted\)/)
    const findings = (
      await pg.query("select discipline, quote, status from kriya.harness_scout_findings")
    ).rows
    expect(findings).toEqual([
      {
        discipline: "frontend",
        quote: "React 20 deprecates the legacy context API",
        status: "new",
      },
    ])
    const usage = (
      await pg.query<{ quantity: unknown; cost_micro_usd: unknown }>(
        "select quantity, cost_micro_usd from kriya.resource_usage where kind = 'scout_model'"
      )
    ).rows
    expect(
      usage.map((u) => ({ quantity: Number(u.quantity), cost: Number(u.cost_micro_usd) }))
    ).toEqual([{ quantity: 900, cost: 1234 }])
  })

  it("WT-SC-05: an unchanged page isn't sent to a model; only new paragraphs are", async () => {
    harnessEnv({
      KRIYA_HARNESS_SCOUT: "on",
      KRIYA_HARNESS_SCOUT_MONTHLY_INR: "500",
      KRIYA_HARNESS_SCOUT_EVERY_DAYS: "1",
      KRIYA_FX_USD_INR: "84.0000",
      OPENROUTER_API_KEY: "upstream-key-not-real",
      OPENROUTER_DEFAULT_MODEL: "test/budget",
    })
    await source("https://a.example/notes")
    pages.set("https://a.example/notes", page(P1, P3))
    reply = "[]"
    await ticks(4)
    expect(asked).toHaveLength(1)
    clock = new Date(clock.getTime() + 2 * 24 * 3600_000)
    expect(await ticks(3)).toEqual(["started", "fetched: unchanged", "finished"])
    expect(asked).toHaveLength(1)
    clock = new Date(clock.getTime() + 2 * 24 * 3600_000)
    pages.set("https://a.example/notes", page(P1, P2, P3))
    await ticks(3)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain(P2)
    expect(asked[1]).not.toContain(P1)
  })

  it("WT-SC-06: a finding is confirmed only by a second fetch an hour later that still has the quote, else dropped", async () => {
    harnessEnv({
      KRIYA_HARNESS_SCOUT: "on",
      KRIYA_HARNESS_SCOUT_MONTHLY_INR: "500",
      KRIYA_FX_USD_INR: "84.0000",
      OPENROUTER_API_KEY: "upstream-key-not-real",
      OPENROUTER_DEFAULT_MODEL: "test/budget",
    })
    await source("https://a.example/notes")
    pages.set("https://a.example/notes", page(P1, P2))
    reply = JSON.stringify([
      {
        discipline: "frontend",
        kind: "deprecation",
        claim: "a",
        quote: "React 20 deprecates the legacy context API",
      },
      {
        discipline: "frontend",
        kind: "practice",
        claim: "b",
        quote: "Server actions now require an explicit origin check",
      },
    ])
    await ticks(4)
    expect(await scoutTick(deps)).toBe("idle")
    clock = new Date(clock.getTime() + 61 * 60_000)
    pages.set("https://a.example/notes", page(P1))
    const outcomes = [await scoutTick(deps), await scoutTick(deps)]
    expect(outcomes.sort()).toEqual([
      "confirmed a finding",
      "dropped a finding (quote gone)",
    ])
    const states = (
      await pg.query(
        "select claim, status, confirmed_at is not null as confirmed from kriya.harness_scout_findings order by claim"
      )
    ).rows
    expect(states).toEqual([
      { claim: "a", status: "confirmed", confirmed: true },
      { claim: "b", status: "dropped", confirmed: false },
    ])
  })

  it("WT-SC-07: past the monthly cap the run stops as cap reached, and no model call is made", async () => {
    harnessEnv({
      KRIYA_HARNESS_SCOUT: "on",
      KRIYA_HARNESS_SCOUT_MONTHLY_INR: "1",
      KRIYA_FX_USD_INR: "84.0000",
      OPENROUTER_API_KEY: "upstream-key-not-real",
      OPENROUTER_DEFAULT_MODEL: "test/budget",
    })
    await pg.query(
      "insert into kriya.resource_usage (request_key, kind, quantity, cost_micro_usd) values ('old', 'scout_model', 1, 11900)"
    )
    await source("https://a.example/notes")
    pages.set("https://a.example/notes", page(P1))
    expect(await ticks(3)).toEqual(["started", "fetched: fetched", "cap reached"])
    expect(asked).toEqual([])
    expect((await pg.query("select status from kriya.harness_scout_runs")).rows).toEqual([
      { status: "cap_reached" },
    ])
  })

  it("WT-SC-08: a fetch that fails marks that source and moves on; a scheduler step never throws and never overlaps itself", async () => {
    await source("https://a.example/missing")
    await source("https://b.example/notes")
    pages.set("https://b.example/notes", page(P2))
    expect(await ticks(4)).toEqual([
      "started",
      "fetch failed",
      "fetched: fetched",
      "skipped: no scout budget",
    ])
    let release: () => void = () => {}
    let called: () => void = () => {}
    const started = new Promise<void>((done) => (called = done))
    const slow: ScoutDeps = {
      ...deps,
      fetchPage: () =>
        new Promise((done) => ((release = () => done(page(P3))), called())),
    }
    await pg.exec("delete from kriya.harness_scout_runs")
    await source("https://c.example/notes")
    await scoutTick(deps)
    const first = scoutStep(slow)
    await started
    expect(await scoutStep(slow)).toBe("busy")
    release()
    expect(typeof (await first)).toBe("string")
  })

  it("WT-SC-09: changed paragraphs and accepted findings are pure and bounded; sources are https names only", () => {
    const first = changedParagraphs(page(P1, P2), [])
    expect(first.changed).toBe(`${P1}\n\n${P2}`)
    expect(changedParagraphs(page(P1, P2, P3), first.hashes).changed).toBe(P3)
    expect(acceptedFindings("not json", P1)).toEqual([])
    // At most five per page, each item checked on its own
    expect(
      acceptedFindings(
        JSON.stringify(
          Array.from({ length: 6 }, () => ({
            discipline: "frontend",
            kind: "practice",
            claim: "c",
            quote: "React 20",
          }))
        ),
        P1
      )
    ).toHaveLength(5)
    expect(
      acceptedFindings(
        JSON.stringify([
          {
            discipline: "frontend",
            kind: "practice",
            claim: "c",
            quote: "React 20",
            extra: 1,
          },
          { discipline: "frontend", kind: "practice", claim: "c", quote: "React 20" },
        ]),
        P1
      )
    ).toHaveLength(1)
    for (const url of [
      "http://example.org/x",
      "https://127.0.0.1/x",
      "https://user:pw@example.org/x",
      "ftp://example.org",
    ])
      expect(
        NewScoutSource.safeParse({ discipline: "frontend", kind: "changelog", url })
          .success,
        url
      ).toBe(false)
    expect(
      NewScoutSource.safeParse({
        discipline: "frontend",
        kind: "changelog",
        url: "https://react.dev/blog",
      }).success
    ).toBe(true)
  })
})
