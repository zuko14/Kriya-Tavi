import { drizzle } from "drizzle-orm/pglite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { LANGUAGES } from "@/lib/voice/languages"
import {
  connectMockStream,
  mockRecognition,
  mockSynthesis,
  mockTelephony,
  type Scenario,
} from "@/lib/voice/mock"
import type { SpeechSynthesisProvider } from "@/lib/voice/providers"
import {
  claimNext,
  loadAttemptContext,
  recoverVoice,
  runCall,
} from "@/lib/voice/run-call"
import { clock } from "@/lib/voice/schedule"
import { runSession, type SessionDeps } from "@/lib/voice/session"
import { confirmCall, createDraft, requestConfirmation } from "@/lib/voice/tasks"
import { handleStatusWebhook, registerTelephony } from "@/lib/voice/verify"
import { createVoiceService } from "@/voice/index"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, seed, voiceCall, voiceTask } from "../db/voice-fixtures"
import { fair, say, scriptedModel, type Seen } from "./fair-model"

// A whole call on mocks (TEST_STRATEGY §1, "Pipeline end to end"): the
// worker dials, the provider's webhooks arrive, the media stream connects
// to kriya-voice, and the dialogue runs on mock STT/TTS and the scripted
// model; then the outcome is extracted, checked and the task settles.

const en = LANGUAGES["en-IN"]
const T0 = new Date("2026-10-13T14:00:00+05:30")
const SECRET = "stream-secret-".padEnd(48, "s")
const SCENARIO: Scenario = {
  id: "session",
  provider_script: [
    { status: "ringing", atMs: 0 },
    { status: "answered", atMs: 4000 },
    { status: "completed", atMs: 60000 },
  ],
  billable_seconds: 60,
}

// The fair dialogue model, and an extractor that reports what the notes say
const extracting = (seen: Seen) => {
  if (!seen.system.includes("Fill in the outcome")) return fair(seen)
  const notes = JSON.parse(seen.last.split("Notes Tavi recorded during the call:\n")[1])
  const agreed = notes.agreements.filter((a: { superseded: boolean }) => !a.superseded)
  return [
    say(
      JSON.stringify({
        recipient: { label: "my CA", confirmed_role: true, name_said: null },
        purpose: "Meet on Wednesday",
        summary: agreed.length ? "The CA agreed to the meeting." : "No time was agreed.",
        result: agreed.length ? "agreed" : "unclear",
        commitments: [],
        proposed_times: notes.proposed,
        agreed_times: notes.agreements,
        unresolved_questions: [],
        next_action: { type: "none", suggested_at: null },
        next_action_due_at: null,
        uncertainty_notes: [],
        confidence: 0.9,
      })
    ),
  ]
}

let pg: TestDb
let user: string
let mock: ReturnType<typeof mockTelephony>
let stt: ReturnType<typeof mockRecognition>
let service: Awaited<ReturnType<typeof createVoiceService>> | undefined
let sessions: Promise<void>[]

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

async function start(tts: SpeechSynthesisProvider = mockSynthesis()) {
  const deps: SessionDeps = {
    stt,
    tts,
    model: scriptedModel(extracting),
    voice: "test-voice",
    sampleRate: 8000,
    heartbeatMs: 50,
  }
  service = await createVoiceService({
    streamSecret: SECRET,
    onCall: (call) => void sessions.push(runSession(call, deps)),
  })
  return service
}

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
  mock = mockTelephony(SCENARIO)
  registerTelephony(mock)
  stt = mockRecognition()
  sessions = []
  service = undefined
})

afterEach(async () => {
  await service?.close()
})

afterAll(() => {
  vi.unstubAllEnvs()
  clock.now = () => new Date()
})

// Authorizes the canonical task, dials it, and connects its media stream
async function dialAndConnect(voice: NonNullable<typeof service>, autoPlay = true) {
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
  })
  if (!draft.ok) throw new Error(draft.message)
  const request = await requestConfirmation(user, draft.taskId)
  if (!request.ok) throw new Error(request.message)
  const confirmed = await confirmCall(user, request.approvalId, request.payloadHash)
  if (!confirmed.ok) throw new Error(confirmed.message)

  const deps = {
    workerId: "w1",
    provider: mock,
    appUrl: "https://kriya.test",
    voiceUrl: voice.mediaUrl.replace(/\/media\/exotel$/, ""),
    heartbeatMs: 5,
    watchMs: 5_000,
  }
  const callId = (await claimNext(deps))!
  const watching = runCall(callId, deps)
  await vi.waitFor(() => expect(mock.placed).toHaveLength(1))
  const placed = mock.placed[0]
  const statusToken = placed.statusUrl.split("/").at(-1)!
  const [ringing, answered, completed] = mock.webhooks(placed.providerCallId)
  for (const body of [ringing, answered]) {
    await handleStatusWebhook(statusToken, body, new Headers())
  }
  const client = await connectMockStream({
    url: voice.mediaUrl,
    secret: SECRET,
    token: new URL(placed.streamUrl).searchParams.get("t")!,
    callSid: placed.providerCallId,
    autoPlay,
  })
  await watching
  const [attempt] = await q<{ id: string }>("select id from kriya.call_attempts")
  return {
    taskId: draft.taskId,
    attemptId: attempt.id,
    client,
    // The provider's final word, after the call
    complete: () => handleStatusWebhook(statusToken, completed, new Headers()),
  }
}

// Waits until Tavi's nth turn has played to the end
const heard = (attemptId: string, n: number) =>
  vi.waitFor(
    async () => {
      const rows = await q<{ played: number | null }>(
        "select played_ms as played from kriya.conversation_turns where call_attempt_id = $1 and speaker = 'tavi' order by seq",
        [attemptId]
      )
      if (rows.length < n || rows[n - 1].played === null)
        throw new Error("still speaking")
    },
    { timeout: 5_000, interval: 10 }
  )

const outcomeOf = (attemptId: string) =>
  vi.waitFor(
    async () => {
      const [row] = await q<{
        verifier_status: string
        interpreted: Record<string, unknown>
      }>(
        "select verifier_status, interpreted from kriya.call_outcomes where call_attempt_id = $1",
        [attemptId]
      )
      if (!row || row.verifier_status === "pending") throw new Error("not checked yet")
      return row
    },
    { timeout: 5_000, interval: 10 }
  )

describe("a connected call, end to end on mocks", () => {
  it("S01: disclosure, read-back, agreement; outcome accepted; task completed", async () => {
    const { taskId, attemptId, client, complete } = await dialAndConnect(await start())
    const callee = stt.streams[0]
    await heard(attemptId, 1)
    callee.say("Hello?")
    await heard(attemptId, 2)
    callee.say("Yes, speaking.")
    await heard(attemptId, 3)
    callee.say("Yes, that works.")
    // Tavi says goodbye and hangs up
    expect((await client.closed).code).toBe(1000)
    await Promise.all(sessions)

    const outcome = await outcomeOf(attemptId)
    expect(outcome.verifier_status).toBe("accepted")
    expect(outcome.interpreted).toMatchObject({
      result: "agreed",
      agreed_times: [{ date: "2026-10-14", time: "15:00" }],
    })
    const turns = await q<{ seq: number; speaker: string; text: string }>(
      "select seq, speaker, text from kriya.conversation_turns where call_attempt_id = $1 order by seq",
      [attemptId]
    )
    expect(turns.map((t) => t.speaker).join(" ")).toBe(
      "tavi callee tavi callee tavi callee tavi"
    )
    expect(turns[0].text).toBe(en.disclosure("Asha"))
    expect(turns[4].text).toBe(
      "Asha would like to meet you on Wednesday the 14th at 3 PM. Would that work for you?"
    )

    // T-POL-01: the attempt records the bundle it ran on
    const [attempt] = await q<{
      policy_version: string
      status: string
      end_reason: string
    }>(
      "select policy_version, status, end_reason from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(attempt).toEqual({
      policy_version: "v1",
      status: "ended",
      end_reason: "tavi_hangup",
    })

    // The provider's final status: verified, then the call and task settle
    await complete()
    const [task] = await q<{ status: string; result: string }>(
      "select status, result from kriya.voice_tasks where id = $1",
      [taskId]
    )
    expect(task).toEqual({ status: "completed", result: "agreed" })
    const [call] = await q<{ status: string }>(
      "select status from kriya.voice_calls where voice_task_id = $1",
      [taskId]
    )
    expect(call.status).toBe("settled")

    // Metered: the model, every spoken turn, the stream, the telephony leg
    const usage = await q<{ component: string; n: number }>(
      "select component, count(*)::int as n from kriya.voice_usage where call_attempt_id = $1 group by component order by component",
      [attemptId]
    )
    expect(Object.fromEntries(usage.map((u) => [u.component, u.n]))).toEqual({
      llm: 2,
      stt: 1,
      telephony: 1,
      tts: 4,
    })
    expect(mock.placed).toHaveLength(1)
  })

  // Every log line of a whole call, web to worker to kriya-voice and back
  it("T-SEC-02 no secret or phone number in the logs of a whole call", async () => {
    const lines: string[] = []
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(args.map(String).join(" "))
      })
    )
    try {
      const { attemptId, client, complete } = await dialAndConnect(await start())
      const callee = stt.streams[0]
      await heard(attemptId, 1)
      callee.say("Hello?")
      await heard(attemptId, 2)
      callee.say("Yes, speaking.")
      await heard(attemptId, 3)
      callee.say("Yes, that works.")
      await client.closed
      await Promise.all(sessions)
      await complete()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const all = lines.join("\n")
    expect(all).toContain("voice outcome checked")
    // The callee's number in any spacing, and the two secrets in use
    expect(all.replace(/[\s-]/g, "")).not.toMatch(/9876543210/)
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain("test-phone-hash-key-")
  })

  it("T-DLG-05 barge-in: clear sent, synthesis stopped, the turn marked interrupted, the disclosure repeated", async () => {
    const { attemptId, client } = await dialAndConnect(await start(), false)
    await vi.waitFor(() => expect(client.audio()).toBeGreaterThan(0))
    // The callee hears the first chunks, then talks over the rest
    client.play()
    await vi.waitFor(async () => {
      const [{ n }] = await q<{ n: number }>(
        "select count(*)::int as n from kriya.conversation_turns where call_attempt_id = $1",
        [attemptId]
      )
      expect(n).toBe(1)
    })
    await vi.waitFor(() => expect(client.audio()).toBeGreaterThan(2))
    stt.streams[0].say("Hello? Who is this?")
    await vi.waitFor(async () => {
      const rows = await q<{ seq: number }>(
        "select seq from kriya.conversation_turns where call_attempt_id = $1 order by seq",
        [attemptId]
      )
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2])
    })
    expect(client.received.some((m) => m.event === "clear")).toBe(true)
    const rows = await q<{ text: string; interrupted: boolean; played: number }>(
      "select text, interrupted, played_ms as played from kriya.conversation_turns where call_attempt_id = $1 order by seq",
      [attemptId]
    )
    expect(rows[0].interrupted).toBe(true)
    // Some of the disclosure was heard, not all of it
    expect(rows[0].played).toBeGreaterThan(0)
    expect(rows[0].played).toBeLessThan(5_000)
    expect(rows[2].text).toBe(en.disclosure("Asha"))
    client.stop()
    await client.closed
    await Promise.all(sessions)
  })

  it("'don't call me again' suppresses the number for everyone (S24)", async () => {
    const { attemptId, client } = await dialAndConnect(await start())
    await heard(attemptId, 1)
    stt.streams[0].say("Please don't call me again.")
    await client.closed
    await Promise.all(sessions)
    const [task] = await q<{ hash: string }>(
      "select recipient_phone_hash as hash from kriya.voice_tasks"
    )
    const rows = await q<{ phone_hash: string; reason: string }>(
      "select phone_hash, reason from kriya.call_suppressions"
    )
    expect(rows).toEqual([{ phone_hash: task.hash, reason: "recipient_opt_out" }])
  })

  it("TTS down: the sentence is tried twice, then the call ends as tts_failed (S13)", async () => {
    const broken: SpeechSynthesisProvider = {
      name: "broken",
      billedUnits: (text) => text.length,
      async *synthesize() {
        throw new Error("vendor down")
      },
    }
    const { attemptId, client } = await dialAndConnect(await start(broken))
    await client.closed
    await Promise.all(sessions)
    const [attempt] = await q<{ end_reason: string }>(
      "select end_reason from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(attempt.end_reason).toBe("tts_failed")
    const tts = await q<{ request_key: string }>(
      "select request_key from kriya.voice_usage where component = 'tts' order by request_key"
    )
    expect(tts.map((r) => r.request_key)).toEqual([
      `${attemptId}:tts:0:1`,
      `${attemptId}:tts:0:2`,
    ])
    // Nobody spoke: never a success
    expect((await outcomeOf(attemptId)).verifier_status).toBe("needs_review")
  })
})

describe("T-SEC-05 kriya-voice reads only the stream's own attempt", () => {
  it("by attempt id and user id; another person's id finds nothing", async () => {
    const other = await createUser(pg)
    const attemptFor = async (owner: string) =>
      callAttempt(
        pg,
        owner,
        await voiceCall(
          pg,
          owner,
          await voiceTask(pg, owner, { status: "in_progress" }),
          {
            status: "dialing",
          }
        ),
        { status: "answered" }
      )
    const mine = await attemptFor(user)
    // The other person's rows exist beside it
    await attemptFor(other)
    expect(await loadAttemptContext(mine, other)).toBeNull()
    const ctx = await loadAttemptContext(mine, user)
    expect(Object.keys(ctx!).sort()).toEqual(["attempt", "call", "task"])
    expect([ctx!.attempt.userId, ctx!.call.userId, ctx!.task.userId]).toEqual([
      user,
      user,
      user,
    ])
  })
})

describe("S17 kriya-voice lost mid-call", () => {
  it("recovery hangs up, ends the attempt as voice_lost, leaves it for review, never redials", async () => {
    const { providerCallId } = await mock.placeCall({
      attemptId: "seeded",
      to: "+919876543210",
      callerId: "",
      streamUrl: "wss://voice.test/media/exotel?t=x",
      statusUrl: "https://web.test/s/y",
      ringTimeoutSeconds: 30,
      maxDurationSeconds: 300,
    })
    const task = await voiceTask(pg, user, { status: "in_progress" })
    const call = await voiceCall(pg, user, task, { status: "dialing" })
    const attempt = await callAttempt(pg, user, call, {
      status: "connected",
      telephony_provider: "mock",
      provider_call_id: providerCallId,
      answered_at: new Date(Date.now() - 90_000).toISOString(),
      connected_at: new Date(Date.now() - 90_000).toISOString(),
      stream_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    })
    await recoverVoice({
      workerId: "w1",
      provider: mock,
      appUrl: "https://kriya.test",
      voiceUrl: "wss://voice.kriya.test",
    })
    expect(mock.hangups).toEqual([providerCallId])
    expect(mock.placed).toHaveLength(1)
    const [row] = await q<{ status: string; end_reason: string; verified: boolean }>(
      "select status, end_reason, verified_at is not null as verified from kriya.call_attempts where id = $1",
      [attempt]
    )
    expect(row).toEqual({ status: "ended", end_reason: "voice_lost", verified: true })
    const [outcome] = await q<{ verifier_status: string }>(
      "select verifier_status from kriya.call_outcomes where call_attempt_id = $1",
      [attempt]
    )
    expect(outcome.verifier_status).toBe("needs_review")
    const [taskRow] = await q<{ status: string }>(
      "select status from kriya.voice_tasks where id = $1",
      [task]
    )
    expect(taskRow.status).toBe("needs_owner")
  })
})
