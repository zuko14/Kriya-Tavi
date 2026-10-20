import { generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai"
import { z } from "zod"

import { resultFromNotes, type CallNotes, type Turn } from "./dialogue"
import { languageFor } from "./languages"
import { ACTIVE_POLICY, fill, type VoicePolicy } from "./policy/v1"
import type { VoiceTaskSpec } from "./schemas"

// The structured outcome of one attempt (CONVERSATION_AND_VERIFICATION §6–7).
// `observed` comes only from the provider and the media stream; `interpreted`
// from post-call extraction over the stored turns and the call's notes,
// then held to deterministic checks. A failed check is needs_review: the
// owner reads the transcript. Nothing is ever silently "fixed" into success.

export type Observed = {
  connection_status:
    | "connected"
    | "answered_no_stream"
    | "busy"
    | "no_answer"
    | "rejected"
    | "failed"
    | "canceled"
    | "unknown"
  provider_call_id: string | null
  answered_at: string | null
  ended_at: string | null
  billable_seconds: number | null
  ended_by: "callee" | "tavi" | "provider" | "unknown"
  // The mark for the opening line came back (S2)
  disclosure_played: boolean
  turns: number
  transcript_reference: { attemptId: string; firstSeq: number; lastSeq: number } | null
  evidence_references: string[]
}

type AttemptFacts = {
  id: string
  status: string
  providerCallId: string | null
  answeredAt: Date | null
  connectedAt: Date | null
  endedAt: Date | null
  billableSeconds: number | null
  endReason: string | null
}

const ENDED_BY: Record<string, Observed["ended_by"]> = {
  callee_hangup: "callee",
  tavi_hangup: "tavi",
  max_duration: "tavi",
  tts_failed: "tavi",
  stt_failed: "tavi",
  provider: "provider",
  voice_lost: "provider",
}
const NOT_CONNECTED = ["busy", "no_answer", "rejected", "failed", "canceled"]

export function observedFrom(
  attempt: AttemptFacts,
  stream: { disclosurePlayed: boolean; turns: number[]; eventIds: string[] }
): Observed {
  const status = attempt.connectedAt
    ? "connected"
    : attempt.answeredAt
      ? "answered_no_stream"
      : NOT_CONNECTED.includes(attempt.status)
        ? (attempt.status as Observed["connection_status"])
        : "unknown"
  const seqs = stream.turns
  return {
    connection_status: status,
    provider_call_id: attempt.providerCallId,
    answered_at: attempt.answeredAt?.toISOString() ?? null,
    ended_at: attempt.endedAt?.toISOString() ?? null,
    billable_seconds: attempt.billableSeconds,
    ended_by: ENDED_BY[attempt.endReason ?? ""] ?? "unknown",
    disclosure_played: stream.disclosurePlayed,
    turns: seqs.length,
    transcript_reference: seqs.length
      ? { attemptId: attempt.id, firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) }
      : null,
    evidence_references: stream.eventIds,
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const turn = z.number().int().min(0)

export const interpretedSchema = z.object({
  recipient: z.object({
    label: z.string().max(80),
    confirmed_role: z.boolean(),
    name_said: z.string().max(80).nullable(),
  }),
  purpose: z.string().max(600),
  summary: z.string().max(400),
  result: z.enum([
    "agreed",
    "alternative_proposed",
    "declined",
    "wrong_person",
    "callback_requested",
    "unclear",
  ]),
  commitments: z
    .array(
      z.object({
        by: z.enum(["callee", "owner_via_tavi"]),
        what: z.string().max(300),
        turnSeq: turn,
      })
    )
    .max(10),
  proposed_times: z
    .array(z.object({ date, time, by: z.enum(["callee", "tavi"]), turnSeq: turn }))
    .max(10),
  agreed_times: z
    .array(
      z.object({
        date,
        time,
        readBackTurnSeq: turn,
        confirmTurnSeq: turn,
        superseded: z.boolean(),
      })
    )
    .max(5),
  unresolved_questions: z
    .array(z.object({ question: z.string().max(300), turnSeq: turn }))
    .max(10),
  next_action: z.object({
    type: z.enum(["none", "owner_decides", "call_again", "owner_calls_back"]),
    suggested_at: z.string().max(40).nullable(),
  }),
  next_action_due_at: z.string().max(40).nullable(),
  uncertainty_notes: z.array(z.string().max(300)).max(10),
  confidence: z.number().min(0).max(1),
})

export type Interpreted = z.infer<typeof interpretedSchema>

type Context = { spec: VoiceTaskSpec; turns: Turn[]; notes: CallNotes }

export type ModelCall = (call: {
  n: number
  modelId: string
  usage: LanguageModelUsage
  providerMetadata: unknown
}) => void | Promise<void>

const transcript = (turns: Turn[]) =>
  turns
    .map((t) => `turn ${t.seq} (${t.speaker === "tavi" ? "Tavi" : "Callee"}): ${t.text}`)
    .join("\n")

// Post-call extraction (§7 step 3): the call's model, then the escalation
// model if the first answer doesn't validate. Null after two failures.
export async function extractOutcome(
  input: Context & {
    model: LanguageModel
    escalation?: LanguageModel | null
    policy?: VoicePolicy
    onModelCall?: ModelCall
  }
): Promise<{ interpreted: Interpreted; model: string } | null> {
  const policy = input.policy ?? ACTIVE_POLICY
  const instructions = fill(policy.prompts.extraction, {
    owner: input.spec.owner.displayName,
    recipient: input.spec.recipient.label,
    goal: JSON.stringify(input.spec.goal),
    authority: JSON.stringify(input.spec.authority),
  })
  const notes = {
    proposed: input.notes.proposed,
    agreements: input.notes.agreed,
    questions: input.notes.questions,
    wrongPerson: input.notes.wrongPerson,
    callback: input.notes.callback,
    flags: input.notes.flags,
  }
  const prompt = `Transcript:\n${transcript(input.turns)}\n\nNotes Tavi recorded during the call:\n${JSON.stringify(notes)}`
  const tries = [input.model, input.escalation ?? input.model]
  for (const [i, model] of tries.entries()) {
    const modelId = typeof model === "string" ? model : model.modelId
    try {
      const result = await generateText({
        model,
        instructions,
        prompt,
        output: Output.object({ schema: interpretedSchema }),
        maxRetries: 1,
      })
      await input.onModelCall?.({
        n: i + 1,
        modelId,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
      })
      return { interpreted: result.output, model: modelId }
    } catch {
      // Invalid output or a failed request: the next try, or none
    }
  }
  return null
}

// Deterministic checks (§7 step 4). Returns the outcome to store: an
// unsupported agreement is demoted to a proposal (never the reverse), and
// any failed check makes it needs_review
export function checkOutcome(interpreted: Interpreted, { spec, turns, notes }: Context) {
  const lang = languageFor(spec.language)
  const today = spec.referenceDate
  const owner = spec.owner.displayName
  const reasons: string[] = []
  const out: Interpreted = structuredClone(interpreted)
  const turnOf = (seq: number) => turns.find((t) => t.seq === seq)
  const cites = (seq: number, what: string) => {
    if (turnOf(seq)) return true
    reasons.push(`${what} cites turn ${seq}, which doesn't exist`)
    return false
  }

  // Every agreed time needs the guarded agreement from the call
  const live = notes.agreed.filter((a) => !a.superseded)
  out.agreed_times = interpreted.agreed_times.filter((a) => {
    cites(a.readBackTurnSeq, "an agreed time")
    cites(a.confirmTurnSeq, "an agreed time")
    if (a.superseded) return true
    if (live.some((n) => n.date === a.date && n.time === a.time)) return true
    reasons.push(
      `${a.date} ${a.time} was claimed as agreed with no agreement on the call`
    )
    out.uncertainty_notes.push(
      `${a.date} ${a.time}: no agreement was recorded on the call; kept as a proposal`
    )
    if (!out.proposed_times.some((p) => p.date === a.date && p.time === a.time)) {
      out.proposed_times.push({
        date: a.date,
        time: a.time,
        by: "callee",
        turnSeq: a.confirmTurnSeq,
      })
    }
    return false
  })

  // Proposed times must be in the words of the turn they cite
  for (const p of out.proposed_times) {
    if (!cites(p.turnSeq, "a proposed time")) continue
    if (lang.normalize(turnOf(p.turnSeq)!.text, today).time !== p.time) {
      reasons.push(`turn ${p.turnSeq} doesn't say ${p.time}`)
    }
  }
  // Tavi's only authority to commit the owner is an agreed time
  for (const c of out.commitments) {
    cites(c.turnSeq, "a commitment")
    const named = lang.normalize(c.what, today).time
    if (c.by === "owner_via_tavi" && !live.some((a) => a.time === named)) {
      reasons.push(`a commitment for ${owner} beyond the agreed time: "${c.what}"`)
    }
  }
  for (const q of out.unresolved_questions) cites(q.turnSeq, "a question")

  // The result can't contradict what the guards recorded
  const fromNotes = resultFromNotes(notes)
  if (out.result === "agreed" && !out.agreed_times.some((a) => !a.superseded)) {
    out.result = fromNotes === "agreed" ? "unclear" : fromNotes
  }
  if (
    (["agreed", "wrong_person"].includes(fromNotes) || interpreted.result === "agreed") &&
    out.result !== fromNotes
  ) {
    reasons.push(`result ${interpreted.result}, but the call's notes say ${fromNotes}`)
  }
  if (!turns.some((t) => t.speaker === "callee") && out.result !== "unclear") {
    reasons.push("the callee never spoke")
  }
  // Tavi's own failure (speech, recognition, model) is the owner's to see,
  // never a quiet "unclear" (S12, S13)
  for (const flag of notes.flags.filter((f) => /failed|unavailable/.test(f))) {
    reasons.push(`the call had a fault: ${flag}`)
  }

  return {
    status: reasons.length ? ("needs_review" as const) : ("accepted" as const),
    interpreted: out,
    reasons,
  }
}
