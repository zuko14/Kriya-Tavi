import type { LanguageModel } from "ai"
import { asc, desc, eq } from "drizzle-orm"

import { privileged, type Q } from "@/db"
import {
  callAttempts,
  callEvents,
  callOutcomes,
  conversationTurns,
  voiceCalls,
  voiceProfiles,
  voiceTasks,
  voiceUsage,
} from "@/db/schema"
import { log } from "@/lib/log"

import type { CallNotes } from "./dialogue"
import { checkOutcome, extractOutcome, observedFrom, type ModelCall } from "./outcome"
import type { CallStatus, ProviderCall, TelephonyProvider } from "./providers"
import { clock, outreachRetryAt, reportRetryAt } from "./schedule"
import type { VoiceTaskSpec } from "./schemas"
import { bundleFor } from "./policy"
import { hashToken } from "./streams"
import { TERMINAL_CALL, TERMINAL_TASK, transition } from "./tasks"

// Provider truth for voice calls (CONVERSATION_AND_VERIFICATION.md §7,
// TELEPHONY_PROVIDER_ASSESSMENT.md §2.3). Status webhooks are unsigned, so a
// webhook moves an attempt forward only for non-final statuses; a final one
// is checked against the provider's API, and the API wins. Then the call and
// its task are settled from what the database records, never from a model.

// Providers by name; the worker and web register theirs at start (mock in
// tests; Exotel in phase 5)
const registry = new Map<string, TelephonyProvider>()
export const registerTelephony = (provider: TelephonyProvider) =>
  registry.set(provider.name, provider)

export const TERMINAL_ATTEMPT = [
  "ended",
  "busy",
  "no_answer",
  "rejected",
  "failed",
  "canceled",
  "unknown",
]

const FROM_PROVIDER: Record<CallStatus, string | null> = {
  initiated: "initiated",
  ringing: "ringing",
  answered: "answered",
  completed: "ended",
  busy: "busy",
  no_answer: "no_answer",
  failed: "failed",
  canceled: "canceled",
  unknown: null,
}

// Edges reconciliation may walk (DATA_MODEL §3.3)
const NEXT: Record<string, string[]> = {
  requested: ["initiated"],
  unknown: ["initiated"],
  initiated: ["ringing", "answered", "busy", "no_answer", "failed", "canceled"],
  ringing: ["answered", "busy", "no_answer", "rejected", "failed", "canceled"],
  answered: ["ended"],
  connected: ["ended"],
}

function path(from: string, to: string): string[] {
  const queue: string[][] = [[from]]
  for (const route of queue) {
    const at = route.at(-1)!
    if (at === to) return route.slice(1)
    for (const next of NEXT[at] ?? [])
      if (!route.includes(next)) queue.push([...route, next])
  }
  // A call answered, then reported failed or busy, ended
  return from === "answered" || from === "connected" ? ["ended"] : []
}

// Numbers in a stored payload keep only their last 4 digits
export function maskNumbers(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\+?\d[\d\s-]{8,}\d/g,
      (n) => `***${n.replace(/\D/g, "").slice(-4)}`
    )
  }
  if (Array.isArray(value)) return value.map(maskNumbers)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskNumbers(v)]))
  }
  return value
}

export async function handleStatusWebhook(token: string, body: string, headers: Headers) {
  const [attempt] = await privileged
    .select()
    .from(callAttempts)
    .where(eq(callAttempts.callbackTokenHash, hashToken(token)))
  if (!attempt) {
    log.warn("voice webhook for an unknown attempt")
    return { status: 404 }
  }
  const provider = registry.get(attempt.telephonyProvider ?? "")
  if (!provider) {
    log.error("voice webhook for a provider that isn't configured", {
      attemptId: attempt.id,
    })
    return { status: 503 }
  }
  const event = provider.parseStatusEvent(body, headers)
  if (
    !event ||
    (attempt.providerCallId && event.providerCallId !== attempt.providerCallId) ||
    (event.attemptId && event.attemptId !== attempt.id)
  ) {
    log.warn("voice webhook that doesn't match its attempt", { attemptId: attempt.id })
    return { status: 400 }
  }
  const stored = await privileged
    .insert(callEvents)
    .values({
      userId: attempt.userId,
      callAttemptId: attempt.id,
      provider: provider.name,
      source: "status_webhook",
      dedupeKey: event.dedupeKey,
      status: event.status,
      occurredAt: event.occurredAt,
      payload: maskNumbers(event.raw),
    })
    .onConflictDoNothing()
    .returning({ id: callEvents.id })
  // A repeat: already stored and acted on
  if (stored.length === 0) return { status: 200 }

  const to = FROM_PROVIDER[event.status]
  if (to && TERMINAL_ATTEMPT.includes(to)) {
    await verifyAttempt(attempt.id, provider, event.providerCallId)
  } else if (to) {
    // Out of order or not ours to take: kept in call_events, state unchanged
    await transition(
      privileged,
      "attempt",
      attempt.id,
      to,
      "webhook",
      {},
      { optional: true }
    ).catch((error) =>
      log.warn("voice webhook not applied", { attemptId: attempt.id, error })
    )
  }
  return { status: 200 }
}

// Moves the attempt to what the provider's API says, and settles the call
// when that's final. Unreachable provider: nothing changes; a later check
// (the worker's watch, or recovery) asks again.
export async function verifyAttempt(
  attemptId: string,
  provider: TelephonyProvider,
  providerCallId?: string
) {
  const [attempt] = await privileged
    .select()
    .from(callAttempts)
    .where(eq(callAttempts.id, attemptId))
  const callId = attempt?.providerCallId ?? providerCallId
  // kriya-voice may end a connected attempt before the provider is asked:
  // terminal but unverified still needs the provider's word
  if (!attempt || !callId || attempt.verifiedAt) return
  let truth: ProviderCall | null
  try {
    truth = await provider.getCall(callId)
  } catch (error) {
    log.warn("voice verification couldn't reach the provider", { attemptId, error })
    return
  }
  const target = truth && FROM_PROVIDER[truth.status]
  if (!truth || !target) return
  const final = TERMINAL_ATTEMPT.includes(target)
  await privileged.transaction(async (tx) => {
    for (const step of path(attempt.status, target)) {
      await transition(
        tx,
        "attempt",
        attempt.id,
        step,
        step === "initiated" ? "janitor" : "verifier",
        step === "initiated" ? { provider_call_id: callId } : {}
      )
    }
    if (final) {
      await tx
        .update(callAttempts)
        .set({
          verifiedAt: new Date(),
          billableSeconds: truth.billableSeconds,
          providerSnapshot: maskNumbers({
            status: truth.status,
            answeredAt: truth.answeredAt,
            endedAt: truth.endedAt,
            billableSeconds: truth.billableSeconds,
          }) as Record<string, unknown>,
        })
        .where(eq(callAttempts.id, attempt.id))
    }
  })
  if (final) {
    await recordAttemptEnd(attempt.id)
    await settleCall(attempt.voiceCallId)
  }
}

// Bookkeeping for a final attempt: its telephony row, and for a call that
// never connected the observed outcome with nothing to interpret (§7 step 2)
export async function recordAttemptEnd(attemptId: string) {
  await recordTelephonyUsage(attemptId)
  const [row] = await privileged
    .select({ attempt: callAttempts, taskId: voiceCalls.voiceTaskId })
    .from(callAttempts)
    .innerJoin(voiceCalls, eq(voiceCalls.id, callAttempts.voiceCallId))
    .where(eq(callAttempts.id, attemptId))
  // Outcomes belong to tasks; a verification call has none
  if (!row || row.attempt.connectedAt || !row.taskId) return
  await privileged
    .insert(callOutcomes)
    .values({
      userId: row.attempt.userId,
      callAttemptId: attemptId,
      voiceTaskId: row.taskId,
      observed: observedFrom(row.attempt, {
        disclosurePlayed: false,
        turns: [],
        eventIds: [],
      }),
      interpreted: null,
      verifierStatus: "accepted",
    })
    .onConflictDoNothing()
}

// What kriya-voice records while a call is live (call_outcomes, pending)
export type StreamFacts = { disclosurePlayed: boolean; turns: number[] }
export type LiveOutcome = { notes: CallNotes }

export type OutcomeModels = {
  model: LanguageModel
  escalation?: LanguageModel | null
  onModelCall?: ModelCall
}

// After a connected attempt's stream ends (kriya-voice), or after recovery
// found it lost (worker): extraction and the deterministic checks over the
// stored turns and notes, then the call can settle. Without models (or
// when extraction fails twice) the outcome is needs_review: the owner reads
// the transcript (§7). Safe to run twice: only a pending outcome is changed.
export async function finishOutcome(
  attemptId: string,
  models: OutcomeModels | null,
  { lost = false } = {}
) {
  const [found] = await privileged
    .select({
      attempt: callAttempts,
      spec: voiceTasks.spec,
      taskId: voiceTasks.id,
      callId: voiceCalls.id,
      kind: voiceCalls.kind,
    })
    .from(callAttempts)
    .innerJoin(voiceCalls, eq(voiceCalls.id, callAttempts.voiceCallId))
    .innerJoin(voiceTasks, eq(voiceTasks.id, voiceCalls.voiceTaskId))
    .where(eq(callAttempts.id, attemptId))
  if (!found) return
  // Owner calls have no outcome: they settle from their delivery
  if (found.kind !== "outreach") return settleCall(found.callId)
  // A session that died before writing anything still gets an outcome
  await privileged
    .insert(callOutcomes)
    .values({
      userId: found.attempt.userId,
      callAttemptId: attemptId,
      voiceTaskId: found.taskId,
      observed: {},
    })
    .onConflictDoNothing()
  const [outcome] = await privileged
    .select()
    .from(callOutcomes)
    .where(eq(callOutcomes.callAttemptId, attemptId))
  if (outcome.verifierStatus !== "pending") return
  const row = { ...found, outcome }
  const spec = row.spec as VoiceTaskSpec
  const live = (row.outcome.interpreted ?? {}) as Partial<LiveOutcome>
  const notes = live.notes
  const stored = await privileged
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.callAttemptId, attemptId))
    .orderBy(asc(conversationTurns.seq))
  const turns = stored.map((t) => ({
    seq: t.seq,
    speaker: t.speaker as "tavi" | "callee",
    text: t.text,
    confidence: t.sttConfidence === null ? null : Number(t.sttConfidence),
  }))
  const facts = (row.outcome.observed ?? {}) as Partial<StreamFacts>
  const events = await privileged
    .select({ id: callEvents.id })
    .from(callEvents)
    .where(eq(callEvents.callAttemptId, attemptId))
  const observed = observedFrom(row.attempt, {
    disclosurePlayed: facts.disclosurePlayed ?? false,
    turns: turns.map((t) => t.seq),
    eventIds: events.map((e) => String(e.id)),
  })

  const reasons: string[] = lost ? ["the voice service was lost during the call"] : []
  let interpreted: Record<string, unknown> = { notes }
  let model: string | null = null
  let status: "accepted" | "needs_review" = "needs_review"
  const extracted =
    notes && models
      ? await extractOutcome({
          spec,
          turns,
          notes,
          ...models,
          // The extraction prompt of the bundle this attempt ran on (D-17)
          policy: await bundleFor(row.attempt.policyVersion),
        }).catch(() => null)
      : null
  if (!notes) reasons.push("no notes from the call")
  else if (!extracted) reasons.push("the outcome couldn't be extracted")
  else {
    const checked = checkOutcome(extracted.interpreted, { spec, turns, notes })
    interpreted = { ...checked.interpreted, notes }
    model = extracted.model
    reasons.push(...checked.reasons)
    if (checked.status === "accepted" && !lost) status = "accepted"
  }
  await privileged
    .update(callOutcomes)
    .set({
      observed,
      interpreted,
      extractionModel: model,
      verifierStatus: status,
      verifierNotes: reasons.join("; ").slice(0, 2000) || null,
    })
    .where(eq(callOutcomes.id, row.outcome.id))
  log.info("voice outcome checked", { attemptId, status })
  await settleCall(row.callId)
}

// The task's result from an outcome: the task has no callback_requested
const TASK_RESULTS = [
  "agreed",
  "alternative_proposed",
  "declined",
  "wrong_person",
  "unclear",
]

// One telephony row per attempt, whatever its end (COST_AND_METERING §4).
// No price sheet yet: the cost stays null, never zero
export async function recordTelephonyUsage(attemptId: string) {
  const [row] = await privileged
    .select({ attempt: callAttempts, taskId: voiceCalls.voiceTaskId })
    .from(callAttempts)
    .innerJoin(voiceCalls, eq(voiceCalls.id, callAttempts.voiceCallId))
    .where(eq(callAttempts.id, attemptId))
  if (!row) return
  const seconds = row.attempt.billableSeconds
  await privileged
    .insert(voiceUsage)
    .values({
      requestKey: `${attemptId}:telephony`,
      userId: row.attempt.userId,
      voiceTaskId: row.taskId,
      callAttemptId: attemptId,
      component: "telephony",
      provider: row.attempt.telephonyProvider ?? "unknown",
      product: "outbound",
      quantity: seconds,
      unit: "second",
      usageStatus: seconds === null ? "missing" : "reported",
    })
    .onConflictDoNothing()
}

export const latestAttempt = (q: Q, callId: string) =>
  q
    .select()
    .from(callAttempts)
    .where(eq(callAttempts.voiceCallId, callId))
    .orderBy(desc(callAttempts.attempt))
    .limit(1)
    .then(([a]) => a)

const resultOf = (status: string | undefined) =>
  status === "busy" || status === "no_answer" ? status : "call_failed"

// Decides a dialing call's next state once its attempt is final: retry,
// exhausted, needs the owner, or cancelled. Then moves its task on. Safe to
// run twice, from the webhook and from the worker's watch at once.
export async function settleCall(callId: string) {
  await privileged.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.id, callId))
      .for("update")
    if (!call) return
    const last = await latestAttempt(tx, call.id)
    // Someone talked to the callee: this call settles from its outcome and
    // is never retried (a lost session didn't move it to in_call itself)
    if (call.status === "dialing" && last?.connectedAt) {
      await transition(tx, "call", call.id, "in_call", "worker")
      call.status = "in_call"
    }
    if (call.status === "in_call") {
      if (!last || !TERMINAL_ATTEMPT.includes(last.status) || !last.verifiedAt) return
      // An outreach call settles from its checked outcome; an owner call
      // from its delivery (D-08)
      if (call.kind === "outreach") {
        const [outcome] = await tx
          .select({ status: callOutcomes.verifierStatus })
          .from(callOutcomes)
          .where(eq(callOutcomes.callAttemptId, last.id))
        if (!outcome || outcome.status === "pending") return
      }
      await transition(
        tx,
        "call",
        call.id,
        call.cancelRequestedAt ? "canceled" : "settled",
        call.cancelRequestedAt ? "worker" : "verifier"
      )
      // A report not heard to its end goes round again (VOICE_REMINDERS §3)
      if (call.kind === "owner_report" && !call.cancelRequestedAt && !call.deliveredAt) {
        await transition(tx, "call", call.id, "retry_wait", "worker")
        await retryOrEnd(tx, call)
      }
      await tx
        .update(voiceCalls)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(voiceCalls.id, call.id))
    } else if (call.status === "dialing") {
      if (last && !TERMINAL_ATTEMPT.includes(last.status)) return
      if (call.cancelRequestedAt) {
        await transition(tx, "call", call.id, "canceled", "worker")
      } else if (last?.status === "unknown" && call.kind === "outreach") {
        // We may have rung someone and can't prove it: the owner decides
        await transition(tx, "call", call.id, "needs_owner", "worker")
      } else {
        const next = await retryAt(tx, call)
        if (next) {
          await transition(tx, "call", call.id, "retry_wait", "worker")
          await tx
            .update(voiceCalls)
            .set({ availableAt: next })
            .where(eq(voiceCalls.id, call.id))
        } else {
          await transition(tx, "call", call.id, "exhausted", "worker")
        }
      }
      await tx
        .update(voiceCalls)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(voiceCalls.id, call.id))
    }
    if (call.voiceTaskId) await followTask(tx, call.voiceTaskId)
  })
}

// When a call may be tried again, or null once it's done: attempts used,
// window closed, or (owner calls) the next try falls in quiet hours
async function retryAt(tx: Q, call: typeof voiceCalls.$inferSelect) {
  const now = clock.now()
  let next: Date | null = outreachRetryAt(now)
  if (call.kind !== "outreach") {
    const [profile] = await tx
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, call.userId))
    next = profile ? reportRetryAt(now, profile, profile.reportRetryMinutes) : null
  }
  return call.attempts < call.maxAttempts &&
    next &&
    (!call.windowEnd || next < call.windowEnd)
    ? next
    : null
}

// A call in retry_wait: its next try, or exhausted
async function retryOrEnd(tx: Q, call: typeof voiceCalls.$inferSelect) {
  const next = await retryAt(tx, call)
  if (next) {
    await tx
      .update(voiceCalls)
      .set({ availableAt: next })
      .where(eq(voiceCalls.id, call.id))
  } else {
    await transition(tx, "call", call.id, "exhausted", "worker")
  }
}

// The task's state follows its calls (DATA_MODEL §3.1)
async function followTask(tx: Q, taskId: string) {
  const [task] = await tx
    .select()
    .from(voiceTasks)
    .where(eq(voiceTasks.id, taskId))
    .for("update")
  if (!task || TERMINAL_TASK.includes(task.status)) return
  const calls = await tx
    .select()
    .from(voiceCalls)
    .where(eq(voiceCalls.voiceTaskId, task.id))
  if (task.cancelRequestedAt) {
    const live = calls.some((c) => c.status === "dialing" || c.status === "in_call")
    if (!live) await transition(tx, "task", task.id, "cancelled", "worker")
    return
  }
  const outreach = calls.find((c) => c.kind === "outreach")
  const report = calls.find((c) => c.kind === "owner_report")
  const last = outreach && (await latestAttempt(tx, outreach.id))

  if (
    outreach?.status === "blocked" &&
    ["authorized", "in_progress"].includes(task.status)
  ) {
    await transition(tx, "task", task.id, "failed", "worker", {
      error_code: outreach.lastErrorCode ?? "blocked",
    })
    return
  }
  if (outreach?.status === "needs_owner" && task.status === "in_progress" && last) {
    await transition(tx, "task", task.id, "needs_owner", "worker", {
      attempt_id: last.id,
    })
    return
  }
  // A conversation: the verifier's verdict decides. Needs review → the owner
  const [outcome] = last
    ? await tx
        .select({
          status: callOutcomes.verifierStatus,
          interpreted: callOutcomes.interpreted,
        })
        .from(callOutcomes)
        .where(eq(callOutcomes.callAttemptId, last.id))
    : []
  let status = task.status
  if (outreach?.status === "settled" && task.status === "in_progress" && last) {
    if (outcome?.status !== "accepted") {
      await transition(tx, "task", task.id, "needs_owner", "verifier", {
        attempt_id: last.id,
      })
      return
    }
    await transition(tx, "task", task.id, "awaiting_report", "verifier", {
      attempt_id: last.id,
      verified_at: last.verifiedAt!.toISOString(),
    })
    status = "awaiting_report"
  }
  if (outreach?.status === "exhausted") {
    if (task.status === "authorized") {
      await transition(tx, "task", task.id, "failed", "worker", {
        error_code: "window_closed",
      })
      return
    }
    if (task.status === "in_progress" && last?.verifiedAt) {
      await transition(tx, "task", task.id, "awaiting_report", "verifier", {
        attempt_id: last.id,
        verified_at: last.verifiedAt.toISOString(),
      })
      status = "awaiting_report"
    }
  }
  if (status !== "awaiting_report") return
  const said = (outcome?.interpreted as { result?: string } | null)?.result
  const result =
    outreach?.status === "settled"
      ? TASK_RESULTS.includes(said ?? "")
        ? said
        : "unclear"
      : resultOf(last?.status)
  const reports = calls.filter((c) => c.kind === "owner_report")
  const delivered = reports.find((c) => c.deliveredAt)
  if (!task.reportRequested || delivered) {
    // No report asked for, or one was heard to its end (D-08)
    await transition(tx, "task", task.id, "completed", "verifier", {
      result,
      ...(delivered && { voice_call_id: delivered.id }),
    })
  } else if (
    report?.status === "exhausted" &&
    !reports.some((c) => !TERMINAL_CALL.includes(c.status))
  ) {
    await transition(tx, "task", task.id, "unreported", "worker", {
      voice_call_id: report.id,
      result,
    })
  }
}
