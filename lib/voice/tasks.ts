import { createHash, createHmac, randomUUID } from "node:crypto"

import type { LanguageModel } from "ai"
import { and, count, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm"

import { privileged, rowsOf, withUser, type Q } from "@/db"
import {
  callAttempts,
  callSuppressions,
  conversationTurns,
  profiles,
  voiceAccess,
  voiceApprovals,
  voiceCalls,
  voiceProfiles,
  voiceTasks,
  voiceUsage,
  type Plan,
  type VoiceActor,
  type VoiceCallStatus,
  type VoiceTaskStatus,
} from "@/db/schema"
import { getPlan } from "@/lib/entitlements"
import { log } from "@/lib/log"
import { usageFromMetadata } from "@/lib/models"

import {
  clock,
  dayStart,
  inQuietHours,
  nextCallingTime,
  outreachWindowEnd,
  reportWindowEnd,
} from "./schedule"
import {
  disclosure,
  parseIndianMobile,
  type DraftInput,
  type VoiceTaskSpec,
} from "./schemas"
import { extractSpec } from "./spec"

// What the owner does with a voice task (API_AND_EXECUTION_CONTRACTS.md §2):
// draft, ask to confirm, confirm the exact payload, decline, cancel, stop.
// Called by actions/voice.ts after the session check, with the session's
// user id. Users have no write grants on voice tables (D-06), so these run
// on the privileged connection and every query is scoped by that id
// (AGENTS.md invariant 1); another user's id simply finds nothing.

export type VoiceErrorCode =
  | "invalid"
  | "not_found"
  | "voice_unavailable"
  | "number_unverified"
  | "suppressed"
  | "limit_daily"
  | "limit_number"
  | "quiet_hours"
  | "outside_calling_hours"
  | "stale_approval"
  | "expired"
  | "already_final"
  | "rate_limited"

export type VoiceFailure = {
  ok: false
  code: VoiceErrorCode
  message: string
  fields?: Record<string, string>
}

export const fail = (
  code: VoiceErrorCode,
  message: string,
  fields?: Record<string, string>
): VoiceFailure => ({ ok: false, code, message, ...(fields ? { fields } : {}) })

const UNAVAILABLE = fail(
  "voice_unavailable",
  "Phone calls aren't available on your account."
)
const NOT_FOUND = fail("not_found", "That call request wasn't found.")
const FINAL = fail("already_final", "That call request is already finished.")

export const TERMINAL_TASK: VoiceTaskStatus[] = [
  "completed",
  "unreported",
  "failed",
  "cancelled",
  "expired",
]
export const TERMINAL_CALL: VoiceCallStatus[] = [
  "settled",
  "exhausted",
  "canceled",
  "blocked",
  "needs_owner",
]
const PER_NUMBER_WEEK = 5
const APPROVAL_MINUTES = 30

// HMAC of a number, for suppression and per-number limits; null without a key
export function phoneHash(e164: string) {
  const key = process.env.KRIYA_PHONE_HASH_KEY?.trim()
  return key ? createHmac("sha256", key).update(e164).digest("hex") : null
}

// Throws when the edge doesn't exist from the current status: code that
// decided on a move must not carry on as if it happened. Only events that
// may arrive out of order (webhooks) pass `optional` and accept a no-op.
export async function transition(
  q: Q,
  entity: "task" | "call" | "attempt",
  id: string,
  to: string,
  actor: VoiceActor,
  evidence: Record<string, unknown> = {},
  { optional = false } = {}
) {
  const result = await q.execute(
    sql`select kriya.voice_transition(${entity}, ${id}::uuid, ${to}, ${actor}, ${JSON.stringify(evidence)}::jsonb) as ok`
  )
  const ok = rowsOf<{ ok: boolean }>(result)[0]?.ok === true
  if (!ok && !optional)
    throw new Error(`voice ${entity} can't move to ${to} from where it is`)
  return ok
}

// Voice needs the allow-list (D-12) and a plan with voice switched on
async function voicePlan(userId: string): Promise<Plan | null> {
  const [access] = await privileged
    .select({ userId: voiceAccess.userId })
    .from(voiceAccess)
    .where(eq(voiceAccess.userId, userId))
  if (!access) return null
  const plan = await getPlan(userId)
  const on =
    plan.voiceEnabled &&
    plan.maxOutreachCallsPerDay > 0 &&
    plan.maxVoiceTaskCostMicroInr > 0
  return on ? plan : null
}

// For thread agents: propose_call and its instructions line exist only then (F4, F5)
export const voiceAvailable = async (userId: string) => Boolean(await voicePlan(userId))

export const suppressed = async (q: Q, hash: string) =>
  (
    await q
      .select({ hash: callSuppressions.phoneHash })
      .from(callSuppressions)
      .where(eq(callSuppressions.phoneHash, hash))
  ).length > 0

// Daily outreach and per-number limits, and suppression (SECURITY §5)
async function limits(q: Q, userId: string, plan: Plan, hash: string) {
  if (await suppressed(q, hash)) return fail("suppressed", "This number can't be called.")
  const authorized = (since: Date, extra = sql`true`) =>
    q
      .select({ n: count() })
      .from(voiceTasks)
      .where(
        and(eq(voiceTasks.userId, userId), gte(voiceTasks.authorizedAt, since), extra)
      )
      .then(([row]) => row?.n ?? 0)
  if ((await authorized(dayStart(clock.now()))) >= plan.maxOutreachCallsPerDay) {
    return fail(
      "limit_daily",
      `Your plan allows ${plan.maxOutreachCallsPerDay} calls a day. Try again tomorrow.`
    )
  }
  const week = new Date(clock.now().getTime() - 7 * 86_400_000)
  if (
    (await authorized(week, eq(voiceTasks.recipientPhoneHash, hash))) >= PER_NUMBER_WEEK
  ) {
    return fail("limit_number", "This number has been called often this week. Try later.")
  }
  return null
}

const ownTask = (q: Q, userId: string, taskId: string) =>
  q
    .select()
    .from(voiceTasks)
    .where(and(eq(voiceTasks.id, taskId), eq(voiceTasks.userId, userId)))
    .for("update")
    .then(([task]) => task)

// Keys sorted at every level, so the hash doesn't depend on key order
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

// The earliest a third party may be called for this task
function earliestCall(spec: VoiceTaskSpec) {
  const now = clock.now()
  const asked = spec.earliestAt ? new Date(spec.earliestAt) : now
  return nextCallingTime(asked > now ? asked : now)
}

export async function createDraft(userId: string, input: DraftInput) {
  const plan = await voicePlan(userId)
  if (!plan) return UNAVAILABLE
  const phone = parseIndianMobile(input.recipientPhone)
  if (!phone) {
    return fail("invalid", "Enter an Indian mobile number.", {
      recipientPhone: "Enter a 10-digit Indian mobile number.",
    })
  }
  const hash = phoneHash(phone)
  if (!hash) {
    log.warn("voice draft refused: KRIYA_PHONE_HASH_KEY is not set")
    return UNAVAILABLE
  }
  return privileged.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: voiceTasks.id })
      .from(voiceTasks)
      .where(
        and(
          eq(voiceTasks.userId, userId),
          eq(voiceTasks.idempotencyKey, input.idempotencyKey)
        )
      )
    if (existing) return { ok: true as const, taskId: existing.id }

    const [profile] = await tx
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, userId))
    if (profile?.ownerPhoneE164 === phone) {
      return fail("invalid", "That's your own number. Ask for a reminder call instead.", {
        recipientPhone: "That's your own number.",
      })
    }
    if (await suppressed(tx, hash))
      return fail("suppressed", "This number can't be called.")
    const [owner] = await tx
      .select({ name: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, userId))
    const spec: VoiceTaskSpec = {
      version: 1,
      language: "en-IN",
      owner: { displayName: owner?.name ?? "" },
      recipient: { label: input.recipientLabel, name: input.recipientName },
      goal: input.goal,
      authority: input.authority,
      mustNot: input.mustNot,
      earliestAt: input.earliestAt ?? null,
      report: { at: input.reportAt ?? null, mode: profile?.reportMode ?? "scheduled" },
      timezone: profile?.timezone ?? "Asia/Kolkata",
      referenceDate: clock.now().toISOString().slice(0, 10),
    }
    const [task] = await tx
      .insert(voiceTasks)
      .values({
        userId,
        threadId: input.threadId,
        recipientLabel: input.recipientLabel,
        recipientName: input.recipientName,
        recipientPhoneE164: phone,
        recipientPhoneHash: hash,
        purpose: input.purpose,
        spec,
        reportAt: input.reportAt ? new Date(input.reportAt) : null,
        reportRequested: Boolean(input.reportAt),
        planId: plan.id,
        maxCallSeconds: plan.maxCallSeconds,
        costBudgetMicroInr: plan.maxVoiceTaskCostMicroInr,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: voiceTasks.id })
    log.info("voice draft created", { taskId: task.id })
    return { ok: true as const, taskId: task.id }
  })
}

// The person's words → a draft card to complete (API §2). Nothing is
// stored but the model's usage: the task row is created by createDraft
// once the card has a number, a recipient and a goal
export async function draftFromText(userId: string, text: string, model: LanguageModel) {
  if (!(await voicePlan(userId))) return UNAVAILABLE
  const [profile] = await privileged
    .select({ timezone: voiceProfiles.timezone })
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId))
  const request = randomUUID()
  const result = await extractSpec({
    text,
    now: clock.now(),
    timezone: profile?.timezone ?? "Asia/Kolkata",
    model,
    onModelCall: async ({ modelId, usage, providerMetadata }) => {
      const cost = usageFromMetadata(providerMetadata)?.costMicroUsd ?? null
      await privileged
        .insert(voiceUsage)
        .values({
          requestKey: `draft:${request}`,
          userId,
          component: "llm",
          provider: "openrouter",
          product: modelId,
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          usageStatus: cost === null ? "missing" : "reported",
          reportedCostMicro: cost,
          reportedCurrency: cost === null ? null : "USD",
          costSource: cost === null ? null : "provider",
        })
        .onConflictDoNothing()
    },
  })
  return { ok: true as const, ...result }
}

export async function requestConfirmation(userId: string, taskId: string) {
  const plan = await voicePlan(userId)
  if (!plan) return UNAVAILABLE
  return privileged.transaction(async (tx) => {
    const task = await ownTask(tx, userId, taskId)
    if (!task) return NOT_FOUND
    if (task.status === "awaiting_confirmation") {
      const [pending] = await tx
        .select()
        .from(voiceApprovals)
        .where(
          and(
            eq(voiceApprovals.voiceTaskId, task.id),
            eq(voiceApprovals.status, "pending")
          )
        )
      if (pending) {
        return {
          ok: true as const,
          approvalId: pending.id,
          payload: pending.payload,
          payloadHash: pending.payloadHash,
          expiresAt: pending.expiresAt,
        }
      }
    }
    if (task.status !== "draft") return FINAL

    const spec = task.spec as VoiceTaskSpec
    const [owner] = await tx
      .select({ name: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, userId))
    if (!owner?.name) {
      return fail(
        "invalid",
        "Add your name in Account, so Tavi can say who it's calling for.",
        {
          owner: "Your name is missing.",
        }
      )
    }
    const [profile] = await tx
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, userId))
    if (task.reportRequested && task.reportAt) {
      if (!profile?.ownerPhoneE164 || !profile.ownerPhoneVerifiedAt) {
        return fail(
          "number_unverified",
          "Verify your phone number first, so Tavi can call you with the result."
        )
      }
      if (task.reportAt <= clock.now()) {
        return fail("invalid", "Choose a report time in the future.", {
          reportAt: "In the past.",
        })
      }
      if (inQuietHours(task.reportAt, profile)) {
        return fail(
          "quiet_hours",
          "That report time is in your quiet hours. Pick another."
        )
      }
    }
    const notBefore = earliestCall(spec)
    if (notBefore >= outreachWindowEnd(notBefore, task.reportAt)) {
      return fail(
        "outside_calling_hours",
        "Tavi calls people between 9 AM and 9 PM, Monday to Saturday. Move the report later."
      )
    }
    const refused = await limits(tx, userId, plan, task.recipientPhoneHash)
    if (refused) return refused

    // Exactly what the confirmation card shows (API_AND_EXECUTION_CONTRACTS §2)
    const payload = {
      recipientLabel: task.recipientLabel,
      recipientName: task.recipientName ?? null,
      phone: task.recipientPhoneE164,
      purpose: task.purpose,
      goal: spec.goal,
      authority: spec.authority,
      mustNot: spec.mustNot,
      disclosure: disclosure(owner.name),
      earliestCallAt: notBefore.toISOString(),
      reportAt: task.reportAt?.toISOString() ?? null,
      timezone: spec.timezone,
      // No price sheet yet (COST_AND_METERING §2): never an invented number
      cost: "price not yet set",
    }
    const payloadHash = createHash("sha256").update(canonical(payload)).digest("hex")
    const [approval] = await tx
      .insert(voiceApprovals)
      .values({
        userId,
        voiceTaskId: task.id,
        kind: task.parentTaskId ? "follow_up_call" : "outreach_call",
        payload,
        payloadHash,
        expiresAt: new Date(Date.now() + APPROVAL_MINUTES * 60_000),
      })
      .returning()
    await transition(tx, "task", task.id, "awaiting_confirmation", "owner")
    return {
      ok: true as const,
      approvalId: approval.id,
      payload,
      payloadHash,
      expiresAt: approval.expiresAt,
    }
  })
}

export async function confirmCall(
  userId: string,
  approvalId: string,
  payloadHash: string
) {
  const plan = await voicePlan(userId)
  if (!plan) return UNAVAILABLE
  return privileged.transaction(async (tx) => {
    const [approval] = await tx
      .select({
        row: voiceApprovals,
        expired: sql<boolean>`${voiceApprovals.expiresAt} < now()`,
      })
      .from(voiceApprovals)
      .where(and(eq(voiceApprovals.id, approvalId), eq(voiceApprovals.userId, userId)))
      .for("update")
    if (!approval) return NOT_FOUND
    const task = await ownTask(tx, userId, approval.row.voiceTaskId)
    if (!task) return NOT_FOUND
    // Confirming twice gives the first answer
    if (approval.row.status === "approved") {
      return { ok: true as const, taskId: task.id, status: task.status }
    }
    const pending = approval.row.status === "pending"
    if (approval.row.status === "expired" || (pending && approval.expired)) {
      return fail("expired", "This confirmation expired. Review the call again.")
    }
    if (!pending || approval.row.payloadHash !== payloadHash) {
      return fail("stale_approval", "The details changed. Review the call again.")
    }
    const refused = await limits(tx, userId, plan, task.recipientPhoneHash)
    if (refused) return refused

    await tx
      .update(voiceApprovals)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(voiceApprovals.id, approvalId))
    await transition(tx, "task", task.id, "authorized", "owner", {
      approval_id: approvalId,
      payload_hash: payloadHash,
    })

    const notBefore = earliestCall(task.spec as VoiceTaskSpec)
    const rows: (typeof voiceCalls.$inferInsert)[] = [
      {
        userId,
        voiceTaskId: task.id,
        kind: "outreach",
        seq: 1,
        toPhoneE164: task.recipientPhoneE164,
        notBefore,
        availableAt: notBefore,
        windowEnd: outreachWindowEnd(notBefore, task.reportAt),
        maxAttempts: plan.maxAttemptsPerCall,
      },
    ]
    const [profile] = await tx
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, userId))
    if (task.reportRequested && task.reportAt && profile?.ownerPhoneE164) {
      rows.push({
        userId,
        voiceTaskId: task.id,
        kind: "owner_report",
        seq: 1,
        toPhoneE164: profile.ownerPhoneE164,
        notBefore: task.reportAt,
        availableAt: task.reportAt,
        windowEnd: reportWindowEnd(task.reportAt, profile),
        maxAttempts: profile.reportMaxAttempts,
      })
    }
    await tx.insert(voiceCalls).values(rows).onConflictDoNothing()
    log.info("voice call confirmed", { taskId: task.id })
    return { ok: true as const, taskId: task.id, status: "authorized" as const }
  })
}

export async function declineCall(userId: string, approvalId: string) {
  return privileged.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(voiceApprovals)
      .where(and(eq(voiceApprovals.id, approvalId), eq(voiceApprovals.userId, userId)))
      .for("update")
    if (!approval) return NOT_FOUND
    if (approval.status === "declined") return { ok: true as const }
    if (approval.status !== "pending") return FINAL
    await tx
      .update(voiceApprovals)
      .set({ status: "declined", decidedAt: new Date() })
      .where(eq(voiceApprovals.id, approvalId))
    await transition(tx, "task", approval.voiceTaskId, "draft", "owner")
    return { ok: true as const }
  })
}

// Scheduled calls stop at once; a live call is hung up by the worker that
// holds it at its next heartbeat, which then finishes the cancellation
export async function cancelVoiceTask(userId: string, taskId: string) {
  return privileged.transaction(async (tx) => {
    const task = await ownTask(tx, userId, taskId)
    if (!task) return NOT_FOUND
    if (TERMINAL_TASK.includes(task.status)) return FINAL
    const at = new Date()
    await tx
      .update(voiceTasks)
      .set({ cancelRequestedAt: at })
      .where(eq(voiceTasks.id, task.id))
    await tx
      .update(voiceApprovals)
      .set({ status: "superseded", decidedAt: at })
      .where(
        and(eq(voiceApprovals.voiceTaskId, task.id), eq(voiceApprovals.status, "pending"))
      )
    const open = await tx
      .update(voiceCalls)
      .set({ cancelRequestedAt: at })
      .where(
        and(
          eq(voiceCalls.voiceTaskId, task.id),
          notInArray(voiceCalls.status, TERMINAL_CALL)
        )
      )
      .returning({ id: voiceCalls.id, status: voiceCalls.status })
    for (const call of open.filter((c) =>
      ["scheduled", "retry_wait"].includes(c.status)
    )) {
      await transition(tx, "call", call.id, "canceled", "owner")
    }
    if (open.some((c) => ["dialing", "in_call"].includes(c.status))) {
      log.info("voice cancel requested during a call", { taskId: task.id })
      return { ok: true as const, status: task.status }
    }
    await transition(tx, "task", task.id, "cancelled", "owner")
    return { ok: true as const, status: "cancelled" as const }
  })
}

// The person deletes what was said on a task's calls at any time; the
// outcome stays (D-10). Their own session: RLS and the delete grant
export async function deleteTranscript(userId: string, taskId: string) {
  const deleted = await withUser(userId, async (tx) => {
    const attempts = await tx
      .select({ id: callAttempts.id })
      .from(callAttempts)
      .innerJoin(voiceCalls, eq(voiceCalls.id, callAttempts.voiceCallId))
      .where(eq(voiceCalls.voiceTaskId, taskId))
    if (attempts.length === 0) return 0
    const rows = await tx
      .delete(conversationTurns)
      .where(
        inArray(
          conversationTurns.callAttemptId,
          attempts.map((a) => a.id)
        )
      )
      .returning({ id: conversationTurns.id })
    return rows.length
  })
  log.info("voice transcript deleted", { taskId, turns: deleted })
  return { ok: true as const, deleted }
}

export async function emergencyStop(userId: string) {
  const open = await privileged
    .select({ id: voiceTasks.id })
    .from(voiceTasks)
    .where(
      and(eq(voiceTasks.userId, userId), notInArray(voiceTasks.status, TERMINAL_TASK))
    )
    .orderBy(desc(voiceTasks.createdAt))
  let cancelled = 0
  for (const task of open) {
    if ((await cancelVoiceTask(userId, task.id)).ok) cancelled += 1
  }
  log.warn("voice emergency stop", { userId, cancelled })
  return { ok: true as const, cancelled }
}
