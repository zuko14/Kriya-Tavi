import { drizzle } from "drizzle-orm/pglite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import {
  connectMockStream,
  mockRecognition,
  mockSynthesis,
  mockTelephony,
  type Scenario,
} from "@/lib/voice/mock"
import {
  startPhoneVerification,
  updatePreferences,
  verificationStatus,
} from "@/lib/voice/owner-report"
import { claimNext, runCall } from "@/lib/voice/run-call"
import { clock } from "@/lib/voice/schedule"
import { runSession } from "@/lib/voice/session"
import {
  confirmCall,
  createDraft,
  phoneHash,
  requestConfirmation,
} from "@/lib/voice/tasks"
import { handleStatusWebhook, registerTelephony } from "@/lib/voice/verify"
import { getPhoneSettings } from "@/queries/voice"
import { createVoiceService } from "@/voice/index"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"
import { scriptedModel } from "./fair-model"

// Owner calls on mocks (voice phase 6, VOICE_REMINDERS.md): the report call
// with its identity check, delivery (D-08), retries, voicemail and voice
// commands; and the number-verification call (D-13). Report calls use no
// model: fixed lines and fixed intent patterns.

const T0 = new Date("2026-10-13T14:00:00+05:30")
const REPORT_AT = "2026-10-13T18:00:00+05:30"
const OWNER_PHONE = "+919000000001"
const SECRET = "stream-secret-".padEnd(48, "s")

const answered = (id: string): Scenario => ({
  id,
  provider_script: [
    { status: "ringing", atMs: 0 },
    { status: "answered", atMs: 3000 },
    { status: "completed", atMs: 60000 },
  ],
  billable_seconds: 60,
})
const unanswered = (id: string, status: "no_answer" | "busy"): Scenario => ({
  id,
  provider_script: [
    { status: "ringing", atMs: 0 },
    { status, atMs: 30000 },
  ],
})

let pg: TestDb
let user: string
let stt: ReturnType<typeof mockRecognition>
let tts: ReturnType<typeof mockSynthesis>
let service: Awaited<ReturnType<typeof createVoiceService>>
let sessions: Promise<void>[]

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

// The model is never asked on an owner call
const noModel = scriptedModel(() => {
  throw new Error("owner calls use no model")
})

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "test-phone-hash-key-".padEnd(48, "k"))
  clock.now = () => new Date(T0)
  user = await createUser(pg)
  await pg.query("update kriya.profiles set display_name = 'Asha Rao' where id = $1", [
    user,
  ])
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
  stt = mockRecognition()
  tts = mockSynthesis()
  sessions = []
  service = await createVoiceService({
    streamSecret: SECRET,
    onCall: (call) =>
      void sessions.push(
        runSession(call, {
          stt,
          tts,
          model: noModel,
          voice: "test-voice",
          sampleRate: 8000,
          heartbeatMs: 50,
          silenceMs: 1_000,
        })
      ),
  })
})

afterEach(async () => {
  await service.close()
})

afterAll(() => {
  vi.unstubAllEnvs()
  clock.now = () => new Date()
})

// A confirmed task whose outreach call is already settled with an accepted
// outcome (the CA agreed to Wednesday 3 PM), waiting for its 6 PM report
async function awaitingReport(result: "agreed" | "not_reached" = "agreed") {
  const draft = await createDraft(user, {
    idempotencyKey: `key-${Math.random()}`,
    recipientLabel: "my CA",
    recipientPhone: "98765 43210",
    purpose: "Meet tomorrow about the tax review",
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
    reportAt: REPORT_AT,
  })
  if (!draft.ok) throw new Error(draft.message)
  const request = await requestConfirmation(user, draft.taskId)
  if (!request.ok) throw new Error(request.message)
  const confirmed = await confirmCall(user, request.approvalId, request.payloadHash)
  if (!confirmed.ok) throw new Error(confirmed.message)

  await pg.transaction(async (tx) => {
    await tx.query("select set_config('kriya.transition', 'on', true)")
    const [outreach] = (
      await tx.query<{ id: string }>(
        `update kriya.voice_calls set status = $2, attempts = 2
         where voice_task_id = $1 and kind = 'outreach' returning id`,
        [draft.taskId, result === "agreed" ? "settled" : "exhausted"]
      )
    ).rows
    const times =
      result === "agreed"
        ? [["2026-10-13T16:10:00+05:30", "ended", true]]
        : [
            ["2026-10-13T16:10:00+05:30", "busy", false],
            ["2026-10-13T16:25:00+05:30", "no_answer", false],
          ]
    for (const [i, [at, status, connected]] of times.entries()) {
      const [attempt] = (
        await tx.query<{ id: string }>(
          `insert into kriya.call_attempts (user_id, voice_call_id, attempt, policy_version,
             callback_token_hash, stream_token_hash, status, requested_at, connected_at, verified_at)
           values ($1, $2, $3, 'v1', md5(random()::text) || md5(random()::text),
             md5(random()::text) || md5(random()::text), $4, $5::timestamptz,
             case when $6 then $5::timestamptz end, $5::timestamptz) returning id`,
          [user, outreach.id, i + 1, status, at, connected]
        )
      ).rows
      if (connected) {
        await tx.query(
          `insert into kriya.call_outcomes (user_id, voice_task_id, call_attempt_id, observed,
             interpreted, verifier_status)
           values ($1, $2, $3, '{}', $4::jsonb, 'accepted')`,
          [
            user,
            draft.taskId,
            attempt.id,
            JSON.stringify({
              result: "agreed",
              agreed_times: [
                {
                  date: "2026-10-14",
                  time: "15:00",
                  readBackTurnSeq: 4,
                  confirmTurnSeq: 5,
                  superseded: false,
                },
              ],
              proposed_times: [
                { date: "2026-10-14", time: "15:00", by: "tavi", turnSeq: 4 },
              ],
              unresolved_questions: [],
            }),
          ]
        )
      }
    }
    await tx.query(
      "update kriya.voice_tasks set status = 'awaiting_report' where id = $1",
      [draft.taskId]
    )
  })
  const [report] = await q<{ id: string }>(
    "select id from kriya.voice_calls where voice_task_id = $1 and kind = 'owner_report'",
    [draft.taskId]
  )
  return { taskId: draft.taskId, reportId: report.id }
}

const deps = (mock: ReturnType<typeof mockTelephony>) => ({
  workerId: "w1",
  provider: mock,
  appUrl: "https://kriya.test",
  voiceUrl: service.mediaUrl.replace(/\/media\/exotel$/, ""),
  heartbeatMs: 5,
  watchMs: 60_000,
})

// Dials the next due call on a scenario. Unanswered: the provider's final
// webhook ends it. Answered: the stream connects and the test talks
async function dial(scenario: Scenario, { autoPlay = true } = {}) {
  const mock = mockTelephony(scenario)
  registerTelephony(mock)
  const callId = (await claimNext(deps(mock)))!
  expect(callId).toBeTruthy()
  const watching = runCall(callId, deps(mock))
  await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
  const placed = mock.placed[0]
  const token = placed.statusUrl.split("/").at(-1)!
  const hooks = mock.webhooks(placed.providerCallId)
  const final = () => handleStatusWebhook(token, hooks.at(-1)!, new Headers())
  if (!scenario.provider_script.some((e) => e.status === "answered")) {
    for (const body of hooks) await handleStatusWebhook(token, body, new Headers())
    await watching
    return { callId, placed }
  }
  for (const body of hooks.slice(0, 2))
    await handleStatusWebhook(token, body, new Headers())
  const client = await connectMockStream({
    url: service.mediaUrl,
    secret: SECRET,
    token: new URL(placed.streamUrl).searchParams.get("t")!,
    callSid: placed.providerCallId,
    autoPlay,
  })
  const [attempt] = await q<{ id: string }>(
    "select id from kriya.call_attempts where voice_call_id = $1 order by attempt desc limit 1",
    [callId]
  )
  // The provider's final word once the call is over, then the worker's watch
  const end = async () => {
    await client.closed
    await Promise.all(sessions)
    await final()
    await watching
  }
  return { callId, placed, client, attemptId: attempt.id, end }
}

// Waits until Tavi's nth turn has played to its end
const heard = (attemptId: string, n: number) =>
  vi.waitFor(
    async () => {
      const rows = await q<{ played: number | null }>(
        "select played_ms as played from kriya.conversation_turns where call_attempt_id = $1 and speaker = 'tavi' order by seq",
        [attemptId]
      )
      if (rows.length < n || rows[n - 1].played === null) throw new Error("speaking")
    },
    { timeout: 5_000, interval: 10 }
  )

const callee = () => vi.waitFor(() => stt.streams.at(-1)!)

const callRow = (id: string) =>
  q<{
    status: string
    delivered_at: string | null
    acknowledged_at: string | null
    available_at: string
    attempts: number
  }>(
    "select status, delivered_at, acknowledged_at, available_at, attempts from kriya.voice_calls where id = $1",
    [id]
  ).then((r) => r[0])

const taskRow = (id: string) =>
  q<{ status: string; result: string | null }>(
    "select status, result from kriya.voice_tasks where id = $1",
    [id]
  ).then((r) => r[0])

describe("report calls (VOICE_REMINDERS §3–4, D-08)", () => {
  it("T-REM-02 delivered once the report's last mark plays while connected; the task completes", async () => {
    const { taskId, reportId } = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    const { client, attemptId, end } = await dial(answered("report"))
    await heard(attemptId!, 1)
    expect(tts.spoken[0]).toBe(
      "Hi, this is Kriya Tavi with your update about the call to my CA. Is this Asha?"
    )
    ;(await callee()).say("Yes, speaking.")
    await heard(attemptId!, 2)
    expect(tts.spoken[1]).toContain("my CA agreed to Wednesday the 14th at 3 PM")
    expect((await callRow(reportId)).delivered_at).not.toBeNull()
    const [attempt] = await q<{ mark: string | null }>(
      "select last_report_mark_at as mark from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(attempt.mark).not.toBeNull()

    ;(await callee()).say("Got it, thanks.")
    expect((await client!.closed).code).toBe(1000)
    await end!()
    const call = await callRow(reportId)
    expect(call.status).toBe("settled")
    expect(call.acknowledged_at).not.toBeNull()
    expect(await taskRow(taskId)).toEqual({ status: "completed", result: "agreed" })
  })

  it("T-REM-02 answered alone isn't delivered: a hang-up before the last mark goes round again", async () => {
    const { taskId, reportId } = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    const { client, end } = await dial(answered("hangup"), { autoPlay: false })
    await vi.waitFor(() => expect(tts.spoken).toHaveLength(1))
    client!.stop()
    await end!()
    const call = await callRow(reportId)
    expect(call.delivered_at).toBeNull()
    expect(call.status).toBe("retry_wait")
    expect(new Date(call.available_at).toISOString()).toBe(
      new Date("2026-10-13T18:10:00+05:30").toISOString()
    )
    expect((await taskRow(taskId)).status).toBe("awaiting_report")
  })

  it("the report says what's true at dial time: not reached yet, with the times tried", async () => {
    await awaitingReport("not_reached")
    clock.now = () => new Date(REPORT_AT)
    const { attemptId, client, end } = await dial(answered("not-reached"))
    await heard(attemptId!, 1)
    ;(await callee()).say("Yes.")
    await heard(attemptId!, 2)
    expect(tts.spoken[1]).toContain(
      "I haven't been able to reach my CA yet. I tried twice, at 4:10 PM and 4:25 PM"
    )
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("T-REM-03 / §8 worked example: no answer, busy, hang-up mid-report → exhausted, task unreported", async () => {
    const { taskId, reportId } = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    await dial(unanswered("a1", "no_answer"))
    expect((await callRow(reportId)).status).toBe("retry_wait")

    clock.now = () => new Date("2026-10-13T18:10:00+05:30")
    await pg.query("update kriya.voice_calls set available_at = now() where id = $1", [
      reportId,
    ])
    await dial(unanswered("a2", "busy"))
    expect((await callRow(reportId)).status).toBe("retry_wait")

    clock.now = () => new Date("2026-10-13T18:20:00+05:30")
    await pg.query("update kriya.voice_calls set available_at = now() where id = $1", [
      reportId,
    ])
    const third = await dial(answered("a3"), { autoPlay: false })
    await vi.waitFor(() => expect(tts.spoken.length).toBeGreaterThan(0))
    third.client!.stop()
    await third.end!()

    const call = await callRow(reportId)
    expect(call).toMatchObject({ status: "exhausted", attempts: 3, delivered_at: null })
    expect(await taskRow(taskId)).toEqual({ status: "unreported", result: "agreed" })
    // T-REM-07: nothing but voice rows; no agent task, no event for the notifier
    expect(await q("select id from kriya.tasks")).toEqual([])
  })

  it("T-REM-03 a retry that would fall in quiet hours ends the call instead", async () => {
    const { reportId } = await awaitingReport()
    await pg.query(
      "update kriya.voice_profiles set quiet_start = '18:05' where user_id = $1",
      [user]
    )
    clock.now = () => new Date(REPORT_AT)
    await dial(unanswered("quiet", "no_answer"))
    expect((await callRow(reportId)).status).toBe("exhausted")
  })

  it("T-REM-04 / S30 someone else answers: no task details are spoken", async () => {
    const { reportId } = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    const { attemptId, client, end } = await dial(answered("wrong"))
    await heard(attemptId!, 1)
    ;(await callee()).say("No, this is the wrong number.")
    expect((await client!.closed).code).toBe(1000)
    await end!()
    expect(tts.spoken).toEqual([
      "Hi, this is Kriya Tavi with your update about the call to my CA. Is this Asha?",
      "Sorry, wrong person. Goodbye.",
    ])
    const [attempt] = await q<{ end_reason: string }>(
      "select end_reason from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(attempt.end_reason).toBe("not_owner")
    expect((await callRow(reportId)).delivered_at).toBeNull()
  })

  it("S29 voicemail: silence twice → hang up without details", async () => {
    const { reportId } = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    const { attemptId, client, end } = await dial(answered("voicemail"))
    await heard(attemptId!, 1)
    expect((await client!.closed).code).toBe(1000)
    await end!()
    expect(tts.spoken).toEqual([
      "Hi, this is Kriya Tavi with your update about the call to my CA. Is this Asha?",
      "Hello? Is this Asha?",
    ])
    const [attempt] = await q<{ end_reason: string }>(
      "select end_reason from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(attempt.end_reason).toBe("voicemail")
    expect((await callRow(reportId)).status).toBe("retry_wait")
  })
})

describe("voice commands after the report (VOICE_REMINDERS §7)", () => {
  // Connects the report call and plays the report
  async function reported() {
    const task = await awaitingReport()
    clock.now = () => new Date(REPORT_AT)
    const call = await dial(answered("commands"))
    await heard(call.attemptId!, 1)
    ;(await callee()).say("Yes.")
    await heard(call.attemptId!, 2)
    return { ...task, ...call }
  }

  it("T-REM-05 / S19 cancel needs a repeat-back and a yes; recorded as the owner with the turn", async () => {
    const { taskId, attemptId, client, end } = await reported()
    // A second report call the owner asked for earlier
    const [later] = await q<{ id: string }>(
      `insert into kriya.voice_calls (user_id, voice_task_id, kind, seq, to_phone_e164,
         not_before, available_at, max_attempts)
       values ($1, $2, 'owner_report', 2, $3, '2026-10-13T20:00:00+05:30',
         '2026-10-13T20:00:00+05:30', 3) returning id`,
      [user, taskId, OWNER_PHONE]
    )
    ;(await callee()).say("Cancel the other reminders.")
    await heard(attemptId!, 3)
    expect(tts.spoken[2]).toBe(
      "I'll cancel the other report calls about my CA. Shall I go ahead?"
    )
    expect((await callRow(later.id)).status).toBe("scheduled")
    ;(await callee()).say("Yes, please.")
    await heard(attemptId!, 4)
    expect((await callRow(later.id)).status).toBe("canceled")
    const [moved] = await q<{
      actor: string
      evidence: { attemptId: string; turnSeq: number }
    }>(
      "select actor, evidence from kriya.voice_transitions where entity_id = $1 and to_status = 'canceled'",
      [later.id]
    )
    expect(moved.actor).toBe("owner")
    expect(moved.evidence).toEqual({ attemptId, turnSeq: 5 })
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("T-REM-05 a cancel without a yes changes nothing", async () => {
    const { taskId, attemptId, client, end } = await reported()
    const [later] = await q<{ id: string }>(
      `insert into kriya.voice_calls (user_id, voice_task_id, kind, seq, to_phone_e164,
         not_before, available_at, max_attempts)
       values ($1, $2, 'owner_report', 2, $3, now(), now(), 3) returning id`,
      [user, taskId, OWNER_PHONE]
    )
    ;(await callee()).say("Cancel that reminder.")
    await heard(attemptId!, 3)
    ;(await callee()).say("No, leave it.")
    await heard(attemptId!, 4)
    expect((await callRow(later.id)).status).toBe("scheduled")
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("T-REM-05 'remind me again at 8' repeats back, then schedules the next report call", async () => {
    const { taskId, attemptId, client, end } = await reported()
    ;(await callee()).say("Remind me again at 8.")
    await heard(attemptId!, 3)
    expect(tts.spoken[2]).toBe(
      "I'll call you again on Tuesday the 13th at 8 PM. Shall I go ahead?"
    )
    ;(await callee()).say("Yes.")
    await heard(attemptId!, 4)
    const calls = await q<{ seq: number; status: string; available_at: string }>(
      "select seq, status, available_at from kriya.voice_calls where voice_task_id = $1 and kind = 'owner_report' order by seq",
      [taskId]
    )
    expect(calls).toHaveLength(2)
    expect(calls[1].status).toBe("scheduled")
    expect(new Date(calls[1].available_at).toISOString()).toBe(
      new Date("2026-10-13T20:00:00+05:30").toISOString()
    )
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("a reminder inside quiet hours is refused, not moved", async () => {
    const { taskId, attemptId, client, end } = await reported()
    ;(await callee()).say("Remind me again at 11 pm.")
    await heard(attemptId!, 3)
    expect(tts.spoken[2]).toContain("quiet hours")
    const calls = await q(
      "select id from kriya.voice_calls where voice_task_id = $1 and kind = 'owner_report'",
      [taskId]
    )
    expect(calls).toHaveLength(1)
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("T-REM-06 / S20 'call him again tomorrow' makes a draft only; nobody is called", async () => {
    const { attemptId, client, end } = await reported()
    ;(await callee()).say("Call him again tomorrow.")
    await heard(attemptId!, 3)
    expect(tts.spoken[2]).toContain(
      "Nobody is called until you confirm it in the Kriya app"
    )
    const drafts = await q<{ id: string; status: string }>(
      "select id, status from kriya.voice_tasks where status = 'draft' and user_id = $1",
      [user]
    )
    expect(drafts).toHaveLength(1)
    expect(
      await q("select id from kriya.voice_calls where voice_task_id = $1", [drafts[0].id])
    ).toEqual([])
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })

  it("asks back what time was suggested, repeats the report, and refuses anything else", async () => {
    const { attemptId, client, end } = await reported()
    ;(await callee()).say("What time did he suggest?")
    await heard(attemptId!, 3)
    expect(tts.spoken[2]).toBe("Times mentioned: Wednesday the 14th at 3 PM.")
    ;(await callee()).say("Book me a cab.")
    await heard(attemptId!, 4)
    expect(tts.spoken[3]).toBe(
      "I can't do that on this call; you can do it in the Kriya app."
    )
    ;(await callee()).say("Repeat that.")
    await heard(attemptId!, 5)
    expect(tts.spoken[4]).toBe(tts.spoken[1])
    ;(await callee()).say("That's all.")
    await client!.closed
    await end!()
  })
})

describe("Phone & calls settings (UX spec §7)", () => {
  it("shows the verified number masked, and saves preferences through the owner's session", async () => {
    expect(await getPhoneSettings(user)).toMatchObject({
      phone: "+91 90xxx xxx01",
      timezone: "Asia/Kolkata",
      quietStart: "21:30",
      reportMaxAttempts: 3,
    })
    expect(
      await updatePreferences(user, {
        timezone: "Asia/Dubai",
        quietStart: "22:00",
        reportMaxAttempts: 5,
        transcriptRetentionDays: 0,
      })
    ).toEqual({ ok: true })
    expect(await getPhoneSettings(user)).toMatchObject({
      timezone: "Asia/Dubai",
      quietStart: "22:00",
      reportMaxAttempts: 5,
      transcriptRetentionDays: 0,
    })
  })

  it("a new owner gets the defaults; the number can't be set this way", async () => {
    const other = await createUser(pg)
    await seed(pg, "voice_access", { user_id: other })
    expect(await getPhoneSettings(other)).toMatchObject({
      phone: null,
      quietEnd: "08:00",
    })
    expect(await updatePreferences(other, { reportMode: "on_completion" })).toEqual({
      ok: true,
    })
    // The session has no update grant on the number (D-13)
    await expect(
      updatePreferences(other, { ownerPhoneE164: OWNER_PHONE } as never)
    ).rejects.toThrow()
    expect(await getPhoneSettings(other)).toMatchObject({
      phone: null,
      reportMode: "on_completion",
    })
  })
})

describe("T-REM-08 number verification by keypad (D-13)", () => {
  const NEW_NUMBER = "+919000000002"

  async function verificationCall() {
    const started = await startPhoneVerification(user, "90000 00002")
    if (!started.ok) throw new Error(started.message)
    const call = await dial(answered("verify"))
    await heard(call.attemptId!, 1)
    expect(tts.spoken[0]).toBe(
      "Hi, this is Kriya Tavi. To verify this number, please key in the 6-digit code shown on your screen."
    )
    return { ...started, ...call }
  }

  it("the right code verifies the number", async () => {
    const { code, verificationId, client, end } = await verificationCall()
    expect(code).toMatch(/^\d{6}$/)
    for (const digit of code) client!.dtmf(digit)
    expect((await client!.closed).code).toBe(1000)
    await end!()
    const [profile] = await q<{ phone: string; at: string | null }>(
      "select owner_phone_e164 as phone, owner_phone_verified_at as at from kriya.voice_profiles where user_id = $1",
      [user]
    )
    expect(profile.phone).toBe(NEW_NUMBER)
    expect(profile.at).not.toBeNull()
    expect(await verificationStatus(user, verificationId)).toEqual({
      ok: true,
      status: "verified",
    })
    // The code itself is never stored or spoken
    expect(tts.spoken.join(" ")).not.toContain(code)
    expect(
      JSON.stringify(await q("select * from kriya.phone_verifications"))
    ).not.toContain(code)
  })

  it("three wrong codes fail; the old number stays verified", async () => {
    const { code, verificationId, client, end } = await verificationCall()
    const wrong = code === "111111" ? "222222" : "111111"
    for (let i = 0; i < 3; i++) {
      for (const digit of wrong) client!.dtmf(digit)
      await vi.waitFor(() => expect(tts.spoken.length).toBeGreaterThan(i + 1))
    }
    expect((await client!.closed).code).toBe(1000)
    await end!()
    expect(tts.spoken.at(-1)).toBe(
      "That code didn't match. Please start again in the Kriya app. Goodbye."
    )
    const [profile] = await q<{ phone: string }>(
      "select owner_phone_e164 as phone from kriya.voice_profiles where user_id = $1",
      [user]
    )
    expect(profile.phone).toBe(OWNER_PHONE)
    expect(await verificationStatus(user, verificationId)).toEqual({
      ok: true,
      status: "failed",
    })
  })

  // F33: the number typed in may be a stranger's
  it("a suppressed number, or a fourth verification of a number in a day from any account, is refused", async () => {
    const other = await createUser(pg)
    await seed(pg, "voice_access", { user_id: other })
    for (const who of [user, other, other]) {
      expect((await startPhoneVerification(who, "90000 00002")).ok).toBe(true)
    }
    expect(await startPhoneVerification(user, "90000 00002")).toMatchObject({
      ok: false,
      code: "limit_number",
    })
    await seed(pg, "call_suppressions", {
      phone_hash: phoneHash("+919000000003"),
      reason: "recipient_opt_out",
    })
    expect(await startPhoneVerification(other, "90000 00003")).toMatchObject({
      ok: false,
      code: "suppressed",
    })
    expect(
      await q("select 1 from kriya.voice_calls where to_phone_e164 = '+919000000003'")
    ).toEqual([])
  })

  it("an expired code isn't dialled", async () => {
    const started = await startPhoneVerification(user, "90000 00002")
    if (!started.ok) throw new Error(started.message)
    // Codes last 10 minutes by the app's clock
    clock.now = () => new Date(T0.getTime() + 11 * 60_000)
    const mock = mockTelephony(answered("expired"))
    registerTelephony(mock)
    const callId = (await claimNext(deps(mock)))!
    await runCall(callId, deps(mock))
    expect(mock.placed).toEqual([])
    expect((await callRow(callId)).status).toBe("blocked")
    expect(await verificationStatus(user, started.verificationId)).toEqual({
      ok: true,
      status: "expired",
    })
  })
})
