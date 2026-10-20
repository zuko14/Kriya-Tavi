import { randomBytes } from "node:crypto"

import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import {
  callAttempts,
  callOutcomes,
  phoneVerifications,
  voiceCalls,
  voiceProfiles,
  voiceTasks,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"

import {
  chargeFinishedVoiceTasks,
  dailyCapAllows,
  fxSettings,
  overBudget,
} from "./metering"
import { policyFor } from "./policy"
import { v1 } from "./policy/v1"
import type { TelephonyProvider } from "./providers"
import {
  clock,
  dayStart,
  inQuietHours,
  nextCallingTime,
  tomorrowOpening,
  withinCallingHours,
} from "./schedule"
import { hashToken } from "./streams"
import { phoneHash, suppressed, transition } from "./tasks"
import {
  finishOutcome,
  latestAttempt,
  recordAttemptEnd,
  settleCall,
  TERMINAL_ATTEMPT,
  verifyAttempt,
  type OutcomeModels,
} from "./verify"

// Placing calls (DATA_MODEL §4, API_AND_EXECUTION_CONTRACTS §5): only the
// worker dials, from rows in voice_calls. Every attempt is committed as
// `requested` before the provider is asked (write-ahead), so nothing is
// dialled that isn't recorded, and an attempt that may have rung a third
// party is never dialled again without the owner (D1 = 0).

export type VoiceDeps = {
  workerId: string
  provider: TelephonyProvider
  // https:// base of kriya-web (status webhooks) and wss:// base of kriya-voice
  appUrl: string
  voiceUrl: string
  callerId?: string
  leaseSeconds?: number
  heartbeatMs?: number
  // Live calls across the platform (voice.maxConcurrentCalls, phase 5)
  maxLive?: number
  ringTimeoutSeconds?: number
  maxDurationSeconds?: number
  // How long to wait for a final status before asking the provider
  watchMs?: number
  signal?: AbortSignal
  // For the outcome of a call whose voice session was lost; none = review
  outcome?: OutcomeModels | null
}

// A connected stream with no heartbeat for this long is lost (DATA_MODEL §4)
const STREAM_STALE_SECONDS = 15

// The only way kriya-voice reads a task (CHANGE_IMPACT §4 rule 3, T-SEC-05):
// the attempt, its call and its task, each by id and the stream's user id,
// and nothing else of that person's
export async function loadAttemptContext(attemptId: string, userId: string) {
  const [row] = await privileged
    .select({ attempt: callAttempts, call: voiceCalls, task: voiceTasks })
    .from(callAttempts)
    .innerJoin(
      voiceCalls,
      and(eq(voiceCalls.id, callAttempts.voiceCallId), eq(voiceCalls.userId, userId))
    )
    .innerJoin(
      voiceTasks,
      and(eq(voiceTasks.id, voiceCalls.voiceTaskId), eq(voiceTasks.userId, userId))
    )
    .where(and(eq(callAttempts.id, attemptId), eq(callAttempts.userId, userId)))
  return row ?? null
}

// A verification call has no task: the attempt and its call only
export async function loadVerificationContext(attemptId: string, userId: string) {
  const [row] = await privileged
    .select({ attempt: callAttempts, call: voiceCalls })
    .from(callAttempts)
    .innerJoin(
      voiceCalls,
      and(
        eq(voiceCalls.id, callAttempts.voiceCallId),
        eq(voiceCalls.userId, userId),
        eq(voiceCalls.kind, "verification")
      )
    )
    .where(and(eq(callAttempts.id, attemptId), eq(callAttempts.userId, userId)))
  return row ?? null
}

// What an owner report says (VOICE_REMINDERS §5): the same task's outreach
// attempts and the outcome of the one that connected. Still only that
// task, by id and the owner's user id (T-SEC-05)
export async function loadReportContext(taskId: string, userId: string) {
  const attempts = await privileged
    .select({
      id: callAttempts.id,
      status: callAttempts.status,
      requestedAt: callAttempts.requestedAt,
      connectedAt: callAttempts.connectedAt,
    })
    .from(callAttempts)
    .innerJoin(
      voiceCalls,
      and(
        eq(voiceCalls.id, callAttempts.voiceCallId),
        eq(voiceCalls.voiceTaskId, taskId),
        eq(voiceCalls.userId, userId),
        eq(voiceCalls.kind, "outreach")
      )
    )
    .where(eq(callAttempts.userId, userId))
    .orderBy(callAttempts.attempt)
  const connected = attempts.filter((a) => a.connectedAt).at(-1)
  const [outcome] = connected
    ? await privileged
        .select({
          status: callOutcomes.verifierStatus,
          interpreted: callOutcomes.interpreted,
        })
        .from(callOutcomes)
        .where(
          and(
            eq(callOutcomes.callAttemptId, connected.id),
            eq(callOutcomes.userId, userId)
          )
        )
    : []
  return { attempts, outcome: outcome ?? null }
}

const LEASE_SECONDS = 30
// A verification code: 3 tries, 10 minutes (D-13)
export const VERIFICATION_TRIES = 3
export const VERIFICATION_MINUTES = 10
// Calls to one number by anyone in a day (SECURITY §5)
const PER_NUMBER_DAY = 3

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

// Live calls need both switches (D-12): KRIYA_VOICE_LIVE=1 on the worker and
// voice.liveCalls on in /owner/config. The mock provider places no real call
async function liveAllowed(provider: string) {
  if (provider === "mock") return true
  return (
    process.env.KRIYA_VOICE_LIVE === "1" && (await getSetting("voice.liveCalls")) === "on"
  )
}

export async function claimNext(deps: VoiceDeps) {
  if (!(await liveAllowed(deps.provider.name))) return null
  // The platform's daily voice spend cap (COST_AND_METERING §5)
  if (!(await dailyCapAllows(deps.provider.name))) return null
  const result = await privileged.execute(
    sql`select id from kriya.claim_voice_call(${deps.workerId}, ${deps.leaseSeconds ?? LEASE_SECONDS}, ${deps.maxLive ?? 2})`
  )
  return rowsOf<{ id: string }>(result)[0]?.id ?? null
}

// Re-checks a claimed call and, if it may go ahead, records its next attempt
// as requested. Null when the call went another way (cancelled, closed,
// blocked, deferred); the caller settles it.
export async function prepareAttempt(callId: string, deps: VoiceDeps) {
  // Read before the transaction: settings use their own connection
  const fx = await fxSettings()
  const [owner] = await privileged
    .select({ userId: voiceCalls.userId })
    .from(voiceCalls)
    .where(eq(voiceCalls.id, callId))
  // The bundle this attempt runs on: the canary or the active version (D-17)
  const policy = owner ? await policyFor(owner.userId) : v1
  // A real provider dials only test numbers until phase 9 (F25); none set = none
  const testNumbers =
    deps.provider.name === "mock"
      ? null
      : ((await getSetting("voice.testNumbers")) ?? "").split(",").filter(Boolean)
  return privileged.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.id, callId),
          eq(voiceCalls.leaseOwner, deps.workerId),
          eq(voiceCalls.status, "dialing")
        )
      )
      .for("update")
    if (!call) return null
    // A verification call has no task
    const [task] = call.voiceTaskId
      ? await tx.select().from(voiceTasks).where(eq(voiceTasks.id, call.voiceTaskId))
      : []
    const now = clock.now()
    const move = async (
      to: string,
      evidence: Record<string, unknown> = {},
      at?: Date
    ) => {
      await transition(tx, "call", call.id, to, "worker", evidence)
      await tx
        .update(voiceCalls)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(at ? { availableAt: at } : {}),
        })
        .where(eq(voiceCalls.id, call.id))
      return null
    }

    if (call.cancelRequestedAt) return move("canceled")
    if ((call.windowEnd && now >= call.windowEnd) || call.attempts >= call.maxAttempts) {
      return move("exhausted")
    }
    if (testNumbers && !testNumbers.includes(call.toPhoneE164)) {
      return move("blocked", { error_code: "not_a_test_number" })
    }
    if (call.kind === "outreach") {
      if (await suppressed(tx, task.recipientPhoneHash)) {
        return move("blocked", { error_code: "suppressed" })
      }
      if (await overBudget(tx, task, deps.provider.name, fx)) {
        return move("blocked", { error_code: "budget" })
      }
      if (!withinCallingHours(now)) return move("retry_wait", {}, nextCallingTime(now))
      const today = await tx.execute(sql`
        select count(*)::int as n from kriya.call_attempts a
        join kriya.voice_calls c on c.id = a.voice_call_id
        join kriya.voice_tasks t on t.id = c.voice_task_id
        where t.recipient_phone_hash = ${task.recipientPhoneHash}
          and c.kind = 'outreach' and a.requested_at >= ${dayStart(now).toISOString()}::timestamptz`)
      if ((rowsOf<{ n: number }>(today)[0]?.n ?? 0) >= PER_NUMBER_DAY) {
        return move("retry_wait", {}, tomorrowOpening(now))
      }
    } else if (call.kind === "verification") {
      // Only while its code can still be keyed in, to the number it's for.
      // No quiet hours: the owner started it and is waiting on screen
      const [code] = await tx
        .select()
        .from(phoneVerifications)
        .where(
          and(
            eq(phoneVerifications.voiceCallId, call.id),
            isNull(phoneVerifications.verifiedAt),
            gt(phoneVerifications.expiresAt, now),
            lt(phoneVerifications.tries, VERIFICATION_TRIES),
            eq(phoneVerifications.phoneE164, call.toPhoneE164)
          )
        )
      if (!code) return move("blocked", { error_code: "verification_closed" })
      // The number may be someone else's, who opted out since (F33)
      const hash = phoneHash(call.toPhoneE164)
      if (!hash || (await suppressed(tx, hash))) {
        return move("blocked", { error_code: "suppressed" })
      }
    } else {
      // Owner calls go only to the verified number, never in quiet hours
      const [profile] = await tx
        .select()
        .from(voiceProfiles)
        .where(eq(voiceProfiles.userId, call.userId))
      if (!profile?.ownerPhoneVerifiedAt || profile.ownerPhoneE164 !== call.toPhoneE164) {
        return move("blocked", { error_code: "number_unverified" })
      }
      if (inQuietHours(now, profile)) return move("exhausted")
    }

    const callbackToken = randomBytes(32).toString("base64url")
    const streamToken = randomBytes(32).toString("base64url")
    const [attempt] = await tx
      .insert(callAttempts)
      .values({
        userId: call.userId,
        voiceCallId: call.id,
        attempt: call.attempts + 1,
        // The behaviour bundle this attempt runs on (D-17, T-POL-01)
        policyVersion: policy.version,
        telephonyProvider: deps.provider.name,
        callbackTokenHash: hashToken(callbackToken),
        streamTokenHash: hashToken(streamToken),
      })
      .returning({ id: callAttempts.id })
    await tx
      .update(voiceCalls)
      .set({ attempts: call.attempts + 1, lastErrorCode: null })
      .where(eq(voiceCalls.id, call.id))
    await transition(tx, "attempt", attempt.id, "requested", "worker")
    if (call.kind === "outreach" && task.status === "authorized") {
      await transition(tx, "task", task.id, "in_progress", "worker", {
        voice_call_id: call.id,
      })
    }
    return {
      attemptId: attempt.id,
      callId: call.id,
      to: call.toPhoneE164,
      statusUrl: `${deps.appUrl}/api/voice/exotel/status/${callbackToken}`,
      streamUrl: `${deps.voiceUrl}/media/exotel?t=${streamToken}`,
    }
  })
}

type Prepared = NonNullable<Awaited<ReturnType<typeof prepareAttempt>>>

// A provider that answered 4xx, or a connection refused, made no call; a
// timeout or anything else may have reached it
const definitelyNotPlaced = (error: unknown) => {
  const e = error as { status?: number; code?: string }
  return (
    (e.status !== undefined && e.status >= 400 && e.status < 500) ||
    e.code === "ECONNREFUSED"
  )
}

async function dial(attempt: Prepared, deps: VoiceDeps) {
  try {
    const { providerCallId } = await deps.provider.placeCall({
      attemptId: attempt.attemptId,
      to: attempt.to,
      callerId: deps.callerId ?? "",
      streamUrl: attempt.streamUrl,
      statusUrl: attempt.statusUrl,
      ringTimeoutSeconds: deps.ringTimeoutSeconds ?? 30,
      maxDurationSeconds: deps.maxDurationSeconds ?? 300,
    })
    await transition(privileged, "attempt", attempt.attemptId, "initiated", "worker", {
      provider_call_id: providerCallId,
    })
    log.info("voice call placed", { attemptId: attempt.attemptId })
    return true
  } catch (error) {
    const refused = definitelyNotPlaced(error)
    log.warn("voice placeCall failed", { attemptId: attempt.attemptId, refused, error })
    await privileged.transaction(async (tx) => {
      await transition(
        tx,
        "attempt",
        attempt.attemptId,
        refused ? "failed" : "unknown",
        "worker"
      )
      // Our own record is the truth for a request the provider refused
      if (refused) {
        await tx
          .update(callAttempts)
          .set({
            endReason: "provider_rejected",
            verifiedAt: new Date(),
            providerSnapshot: { placeCall: "rejected" },
          })
          .where(eq(callAttempts.id, attempt.attemptId))
      }
    })
    await recordAttemptEnd(attempt.attemptId)
    await settleCall(attempt.callId)
    return false
  }
}

// Holds the lease while the call rings: heartbeats, hangs up on a cancel,
// and asks the provider when no final status arrives in time. Returns when
// the attempt is final (settled) or connected (kriya-voice holds it then)
async function watch(callId: string, attemptId: string, deps: VoiceDeps) {
  const deadline =
    Date.now() +
    (deps.watchMs ??
      ((deps.ringTimeoutSeconds ?? 30) + (deps.maxDurationSeconds ?? 300) + 60) * 1000)
  let hungUp = false
  for (;;) {
    await sleep(deps.heartbeatMs ?? 5_000, deps.signal)
    const beat = rowsOf<{ cancel_requested: boolean }>(
      await privileged.execute(
        sql`select * from kriya.heartbeat_voice_call(${callId}, ${deps.workerId}, ${deps.leaseSeconds ?? LEASE_SECONDS})`
      )
    )
    // Settled by a webhook, or the lease was lost
    if (beat.length === 0) return
    const [attempt] = await privileged
      .select({
        status: callAttempts.status,
        providerCallId: callAttempts.providerCallId,
      })
      .from(callAttempts)
      .where(eq(callAttempts.id, attemptId))
    if (TERMINAL_ATTEMPT.includes(attempt.status)) return settleCall(callId)
    if (attempt.status === "connected") {
      await privileged
        .update(voiceCalls)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(voiceCalls.id, callId))
      return
    }
    const late = Date.now() > deadline
    if (beat[0].cancel_requested || late) {
      if (attempt.providerCallId && !hungUp) {
        hungUp = true
        await deps.provider
          .hangup(attempt.providerCallId)
          .catch((error) => log.warn("voice hangup failed", { attemptId, error }))
      }
      await verifyAttempt(attemptId, deps.provider)
      // Still not final: let the lease lapse; recovery asks again
      if (late) return
    }
  }
}

// Runs a claimed or recovered call to its next resting point
export async function runCall(callId: string, deps: VoiceDeps): Promise<void> {
  const last = await latestAttempt(privileged, callId)
  if (!last || TERMINAL_ATTEMPT.includes(last.status)) {
    const attempt = await prepareAttempt(callId, deps)
    if (!attempt) return settleCall(callId)
    if (!(await dial(attempt, deps))) return
    return watch(callId, attempt.attemptId, deps)
  }
  if (last.status === "requested") {
    // The worker before us died after committing the attempt: did the
    // provider make the call? Unprovable means unknown, never a redial
    let found = null
    try {
      found = (await deps.provider.findByAttempt?.(last.id)) ?? null
    } catch (error) {
      log.warn("voice recovery lookup failed", { attemptId: last.id, error })
      return
    }
    if (!found) {
      await transition(privileged, "attempt", last.id, "unknown", "janitor")
      await recordAttemptEnd(last.id)
      return settleCall(callId)
    }
    await transition(privileged, "attempt", last.id, "initiated", "janitor", {
      provider_call_id: found.providerCallId,
    })
  }
  if (last.status === "connected") return
  return watch(callId, last.id, deps)
}

// Calls whose worker died, handed back for runCall; and waiting calls whose
// window closed with no one to dial them
export async function recoverVoice(deps: VoiceDeps) {
  const taken = rowsOf<{ id: string }>(
    await privileged.execute(
      sql`select id from kriya.recover_voice_calls(${deps.workerId}, ${deps.leaseSeconds ?? LEASE_SECONDS})`
    )
  ).map((r) => r.id)
  const closed = await privileged
    .select({ id: voiceCalls.id })
    .from(voiceCalls)
    .where(
      and(
        inArray(voiceCalls.status, ["scheduled", "retry_wait"]),
        lt(voiceCalls.windowEnd, clock.now())
      )
    )
  for (const { id } of closed) {
    await transition(privileged, "call", id, "exhausted", "janitor")
    await settleCall(id)
  }
  // kriya-voice died mid-call (S17): hang up, end the attempt as voice_lost,
  // and leave its outcome for the owner to review. Never redialled
  const lost = rowsOf<{ id: string; provider_call_id: string | null }>(
    await privileged.execute(sql`
      select id, provider_call_id from kriya.call_attempts
      where status = 'connected'
        and coalesce(stream_heartbeat_at, connected_at) < now() - make_interval(secs => ${STREAM_STALE_SECONDS})`)
  )
  for (const attempt of lost) {
    if (attempt.provider_call_id) {
      await deps.provider
        .hangup(attempt.provider_call_id)
        .catch((error) =>
          log.warn("voice hangup failed", { attemptId: attempt.id, error })
        )
    }
    await transition(
      privileged,
      "attempt",
      attempt.id,
      "ended",
      "janitor",
      {},
      { optional: true }
    )
    await privileged
      .update(callAttempts)
      .set({ endReason: sql`coalesce(${callAttempts.endReason}, 'voice_lost')` })
      .where(eq(callAttempts.id, attempt.id))
    log.warn("voice stream lost", { attemptId: attempt.id })
    await verifyAttempt(attempt.id, deps.provider)
    await finishOutcome(attempt.id, deps.outcome ?? null, { lost: true })
  }
  if (taken.length) log.warn("voice calls recovered", { count: taken.length })
  // One charge per finished task, however it ended
  await chargeFinishedVoiceTasks().catch((error) =>
    log.error("voice charges failed", { error })
  )
  return taken
}

// The voice loop in kriya-worker: its own map and concurrency, never the
// agent queue's (F6). Errors are logged and the loop goes on.
export async function voiceLoop(
  deps: VoiceDeps & {
    concurrency: number
    pollMs?: number
    recoverMs?: number
    signal: AbortSignal
  }
) {
  const running = new Map<string, Promise<void>>()
  const start = (id: string) => {
    if (running.has(id)) return
    running.set(
      id,
      runCall(id, deps)
        .catch((error) => log.error("voice call failed", { callId: id, error }))
        .finally(() => running.delete(id))
    )
  }
  let lastRecover = 0
  while (!deps.signal.aborted) {
    try {
      if (Date.now() - lastRecover >= (deps.recoverMs ?? 15_000)) {
        lastRecover = Date.now()
        for (const id of await recoverVoice(deps)) start(id)
      }
      while (running.size < deps.concurrency && !deps.signal.aborted) {
        const id = await claimNext(deps)
        if (!id) break
        start(id)
      }
    } catch (error) {
      log.error("voice loop error", { error })
    }
    await sleep(deps.pollMs ?? 1_000, deps.signal)
  }
  await Promise.allSettled(running.values())
}
