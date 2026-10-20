import { generateText, Output, type LanguageModel } from "ai"
import { z } from "zod"

import { localDate } from "./languages"
import type { ModelCall } from "./outcome"
import { ACTIVE_POLICY, fill } from "./policy/v1"
import { parseIndianMobile, type DraftInput } from "./schemas"

// A call request in the person's own words → a draft for them to check
// (CONVERSATION_AND_VERIFICATION §2, API_AND_EXECUTION_CONTRACTS §2). One
// structured model call on the web server, no tools; then code decides what
// is still missing. The person confirms every field on the card before
// anyone is called, so a gap is asked for, never guessed.

export type MissingField =
  | "phone"
  | "recipient"
  | "goal"
  | "date"
  | "preferred_time"
  | "acceptable_window"
  | "ambiguous_date"

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
const ymd = /^\d{4}-\d{2}-\d{2}$/

const extractedSchema = z.object({
  recipientLabel: z.string().max(80).nullable(),
  recipientName: z.string().max(80).nullable(),
  recipientPhone: z.string().max(32).nullable(),
  purpose: z.string().max(600).nullable(),
  goalType: z.enum(["schedule_meeting", "deliver_message", "ask_question"]).nullable(),
  date: z.string().max(10).nullable(),
  preferred: z.string().max(5).nullable(),
  acceptable: z.array(z.object({ from: z.string(), to: z.string() })).max(5),
  message: z.string().max(500).nullable(),
  question: z.string().max(300).nullable(),
  mayAcceptWithinAcceptable: z.boolean(),
  mayProposeAlternatives: z.boolean(),
  reportAt: z.string().max(40).nullable(),
})

export type SpecDraft = Partial<Omit<DraftInput, "idempotencyKey" | "threadId">>

const digits = (s: string) => s.replace(/\D/g, "")

export async function extractSpec(input: {
  text: string
  now: Date
  timezone: string
  model: LanguageModel
  onModelCall?: ModelCall
}): Promise<{ draft: SpecDraft; missing: MissingField[] }> {
  const today = localDate(input.now, input.timezone)
  const tomorrow = localDate(new Date(input.now.getTime() + 86_400_000), input.timezone)
  let got: z.infer<typeof extractedSchema> | null = null
  try {
    const result = await generateText({
      model: input.model,
      instructions: fill(ACTIVE_POLICY.prompts.spec, { today, tomorrow }),
      prompt: input.text,
      output: Output.object({ schema: extractedSchema }),
      maxRetries: 1,
    })
    await input.onModelCall?.({
      n: 1,
      modelId: typeof input.model === "string" ? input.model : input.model.modelId,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
    })
    got = result.output
  } catch {
    // Nothing usable: the person fills the card in
  }

  const missing: MissingField[] = []
  const draft: SpecDraft = {
    purpose: got?.purpose?.trim() || input.text.trim().slice(0, 600),
    authority: {
      mayAcceptWithinAcceptable: got?.mayAcceptWithinAcceptable ?? false,
      mayProposeAlternatives: got?.mayProposeAlternatives ?? false,
      mayShareOwnerPhone: false,
      mayDiscuss: [],
    },
    mustNot: [],
  }
  // Only a number that is in what the person typed: a model never supplies one
  const phone = got?.recipientPhone
  if (
    phone &&
    parseIndianMobile(phone) &&
    digits(input.text).includes(digits(phone).slice(-10))
  ) {
    draft.recipientPhone = phone
  } else missing.push("phone")
  if (got?.recipientLabel?.trim()) {
    draft.recipientLabel = got.recipientLabel.trim()
    if (got.recipientName?.trim()) draft.recipientName = got.recipientName.trim()
  } else missing.push("recipient")

  if (got?.goalType === "schedule_meeting") {
    const acceptable = got.acceptable.filter(
      (w) => hhmm.test(w.from) && hhmm.test(w.to) && w.from <= w.to
    )
    const date = got.date && ymd.test(got.date) ? got.date : null
    const preferred = got.preferred && hhmm.test(got.preferred) ? got.preferred : null
    if (!date) missing.push("date")
    if (!preferred) missing.push("preferred_time")
    if (got.mayProposeAlternatives && acceptable.length === 0) {
      missing.push("acceptable_window")
    }
    if (date && preferred) {
      draft.goal = { type: "schedule_meeting", date, preferred, acceptable }
    }
    // "Tomorrow" said around midnight: which day did they mean? (§2)
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: input.timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(input.now)
    )
    if (/\btomorrow\b/i.test(input.text) && (hour >= 23 || hour < 1)) {
      missing.push("ambiguous_date")
    }
  } else if (got?.goalType === "deliver_message" && got.message?.trim()) {
    draft.goal = {
      type: "deliver_message",
      message: got.message.trim(),
      askForReply: true,
    }
  } else if (got?.goalType === "ask_question" && got.question?.trim()) {
    draft.goal = { type: "ask_question", question: got.question.trim() }
  } else missing.push("goal")

  if (got?.reportAt && !Number.isNaN(Date.parse(got.reportAt))) {
    draft.reportAt = got.reportAt
  }
  return { draft, missing }
}
