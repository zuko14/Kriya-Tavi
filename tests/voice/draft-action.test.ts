import { MockLanguageModelV4 } from "ai/test"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

// extractCallDraft (actions/voice.ts): identity from the session only, input
// validated, rate limited, and nothing stored but the model's usage. The
// session, limiter and model are stubbed; the database is PGlite.

const state = vi.hoisted(() => ({ user: "", allowed: true }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: state.user, email: null }),
}))
vi.mock("@/lib/rate-limit", () => ({
  allowAll: async () => state.allowed,
  clientIp: async () => "203.0.113.7",
}))
vi.mock("@/lib/models", async (original) => {
  const actual = await original<typeof import("@/lib/models")>()
  return {
    ...actual,
    modelForTier: async () => "test/budget-model",
    createGatewayModel: (modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doGenerate: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                recipientLabel: "my CA",
                recipientName: null,
                recipientPhone: "98765 43210",
                purpose: "Ask whether 3 PM tomorrow works",
                goalType: "ask_question",
                date: null,
                preferred: null,
                acceptable: [],
                message: null,
                question: "Does 3 PM tomorrow work?",
                mayAcceptWithinAcceptable: false,
                mayProposeAlternatives: false,
                reportAt: null,
              }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 400,
              noCache: 400,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 80, text: 80, reasoning: undefined },
          },
          warnings: [],
        }),
      }),
  }
})

import { extractCallDraft } from "@/actions/voice"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"

let pg: TestDb

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  state.user = await createUser(pg)
  state.allowed = true
})

const grant = async () => {
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000`
  )
  await seed(pg, "voice_access", { user_id: state.user })
}

describe("extractCallDraft", () => {
  it("fills the card from the person's words; stores only the model's usage", async () => {
    await grant()
    const result = await extractCallDraft(
      "Call my CA on 98765 43210 and ask whether 3 PM tomorrow works"
    )
    expect(result).toMatchObject({
      ok: true,
      missing: [],
      draft: { recipientPhone: "98765 43210", goal: { type: "ask_question" } },
    })
    expect((await pg.query("select 1 from kriya.voice_tasks")).rows).toHaveLength(0)
    const usage = await pg.query<{ user_id: string; component: string }>(
      "select user_id, component from kriya.voice_usage"
    )
    expect(usage.rows).toEqual([{ user_id: state.user, component: "llm" }])
  })

  it("needs voice access", async () => {
    expect(await extractCallDraft("Call my CA")).toMatchObject({
      ok: false,
      code: "voice_unavailable",
    })
  })

  it("refuses empty or oversized text, and respects the rate limit", async () => {
    await grant()
    for (const text of ["", "x".repeat(2001), 42]) {
      expect(await extractCallDraft(text)).toMatchObject({ ok: false, code: "invalid" })
    }
    state.allowed = false
    expect(await extractCallDraft("Call my CA")).toMatchObject({
      ok: false,
      code: "rate_limited",
    })
  })
})
