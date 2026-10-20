"use server"

import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { createGatewayModel, modelForTier } from "@/lib/models"
import { allowAll, clientIp } from "@/lib/rate-limit"
import {
  startPhoneVerification,
  updatePreferences,
  verificationStatus,
} from "@/lib/voice/owner-report"
import { recordFeedback } from "@/lib/voice/improve"
import { draftInputSchema } from "@/lib/voice/schemas"
import {
  cancelVoiceTask,
  confirmCall,
  createDraft,
  declineCall,
  deleteTranscript,
  draftFromText,
  emergencyStop,
  fail,
  requestConfirmation,
  voiceAvailable,
} from "@/lib/voice/tasks"

// Phone calls the owner asks for (API_AND_EXECUTION_CONTRACTS.md §2). No
// action places a call: confirming only schedules it, and kriya-worker
// dials. Identity comes from the session; the browser's user id, plan or
// price is never read (invariant 3). draftCall takes the completed card;
// extractCallDraft fills one in from the person's own words (voice phase 4).

const id = z.string().uuid()
const hash = z.string().regex(/^[0-9a-f]{64}$/)

const INVALID = fail("invalid", "That request wasn't valid.")
const RATE_LIMITED = fail(
  "rate_limited",
  "Too many requests. Wait a little and try again."
)

// Per address on every voice action; per account for drafts and confirmations
const LIMITS = {
  draft: [20, 3600],
  confirm: [10, 3600],
  // Each one rings the owner's phone
  verify: [5, 3600],
  other: [60, 60],
} as const

async function limited(userId: string, kind: keyof typeof LIMITS) {
  const [max, seconds] = LIMITS[kind]
  return !(await allowAll([
    [`voice:ip:${await clientIp()}`, 60, 60],
    [`voice:${kind}:${userId}`, max, seconds],
  ]))
}

export async function draftCall(input: unknown) {
  const user = await requireUser()
  const parsed = draftInputSchema.safeParse(input)
  if (!parsed.success) {
    const fields = Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join("."), issue.message])
    )
    return fail("invalid", "Some details are missing or not valid.", fields)
  }
  if (await limited(user.id, "draft")) return RATE_LIMITED
  return createDraft(user.id, parsed.data)
}

// "Call my CA at … and ask whether 3 PM tomorrow works" → the fields for
// the draft card, and what's missing (API §2). One structured model call,
// no tools; nothing is stored until draftCall gets the completed card
export async function extractCallDraft(text: unknown) {
  const user = await requireUser()
  const parsed = z.string().trim().min(1).max(2000).safeParse(text)
  if (!parsed.success) return INVALID
  if (await limited(user.id, "draft")) return RATE_LIMITED
  return draftFromText(
    user.id,
    parsed.data,
    createGatewayModel(await modelForTier("budget"))
  )
}

export async function askToConfirmCall(taskId: string) {
  const user = await requireUser()
  if (!id.safeParse(taskId).success) return INVALID
  if (await limited(user.id, "confirm")) return RATE_LIMITED
  return requestConfirmation(user.id, taskId)
}

export async function confirmVoiceCall(approvalId: string, payloadHash: string) {
  const user = await requireUser()
  if (!id.safeParse(approvalId).success || !hash.safeParse(payloadHash).success) {
    return INVALID
  }
  if (await limited(user.id, "confirm")) return RATE_LIMITED
  return confirmCall(user.id, approvalId, payloadHash)
}

export async function declineVoiceCall(approvalId: string) {
  const user = await requireUser()
  if (!id.safeParse(approvalId).success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  return declineCall(user.id, approvalId)
}

export async function cancelCall(taskId: string) {
  const user = await requireUser()
  if (!id.safeParse(taskId).success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  return cancelVoiceTask(user.id, taskId)
}

// What was said on a task's calls; the outcome stays (D-10, UX spec §5)
export async function deleteCallTranscript(taskId: string) {
  const user = await requireUser()
  if (!id.safeParse(taskId).success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  return deleteTranscript(user.id, taskId)
}

// Whether to show the way into /calls (UX spec §1). A convenience only:
// every page and action checks voice access again itself
export async function voiceEntry() {
  const user = await requireUser()
  return voiceAvailable(user.id)
}

// The owner's own stop (UX spec §9): every open voice task is cancelled.
// Not rate limited: stopping must always work
export async function stopAllCalls() {
  const user = await requireUser()
  return emergencyStop(user.id)
}

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const preferencesSchema = z
  .object({
    timezone: z
      .string()
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone })
          return true
        } catch {
          return false
        }
      }),
    quietStart: clockTime,
    quietEnd: clockTime,
    reportMode: z.enum(["scheduled", "on_completion"]),
    reportMaxAttempts: z.number().int().min(1).max(5),
    reportRetryMinutes: z.number().int().min(5).max(120),
    transcriptRetentionDays: z.number().int().min(0).max(365),
  })
  .partial()
  .strict()

export async function updateVoicePreferences(input: unknown) {
  const user = await requireUser()
  const parsed = preferencesSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  return updatePreferences(user.id, parsed.data)
}

// The code to show on screen, and a verification call to the number (D-13)
export async function verifyOwnerPhone(phone: unknown) {
  const user = await requireUser()
  const parsed = z.string().trim().min(1).max(20).safeParse(phone)
  if (!parsed.success) return INVALID
  if (await limited(user.id, "verify")) return RATE_LIMITED
  return startPhoneVerification(user.id, parsed.data)
}

export async function ownerPhoneVerificationStatus(verificationId: string) {
  const user = await requireUser()
  if (!id.safeParse(verificationId).success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  return verificationStatus(user.id, verificationId)
}

// "Is this right?" on an outcome (SELF_IMPROVEMENT §3.2): the owner's
// correction becomes feedback for the weekly cases. RLS limits it to the
// owner's own attempts
const feedbackSchema = z
  .object({
    callAttemptId: id,
    field: z.enum(["result", "agreed_times", "proposed_times", "questions", "other"]),
    was: z.string().trim().max(500).optional(),
    shouldBe: z.string().trim().max(500).optional(),
  })
  .strict()

export async function correctCallOutcome(input: unknown) {
  const user = await requireUser()
  const parsed = feedbackSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (await limited(user.id, "other")) return RATE_LIMITED
  try {
    return await recordFeedback(user.id, { ...parsed.data, source: "app" })
  } catch {
    // Someone else's attempt: RLS refuses the row
    return INVALID
  }
}
