import { z } from "zod"

import type { ThreadSummary } from "@/db/schema"

// Thread summary checkpoints (MEMORY_AND_CONTEXT.md §7). A long thread's
// older turns are replaced in the model's input by a short structured
// summary; the person still sees every message. Pure rules here; the job
// that writes checkpoints is lib/memory/maintenance.ts.

// A checkpoint is due once the messages since the last one pass this size
export const SUMMARY_TRIGGER_CHARS = 12_000
// The newest person turns (and the replies to them) always stay verbatim
export const KEEP_PERSON_TURNS = 6
export const SUMMARY_MAX_CHARS = 3_200

const items = (max: number) => z.array(z.string().min(1).max(400)).max(max)

export const summarySchema = z.object({
  facts: items(40).describe("What is true about the person, their work and this thread"),
  decisions: items(20).describe("What was decided, with the reason"),
  open_questions: items(20).describe("Questions still open"),
  pending_actions: items(20).describe("What someone still has to do"),
  numbers: items(80).describe(
    "Every amount, date, id and link from the conversation, copied exactly as written"
  ),
})

export type SummaryMessage = { role: string; parts: unknown[] }

const partOf = (part: unknown) => part as { type?: string; text?: string; state?: string }

const hasApproval = (message: SummaryMessage) =>
  message.parts.some((part) => {
    const state = partOf(part).state
    return state === "approval-requested" || state === "approval-responded"
  })

// How many leading messages a checkpoint may cover: everything before the
// 6th-newest person message. The cut always falls just before a person
// message, so a tool call is never separated from its result (both live in
// one reply), and it moves earlier so no reply with an approval is covered.
export function coveredCount(messages: SummaryMessage[]) {
  const people = messages.flatMap((message, i) => (message.role === "user" ? [i] : []))
  if (people.length <= KEEP_PERSON_TURNS) return 0
  let cut = people[people.length - KEEP_PERSON_TURNS]
  const approval = messages.slice(0, cut).findIndex(hasApproval)
  if (approval !== -1) cut = people.filter((i) => i <= approval).at(-1) ?? 0
  return cut
}

export const textOfParts = (message: SummaryMessage) =>
  message.parts
    .map(partOf)
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join(" ")

const AMOUNT =
  /(?:₹|\brs\.?|\binr)\s?\d+(?:,\d+)*(?:\.\d+)?(?:\s?(?:lakh|lakhs|crore|crores|k)\b)?/gi
const DATES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi,
]
const URL = /https?:\/\/[^\s<>()"']+/g

// Every amount, date and link the person wrote in these messages, in that
// order. The agent's own text isn't checked: it can be regenerated, the
// person's facts can't.
export function personFacts(messages: SummaryMessage[]) {
  const said = messages
    .filter((message) => message.role === "user")
    .map(textOfParts)
    .join("\n")
  const found = [
    ...(said.match(AMOUNT) ?? []),
    ...DATES.flatMap((pattern) => said.match(pattern) ?? []),
    ...(said.match(URL) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")),
  ]
  return [...new Set(found)]
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "")

// The values a summary doesn't contain anywhere
export function dropped(values: string[], summary: ThreadSummary) {
  const kept = squash(Object.values(summary).flat().join("\n"))
  return values.filter((value) => !kept.includes(squash(value)))
}

// The person's facts a summary dropped; a summary is accepted only when
// this is empty (§7 "Check")
export function missingFacts(covered: SummaryMessage[], summary: ThreadSummary) {
  return dropped(personFacts(covered), summary)
}

const SECTIONS: [keyof ThreadSummary, string][] = [
  ["facts", "Facts"],
  ["decisions", "Decisions"],
  ["open_questions", "Open questions"],
  ["pending_actions", "Still to do"],
  ["numbers", "Numbers, dates and links"],
]

export function renderSummary(summary: ThreadSummary) {
  return SECTIONS.filter(([key]) => summary[key].length > 0)
    .map(
      ([key, title]) => `${title}:\n${summary[key].map((item) => `- ${item}`).join("\n")}`
    )
    .join("\n")
}
