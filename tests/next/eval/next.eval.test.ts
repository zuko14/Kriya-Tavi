import fs from "node:fs"

import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest"

// Paid evaluation of NG-01, 03, 05, 12 and 17 on a real model (EVALUATION_PLAN
// §4). Skipped unless KRIYA_NEXT_EVAL_MODEL is set, which `npm run next:eval`
// does only with the owner's go-ahead. Everything but the model is the golden
// suites' own: the real runner, approvals, verifier and delivery status on
// PGlite, the connectors faked, the app the repo's fixture server. Each run is
// pass or fail by code (tools run, approvals, status); a model that does worse
// is a recorded failure, not a test error. KRIYA_EVAL_OUT=<file> gets the JSON.

const MODEL = process.env.KRIYA_NEXT_EVAL_MODEL
const N = Number(process.env.KRIYA_NEXT_EVAL_N ?? 3)

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "", email: null }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock(
  "@/lib/connectors",
  async (original) =>
    (await import("../golden/mocks")).connectors(await original()) as never
)
vi.mock(
  "@/lib/connectors/sheets",
  async (original) =>
    (await import("../golden/mocks")).sheetsConnector(await original()) as never
)
vi.mock(
  "@/lib/web",
  async (original) => (await import("../golden/mocks")).webMock(await original()) as never
)
vi.mock("@/lib/mcp/fetch", async (original) => {
  const { fixtureFetch } = await import("../../fixtures/mcp/server")
  return {
    ...(await original<typeof import("@/lib/mcp/fetch")>()),
    guardedFetch: (server: { url: string }) => fixtureFetch(server),
  }
})
vi.mock(
  "@/lib/mcp/registry",
  async (original) =>
    (await import("../golden/mocks")).registryMock(await original()) as never
)

import { recheckDeliveries, type Readers } from "@/lib/delivery/recheck"

import { asUser } from "../../db/harness"
import { fixtureHosts, registerFixture, startMcpFixture } from "../../fixtures/mcp/server"
import { switches, world, type World } from "../../operator/golden/harness"
import { answerAll, delivery } from "../golden/harness"
import { behave, reset, seen } from "../golden/mocks"

const NEXT = {
  KRIYA_NEXT_DELIVERY: "on",
  KRIYA_NEXT_RECHECK: "on",
  KRIYA_NEXT_RELIABILITY: "on",
  KRIYA_NEXT_SKILLS_V2: "on",
  KRIYA_NEXT_MCP: "on",
  KRIYA_AGENTS_SKILL_LIBRARY: "on",
}
const flip = (on: boolean) => {
  for (const [key, value] of Object.entries(NEXT)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

type Result = {
  scenario: string
  run: number
  pass: boolean
  detail: string
  costMicroUsd: number | null
}
const results: Result[] = []

let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let w: World
beforeAll(async () => {
  if (!MODEL) return
  fixture = await startMcpFixture()
  fixtureHosts.set("tracker.fixture.example", fixture.url)
})
afterAll(async () => {
  await fixture?.close()
  if (!MODEL) return
  for (const r of results)
    console.log(`${r.pass ? "pass" : "FAIL"} ${r.scenario} #${r.run} ${r.detail}`)
  const by = Map.groupBy(results, (r) => r.scenario)
  for (const [scenario, runs] of by)
    console.log(
      `${scenario}: ${runs.filter((r) => r.pass).length}/${runs.length} · model ${MODEL}`
    )
  if (process.env.KRIYA_EVAL_OUT)
    fs.writeFileSync(
      process.env.KRIYA_EVAL_OUT,
      JSON.stringify(
        { model: MODEL, n: N, at: new Date().toISOString(), results },
        null,
        2
      )
    )
})
afterEach(() => {
  flip(false)
  switches(false)
})

async function fresh() {
  reset()
  fixture.state.calls.length = 0
  fixture.state.items.clear()
  fixture.state.unreadable.clear()
  fixture.state.read = "ok"
  w = await world()
  flip(true)
  // The real model, for every tier
  process.env.OPENROUTER_DEFAULT_MODEL = MODEL
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  await w.q(
    `update kriya.agents set skills = '{"on":["gst-invoices","calendar-operations"],"auto":true}'`
  )
  await w.q(
    "update kriya.connections set scopes = scopes || '{https://www.googleapis.com/auth/calendar.events}' where provider = 'google'"
  )
  await registerFixture(w.q, "tracker", [
    { name: "get_item", risk: "R0" },
    {
      name: "create_item",
      risk: "R3",
      verify: {
        tool: "get_item",
        args: { id: "/structuredContent/id" },
        expect: { "/structuredContent/title": "/input/title" },
      },
    },
  ])
  await asUser(w.pg, w.user, (tx) =>
    tx.query(
      "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
      [w.user]
    )
  )
}

// What the run cost as the provider reported it; null when nothing was reported
const cost = async () =>
  (
    await w.q<{ c: string | null }>(
      "select sum(cost_micro_usd)::text as c from kriya.usage_events where cost_micro_usd is not null"
    )
  )[0].c

async function record(
  scenario: string,
  run: number,
  check: () => Promise<string | null>
) {
  let failure: string | null
  try {
    failure = await check()
  } catch (error) {
    failure = `error: ${(error as Error).message}`
  }
  const c = await cost().catch(() => null)
  results.push({
    scenario,
    run,
    pass: failure === null,
    detail: failure ?? "",
    costMicroUsd: c === null ? null : Number(c),
  })
}

const expectDelivered = async () => {
  const d = await delivery(w)
  return d?.status === "delivered" ? null : `status ${d?.status ?? "none"}`
}
const runs = Array.from({ length: N }, (_, i) => i + 1)

describe.skipIf(!MODEL)("next:eval on a real model", () => {
  it.each(runs)("NG-01 two reminder drafts, run %i", async (run) => {
    await fresh()
    await record("NG-01", run, async () => {
      await w.turn(
        "Save two polite payment reminders as Gmail drafts: one to asha@example.com for overdue invoice INV/1, one to ravi@example.com for overdue invoice INV/2."
      )
      await answerAll(w)
      const to = seen.drafts.flatMap((d) => d.to).sort()
      if (to.join() !== "asha@example.com,ravi@example.com")
        return `drafts to ${to.join(" ") || "nobody"}`
      return expectDelivered()
    })
  })

  it.each(runs)("NG-03 a tracker issue per bug, run %i", async (run) => {
    await fresh()
    await record("NG-03", run, async () => {
      await w.turn(
        "Create one tracker issue for each bug in this thread: (1) Login fails on Safari, (2) Invoice PDF is blank."
      )
      await answerAll(w)
      const titles = fixture.state.calls
        .filter((c) => c.name === "create_item")
        .map((c) => String((c.arguments as { title?: string })?.title))
      if (titles.length !== 2) return `${titles.length} issues created`
      if (!titles.some((t) => /safari/i.test(t)) || !titles.some((t) => /pdf/i.test(t)))
        return `titles ${titles.join(" | ")}`
      return expectDelivered()
    })
  })

  it.each(runs)("NG-05 an exam on the calendar, run %i", async (run) => {
    await fresh()
    await record("NG-05", run, async () => {
      await w.turn(
        "Put my Maths exam on my calendar on 30 October 2026, 10:00 to 11:00 India time."
      )
      if (seen.events.length) return "created before the person said yes"
      await answerAll(w)
      if (seen.events.length !== 1) return `${seen.events.length} events created`
      if (!/maths/i.test(seen.events[0].title)) return `title ${seen.events[0].title}`
      return expectDelivered()
    })
  })

  it.each(runs)("NG-12 Hindi bills into the sheet, run %i", async (run) => {
    await fresh()
    await record("NG-12", run, async () => {
      await w.turn(
        "मेरे सारे बिल शीट में डाल दो। शीट 1AbCdEfGhIjKlMnOpQrStUvW, टैब Bills, कॉलम: Vendor, Amount। बिल: Sharma Traders ₹1,180; Mehta Stationers ₹2,360।"
      )
      await answerAll(w)
      const rows = seen.appends.reduce((n, a) => n + a.rows.length, 0)
      if (rows !== 2) return `${rows} rows appended`
      return expectDelivered()
    })
  })

  it.each(runs)("NG-17 a lagging read-back, then the re-check, run %i", async (run) => {
    await fresh()
    await record("NG-17", run, async () => {
      behave.calendar = "unverified"
      await w.turn(
        "Add my Maths exam to my calendar on 30 October 2026, 10:00 to 11:00 India time."
      )
      await answerAll(w)
      if (seen.events.length !== 1) return `${seen.events.length} events created`
      const first = await delivery(w)
      if (first?.status !== "partly") return `before the re-check: ${first?.status}`
      await w.q(
        "update kriya.tool_executions set finished_at = now() - interval '10 minutes' where side_effect"
      )
      const made = seen.events[0] as {
        title: string
        attendees?: string[]
        start: string
      }
      const offset = /(Z|[+-]\d\d:?\d\d)$/.test(made.start)
      const readers: Readers = {
        calendar: async () => ({
          found: true,
          cancelled: false,
          title: made.title,
          attendees: made.attendees ?? [],
          startMs: offset ? Date.parse(made.start) : null,
        }),
        githubIssue: async () => null,
        sheetsRange: async () => "gone",
      }
      await recheckDeliveries(new Date(), { readers })
      const after = await delivery(w)
      return after?.status === "delivered" ? null : `after the re-check: ${after?.status}`
    })
  })
})

// The shape an empty skipped file needs to be a valid suite
it.skipIf(!!MODEL)("is skipped without KRIYA_NEXT_EVAL_MODEL (paid)", () => {})
