import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

// actions/voice.ts: identity from the session only, input validated, rate
// limits applied, nothing placed. Session and limiter are stubbed; the
// database is PGlite.

const state = vi.hoisted(() => ({ user: "", allowed: true }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: state.user, email: null }),
}))
vi.mock("@/lib/rate-limit", () => ({
  allowAll: async () => state.allowed,
  clientIp: async () => "203.0.113.7",
}))

import {
  askToConfirmCall,
  cancelCall,
  confirmVoiceCall,
  draftCall,
  stopAllCalls,
} from "@/actions/voice"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { clock } from "@/lib/voice/schedule"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"

let pg: TestDb

const input = (extra = {}) => ({
  idempotencyKey: `k-${Math.random()}`,
  recipientLabel: "my CA",
  recipientPhone: "+91 98765 43210",
  purpose: "Ask whether 3 PM works",
  goal: { type: "ask_question", question: "Does 3 PM tomorrow work?" },
  authority: {
    mayAcceptWithinAcceptable: false,
    mayProposeAlternatives: false,
    mayShareOwnerPhone: false,
    mayDiscuss: [],
  },
  ...extra,
})

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "k".repeat(48))
  clock.now = () => new Date("2026-10-13T14:00:00+05:30")
  state.user = await createUser(pg)
  state.allowed = true
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [
    state.user,
  ])
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000 where id = 'free'`
  )
  await seed(pg, "voice_access", { user_id: state.user })
})

describe("voice server actions", () => {
  it("draft, confirm and cancel as the signed-in person; no call is placed", async () => {
    const draft = await draftCall(input())
    if (!draft.ok) throw new Error(draft.message)
    const ask = await askToConfirmCall(draft.taskId)
    if (!ask.ok) throw new Error(ask.message)
    expect(await confirmVoiceCall(ask.approvalId, ask.payloadHash)).toMatchObject({
      ok: true,
      status: "authorized",
    })
    const { rows } = await pg.query<{ user_id: string }>(
      "select user_id from kriya.voice_tasks"
    )
    expect(rows).toEqual([{ user_id: state.user }])
    expect((await pg.query("select 1 from kriya.call_attempts")).rows).toEqual([])
    expect(await cancelCall(draft.taskId)).toEqual({ ok: true, status: "cancelled" })
  })

  it("ignores a user id in the input: the task belongs to the session", async () => {
    const someoneElse = await createUser(pg)
    const draft = await draftCall({
      ...input(),
      userId: someoneElse,
      user_id: someoneElse,
    })
    if (!draft.ok) throw new Error(draft.message)
    const { rows } = await pg.query("select user_id from kriya.voice_tasks")
    expect(rows).toEqual([{ user_id: state.user }])
  })

  it("names the invalid fields", async () => {
    const result = await draftCall(input({ recipientLabel: "", goal: { type: "chat" } }))
    expect(result).toMatchObject({ ok: false, code: "invalid" })
    expect(Object.keys((result as { fields: object }).fields)).toEqual(
      expect.arrayContaining(["recipientLabel", "goal.type"])
    )
    expect(await askToConfirmCall("not-a-uuid")).toMatchObject({ code: "invalid" })
    expect(await confirmVoiceCall(crypto.randomUUID(), "short")).toMatchObject({
      code: "invalid",
    })
  })

  it("rate limits drafts and confirmations, but never the stop", async () => {
    state.allowed = false
    expect(await draftCall(input())).toMatchObject({ code: "rate_limited" })
    expect(await askToConfirmCall(crypto.randomUUID())).toMatchObject({
      code: "rate_limited",
    })
    expect(await stopAllCalls()).toEqual({ ok: true, cancelled: 0 })
  })
})
