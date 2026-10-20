import { z } from "zod"

// Voice task inputs and the stored spec (CONVERSATION_AND_VERIFICATION.md
// §2), shared by the server actions and, later, the UI. Phase 3 takes the
// spec as structured input; extracting it from free text is phase 4.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm.")
const instant = z.iso.datetime({ offset: true })

export const goalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("schedule_meeting"),
    date,
    preferred: time,
    acceptable: z
      .array(z.object({ from: time, to: time }).refine((w) => w.from <= w.to))
      .max(5),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    place: z.string().trim().max(120).optional(),
  }),
  z.object({
    type: z.literal("deliver_message"),
    message: z.string().trim().min(1).max(500),
    askForReply: z.boolean(),
  }),
  z.object({
    type: z.literal("ask_question"),
    question: z.string().trim().min(1).max(300),
  }),
])

export const authoritySchema = z.object({
  mayAcceptWithinAcceptable: z.boolean(),
  mayProposeAlternatives: z.boolean(),
  // Always false in the MVP
  mayShareOwnerPhone: z.literal(false),
  mayDiscuss: z.array(z.string().trim().min(1).max(80)).max(5),
})

// The fields alone: zod can't omit fields from a refined object, and
// propose_call (lib/agent/tools.ts) omits two, then applies the rule below
export const draftFieldsSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  threadId: z.string().min(1).max(64).optional(),
  recipientLabel: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(1).max(80).optional(),
  recipientPhone: z.string().trim().min(6).max(32),
  purpose: z.string().trim().min(1).max(600),
  goal: goalSchema,
  authority: authoritySchema,
  mustNot: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  // Earliest the call may start; now when absent
  earliestAt: instant.optional(),
  // When Tavi calls the owner with the outcome; none when absent
  reportAt: instant.optional(),
})

type Rule = [
  (d: Pick<z.infer<typeof draftFieldsSchema>, "goal" | "authority">) => boolean,
  { path: string[]; message: string },
]

export const acceptableTimesRule: Rule = [
  (d) =>
    d.goal.type !== "schedule_meeting" ||
    !d.authority.mayProposeAlternatives ||
    d.goal.acceptable.length > 0,
  { path: ["goal", "acceptable"], message: "Say which times Tavi may offer." },
]

export const draftInputSchema = draftFieldsSchema.refine(...acceptableTimesRule)

export type DraftInput = z.infer<typeof draftInputSchema>

export type VoiceTaskSpec = {
  version: 1
  language: "en-IN"
  owner: { displayName: string }
  recipient: { label: string; name?: string }
  goal: z.infer<typeof goalSchema>
  authority: z.infer<typeof authoritySchema>
  mustNot: string[]
  earliestAt: string | null
  report: { at: string | null; mode: "scheduled" | "on_completion" }
  timezone: string
  referenceDate: string
}

// Indian mobile numbers only in the MVP (SECURITY §5): emergency, short,
// toll-free, premium and landline numbers don't match, so they're refused.
// Accepts +91, 91 or 0 prefixes and spaces, dashes or brackets.
export function parseIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "")
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits)
  return match ? `+91${match[1]}` : null
}

// The fixed opening line (CONVERSATION §3); never generated
export const disclosure = (owner: string) =>
  `Hello, this is Kriya Tavi, an AI assistant calling on behalf of ${owner}. Is this a good moment for a quick question?`
