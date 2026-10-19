import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { untrustedSeen } from "@/lib/agent/tools"
import { claimDueSchedules, runDue } from "@/lib/schedules"
import {
  diff,
  MAX_DIFF,
  normalise,
  setWatchFetcherForTests,
  UNTRUSTED_DIFF,
  watchPrompt,
} from "@/lib/watch"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Zero-token watchers (K5) through the real scheduler on PGlite, with a
// fixture page instead of a real fetch. AT-WAT-01: an unchanged page makes
// no task and no model call (W1 = 0). AT-WAT-02: a counter-only change is
// ignored. AT-WAT-03: a change's diff is capped and marked untrusted.

let modelCalls = 0
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: () => {
    modelCalls++
    throw new Error("no model in watcher tests")
  },
}))

const PAGE = (closes: string, visitors: number, stamp = "10:15 AM") =>
  `GATE 2027 notices\nRegistration closes on ${closes}.\nVisitors: ${visitors.toLocaleString("en-IN")}\nLast updated: 18 Oct 2026, ${stamp}`

let pg: TestDb
let user: string
let page: string
let fetches: number

async function watcher(id: string, minutesAgo = 1) {
  await pg.query(
    `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule, next_run_at, approved_at, watch)
     values ($1, $2, 'a1', 't1', 'watch', 'Tell me if GATE dates change', '{"freq":"daily","at":"09:00"}', now() - make_interval(mins => $3), now(), $4)`,
    [
      id,
      user,
      minutesAgo,
      JSON.stringify({
        url: "https://gate.example.ac.in/notices",
        condition: "dates change",
      }),
    ]
  )
}

// Makes the schedule due again and runs the scheduler once
async function tick(id = "w1") {
  await pg.query(
    "update kriya.schedules set next_run_at = now() - interval '1 minute' where id = $1",
    [id]
  )
  const outcomes: string[] = []
  for (const run of await claimDueSchedules()) outcomes.push(await runDue(run))
  return outcomes
}

const tasks = async () => (await pg.query("select 1 from kriya.tasks")).rows.length

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.KRIYA_AGENTS_WATCHERS = "on"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
  modelCalls = 0
  fetches = 0
  page = PAGE("10 October 2026", 1200)
  setWatchFetcherForTests(async () => {
    fetches++
    return page
  })
  await watcher("w1")
})

afterEach(() => {
  setWatchFetcherForTests(null)
  delete process.env.KRIYA_AGENTS_WATCHERS
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
})

describe("AT-WAT-01 an unchanged page costs no task and no model call", () => {
  it("first check sets the baseline; 7 more unchanged days make nothing", async () => {
    for (let day = 0; day < 8; day++) expect(await tick()).toEqual(["unchanged"])
    expect(await tasks()).toBe(0)
    expect(modelCalls).toBe(0)
    expect(fetches).toBe(8)
    // Fetches are metered, unpriced (RG-11), never as zero cost
    const { rows } = await pg.query(
      "select count(*)::int as n, count(cost_micro_usd)::int as priced from kriya.resource_usage where kind = 'web_fetch'"
    )
    expect(rows[0]).toEqual({ n: 8, priced: 0 })
    const { rows: state } = await pg.query(
      "select checked_at is not null as checked, failures from kriya.watch_state"
    )
    expect(state).toEqual([{ checked: true, failures: 0 }])
  })
})

describe("AT-WAT-02 volatile bits don't count as a change", () => {
  it("visitor counters, last-updated stamps and clock times are ignored", async () => {
    await tick()
    page = PAGE("10 October 2026", 1350, "11:42 PM")
    expect(await tick()).toEqual(["unchanged"])
    expect(await tasks()).toBe(0)
    expect(normalise("Views: 1,234 · 5 minutes ago · Exam on 10 Oct 2026")).toBe(
      "· · Exam on 10 Oct 2026"
    )
  })

  it("but a moved date is a change, and starts one run with the diff", async () => {
    await tick()
    page = PAGE("17 October 2026", 1400)
    expect(await tick()).toEqual(["enqueued"])
    expect(await tasks()).toBe(1)
    const { rows } = await pg.query<{ parts: { text: string }[] }>(
      "select parts from kriya.messages where role = 'user'"
    )
    const prompt = rows[0].parts[0].text
    expect(prompt).toContain("- Registration closes on 10 October 2026.")
    expect(prompt).toContain("+ Registration closes on 17 October 2026.")
    expect(prompt).toContain("Tell the person only if this holds: dates change")
    expect(modelCalls).toBe(0)
  })
})

describe("AT-WAT-03 the diff is capped and marked untrusted", () => {
  it("caps the diff and puts the untrusted notice before it", () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const after = Array.from(
      { length: 400 },
      (_, i) => `changed ${i} ${"x".repeat(20)}`
    ).join("\n")
    const d = diff(before, after)
    expect(d.length).toBeLessThanOrEqual(MAX_DIFF + 40)
    expect(d).toMatch(/cut at 4000 characters/)
    const prompt = watchPrompt("Watch it", { url: "https://x.example" }, d)
    expect(prompt.indexOf(UNTRUSTED_DIFF)).toBeLessThan(prompt.indexOf("```diff"))
  })

  it("a run that carries a diff counts as untrusted for memory quarantine", () => {
    const withDiff: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: watchPrompt("Watch", { url: "https://x.example" }, "+ new"),
          },
        ],
      },
    ]
    const plain: ModelMessage[] = [{ role: "user", content: "Plan my week" }]
    expect(untrustedSeen(withDiff)).toBe(true)
    expect(untrustedSeen(plain)).toBe(false)
  })
})

describe("failures and the switch", () => {
  it("a page that can't be read makes no task; five in a row pause the watcher", async () => {
    setWatchFetcherForTests(async () => {
      throw new Error("timeout")
    })
    for (let i = 0; i < 5; i++) expect(await tick()).toEqual(["failed"])
    expect(await tasks()).toBe(0)
    const { rows } = await pg.query(
      "select status, pause_reason from kriya.schedules where id = 'w1'"
    )
    expect(rows).toEqual([{ status: "paused", pause_reason: "fetch" }])
  })

  it("with agents.watchers off, a watch run fails without fetching", async () => {
    delete process.env.KRIYA_AGENTS_WATCHERS
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    expect(await tick()).toEqual(["failed"])
    expect(fetches).toBe(0)
  })
})
