import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { privileged, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { setSetting } from "@/lib/config"
import { checkVoiceAllowed, usageSummary } from "@/lib/entitlements"
import { applyMarkup } from "@/lib/money"
import { voiceFinance, voiceOperations } from "@/lib/owner"
import {
  chargeFinishedVoiceTasks,
  chargeVoiceTask,
  fxSettings,
  overBudget,
  repriceVoiceTask,
} from "@/lib/voice/metering"
import type { TelephonyProvider } from "@/lib/voice/providers"
import { claimNext } from "@/lib/voice/run-call"
import { clock } from "@/lib/voice/schedule"
import { createDraft, emergencyStop, requestConfirmation } from "@/lib/voice/tasks"
import { recordAttemptEnd } from "@/lib/voice/verify"
import { getCallUsage } from "@/queries/voice"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, seed, voiceCall, voiceTask } from "../db/voice-fixtures"

// Voice phase 8 (COST_AND_METERING.md, TEST_STRATEGY T-COST-01…06, T-OWN-01)

vi.mock("server-only", () => ({}))

let pg: TestDb
let user: string

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "test-phone-hash-key-".padEnd(48, "k"))
  vi.stubEnv("KRIYA_FX_USD_INR", "")
  vi.stubEnv("KRIYA_VOICE_DAILY_SPEND_CAP_MICRO_INR", "")
  user = await createUser(pg)
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000, markup_bps = 15000 where id = 'free'`
  )
})

afterEach(() => vi.unstubAllEnvs())
afterAll(() => {
  clock.now = () => new Date()
})

// A finished task with one outreach call and its attempts
async function finishedTask(status: string, attempts: Record<string, unknown>[]) {
  const task = await voiceTask(pg, user, { status })
  const call = await voiceCall(pg, user, task, { status: "exhausted" })
  const ids: string[] = []
  for (const row of attempts) {
    ids.push(
      await callAttempt(pg, user, call, {
        telephony_provider: "exotel",
        verified_at: new Date().toISOString(),
        ...row,
      })
    )
  }
  return { task, call, attempts: ids }
}

const usage = (task: string) =>
  q<{
    request_key: string
    reported_cost_micro: string | null
    estimated_cost_micro: string | null
    price_id: string | null
  }>("select * from kriya.voice_usage where voice_task_id = $1 order by request_key", [
    task,
  ])

const chargeOf = (task: string) =>
  q<{
    status: string
    unmetered_items: number
    provider_cost_micro_inr: number | null
    charge_micro_inr: number | null
    cost_basis: string
  }>("select * from kriya.voice_charges where voice_task_id = $1", [task])

const price = (row: Record<string, unknown>) =>
  seed(pg, "voice_prices", {
    effective_from: "2026-01-01T00:00:00Z",
    checked_at: "2026-10-20T00:00:00Z",
    source: "test quote",
    ...row,
  })

describe("T-COST-01/02 telephony usage for every attempt", () => {
  it("busy, unanswered and answered attempts each get one row; unpriced ones stay null and count as unmetered", async () => {
    const { task, attempts } = await finishedTask("failed", [
      { status: "busy" },
      { status: "no_answer" },
      { status: "ended", billable_seconds: 75 },
    ])
    // T-COST-02: the webhook and the worker's watch may both end an attempt
    for (const id of [...attempts, ...attempts]) await recordAttemptEnd(id)
    const rows = await usage(task)
    expect(rows.map((r) => r.request_key)).toEqual(
      attempts.map((id) => `${id}:telephony`).sort()
    )
    expect(rows.every((r) => r.reported_cost_micro === null)).toBe(true)
    expect(rows.every((r) => r.estimated_cost_micro === null)).toBe(true)

    expect(await chargeFinishedVoiceTasks()).toBe(1)
    expect(await chargeOf(task)).toMatchObject([
      {
        status: "unpriced",
        unmetered_items: 3,
        provider_cost_micro_inr: null,
        charge_micro_inr: null,
      },
    ])
  })
})

describe("T-COST-04 one charge per voice task; repricing", () => {
  it("failed and cancelled tasks are charged once; a price reprices estimated charges only", async () => {
    const failed = await finishedTask("failed", [
      { status: "busy" },
      { status: "ended", billable_seconds: 61 },
    ])
    const cancelled = await finishedTask("cancelled", [{ status: "no_answer" }])
    for (const id of [...failed.attempts, ...cancelled.attempts])
      await recordAttemptEnd(id)
    // A task whose provider reported its cost is final
    const reported = await finishedTask("completed", [])
    await seed(pg, "voice_usage", {
      request_key: `${reported.task}:telephony:reported`,
      user_id: user,
      voice_task_id: reported.task,
      component: "telephony",
      provider: "exotel",
      product: "outbound",
      quantity: 30,
      unit: "second",
      usage_status: "reported",
      reported_cost_micro: 400_000,
      reported_currency: "INR",
      cost_source: "provider",
    })

    expect(await chargeFinishedVoiceTasks()).toBe(3)
    expect(await chargeFinishedVoiceTasks()).toBe(0)
    await chargeVoiceTask(failed.task)
    expect(await q("select 1 from kriya.voice_charges")).toHaveLength(3)
    expect((await chargeOf(reported.task))[0]).toMatchObject({
      status: "final",
      cost_basis: "provider",
      provider_cost_micro_inr: 400000,
      charge_micro_inr: applyMarkup(400_000, 15000),
    })

    // ₹0.30 per 60 s pulse: 61 s is 2 pulses. The busy attempt has no
    // seconds to bill, so it stays unmetered
    await price({
      id: "exotel:outbound",
      provider: "exotel",
      product: "outbound",
      unit: "minute_pulse_60",
      price_micro: 300_000,
      currency: "INR",
    })
    for (const t of [failed.task, cancelled.task, reported.task])
      await repriceVoiceTask(t)
    expect((await chargeOf(failed.task))[0]).toMatchObject({
      status: "estimated",
      cost_basis: "estimate",
      unmetered_items: 1,
      provider_cost_micro_inr: 600000,
      charge_micro_inr: applyMarkup(600_000, 15000),
    })
    expect((await usage(failed.task)).map((r) => r.price_id)).toContain("exotel:outbound")
    // The final charge is never changed by repricing
    expect((await chargeOf(reported.task))[0]).toMatchObject({
      status: "final",
      provider_cost_micro_inr: 400000,
    })
  })

  it("USD costs need the owner's rate; without one the charge is unpriced", async () => {
    const { task } = await finishedTask("completed", [])
    await seed(pg, "voice_usage", {
      request_key: `${task}:llm:1`,
      user_id: user,
      voice_task_id: task,
      component: "llm",
      provider: "openrouter",
      product: "test/model",
      usage_status: "reported",
      reported_cost_micro: 1_000,
      reported_currency: "USD",
      cost_source: "provider",
    })
    await chargeVoiceTask(task)
    expect((await chargeOf(task))[0]).toMatchObject({
      status: "unpriced",
      charge_micro_inr: null,
    })
    vi.stubEnv("KRIYA_FX_USD_INR", "84.0000")
    await repriceVoiceTask(task)
    expect((await chargeOf(task))[0]).toMatchObject({
      status: "final",
      provider_cost_micro_inr: 84000,
    })
  })
})

describe("T-COST-05 voice charges spend the plan allowance", () => {
  it("usageSummary includes them, and a used-up allowance blocks confirmation", async () => {
    clock.now = () => new Date("2026-10-13T14:00:00+05:30")
    await pg.query(
      "update kriya.plans set included_usage_micro_inr = 1000000, overage_allowed = false where id = 'free'"
    )
    // Confirmation needs the name Tavi introduces the owner by
    await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [
      user,
    ])
    await seed(pg, "voice_access", { user_id: user })
    await seed(pg, "voice_profiles", {
      user_id: user,
      owner_phone_e164: "+919000000001",
      owner_phone_verified_at: new Date().toISOString(),
    })
    const before = await usageSummary(user)
    expect(checkVoiceAllowed(before).ok).toBe(true)

    const { task } = await finishedTask("completed", [])
    await seed(pg, "voice_charges", {
      user_id: user,
      voice_task_id: task,
      plan_id: "free",
      provider_cost_micro_inr: 700_000,
      cost_basis: "provider",
      markup_bps: 15000,
      charge_micro_inr: 1_050_000,
      status: "final",
    })
    const after = await usageSummary(user)
    expect(after.usedMicroInr).toBe(before.usedMicroInr + 1_050_000)
    expect(checkVoiceAllowed(after)).toMatchObject({ ok: false, code: "allowance" })

    const draft = await createDraft(user, {
      idempotencyKey: `key-${Math.random()}`,
      recipientLabel: "my CA",
      recipientPhone: "98765 43210",
      purpose: "Ask whether 3 PM tomorrow works for the tax review",
      goal: {
        type: "schedule_meeting",
        date: "2026-10-14",
        preferred: "15:00",
        acceptable: [{ from: "14:00", to: "17:00" }],
      },
      authority: {
        mayAcceptWithinAcceptable: true,
        mayProposeAlternatives: true,
        mayShareOwnerPhone: false,
        mayDiscuss: [],
      },
      mustNot: [],
    })
    if (!draft.ok) throw new Error(draft.message)
    expect(await requestConfirmation(user, draft.taskId)).toMatchObject({
      ok: false,
      code: "limit_allowance",
    })
  })
})

describe("T-COST-06 the platform daily spend cap stops claims", () => {
  // claimNext reads only the provider's name before claiming
  const deps = (name = "mock") => ({
    workerId: "w1",
    provider: { name } as unknown as TelephonyProvider,
    appUrl: "https://kriya.test",
    voiceUrl: "wss://voice.kriya.test",
  })

  async function dueCall() {
    const task = await voiceTask(pg, user, { status: "authorized" })
    return voiceCall(pg, user, task, {
      not_before: "2026-01-01T00:00:00Z",
      available_at: "2026-01-01T00:00:00Z",
    })
  }

  async function spentToday(microInr: number) {
    await seed(pg, "voice_usage", {
      request_key: `spend:${Math.random()}`,
      user_id: user,
      component: "telephony",
      provider: "exotel",
      product: "outbound",
      usage_status: "reported",
      reported_cost_micro: microInr,
      reported_currency: "INR",
      cost_source: "provider",
    })
  }

  it("refuses at the cap, claims under it", async () => {
    const call = await dueCall()
    await spentToday(2_000_000)
    vi.stubEnv("KRIYA_VOICE_DAILY_SPEND_CAP_MICRO_INR", "2000000")
    expect(await claimNext(deps())).toBeNull()
    vi.stubEnv("KRIYA_VOICE_DAILY_SPEND_CAP_MICRO_INR", "10000000")
    expect(await claimNext(deps())).toBe(call)
  })

  it("unset: a real provider is refused, the mock may dial", async () => {
    const call = await dueCall()
    expect(await claimNext(deps("exotel"))).toBeNull()
    expect(await claimNext(deps())).toBe(call)
  })
})

describe("T-SEC-04 the live switches and the emergency stop stop new dials", () => {
  const deps = (name: string) => ({
    workerId: "w1",
    provider: { name } as unknown as TelephonyProvider,
    appUrl: "https://kriya.test",
    voiceUrl: "wss://voice.kriya.test",
  })
  const due = async () => {
    const task = await voiceTask(pg, user, { status: "authorized" })
    const call = await voiceCall(pg, user, task, {
      not_before: "2026-01-01T00:00:00Z",
      available_at: "2026-01-01T00:00:00Z",
    })
    return { task, call }
  }

  it("a real provider dials only with KRIYA_VOICE_LIVE=1 and voice.liveCalls on", async () => {
    const { call } = await due()
    vi.stubEnv("KRIYA_VOICE_DAILY_SPEND_CAP_MICRO_INR", "10000000")
    expect(await claimNext(deps("exotel"))).toBeNull()
    vi.stubEnv("KRIYA_VOICE_LIVE", "1")
    // The owner's switch is still off (the default)
    expect(await claimNext(deps("exotel"))).toBeNull()
    // As the owner saves it in /owner/config (clears the settings cache)
    await setSetting("voice.liveCalls", "on", user)
    expect(await claimNext(deps("exotel"))).toBe(call)
    // Off again, so the process-wide settings cache holds nothing for later tests
    await setSetting("voice.liveCalls", null, user)
  })

  it("after the emergency stop nothing is claimed", async () => {
    await due()
    await due()
    expect((await emergencyStop(user)).cancelled).toBe(2)
    expect(await claimNext(deps("mock"))).toBeNull()
    expect(
      await q("select status from kriya.voice_calls where status <> 'canceled'")
    ).toEqual([])
  })
})

describe("T-OWN-01 the owner console never reads what was said", () => {
  it("the voice queries name no transcript, outcome or note column", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/owner.ts"), "utf8")
    expect(source).not.toMatch(
      /conversation_?turns|conversationTurns|interpreted|verifier_?notes|verifierNotes|call_outcomes|callOutcomes/i
    )
  })

  it("no canary from a transcript or outcome reaches the voice views", async () => {
    const { task, attempts } = await finishedTask("completed", [
      { status: "ended", billable_seconds: 40 },
    ])
    await seed(pg, "conversation_turns", {
      user_id: user,
      call_attempt_id: attempts[0],
      seq: 1,
      speaker: "callee",
      text: "CANARY-7f3a the CA said something private",
    })
    await seed(pg, "call_outcomes", {
      user_id: user,
      voice_task_id: task,
      call_attempt_id: attempts[0],
      observed: { note: "CANARY-7f3a" },
      interpreted: { summary: "CANARY-7f3a" },
      verifier_status: "accepted",
      verifier_notes: "CANARY-7f3a",
    })
    await recordAttemptEnd(attempts[0])
    await chargeFinishedVoiceTasks()
    const out = JSON.stringify([await voiceFinance(30), await voiceOperations()])
    expect(out).toContain("telephony")
    expect(out).not.toContain("CANARY")
  })
})

describe("per-task budget before a dial (COST_AND_METERING §5)", () => {
  it("spend so far plus one full-length call at the telephony price must fit", async () => {
    const task = {
      id: await voiceTask(pg, user),
      costBudgetMicroInr: 1_000_000,
      maxCallSeconds: 300,
    }
    const fx = await fxSettings()
    // No telephony price: nothing to project
    expect(await overBudget(privileged, task, "exotel", fx)).toBe(false)
    // ₹0.005 a second × 300 s = ₹1.50 > ₹1.00
    await price({
      id: "exotel:outbound",
      provider: "exotel",
      product: "outbound",
      unit: "second",
      price_micro: 5_000,
      currency: "INR",
    })
    expect(await overBudget(privileged, task, "exotel", fx)).toBe(true)
    await pg.query("update kriya.voice_prices set price_micro = 1000")
    expect(await overBudget(privileged, task, "exotel", fx)).toBe(false)
    // ₹0.30 projected + ₹0.80 already spent > ₹1.00
    await seed(pg, "voice_usage", {
      request_key: `${task.id}:telephony:1`,
      user_id: user,
      voice_task_id: task.id,
      component: "telephony",
      provider: "exotel",
      product: "outbound",
      usage_status: "reported",
      reported_cost_micro: 800_000,
      reported_currency: "INR",
      cost_source: "provider",
    })
    expect(await overBudget(privileged, task, "exotel", fx)).toBe(true)
  })
})

describe("the Calls row on /usage (UX spec §10)", () => {
  it("counts this period's own calls, minutes and charges; another person's don't count", async () => {
    const since = new Date(Date.now() - 86_400_000)
    const mine = await finishedTask("completed", [
      { status: "ended", billable_seconds: 90 },
    ])
    await pg.query("update kriya.voice_tasks set authorized_at = now() where id = $1", [
      mine.task,
    ])
    await seed(pg, "voice_charges", {
      user_id: user,
      voice_task_id: mine.task,
      cost_basis: "estimate",
      markup_bps: 15000,
      charge_micro_inr: 450_000,
      status: "estimated",
    })
    const other = await createUser(pg)
    const theirs = await voiceTask(pg, other, { status: "completed" })
    await pg.query("update kriya.voice_tasks set authorized_at = now() where id = $1", [
      theirs,
    ])
    await seed(pg, "voice_charges", {
      user_id: other,
      voice_task_id: theirs,
      cost_basis: "provider",
      markup_bps: 15000,
      charge_micro_inr: 9_000_000,
      status: "final",
    })
    expect(await getCallUsage(user, since, 5)).toEqual({
      calls: 1,
      minutes: 2,
      chargedMicroInr: 450_000,
      estimated: 1,
      remainingToday: 4,
    })
  })
})
