import { drizzle } from "drizzle-orm/pglite"
import { jsonSchema, tool, type ToolSet } from "ai"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { definitionShare } from "@/lib/delivery/cost"
import { deliveryMetrics } from "@/lib/delivery/metrics"
import { createGatewayModel } from "@/lib/models"
import { CACHE_VERIFIED, ineffectiveNote } from "@/lib/next"

import { createTestDb, createUser, type TestDb } from "../db/harness"

vi.mock("server-only", () => ({}))

// N10 (ND-16, COST_AND_METERING §3): the cost measures from hand-computed
// rows, and cache markers that appear only for a verified route with the
// switch on, so every request today is byte for byte what it was (NT-CST-01…03).
// Nothing here reaches OpenRouter: the request is captured, not sent. Whether
// a provider honours a marker is NRG-2, a paid request this suite never makes.

const empty = { type: "object", properties: {} } as const
const fake = (description: string) =>
  tool({ description, inputSchema: jsonSchema(empty), execute: async () => "" })

describe("NT-CST-01 NM7: the app share of tool definitions", () => {
  // `{"properties":{},"type":"object"}` is 33 characters
  it("counts name + description + schema, in characters", async () => {
    const tools: ToolSet = { aa: fake("xxx"), mcp_t_x: fake("0123456789") }
    expect(await definitionShare(tools, ["mcp_t_x"])).toEqual({
      app: 7 + 10 + 33,
      total: 2 + 3 + 33 + (7 + 10 + 33),
      share: 50 / 88,
    })
  })

  it("no app tools → 0; no tools at all → null, never 0 of nothing", async () => {
    expect(await definitionShare({ aa: fake("x") }, [])).toMatchObject({
      app: 0,
      share: 0,
    })
    expect(await definitionShare({}, [])).toEqual({ app: 0, total: 0, share: null })
  })
})

describe("NT-CST-01 NM10, C1, C3 on seeded rows", () => {
  let pg: TestDb
  let user: string
  const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
  let task = ""
  let n = 0
  const at = (s: string) => `2026-10-25T10:00:${s}Z`

  const usage = (
    when: string,
    o: {
      input?: number | null
      cached?: number | null
      status?: "reported" | "missing"
      attempt?: number
      old?: boolean
    } = {}
  ) =>
    q(
      `insert into kriya.usage_events (request_key, user_id, task_id, attempt, provider, model, usage_status, input_tokens, cached_tokens, created_at)
       values ($1, $2, $3, $4, 'openrouter', 'm/x', $5, $6, $7, ${o.old ? "now() - interval '40 days'" : "$8"})`,
      [
        `r${++n}`,
        user,
        task,
        o.attempt ?? 1,
        o.status ?? "reported",
        o.input === undefined ? null : o.input,
        o.cached === undefined ? null : o.cached,
        ...(o.old ? [] : [new Date(at(when))]),
      ]
    )
  const call = (when: string, status: "failed" | "succeeded", error?: string) =>
    q(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, status, error, started_at)
       values ($1, $2, 1, $3, 'gmail_search', $4, $5, $6)`,
      [task, user, `c${++n}`, status, error ?? null, new Date(at(when))]
    )

  beforeAll(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(at("59")))
    user = await createUser(pg)
    await q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [user]
    )
    await q("insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')", [
      user,
    ])
    task = (
      (
        await q(
          `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
         values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
          [user]
        )
      ).rows[0] as { id: string }
    ).id

    // Five steps. u1: its only call failed on a busy app → wasted. u2: one busy
    // failure and one success → not wasted. u3: its only call failed because the
    // circuit was open → wasted. u4: a failure that isn't transient → not wasted.
    // u5: no tool call at all. (Every `call` starts before its step's usage row.)
    await call("05", "failed", "The app is busy (503).")
    await usage("10", { input: 100, cached: 0 })
    await call("12", "failed", "Gmail failed (503)")
    await call("13", "succeeded")
    await usage("20", { input: 200, cached: 50 })
    await call(
      "25",
      "failed",
      "Tracker isn't responding; Kriya stopped trying for a minute."
    )
    await usage("30", { input: 300, cached: null })
    await call("35", "failed", "No such item.")
    await usage("40", { input: 999, status: "missing" })
    await usage("50", { input: 400, cached: 50 })
    // Outside the 7-day window: counted nowhere
    await usage("00", { input: 5000, cached: 5000, old: true })
  })
  afterAll(() => vi.useRealTimers())

  it("NM10: wasted steps out of all steps", async () => {
    const m = await deliveryMetrics(7)
    expect(m.nm10).toEqual({ wasted: 2, n: 5 })
  })

  it("C1: reported input tokens over the tasks that made them; a missing report counts nowhere", async () => {
    const m = await deliveryMetrics(7)
    // u1 + u2 + u3 + u5, one task (u4 reported nothing)
    expect(m.c1).toEqual({ inputTokens: 1000, tasks: 1 })
  })

  it("C3: cached ÷ input over rows that said how much was cached, not 0 for the rest", async () => {
    const m = await deliveryMetrics(7)
    // u1 (100, 0) + u2 (200, 50) + u5 (400, 50); u3 never said
    expect(m.c3).toEqual({ cachedTokens: 100, inputTokens: 700 })
    const month = await deliveryMetrics(60)
    expect(month.c3).toEqual({ cachedTokens: 5100, inputTokens: 5700 })
  })
})

describe("NT-CST-02/03 cache markers", () => {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  const reset = () =>
    ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
  const prompt = [
    { role: "system" as const, content: "Be useful." },
    { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
  ]

  beforeAll(async () => {
    const pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    process.env.OPENROUTER_API_KEY = "test-key"
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } }
      )
    })
  })
  afterEach(() => {
    delete process.env.KRIYA_NEXT_PROMPT_CACHE
    reset()
    sent.length = 0
  })

  const run = async (
    modelId: string,
    verified: readonly string[],
    messages: typeof prompt = prompt
  ) => {
    const model = createGatewayModel(modelId, verified)
    await (
      model as unknown as { doGenerate: (o: unknown) => Promise<unknown> }
    ).doGenerate({
      prompt: messages,
    })
    return sent.at(-1)!.body
  }

  it("no route is verified today", () => {
    expect(CACHE_VERIFIED).toEqual([])
  })

  it("NT-CST-02: switch off, or a route that isn't verified → the request is what it always was", async () => {
    const plain = await run("anthropic/claude-x", [])
    expect(plain).toEqual({
      model: "anthropic/claude-x",
      messages: [
        { role: "system", content: "Be useful." },
        { role: "user", content: "Hi" },
      ],
      stream_options: undefined,
    })
    expect(JSON.stringify(plain)).not.toContain("cache_control")
    // Verified but the switch is off: the same bytes
    expect(await run("anthropic/claude-x", ["anthropic/claude-x"])).toEqual(plain)
    // The switch on but the route isn't verified: the same bytes
    process.env.KRIYA_NEXT_PROMPT_CACHE = "on"
    reset()
    expect(await run("anthropic/claude-x", [])).toEqual(plain)
  })

  it("NT-CST-03: a marker on the system message only for a verified route with the switch on", async () => {
    process.env.KRIYA_NEXT_PROMPT_CACHE = "on"
    reset()
    const marked = await run("anthropic/claude-x", ["anthropic/claude-x"])
    expect(marked.messages).toEqual([
      { role: "system", content: "Be useful.", cache_control: { type: "ephemeral" } },
      { role: "user", content: "Hi" },
    ])
    // Another route in the same session isn't touched
    const other = await run("openai/gpt-y", ["anthropic/claude-x"])
    expect(JSON.stringify(other)).not.toContain("cache_control")
    // A prompt with no system message has nothing to mark
    const none = await run("anthropic/claude-x", ["anthropic/claude-x"], [prompt[1]])
    expect(JSON.stringify(none)).not.toContain("cache_control")
  })

  it("the Config note says a switch that's on can't act while no route is verified", () => {
    const on = (key: string) => (key === "next.promptCache" ? "on" : null)
    expect(ineffectiveNote("next.promptCache", on)).toMatch(
      /no model route has been verified/
    )
    expect(ineffectiveNote("next.promptCache", () => "off")).toBeNull()
  })
})
