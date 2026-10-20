import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { mockTelephony, type Scenario } from "@/lib/voice/mock"
import type { TelephonyProvider } from "@/lib/voice/providers"
import { claimNext, prepareAttempt, recoverVoice, runCall } from "@/lib/voice/run-call"
import { clock } from "@/lib/voice/schedule"
import type { DraftInput } from "@/lib/voice/schemas"
import { confirmCall, createDraft, requestConfirmation } from "@/lib/voice/tasks"
import { handleStatusWebhook, registerTelephony } from "@/lib/voice/verify"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed, transition } from "../db/voice-fixtures"

// The fault-injection suite (EVALUATION_PLAN §4, D1 and R2; scenarios S14–S17
// and the placeCall failures): every fault, repeated, on the mock provider.
// D1 counts rings per intended attempt across all runs and must be 0 extra;
// no third party is ever redialled after an attempt we can't account for.

const T0 = new Date("2026-10-13T14:00:00+05:30")
const OWNER_PHONE = "+919000000001"
const RUNS = 10

let pg: TestDb
let user: string

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

const deps = (provider: TelephonyProvider, extra = {}) => ({
  workerId: "w1",
  provider,
  appUrl: "https://kriya.test",
  voiceUrl: "wss://voice.kriya.test",
  heartbeatMs: 5,
  watchMs: 2_000,
  ...extra,
})

// A different number per run: the per-number daily and weekly limits
// would otherwise (rightly) stop the 4th run
const input = (n: number): DraftInput => ({
  idempotencyKey: `key-${Math.random()}`,
  recipientLabel: "my CA",
  recipientPhone: `98765 4${String(n).padStart(4, "0")}`,
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
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 1000,
       max_voice_task_cost_micro_inr = 50000000 where id = 'free'`
  )
  await seed(pg, "voice_access", { user_id: user })
  await seed(pg, "voice_profiles", {
    user_id: user,
    owner_phone_e164: OWNER_PHONE,
    owner_phone_verified_at: T0.toISOString(),
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  clock.now = () => new Date()
})

async function authorize(n: number) {
  const draft = await createDraft(user, input(n))
  if (!draft.ok) throw new Error(draft.message)
  const request = await requestConfirmation(user, draft.taskId)
  if (!request.ok) throw new Error(request.message)
  const confirmed = await confirmCall(user, request.approvalId, request.payloadHash)
  if (!confirmed.ok) throw new Error(confirmed.message)
  return draft.taskId
}

const outreach = async (task: string) =>
  (
    await q<{ id: string; status: string }>(
      "select id, status from kriya.voice_calls where voice_task_id = $1 and kind = 'outreach'",
      [task]
    )
  )[0]
const attemptsOf = (call: string) =>
  q<{ id: string; status: string; end_reason: string | null }>(
    "select id, status, end_reason from kriya.call_attempts where voice_call_id = $1 order by attempt",
    [call]
  )
const taskStatus = async (task: string) =>
  (
    await q<{ status: string }>("select status from kriya.voice_tasks where id = $1", [
      task,
    ])
  )[0].status
const expireLeases = () =>
  pg.query("update kriya.voice_calls set lease_expires_at = now() - interval '1 second'")
// Lets a waiting retry fall due (database time decides claims)
const dueNow = () =>
  pg.query(
    "update kriya.voice_calls set available_at = now() - interval '1 second', not_before = now() - interval '1 second' where status = 'retry_wait'"
  )

// Rings per attempt, across every mock of the suite
const rings = new Map<string, number>()
function count(mock: ReturnType<typeof mockTelephony>) {
  for (const placed of mock.placed) {
    rings.set(placed.attemptId, (rings.get(placed.attemptId) ?? 0) + 1)
  }
}

// Places the claimed call and delivers its webhooks, twice each and in
// reverse order when `noisy` (S15)
async function dialOnce(mock: ReturnType<typeof mockTelephony>, noisy = false) {
  const id = await claimNext(deps(mock))
  if (!id) return null
  const before = mock.placed.length
  const done = runCall(id, deps(mock))
  await vi.waitFor(() => expect(mock.placed.length).toBeGreaterThanOrEqual(before))
  const placed = mock.placed.at(-1)
  if (placed && mock.placed.length > before) {
    const token = placed.statusUrl.split("/").at(-1)!
    let bodies = mock.webhooks(placed.providerCallId)
    if (noisy) bodies = [...bodies, ...bodies].reverse()
    for (const body of bodies) await handleStatusWebhook(token, body, new Headers())
  }
  await done
  return id
}

const script = (statuses: Scenario["provider_script"][number]["status"][]) =>
  statuses.map((status) => ({ status, atMs: 0 }))

type Fault = {
  name: string
  // `n` makes the provider call ids unique across runs
  run: (n: number) => Promise<{ task: string; mock: ReturnType<typeof mockTelephony> }>
  expect: (task: string) => Promise<void>
}

const FAULTS: Fault[] = [
  {
    name: "busy then no answer: retried within the attempt limit",
    run: async (n) => {
      const mock = mockTelephony({
        id: `busy-${n}`,
        provider_script: script(["ringing", "busy"]),
      })
      registerTelephony(mock)
      const task = await authorize(n)
      await dialOnce(mock)
      await dueNow()
      await dialOnce(mock)
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["busy", "busy"])
      expect(call.status).toBe("exhausted")
    },
  },
  {
    name: "S15 duplicate and out-of-order webhooks",
    run: async (n) => {
      const mock = mockTelephony({
        id: `noisy-${n}`,
        provider_script: script(["ringing", "no_answer"]),
      })
      registerTelephony(mock)
      const task = await authorize(n)
      await dialOnce(mock, true)
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["no_answer"])
      expect(call.status).toBe("retry_wait")
    },
  },
  {
    name: "S16 worker dies after requested; the provider has the call",
    run: async (n) => {
      const mock = mockTelephony({
        id: `crash-${n}`,
        provider_script: script(["ringing", "busy"]),
      })
      registerTelephony(mock)
      const task = await authorize(n)
      const id = (await claimNext(deps(mock)))!
      const attempt = (await prepareAttempt(id, deps(mock)))!
      await mock.placeCall({
        attemptId: attempt.attemptId,
        to: `+9198765${String(n).padStart(5, "4")}`,
        callerId: "+918000000000",
        streamUrl: "wss://x",
        statusUrl: attempt.statusUrl,
        ringTimeoutSeconds: 30,
        maxDurationSeconds: 300,
      })
      await expireLeases()
      for (const resumed of await recoverVoice(deps(mock, { workerId: "w2" }))) {
        await runCall(resumed, deps(mock, { workerId: "w2" }))
      }
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["busy"])
    },
  },
  {
    name: "worker dies after requested; the provider has no record",
    run: async (n) => {
      const mock = mockTelephony({
        id: `lost-${n}`,
        provider_script: script(["ringing", "busy"]),
      })
      registerTelephony(mock)
      const task = await authorize(n)
      const id = (await claimNext(deps(mock)))!
      await prepareAttempt(id, deps(mock))
      await expireLeases()
      for (const resumed of await recoverVoice(deps(mock, { workerId: "w2" }))) {
        await runCall(resumed, deps(mock, { workerId: "w2" }))
      }
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["unknown"])
      expect(call.status).toBe("needs_owner")
      expect(await taskStatus(task)).toBe("needs_owner")
    },
  },
  {
    name: "placeCall timed out: unknown, the owner decides",
    run: async (n) => {
      const mock = mockTelephony({
        id: `timeout-${n}`,
        provider_script: script(["ringing", "busy"]),
        place_error: "timeout",
      })
      registerTelephony(mock)
      const task = await authorize(n)
      await dialOnce(mock)
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["unknown"])
      expect(await taskStatus(task)).toBe("needs_owner")
    },
  },
  {
    name: "placeCall refused by the provider: failed, retried",
    run: async (n) => {
      const mock = mockTelephony({
        id: `rejected-${n}`,
        provider_script: script(["ringing", "busy"]),
        place_error: "rejected",
      })
      registerTelephony(mock)
      const task = await authorize(n)
      await dialOnce(mock)
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      expect((await attemptsOf(call.id)).map((a) => a.status)).toEqual(["failed"])
      expect(call.status).toBe("retry_wait")
    },
  },
  {
    name: "S14/S17 the call drops while connected and the voice service is lost",
    run: async (n) => {
      const mock = mockTelephony({
        id: `drop-${n}`,
        provider_script: script(["ringing", "answered", "completed"]),
        billable_seconds: 20,
      })
      registerTelephony(mock)
      const task = await authorize(n)
      const id = (await claimNext(deps(mock)))!
      const attempt = (await prepareAttempt(id, deps(mock)))!
      await mock.placeCall({
        attemptId: attempt.attemptId,
        to: `+9198765${String(n).padStart(5, "4")}`,
        callerId: "+918000000000",
        streamUrl: "wss://x",
        statusUrl: attempt.statusUrl,
        ringTimeoutSeconds: 30,
        maxDurationSeconds: 300,
      })
      const callId = mock.placed.at(-1)!.providerCallId
      await transition(pg, "attempt", attempt.attemptId, "initiated", "worker", {
        provider_call_id: callId,
      })
      await transition(pg, "attempt", attempt.attemptId, "answered", "webhook")
      await transition(pg, "attempt", attempt.attemptId, "connected", "voice")
      await transition(pg, "call", id, "in_call", "voice")
      // The stream went quiet long ago: kriya-voice is gone
      await pg.query(
        "update kriya.call_attempts set stream_heartbeat_at = now() - interval '10 minutes' where id = $1",
        [attempt.attemptId]
      )
      await expireLeases()
      await recoverVoice(deps(mock, { workerId: "w2" }))
      return { task, mock }
    },
    expect: async (task) => {
      const call = await outreach(task)
      const attempts = await attemptsOf(call.id)
      expect(attempts.map((a) => [a.status, a.end_reason])).toEqual([
        ["ended", "voice_lost"],
      ])
      // Someone talked to the callee: never redialled
      expect(call.status).not.toBe("retry_wait")
      expect(
        await claimNext(deps(mockTelephony({ id: "x", provider_script: [] })))
      ).toBeNull()
    },
  },
]

describe(`fault injection (${FAULTS.length} faults × ${RUNS} runs)`, () => {
  it.each(FAULTS.map((f) => [f.name, f] as const))(
    "R2 %s",
    async (_, fault) => {
      for (let run = 0; run < RUNS; run++) {
        // A fresh task each run; earlier ones stay to show they're not redialled
        const { task, mock } = await fault.run(run)
        count(mock)
        await fault.expect(task).catch((error: Error) => {
          throw new Error(`run ${run}: ${error.message}`)
        })
        // Earlier runs' waiting calls stay as they are, just not due during
        // the next run, so each run dials only its own task
        await pg.query(
          "update kriya.voice_calls set available_at = now() + interval '1 day' where status in ('scheduled', 'retry_wait')"
        )
      }
      // Afterwards nothing that ended unknown or with a conversation is dialled
      // again, however often the worker looks
      for (let i = 0; i < 3; i++) {
        await expireLeases()
        await recoverVoice(deps(mockTelephony({ id: "idle", provider_script: [] })))
      }
      const redialled = await q<{ n: number }>(
        `select count(*)::int as n from kriya.call_attempts a
       where a.attempt > 1 and exists (
         select 1 from kriya.call_attempts p
         where p.voice_call_id = a.voice_call_id and p.attempt < a.attempt
           and (p.status = 'unknown' or p.connected_at is not null))`
      )
      expect(redialled[0].n).toBe(0)
      // Ten runs of a fault with two full dials each
    },
    180_000
  )

  it(`D1 = 0: one ring per intended attempt over every run`, () => {
    const extra = [...rings.values()].filter((n) => n > 1)
    // Rule of three: 0 in n runs bounds the rate at about 3/n (EVALUATION_PLAN §5)
    expect(rings.size).toBeGreaterThan(0)
    expect(extra).toEqual([])
  })
})
