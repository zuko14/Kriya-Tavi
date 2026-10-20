import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { mockTelephony, type Scenario } from "@/lib/voice/mock"
import type { TelephonyProvider } from "@/lib/voice/providers"
import {
  claimNext,
  prepareAttempt,
  recoverVoice,
  runCall,
  voiceLoop,
} from "@/lib/voice/run-call"
import { clock } from "@/lib/voice/schedule"
import type { DraftInput } from "@/lib/voice/schemas"
import {
  cancelVoiceTask,
  confirmCall,
  createDraft,
  declineCall,
  emergencyStop,
  requestConfirmation,
} from "@/lib/voice/tasks"
import { handleStatusWebhook, registerTelephony } from "@/lib/voice/verify"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"

// Durable call orchestration on the mock provider (voice phase 3): tasks,
// confirmation, the claim loop, write-ahead attempts, webhooks, retries,
// cancel, limits and crash recovery, against PGlite. The clock is pinned to
// a past Tuesday afternoon so calling-hours rules are deterministic and
// everything is already due by the database's clock.

const T0 = new Date("2026-10-13T14:00:00+05:30")
const OWNER_PHONE = "+919000000001"
const CA_PHONE = "+919876543210"
const SCENARIOS = path.join(process.cwd(), "tests", "voice", "scenarios")
const scenario = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(SCENARIOS, `${id}.json`), "utf8")) as Scenario

let pg: TestDb
let user: string
let mock: ReturnType<typeof mockTelephony>

const deps = (provider: TelephonyProvider = mock, extra = {}) => ({
  workerId: "w1",
  provider,
  appUrl: "https://kriya.test",
  voiceUrl: "wss://voice.kriya.test",
  heartbeatMs: 5,
  watchMs: 2_000,
  ...extra,
})

const input = (extra: Partial<DraftInput> = {}): DraftInput => ({
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
  ...extra,
})

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "test-phone-hash-key-".padEnd(48, "k"))
  clock.now = () => new Date(T0)
  user = await createUser(pg)
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [user])
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000 where id = 'free'`
  )
  await seed(pg, "voice_access", { user_id: user })
  await seed(pg, "voice_profiles", {
    user_id: user,
    owner_phone_e164: OWNER_PHONE,
    owner_phone_verified_at: T0.toISOString(),
  })
  mock = mockTelephony(scenario("S02"))
  registerTelephony(mock)
})

afterAll(() => {
  vi.unstubAllEnvs()
  clock.now = () => new Date()
})

async function authorize(extra: Partial<DraftInput> = {}) {
  const draft = await createDraft(user, input(extra))
  if (!draft.ok) throw new Error(draft.message)
  const request = await requestConfirmation(user, draft.taskId)
  if (!request.ok) throw new Error(request.message)
  const confirmed = await confirmCall(user, request.approvalId, request.payloadHash)
  if (!confirmed.ok) throw new Error(confirmed.message)
  return draft.taskId
}

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

const taskStatus = async (id: string) =>
  (
    await q<{ status: string; result: string | null }>(
      "select status, result from kriya.voice_tasks where id = $1",
      [id]
    )
  )[0]

const calls = (task: string) =>
  q<{ id: string; kind: string; status: string; attempts: number; available_at: Date }>(
    "select id, kind, status, attempts, available_at from kriya.voice_calls where voice_task_id = $1 order by kind",
    [task]
  )

const attempts = (call: string) =>
  q<{ id: string; status: string; verified: boolean }>(
    "select id, status, verified_at is not null as verified from kriya.call_attempts where voice_call_id = $1 order by attempt",
    [call]
  )

const tokenOf = (index = -1) => mock.placed.at(index)!.statusUrl.split("/").at(-1)!

// Dials the next due call and delivers its scripted webhooks
async function dialAndDeliver(provider: TelephonyProvider = mock) {
  const id = await claimNext(deps(provider))
  if (!id) throw new Error("nothing to claim")
  const placedBefore = mock.placed.length
  const done = runCall(id, deps(provider))
  await vi.waitFor(() => expect(mock.placed.length).toBe(placedBefore + 1))
  const placed = mock.placed.at(-1)!
  for (const body of mock.webhooks(placed.providerCallId)) {
    await handleStatusWebhook(tokenOf(), body, new Headers())
  }
  await done
  return id
}

describe("drafts and confirmation", () => {
  it("needs voice access and an enabled plan", async () => {
    await pg.query("delete from kriya.voice_access where user_id = $1", [user])
    expect(await createDraft(user, input())).toMatchObject({
      ok: false,
      code: "voice_unavailable",
    })
  })

  it("refuses numbers that aren't Indian mobiles, and the owner's own number", async () => {
    for (const phone of ["112", "1800 123 4567", "+1 415 555 0100", "04023456789"]) {
      expect(await createDraft(user, input({ recipientPhone: phone }))).toMatchObject({
        ok: false,
        code: "invalid",
      })
    }
    expect(await createDraft(user, input({ recipientPhone: OWNER_PHONE }))).toMatchObject(
      {
        ok: false,
        code: "invalid",
      }
    )
  })

  it("T-Q-07 the same idempotency key gives the same task; confirming twice gives one set of calls", async () => {
    const same = input({ reportAt: "2026-10-13T18:00:00+05:30" })
    const a = await createDraft(user, same)
    const b = await createDraft(user, same)
    expect(a.ok && b.ok && a.taskId === b.taskId).toBe(true)
    if (!a.ok) return
    const request = await requestConfirmation(user, a.taskId)
    if (!request.ok) throw new Error(request.message)
    expect(request.payload).toMatchObject({
      recipientLabel: "my CA",
      phone: CA_PHONE,
      disclosure: expect.stringContaining("an AI assistant calling on behalf of Asha"),
      cost: "price not yet set",
    })
    const first = await confirmCall(user, request.approvalId, request.payloadHash)
    const second = await confirmCall(user, request.approvalId, request.payloadHash)
    expect(first).toEqual({ ok: true, taskId: a.taskId, status: "authorized" })
    expect(second).toEqual(first)
    expect((await calls(a.taskId)).map((c) => [c.kind, c.status])).toEqual([
      ["outreach", "scheduled"],
      ["owner_report", "scheduled"],
    ])
  })

  it("refuses a stale payload hash, and a decline goes back to draft", async () => {
    const draft = await createDraft(user, input())
    if (!draft.ok) throw new Error(draft.message)
    const request = await requestConfirmation(user, draft.taskId)
    if (!request.ok) throw new Error(request.message)
    expect(await confirmCall(user, request.approvalId, "f".repeat(64))).toMatchObject({
      ok: false,
      code: "stale_approval",
    })
    expect(await declineCall(user, request.approvalId)).toEqual({ ok: true })
    expect((await taskStatus(draft.taskId)).status).toBe("draft")
    expect(await calls(draft.taskId)).toEqual([])
  })

  it("another person's task is simply not found", async () => {
    const draft = await createDraft(user, input())
    if (!draft.ok) throw new Error(draft.message)
    const other = await createUser(pg)
    await seed(pg, "voice_access", { user_id: other })
    expect(await requestConfirmation(other, draft.taskId)).toMatchObject({
      ok: false,
      code: "not_found",
    })
    expect(await cancelVoiceTask(other, draft.taskId)).toMatchObject({
      code: "not_found",
    })
  })

  it("refuses a report in quiet hours, or without a verified owner number", async () => {
    const late = await createDraft(user, input({ reportAt: "2026-10-13T22:30:00+05:30" }))
    if (!late.ok) throw new Error(late.message)
    expect(await requestConfirmation(user, late.taskId)).toMatchObject({
      code: "quiet_hours",
    })
    await pg.query("update kriya.voice_profiles set owner_phone_verified_at = null")
    const report = await createDraft(
      user,
      input({ reportAt: "2026-10-13T18:00:00+05:30" })
    )
    if (!report.ok) throw new Error(report.message)
    expect(await requestConfirmation(user, report.taskId)).toMatchObject({
      code: "number_unverified",
    })
  })
})

describe("the claim loop on the mock provider", () => {
  it("T-Q-02 commits the attempt as requested before placeCall is sent", async () => {
    const task = await authorize()
    const seen: string[] = []
    const watching: TelephonyProvider = {
      ...mock,
      placeCall: async (args) => {
        const [row] = await q<{ status: string }>(
          "select status from kriya.call_attempts where id = $1",
          [args.attemptId]
        )
        seen.push(row?.status ?? "missing")
        return mock.placeCall(args)
      },
    }
    registerTelephony(watching)
    await dialAndDeliver(watching)
    expect(seen).toEqual(["requested"])
    expect((await taskStatus(task)).status).toBe("in_progress")
  })

  it("S02 busy: one retry after 15 minutes, then exhausted; usage rows with no invented cost", async () => {
    const task = await authorize()
    const callId = await dialAndDeliver()
    const [outreach] = await calls(task)
    expect(outreach).toMatchObject({ status: "retry_wait", attempts: 1 })
    expect(outreach.available_at).toEqual(new Date("2026-10-13T14:15:00+05:30"))
    expect(await attempts(callId)).toEqual([
      expect.objectContaining({ status: "busy", verified: true }),
    ])

    await dialAndDeliver()
    expect((await calls(task))[0]).toMatchObject({ status: "exhausted", attempts: 2 })
    expect(mock.placed).toHaveLength(2)
    expect(await taskStatus(task)).toEqual({ status: "completed", result: "busy" })

    // T-COST-01: one telephony row per attempt; cost unknown, never zero
    expect(
      await q(
        `select usage_status, reported_cost_micro, estimated_cost_micro
         from kriya.voice_usage where voice_task_id = $1 and component = 'telephony'`,
        [task]
      )
    ).toEqual([
      { usage_status: "missing", reported_cost_micro: null, estimated_cost_micro: null },
      { usage_status: "missing", reported_cost_micro: null, estimated_cost_micro: null },
    ])
  })

  it("S05 no answer: bounded retries; the task waits for its report", async () => {
    mock = mockTelephony(scenario("S05"))
    registerTelephony(mock)
    const task = await authorize({ reportAt: "2026-10-13T18:00:00+05:30" })
    await dialAndDeliver()
    await dialAndDeliver()
    expect((await calls(task)).map((c) => [c.kind, c.status])).toEqual([
      ["outreach", "exhausted"],
      ["owner_report", "scheduled"],
    ])
    expect((await taskStatus(task)).status).toBe("awaiting_report")
  })

  it("T-Q-05 a retry outside calling hours waits for the next opening", async () => {
    clock.now = () => new Date("2026-10-13T20:55:00+05:30")
    const task = await authorize()
    await dialAndDeliver()
    expect((await calls(task))[0]).toMatchObject({
      status: "retry_wait",
      available_at: new Date("2026-10-14T09:00:00+05:30"),
    })
  })

  it("T-Q-05 a retry after the window closes ends the call instead", async () => {
    // The report at 14:10 closes the outreach window before the 14:15 retry
    const task = await authorize({ reportAt: "2026-10-13T14:10:00+05:30" })
    await dialAndDeliver()
    expect((await calls(task)).find((c) => c.kind === "outreach")?.status).toBe(
      "exhausted"
    )
  })

  it("S15 duplicate and out-of-order webhooks: one transition each, final state correct", async () => {
    mock = mockTelephony(scenario("S15"))
    registerTelephony(mock)
    const task = await authorize()
    const callId = await dialAndDeliver()
    const [attempt] = await attempts(callId)
    expect(attempt.status).toBe("ended")
    const steps = await q<{ to_status: string }>(
      "select to_status from kriya.voice_transitions where entity_id = $1 order by id",
      [attempt.id]
    )
    expect(steps.map((s) => s.to_status)).toEqual([
      "requested",
      "initiated",
      "ringing",
      "answered",
      "ended",
    ])
    const [{ n }] = await q<{ n: number }>(
      "select count(*)::int as n from kriya.call_events where call_attempt_id = $1",
      [attempt.id]
    )
    expect(n).toBe(3)
    expect((await taskStatus(task)).status).toBe("in_progress")
  })
})

describe("T-WH status webhooks", () => {
  it("T-WH-01 an unknown token or a malformed body stores nothing", async () => {
    await authorize()
    const id = await claimNext(deps())
    const done = runCall(id!, deps())
    await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
    const [body] = mock.webhooks(mock.placed[0].providerCallId)
    expect(await handleStatusWebhook("not-a-token", body, new Headers())).toEqual({
      status: 404,
    })
    expect(await handleStatusWebhook(tokenOf(), "garbage", new Headers())).toEqual({
      status: 400,
    })
    expect(await q("select 1 from kriya.call_events")).toEqual([])
    for (const b of mock.webhooks(mock.placed[0].providerCallId)) {
      await handleStatusWebhook(tokenOf(), b, new Headers())
    }
    await done
  })

  it("T-WH-02 a duplicate webhook is one event and one transition", async () => {
    await authorize()
    const id = await claimNext(deps())
    const done = runCall(id!, deps())
    await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
    const [ringing, busy] = mock.webhooks(mock.placed[0].providerCallId)
    expect(await handleStatusWebhook(tokenOf(), ringing, new Headers())).toEqual({
      status: 200,
    })
    expect(await handleStatusWebhook(tokenOf(), ringing, new Headers())).toEqual({
      status: 200,
    })
    const [{ attempt }] = await q<{ attempt: string }>(
      "select id as attempt from kriya.call_attempts"
    )
    expect(
      await q("select status from kriya.call_events where call_attempt_id = $1", [
        attempt,
      ])
    ).toEqual([{ status: "ringing" }])
    expect(
      await q(
        "select count(*)::int as n from kriya.voice_transitions where entity_id = $1 and to_status = 'ringing'",
        [attempt]
      )
    ).toEqual([{ n: 1 }])
    await handleStatusWebhook(tokenOf(), busy, new Headers())
    await done
  })

  it("T-WH-03 a terminal webhook is checked with the provider, and the provider wins", async () => {
    const task = await authorize()
    const id = await claimNext(deps())
    const done = runCall(id!, deps())
    await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
    const placed = mock.placed[0]
    // The webhook claims the call completed; the provider's record says busy
    const forged = JSON.stringify({
      CallSid: placed.providerCallId,
      CustomField: placed.attemptId,
      Status: "completed",
      EventId: "forged-1",
      At: T0.toISOString(),
    })
    expect(await handleStatusWebhook(tokenOf(), forged, new Headers())).toEqual({
      status: 200,
    })
    await done
    const [attempt] = await attempts(id!)
    expect(attempt).toMatchObject({ status: "busy", verified: true })
    expect((await calls(task))[0].status).toBe("retry_wait")
  })
})

describe("cancel and emergency stop", () => {
  it("T-Q-06 a scheduled call cancels at once and is never dialled", async () => {
    const task = await authorize({ reportAt: "2026-10-13T18:00:00+05:30" })
    expect(await cancelVoiceTask(user, task)).toEqual({ ok: true, status: "cancelled" })
    expect((await calls(task)).map((c) => c.status)).toEqual(["canceled", "canceled"])
    expect(await claimNext(deps())).toBeNull()
    expect(await cancelVoiceTask(user, task)).toMatchObject({ code: "already_final" })
  })

  it("T-Q-06 a ringing call is hung up within a heartbeat; nothing more is dialled", async () => {
    mock = mockTelephony({
      id: "ring",
      provider_script: [{ status: "ringing", atMs: 0 }],
    })
    registerTelephony(mock)
    const task = await authorize()
    const id = await claimNext(deps())
    const done = runCall(id!, deps())
    await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
    expect(await cancelVoiceTask(user, task)).toEqual({ ok: true, status: "in_progress" })
    await done
    expect(mock.hangups).toEqual([mock.placed[0].providerCallId])
    expect((await attempts(id!))[0].status).toBe("canceled")
    expect((await calls(task))[0].status).toBe("canceled")
    expect((await taskStatus(task)).status).toBe("cancelled")
    expect(await claimNext(deps())).toBeNull()
  })

  it("emergency stop cancels every open task of the person", async () => {
    const a = await authorize()
    const b = await authorize()
    const draft = await createDraft(user, input())
    if (!draft.ok) throw new Error(draft.message)
    expect(await emergencyStop(user)).toEqual({ ok: true, cancelled: 3 })
    for (const id of [a, b, draft.taskId]) {
      expect((await taskStatus(id)).status).toBe("cancelled")
    }
  })
})

describe("T-Q-08 limits and suppression", () => {
  it("stops at the plan's daily outreach limit", async () => {
    await pg.query(
      "update kriya.plans set max_outreach_calls_per_day = 1 where id = 'free'"
    )
    await authorize()
    const second = await createDraft(user, input())
    if (!second.ok) throw new Error(second.message)
    expect(await requestConfirmation(user, second.taskId)).toMatchObject({
      code: "limit_daily",
    })
  })

  it("checks suppression at confirmation and again at dial time", async () => {
    const draft = await createDraft(user, input())
    if (!draft.ok) throw new Error(draft.message)
    const request = await requestConfirmation(user, draft.taskId)
    if (!request.ok) throw new Error(request.message)
    const [{ hash }] = await q<{ hash: string }>(
      "select recipient_phone_hash as hash from kriya.voice_tasks where id = $1",
      [draft.taskId]
    )
    await seed(pg, "call_suppressions", { phone_hash: hash, reason: "recipient_opt_out" })
    expect(
      await confirmCall(user, request.approvalId, request.payloadHash)
    ).toMatchObject({
      code: "suppressed",
    })
    await pg.query("delete from kriya.call_suppressions")

    const task = await authorize()
    await seed(pg, "call_suppressions", { phone_hash: hash, reason: "recipient_opt_out" })
    const id = await claimNext(deps())
    await runCall(id!, deps())
    expect(mock.placed).toEqual([])
    expect((await calls(task))[0].status).toBe("blocked")
    expect((await taskStatus(task)).status).toBe("failed")
  })

  it("a number called three times today by anyone waits for tomorrow", async () => {
    await pg.query(
      "update kriya.plans set max_outreach_calls_per_day = 10 where id = 'free'"
    )
    for (let i = 0; i < 3; i++) {
      await authorize()
      await dialAndDeliver()
    }
    const task = await authorize()
    const id = await claimNext(deps())
    await runCall(id!, deps())
    expect(mock.placed).toHaveLength(3)
    expect((await calls(task))[0]).toMatchObject({
      status: "retry_wait",
      attempts: 0,
      available_at: new Date("2026-10-14T09:00:00+05:30"),
    })
  })
})

describe("crash recovery (D1 = 0)", () => {
  const expireLeases = () =>
    pg.query(
      "update kriya.voice_calls set lease_expires_at = now() - interval '1 second'"
    )

  it("T-Q-03 / S16 worker dies after requested; the provider has the call: reconciled, never redialled", async () => {
    const task = await authorize()
    const id = await claimNext(deps())
    const attempt = await prepareAttempt(id!, deps())
    // The request reached the provider, then the worker died
    await mock.placeCall({
      attemptId: attempt!.attemptId,
      to: CA_PHONE,
      callerId: "+918000000000",
      streamUrl: "wss://x",
      statusUrl: attempt!.statusUrl,
      ringTimeoutSeconds: 30,
      maxDurationSeconds: 300,
    })
    await expireLeases()
    const resumed = await recoverVoice(deps(mock, { workerId: "w2" }))
    expect(resumed).toEqual([id])
    const done = runCall(id!, deps(mock, { workerId: "w2" }))
    for (const body of mock.webhooks(mock.placed[0].providerCallId)) {
      await handleStatusWebhook(tokenOf(), body, new Headers())
    }
    await done
    expect(mock.placed).toHaveLength(1)
    expect((await attempts(id!))[0].status).toBe("busy")
    expect((await calls(task))[0].status).toBe("retry_wait")
  })

  it("T-Q-04 worker dies after requested; the provider has no record: unknown, owner decides, no redial", async () => {
    const task = await authorize()
    const id = await claimNext(deps())
    await prepareAttempt(id!, deps())
    await expireLeases()
    const resumed = await recoverVoice(deps(mock, { workerId: "w2" }))
    for (const call of resumed) await runCall(call, deps(mock, { workerId: "w2" }))
    expect(mock.placed).toEqual([])
    expect((await attempts(id!))[0].status).toBe("unknown")
    expect((await calls(task))[0].status).toBe("needs_owner")
    expect((await taskStatus(task)).status).toBe("needs_owner")
    expect(await claimNext(deps())).toBeNull()
  })

  it("a placeCall the provider rejected fails the attempt and follows the retry rules", async () => {
    mock = mockTelephony({ ...scenario("S02"), place_error: "rejected" })
    registerTelephony(mock)
    const task = await authorize()
    const id = await claimNext(deps())
    await runCall(id!, deps())
    expect((await attempts(id!))[0]).toMatchObject({ status: "failed", verified: true })
    expect((await calls(task))[0].status).toBe("retry_wait")
  })

  it("a placeCall that timed out is unknown: no automatic redial of a third party", async () => {
    mock = mockTelephony({ ...scenario("S02"), place_error: "timeout" })
    registerTelephony(mock)
    const task = await authorize()
    const id = await claimNext(deps())
    await runCall(id!, deps())
    expect((await attempts(id!))[0].status).toBe("unknown")
    expect((await taskStatus(task)).status).toBe("needs_owner")
  })

  it("F25 a real provider dials only voice.testNumbers; none set means none", async () => {
    const live = { ...mock, name: "exotel" as const }
    await authorize()
    let id = await claimNext(deps())
    expect(await prepareAttempt(id!, deps(live))).toBeNull()
    expect(
      await q("select status, last_error_code from kriya.voice_calls where id = $1", [id])
    ).toEqual([{ status: "blocked", last_error_code: "not_a_test_number" }])

    vi.stubEnv("KRIYA_VOICE_TEST_NUMBERS", "+919812345678")
    // A live provider also needs a telephony price (fails closed otherwise)
    await seed(pg, "voice_prices", {
      id: "exotel:outbound",
      provider: "exotel",
      product: "outbound",
      unit: "second",
      price_micro: 1_000,
      currency: "INR",
      effective_from: "2026-01-01T00:00:00Z",
      checked_at: "2026-10-20T00:00:00Z",
      source: "test quote",
    })
    await authorize({ recipientPhone: "98123 45678" })
    id = await claimNext(deps())
    expect(await prepareAttempt(id!, deps(live))).toMatchObject({ to: "+919812345678" })
    vi.stubEnv("KRIYA_VOICE_TEST_NUMBERS", "")
  })

  it("F27 a final webhook before the worker records the call id never uses the body's id", async () => {
    const getCall = vi.spyOn(mock, "getCall")
    await authorize()
    const id = await claimNext(deps())
    const attempt = await prepareAttempt(id!, deps())
    const body = JSON.stringify({
      CallSid: "forged-call",
      CustomField: attempt!.attemptId,
      Status: "completed",
      EventId: "e1",
    })
    const token = attempt!.statusUrl.split("/").at(-1)!
    expect(await handleStatusWebhook(token, body, new Headers())).toEqual({ status: 200 })
    expect(getCall).not.toHaveBeenCalled()
    expect((await attempts(id!))[0].status).toBe("requested")
  })
})

describe("T-WRK-01 the voice loop beside the agent queue", () => {
  it("agent tasks are still claimed while a voice call is dialing", async () => {
    await authorize()
    expect(await claimNext(deps())).not.toBeNull()
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000)`,
      [user]
    )
    expect(await q("select id from kriya.claim_task('agent-worker', 30)")).toHaveLength(1)
  })

  it("errors in the voice loop are logged and never stop it", async () => {
    await authorize()
    const broken: TelephonyProvider = {
      ...mock,
      placeCall: async () => {
        throw new Error("boom")
      },
    }
    const stop = new AbortController()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const loop = voiceLoop({
      ...deps(broken),
      concurrency: 1,
      pollMs: 5,
      recoverMs: 5,
      signal: stop.signal,
    })
    await vi.waitFor(async () =>
      expect((await q("select status from kriya.call_attempts"))[0]).toEqual({
        status: "unknown",
      })
    )
    stop.abort()
    await expect(loop).resolves.toBeUndefined()
    error.mockRestore()
  })
})
