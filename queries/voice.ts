import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm"

import { rowsOf, withUser, type Q } from "@/db"
import {
  callAttempts,
  callOutcomes,
  conversationTurns,
  voiceApprovals,
  voiceCalls,
  voiceProfiles,
  voiceTasks,
} from "@/db/schema"
import { LANGUAGES } from "@/lib/voice/languages"
import { clock } from "@/lib/voice/schedule"

// Reads for the calls screens (UX_AND_INTERACTION_SPEC.md §4–6, §11). All
// through withUser (RLS), attempts by their granted columns only (no token
// hashes). Every sentence the person sees is made here from stored records,
// in words that never claim more than the records show (§5).

const en = LANGUAGES["en-IN"]

type Spec = { timezone?: string }
type Interpreted = {
  result?: string
  agreed_times?: {
    date: string
    time: string
    confirmTurnSeq: number
    superseded: boolean
  }[]
  proposed_times?: { date: string; time: string; by: string; turnSeq: number }[]
  unresolved_questions?: { question: string; turnSeq: number }[]
  summary?: string
}

export type CallSection = "live" | "needs_you" | "upcoming" | "done"

const LIVE_CALL = ["dialing", "in_call"]
const LIVE_ATTEMPT = ["initiated", "ringing", "answered", "connected"]
const TERMINAL = ["completed", "unreported", "failed", "cancelled", "expired"]

// §6, in the person's words
const FAILURES: Record<string, string> = {
  suppressed: "I can't call this number.",
  number_unverified: "Verify your phone number first so I can call you with the result.",
  outside_calling_hours: "I only call people between 9 AM and 9 PM, Monday to Saturday.",
  window_closed: "The time to make this call ran out before it could be placed.",
  limit_daily: "You've reached today's calls.",
  budget: "Another try would go over this call's cost limit, so I stopped.",
  blocked: "This call was stopped before dialling.",
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`

// "at 9:00 AM" today, else "on Wed 14 Oct at 9:00 AM", in the owner's timezone
export function when(at: Date, timeZone = "Asia/Kolkata") {
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(d)
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at)
  if (day(at) === day(clock.now())) return `at ${time}`
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(at)
    .replace(",", "")
  return `on ${date} at ${time}`
}

type TaskRow = Pick<
  typeof voiceTasks.$inferSelect,
  "status" | "result" | "recipientLabel" | "errorCode" | "spec"
>
type CallRow = Pick<
  typeof voiceCalls.$inferSelect,
  "kind" | "status" | "attempts" | "maxAttempts" | "availableAt" | "lastErrorCode"
>
type OutcomeRow = { verifierStatus: string; interpreted: unknown } | null

// What happened, never more than the records show
export function resultLine(task: TaskRow, calls: CallRow[], outcome: OutcomeRow) {
  const who = capital(task.recipientLabel)
  const n = calls.find((c) => c.kind === "outreach")?.attempts ?? 0
  const said = (outcome?.interpreted ?? {}) as Interpreted
  const review = "Needs your review: read what was said before deciding"
  if (task.status === "needs_owner") {
    return outcome?.verifierStatus === "needs_review"
      ? review
      : "I'm not sure whether the phone rang. I won't call again unless you ask."
  }
  if (task.status === "cancelled") return "Cancelled"
  if (task.status === "expired") return "The confirmation expired; nobody was called"
  if (task.status === "failed") {
    return FAILURES[task.errorCode ?? ""] ?? "The call couldn't be made."
  }
  switch (task.result) {
    case "agreed": {
      const agreed = said.agreed_times?.find((a) => !a.superseded)
      // Only an outcome the verifier accepted says "agreed"
      return outcome?.verifierStatus === "accepted" && agreed
        ? `${who} agreed to ${en.speak(agreed.date, agreed.time)}`
        : review
    }
    case "alternative_proposed": {
      const p = said.proposed_times?.find((t) => t.by === "callee")
      return `${who} suggested ${p ? en.speak(p.date, p.time) : "another time"}; I said I'd check with you`
    }
    case "declined":
      return `${who} said no`
    case "wrong_person":
      return "Someone else answered; nothing about the call was shared"
    case "busy":
      return `Line busy (${tries(n)})`
    case "no_answer":
      return `Didn't answer (${tries(n)})`
    case "call_failed":
      return "The call didn't go through"
    case "unclear":
      return "No clear answer. Read what was said"
  }
  return "Done"
}

function section(task: TaskRow, calls: CallRow[]): CallSection {
  if (calls.some((c) => LIVE_CALL.includes(c.status))) return "live"
  if (["draft", "awaiting_confirmation", "needs_owner"].includes(task.status)) {
    return "needs_you"
  }
  return TERMINAL.includes(task.status) ? "done" : "upcoming"
}

// The next thing that will happen, for a task still going
function nextLine(task: TaskRow, calls: CallRow[], connected: boolean) {
  const tz = (task.spec as Spec | null)?.timezone
  if (task.status === "draft") return "Draft: review and confirm"
  if (task.status === "awaiting_confirmation") return "Waiting for your confirmation"
  if (calls.some((c) => LIVE_CALL.includes(c.status))) {
    return connected ? "On the call now" : "Calling now"
  }
  const outreach = calls.find((c) => c.kind === "outreach")
  if (outreach?.status === "scheduled")
    return `Will call ${when(outreach.availableAt, tz)}`
  if (outreach?.status === "retry_wait") {
    return `No luck yet. Trying again ${when(outreach.availableAt, tz)}`
  }
  if (task.status === "awaiting_report") return "Call done"
  return "Waiting"
}

// What each call is doing now (§4)
function callLine(call: CallRow, attempt: { status: string } | undefined, tz?: string) {
  const name = call.kind === "outreach" ? "Call" : "Report call"
  switch (call.status) {
    case "scheduled":
      return `${name}: will call ${when(call.availableAt, tz)}`
    case "dialing":
      return attempt?.status === "ringing"
        ? `${name}: ringing`
        : `${name}: calling… (attempt ${call.attempts} of ${call.maxAttempts})`
    case "in_call":
      return `${name}: on the call`
    case "retry_wait":
      return `${name}: ${call.lastErrorCode === "busy" ? "line busy" : "no answer yet"}. Trying again ${when(call.availableAt, tz)}`
    case "settled":
      return `${name}: done`
    case "exhausted":
      return `${name}: no more tries (${tries(call.attempts)})`
    case "canceled":
      return `${name}: cancelled`
    case "blocked":
      return `${name}: stopped before dialling`
    case "needs_owner":
      return `${name}: I'm not sure whether the phone rang`
  }
  return name
}

async function callsOf(tx: Q, taskIds: string[]) {
  if (taskIds.length === 0) return []
  return tx
    .select({
      id: voiceCalls.id,
      voiceTaskId: voiceCalls.voiceTaskId,
      kind: voiceCalls.kind,
      status: voiceCalls.status,
      attempts: voiceCalls.attempts,
      maxAttempts: voiceCalls.maxAttempts,
      availableAt: voiceCalls.availableAt,
      lastErrorCode: voiceCalls.lastErrorCode,
    })
    .from(voiceCalls)
    .where(inArray(voiceCalls.voiceTaskId, taskIds))
    .orderBy(asc(voiceCalls.kind), asc(voiceCalls.seq))
}

// Granted columns only (no token hashes, no stream owner)
async function attemptsOf(tx: Q, callIds: string[]) {
  if (callIds.length === 0) return []
  return tx
    .select({
      id: callAttempts.id,
      voiceCallId: callAttempts.voiceCallId,
      status: callAttempts.status,
      connectedAt: callAttempts.connectedAt,
      endReason: callAttempts.endReason,
    })
    .from(callAttempts)
    .where(inArray(callAttempts.voiceCallId, callIds))
    .orderBy(asc(callAttempts.attempt))
}

// The outcome of the task's latest attempt that has one
async function latestOutcome(tx: Q, taskId: string) {
  const [row] = await tx
    .select({
      attemptId: callOutcomes.callAttemptId,
      verifierStatus: callOutcomes.verifierStatus,
      interpreted: callOutcomes.interpreted,
    })
    .from(callOutcomes)
    .where(eq(callOutcomes.voiceTaskId, taskId))
    .orderBy(desc(callOutcomes.createdAt))
    .limit(1)
  return row ?? null
}

export async function getCalls(userId: string) {
  return withUser(userId, async (tx) => {
    const tasks = await tx
      .select({
        id: voiceTasks.id,
        status: voiceTasks.status,
        result: voiceTasks.result,
        recipientLabel: voiceTasks.recipientLabel,
        errorCode: voiceTasks.errorCode,
        spec: voiceTasks.spec,
        createdAt: voiceTasks.createdAt,
      })
      .from(voiceTasks)
      .orderBy(desc(voiceTasks.createdAt))
      .limit(100)
    const calls = await callsOf(
      tx,
      tasks.map((t) => t.id)
    )
    const attempts = await attemptsOf(
      tx,
      calls.map((c) => c.id)
    )
    const rows = []
    for (const task of tasks) {
      const own = calls.filter((c) => c.voiceTaskId === task.id)
      const where = section(task, own)
      const connected = attempts.some(
        (a) => a.status === "connected" && own.some((c) => c.id === a.voiceCallId)
      )
      rows.push({
        id: task.id,
        recipient: capital(task.recipientLabel),
        section: where,
        line:
          where === "done" || task.status === "needs_owner"
            ? resultLine(task, own, await latestOutcome(tx, task.id))
            : nextLine(task, own, connected),
      })
    }
    return rows
  })
}

export type CallListItem = Awaited<ReturnType<typeof getCalls>>[number]

export async function getCall(userId: string, taskId: string) {
  return withUser(userId, async (tx) => {
    const [task] = await tx.select().from(voiceTasks).where(eq(voiceTasks.id, taskId))
    if (!task) return null
    const tz = (task.spec as Spec | null)?.timezone
    const calls = await callsOf(tx, [task.id])
    const attempts = await attemptsOf(
      tx,
      calls.map((c) => c.id)
    )
    const outcome = await latestOutcome(tx, task.id)
    const said = (outcome?.interpreted ?? {}) as Interpreted
    const turns = outcome
      ? await tx
          .select({
            seq: conversationTurns.seq,
            speaker: conversationTurns.speaker,
            text: conversationTurns.text,
            interrupted: conversationTurns.interrupted,
          })
          .from(conversationTurns)
          .where(eq(conversationTurns.callAttemptId, outcome.attemptId))
          .orderBy(asc(conversationTurns.seq))
      : []
    const [approval] = await tx
      .select({
        id: voiceApprovals.id,
        payload: voiceApprovals.payload,
        payloadHash: voiceApprovals.payloadHash,
        expiresAt: voiceApprovals.expiresAt,
      })
      .from(voiceApprovals)
      .where(
        and(
          eq(voiceApprovals.voiceTaskId, task.id),
          eq(voiceApprovals.status, "pending"),
          gt(voiceApprovals.expiresAt, sql`now()`)
        )
      )
    const live = attempts.find((a) => LIVE_ATTEMPT.includes(a.status))
    const finished = TERMINAL.includes(task.status) || task.status === "needs_owner"
    const who = capital(task.recipientLabel)
    return {
      id: task.id,
      status: task.status,
      recipient: who,
      purpose: task.purpose,
      terminal: TERMINAL.includes(task.status),
      live: live ? { status: live.status, connectedAt: live.connectedAt } : null,
      hero: finished
        ? resultLine(task, calls, outcome)
        : nextLine(task, calls, live?.status === "connected"),
      verified: outcome?.verifierStatus === "accepted",
      checked: outcome !== null && outcome.verifierStatus !== "pending",
      lost: attempts.some((a) => a.endReason === "voice_lost")
        ? "The call dropped on our side. Here's what was said before it dropped."
        : null,
      calls: calls.map((c) => ({
        id: c.id,
        line: callLine(c, attempts.filter((a) => a.voiceCallId === c.id).at(-1), tz),
      })),
      agreed: (said.agreed_times ?? [])
        .filter((a) => !a.superseded)
        .map((a) => ({ when: en.speak(a.date, a.time), turn: a.confirmTurnSeq })),
      proposed: (said.proposed_times ?? [])
        .filter((p) => p.by === "callee")
        .map((p) => ({ when: en.speak(p.date, p.time), turn: p.turnSeq })),
      questions: (said.unresolved_questions ?? []).map((q) => ({
        question: q.question,
        turn: q.turnSeq,
      })),
      turns: turns.map((t) => ({
        seq: t.seq,
        speaker: t.speaker === "tavi" ? "Tavi" : who,
        tavi: t.speaker === "tavi",
        text: t.text,
        cutOff: t.interrupted,
      })),
      approval: approval
        ? {
            id: approval.id,
            payload: approval.payload as Record<string, unknown>,
            payloadHash: approval.payloadHash,
            expiresAt: approval.expiresAt.toISOString(),
          }
        : null,
    }
  })
}

export type CallDetail = NonNullable<Awaited<ReturnType<typeof getCall>>>

// "Phone & calls" in /account (UX spec §7). The number is masked here, so
// the whole number never reaches the browser; defaults when there's no row
export async function getPhoneSettings(userId: string) {
  const [row] = await withUser(userId, (tx) =>
    tx.select().from(voiceProfiles).where(eq(voiceProfiles.userId, userId))
  )
  const digits = row?.ownerPhoneE164?.replace(/^\+91/, "") ?? ""
  return {
    phone:
      row?.ownerPhoneVerifiedAt && digits.length === 10
        ? `+91 ${digits.slice(0, 2)}xxx xxx${digits.slice(8)}`
        : null,
    timezone: row?.timezone ?? "Asia/Kolkata",
    quietStart: (row?.quietStart ?? "21:30").slice(0, 5),
    quietEnd: (row?.quietEnd ?? "08:00").slice(0, 5),
    reportMode: row?.reportMode ?? "scheduled",
    reportMaxAttempts: row?.reportMaxAttempts ?? 3,
    reportRetryMinutes: row?.reportRetryMinutes ?? 10,
    transcriptRetentionDays: row?.transcriptRetentionDays ?? 30,
  }
}

export type PhoneSettings = Awaited<ReturnType<typeof getPhoneSettings>>

// The "Calls" row on /usage (UX spec §10), this plan period: phone tasks,
// minutes on the line, what they were charged (estimated until final), and
// calls left today. Through the person's session; attempts by granted columns
export async function getCallUsage(userId: string, since: Date, maxPerDay: number) {
  const [row] = await withUser(userId, async (tx) =>
    rowsOf<{
      calls: number
      seconds: number
      charged: string | number
      estimated: number
      today: number
    }>(
      await tx.execute(sql`
        select
          (select count(*)::int from kriya.voice_tasks t
            where t.authorized_at >= ${since.toISOString()}::timestamptz) as calls,
          (select coalesce(sum(a.billable_seconds), 0)::int from kriya.call_attempts a
            where a.created_at >= ${since.toISOString()}::timestamptz) as seconds,
          (select coalesce(sum(c.charge_micro_inr), 0)::bigint from kriya.voice_charges c
            where c.created_at >= ${since.toISOString()}::timestamptz) as charged,
          (select count(*)::int from kriya.voice_charges c
            where c.created_at >= ${since.toISOString()}::timestamptz
              and c.status <> 'final') as estimated,
          (select count(*)::int from kriya.voice_tasks t
            where t.authorized_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
              at time zone 'Asia/Kolkata')) as today`)
    )
  )
  return {
    calls: row?.calls ?? 0,
    minutes: Math.ceil((row?.seconds ?? 0) / 60),
    chargedMicroInr: Number(row?.charged ?? 0),
    estimated: row?.estimated ?? 0,
    remainingToday: Math.max(0, maxPerDay - (row?.today ?? 0)),
  }
}
