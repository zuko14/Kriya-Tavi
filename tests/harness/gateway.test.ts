import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The model gateway (track H, H3; HD-06, ARCHITECTURE §3.2, TEST_STRATEGY
// HT-GW-01…08, -10) against a fake OpenRouter: aliases only, the reservation
// before anything is sent, streams passed through with only `model`
// rewritten, settled from the final usage chunk, aborted streams estimated
// at the reservation, one retry on the fallback model. No real model call.

vi.mock("server-only", () => ({}))

import { GET as models } from "@/app/api/harness/v1/models/route"
import { POST as chat } from "@/app/api/harness/v1/chat/completions/route"
import { log } from "@/lib/log"
import { applyMarkup, usdToInr } from "@/lib/money"
import { MAX_OUTPUT_TOKENS, reserve } from "@/lib/harness/metering"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

const BASE = "https://upstream.test/api/v1"
const PROMPT = "Refactor the parser in src/parse.ts please"
const ANSWER = "Here is the refactored parser"

let pg: TestDb
let user: string
let token: string

type Sent = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

// SSE as OpenRouter sends it: a comment, data lines, the usage chunk, [DONE]
function sse(model: string, opts: { usage?: boolean; hang?: boolean } = {}) {
  const chunks = [
    ": OPENROUTER PROCESSING\n\n",
    `data: {"id":"gen-1","model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"${ANSWER}"}}]}\n\n`,
    `data: {"id":"gen-1","model":"${model}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n`,
  ]
  if (opts.usage !== false)
    chunks.push(
      `data: {"id":"gen-1","model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1200,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":100},"cost":0.000123}}\n\n`,
      "data: [DONE]\n\n"
    )
  return { chunks, body: () => stream(chunks, opts.hang) }
}

function stream(chunks: string[], hang = false) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split one chunk mid-line, as networks do
      for (const chunk of chunks) {
        const at = Math.floor(chunk.length / 2)
        controller.enqueue(encoder.encode(chunk.slice(0, at)))
        controller.enqueue(encoder.encode(chunk.slice(at)))
      }
      if (!hang) controller.close()
    },
  })
}

// The fake OpenRouter: answers in order, records every request
function upstream(...replies: ((sent: Sent) => Response)[]) {
  const sent: Sent[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const request: Sent = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: JSON.parse(String(init.body)),
      }
      sent.push(request)
      const reply = replies.shift()
      if (!reply) throw new Error("unexpected upstream request")
      return reply(request)
    })
  )
  return sent
}

const streamed = (model: string, opts?: { usage?: boolean; hang?: boolean }) => () =>
  new Response(sse(model, opts).body(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const ask = (body: Record<string, unknown>) =>
  chat(call("POST", "/chat/completions", { token, body }))

const usageRows = () =>
  pg
    .query<Record<string, unknown>>(
      "select status, model, tier, reserved_micro_inr, input_tokens, output_tokens, cached_tokens, cost_micro_usd, estimated_cost_micro_usd, charge_micro_inr, charge_status, fx_rate, markup_bps, generation_id, finish_reason from kriya.harness_usage where user_id = $1 order by created_at",
      [user]
    )
    .then((r) => r.rows)

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  user = await db.createUser()
  token = (await deviceFor(pg, user)).token
  await pg.query(
    `insert into kriya.models (id, label, input_micro_usd_per_mtok, output_micro_usd_per_mtok) values
       ('test/budget', 'Budget', 1000000, 2000000), ('test/fallback', 'Fallback', 1000000, 2000000),
       ('test/balanced', 'Balanced', 3000000, 15000000)
     on conflict (id) do nothing`
  )
})

beforeEach(async () => {
  harnessEnv({
    KRIYA_HARNESS_GATEWAY: "on",
    KRIYA_HARNESS_RPM: "600",
    OPENROUTER_API_KEY: "upstream-key-not-real",
    OPENROUTER_BASE_URL: BASE,
    OPENROUTER_DEFAULT_MODEL: "test/budget",
    OPENROUTER_BALANCED_MODEL: "test/balanced",
    OPENROUTER_FALLBACK_MODEL: "test/fallback",
    KRIYA_FX_USD_INR: "84.0000",
  })
  await pg.query("delete from kriya.harness_usage")
  await pg.query(
    "update kriya.plans set harness_monthly_micro_inr = 1000000000, allowed_tiers = '{budget}', markup_bps = 15000 where id = 'free'"
  )
})

afterEach(() => vi.unstubAllGlobals())

describe("HT-GW-01: aliases only", () => {
  it("an allowed alias becomes the tier's model; unknown or disallowed ones are refused before anything is sent", async () => {
    const sent = upstream(streamed("test/budget"))
    const ok = await ask({
      model: "budget",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(ok.status).toBe(200)
    await ok.text()
    expect(sent[0].url).toBe(`${BASE}/chat/completions`)
    expect(sent[0].body.model).toBe("test/budget")
    expect(sent[0].headers.authorization).toBe("Bearer upstream-key-not-real")

    for (const model of ["openai/gpt-4o", "balanced", "escalation"]) {
      const res = await ask({ model, messages: [{ role: "user", content: "x" }] })
      expect(res.status, model).toBe(400)
      expect(await res.json()).toMatchObject({ error: "tier_not_allowed" })
    }
    expect(sent).toHaveLength(1)

    // Each level carries the name of the model the owner routes it to
    const list = await models(call("GET", "/models", { token }))
    expect(await list.json()).toEqual({
      object: "list",
      data: [{ id: "budget", object: "model", owned_by: "kriya", name: "Budget" }],
    })
  })
})

describe("HT-GW-09: /models names the owner's model for each level", () => {
  it("the catalogue label, its repeated vendor prefix trimmed; unusable labels leave the name out", async () => {
    const { displayName } = await import("@/app/api/harness/v1/models/route")
    expect(
      displayName("DeepSeek: DeepSeek V4.1 Flash", "deepseek/deepseek-v4.1-flash-1017")
    ).toBe("DeepSeek V4.1 Flash")
    expect(displayName("Anthropic: Claude Sonnet", "anthropic/claude-sonnet")).toBe(
      "Anthropic: Claude Sonnet"
    )
    expect(displayName(null, "deepseek/deepseek-v4.1-flash-1017")).toBe(
      "deepseek-v4.1-flash-1017"
    )
    expect(displayName("<script>alert(1)</script>", "x/y")).toBeUndefined()
    expect(displayName("a".repeat(90), "x/y")).toHaveLength(60)
  })

  it("every allowed level, named after the model it really runs on", async () => {
    await pg.query(
      "update kriya.plans set allowed_tiers = '{budget,balanced,escalation}' where id = 'free'"
    )
    const list = await (await models(call("GET", "/models", { token }))).json()
    expect(list.data).toEqual([
      { id: "budget", object: "model", owned_by: "kriya", name: "Budget" },
      { id: "balanced", object: "model", owned_by: "kriya", name: "Balanced" },
      // No escalation model routed: the gateway sends it to the budget model,
      // so that's the name
      { id: "escalation", object: "model", owned_by: "kriya", name: "Budget" },
    ])
  })
})

describe("HT-GW-02 / -03: the stream passes through; the usage chunk settles", () => {
  it("chunks unchanged except model; tools passed through; settled with real tokens, cost and charge", async () => {
    const original = sse("test/budget").chunks.join("")
    const sent = upstream(streamed("test/budget"))
    const tools = [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      },
    ]
    const res = await ask({
      model: "budget",
      stream: true,
      tools,
      tool_choice: "auto",
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toBe(original.replaceAll('"model":"test/budget"', '"model":"budget"'))
    expect(sent[0].body.tools).toEqual(tools)
    expect(sent[0].body.tool_choice).toBe("auto")

    const [row] = await usageRows()
    const charge = applyMarkup(usdToInr(123, 840000n), 15000)
    expect(row).toMatchObject({
      status: "settled",
      tier: "budget",
      model: "test/budget",
      input_tokens: 1200,
      output_tokens: 300,
      cached_tokens: 100,
      cost_micro_usd: 123,
      charge_status: "final",
      fx_rate: "84.0000",
      markup_bps: 15000,
      generation_id: "gen-1",
      finish_reason: "tool_calls",
    })
    expect(Number(row.charge_micro_inr)).toBe(charge)
    // 1200 × $1/M + 300 × $2/M
    expect(Number(row.estimated_cost_micro_usd)).toBe(1800)
  })

  it("a non-streaming answer: model rewritten, usage settled", async () => {
    upstream(() =>
      Response.json({
        id: "gen-2",
        model: "test/budget",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: ANSWER },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 },
      })
    )
    const res = await ask({
      model: "budget",
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(await res.json()).toMatchObject({
      model: "budget",
      choices: [{ message: { content: ANSWER } }],
    })
    expect((await usageRows())[0]).toMatchObject({
      status: "settled",
      cost_micro_usd: 20,
      charge_status: "final",
    })
  })
})

describe("HT-GW-04 / MTR-06: refused before forwarding", () => {
  it("the month's cap, a plan without the harness, no price, the switch off: nothing sent upstream", async () => {
    const sent = upstream()
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 10 where id = 'free'"
    )
    let res = await ask({
      model: "budget",
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "cap_reached" })

    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 0 where id = 'free'"
    )
    res = await ask({ model: "budget", messages: [{ role: "user", content: PROMPT }] })
    expect(await res.json()).toMatchObject({ error: "plan_not_allowed" })

    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 1000000000 where id = 'free'"
    )
    harnessEnv({
      KRIYA_HARNESS_GATEWAY: "on",
      OPENROUTER_API_KEY: "k",
      OPENROUTER_BASE_URL: BASE,
      OPENROUTER_DEFAULT_MODEL: "test/budget",
      KRIYA_FX_USD_INR: undefined,
    })
    res = await ask({ model: "budget", messages: [{ role: "user", content: PROMPT }] })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "not_priced" })

    harnessEnv({ KRIYA_HARNESS_GATEWAY: undefined })
    res = await ask({ model: "budget", messages: [{ role: "user", content: PROMPT }] })
    expect(await res.json()).toMatchObject({ error: "harness_off" })

    expect(sent).toHaveLength(0)
    expect(await usageRows()).toEqual([])
  })
})

describe("HT-GW-05: concurrent streams", () => {
  it("a fourth request while three are open is refused", async () => {
    for (let i = 0; i < 3; i++)
      await pg.query(
        "insert into kriya.harness_usage (request_key, user_id, tier, model, reserved_micro_inr) values ($1, $2, 'budget', 'test/budget', 1)",
        [`open-${i}`, user]
      )
    const sent = upstream()
    const res = await ask({ model: "budget", messages: [{ role: "user", content: "x" }] })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: "rate_limited" })
    expect(sent).toHaveLength(0)
  })
})

describe("HT-GW-06: what Kriya sends", () => {
  it("max_tokens capped; provider, models, route and user stripped; usage asked for", async () => {
    const sent = upstream(streamed("test/budget"))
    const res = await ask({
      model: "budget",
      stream: true,
      max_tokens: 999_999,
      max_completion_tokens: 999_999,
      provider: { order: ["cheap"] },
      models: ["other/model"],
      route: "fallback",
      user: "someone@example.com",
      temperature: 0.2,
      messages: [{ role: "user", content: "x" }],
    })
    await res.text()
    const body = sent[0].body
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS)
    for (const field of ["provider", "models", "route", "user", "max_completion_tokens"])
      expect(body, field).not.toHaveProperty(field)
    expect(body.usage).toEqual({ include: true })
    expect(body.temperature).toBe(0.2)
  })
})

describe("HT-GW-07: an aborted stream", () => {
  it("is estimated at its reservation, never zero", async () => {
    upstream(streamed("test/budget", { usage: false, hang: true }))
    const res = await ask({
      model: "budget",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(async () => expect((await usageRows())[0]?.status).toBe("estimated"))
    const [row] = await usageRows()
    expect(row.charge_status).toBe("estimated")
    expect(Number(row.charge_micro_inr)).toBe(Number(row.reserved_micro_inr))
    expect(Number(row.charge_micro_inr)).toBeGreaterThan(0)
  })
})

describe("HT-GW-08: upstream failures", () => {
  it("a 5xx is retried once on the fallback model; twice → upstream_unavailable, reservation failed", async () => {
    const sent = upstream(
      () => new Response("overloaded", { status: 503 }),
      streamed("test/fallback")
    )
    const ok = await ask({
      model: "budget",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('"model":"budget"')
    expect(sent.map((s) => s.body.model)).toEqual(["test/budget", "test/fallback"])
    expect((await usageRows())[0]).toMatchObject({
      status: "settled",
      model: "test/fallback",
    })

    await pg.query("delete from kriya.harness_usage")
    upstream(
      () => new Response("down", { status: 502 }),
      () => new Response("down", { status: 500 })
    )
    const down = await ask({
      model: "budget",
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(down.status).toBe(502)
    expect(await down.json()).toMatchObject({ error: "upstream_unavailable" })
    expect((await usageRows())[0]).toMatchObject({ status: "failed" })
  })
})

// Re-audit 2026-11-02 (invariant 7): the concurrency limit lives in SQL
// with the monthly cap, under the same per-person lock; cost the
// reservation didn't estimate never reaches the provider; a request that
// ends badly never stays open (it would hold a stream slot for 15 minutes)
describe("HT-GW-11: re-audit hardening", () => {
  it("SQL refuses a fourth open reservation, whoever asks", async () => {
    const { rows } = await pg.query<{ id: string }>(
      "select id from kriya.harness_devices where user_id = $1 limit 1",
      [user]
    )
    const open = (i: number) =>
      reserve({
        userId: user,
        deviceId: rows[0].id,
        requestKey: `direct-${i}-${Date.now()}`,
        tier: "budget",
        model: "test/budget",
        estimateMicroInr: 1,
      })
    expect(await Promise.all([0, 1, 2, 3, 4].map(open))).toEqual([
      null,
      null,
      null,
      "open",
      "open",
    ])
    // Stale ones (abandoned) don't count
    await pg.query(
      "update kriya.harness_usage set created_at = now() - interval '20 minutes' where user_id = $1",
      [user]
    )
    expect(await open(9)).toBeNull()
  })

  it("n, plugins and web_search_options never reach the provider", async () => {
    const sent = upstream(streamed("test/budget"))
    const res = await ask({
      model: "budget",
      stream: true,
      n: 8,
      plugins: [{ id: "web" }],
      web_search_options: { search_context_size: "high" },
      messages: [{ role: "user", content: "x" }],
    })
    await res.text()
    for (const field of ["n", "plugins", "web_search_options"])
      expect(sent[0].body, field).not.toHaveProperty(field)
  })

  it("an unreadable answer is estimated at once, not left open", async () => {
    upstream(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const res = await ask({
      model: "budget",
      messages: [{ role: "user", content: PROMPT }],
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: "upstream_unavailable" })
    const [row] = await usageRows()
    expect(row).toMatchObject({ status: "estimated", charge_status: "estimated" })
  })

  it("a stream that breaks mid-way is estimated at once, not left open", async () => {
    const encoder = new TextEncoder()
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sse("test/budget").chunks[1]))
              controller.error(new Error("socket hang up"))
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    )
    const res = await ask({
      model: "budget",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    })
    await expect(res.text()).rejects.toThrow()
    await vi.waitFor(async () => expect((await usageRows())[0]?.status).toBe("estimated"))
  })
})

describe("HT-GW-10: no prompt or output in logs", () => {
  it("only ids, statuses and timings", async () => {
    const spies = [vi.spyOn(log, "info"), vi.spyOn(log, "warn"), vi.spyOn(log, "error")]
    upstream(
      streamed("test/budget"),
      () => new Response("down", { status: 500 }),
      () => new Response("down", { status: 500 })
    )
    await (
      await ask({
        model: "budget",
        stream: true,
        messages: [{ role: "user", content: PROMPT }],
      })
    ).text()
    await ask({ model: "budget", messages: [{ role: "user", content: PROMPT }] })
    const logged = JSON.stringify(spies.map((s) => s.mock.calls))
    for (const secret of [PROMPT, ANSWER, "read_file", "upstream-key-not-real", token])
      expect(logged).not.toContain(secret)
  })
})
