import {
  generateText,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai"

import {
  createCallTools,
  type CallToolHandlers,
  type CallToolName,
} from "@/lib/agent/call-tools"

import { languageFor, type Language } from "./languages"
import { ACTIVE_POLICY, fill, type VoicePolicy } from "./policy/v1"
import type { VoiceTaskSpec } from "./schemas"

// The dialogue engine for one call (CONVERSATION_AND_VERIFICATION §3–§9).
// Text in, text out: kriya-voice turns speech into hear() and replies into
// audio (lib/voice/session.ts). The state machine, every guard and every
// budget are code; the model words replies and calls note tools, which the
// guards accept or refuse. Nothing here sets a task, call or attempt status.

export type DialogueState =
  | "opening"
  | "confirm_person"
  | "negotiate"
  | "confirm_details"
  | "unresolved"
  | "closing"

export type Turn = {
  seq: number
  speaker: "tavi" | "callee"
  text: string
  confidence: number | null
}

export type EndReason =
  | "done"
  | "wrong_person"
  | "declined"
  | "callee_request"
  | "time_limit"
  | "opt_out"
  | "emergency"
  | "budget"
  | "model_failed"

// What the call established, from guarded tool calls and code's own checks.
// Persisted as call_outcomes.interpreted.notes; the verifier reads it
export type CallNotes = {
  proposed: { date: string; time: string; by: "callee" | "tavi"; turnSeq: number }[]
  agreed: {
    date: string
    time: string
    readBackTurnSeq: number
    confirmTurnSeq: number
    superseded: boolean
  }[]
  questions: { question: string; turnSeq: number }[]
  wrongPerson: { turnSeq: number } | null
  callback: { when: string | null; turnSeq: number } | null
  optOut: { turnSeq: number } | null
  flags: string[]
  // Tool calls the guards refused, with why
  rejected: { tool: string; reason: string }[]
  end: EndReason | null
}

// The result the notes support (CONVERSATION §6). The verifier holds the
// model's extracted result to this; "agreed" exists only with a guarded
// agreement that wasn't superseded
export function resultFromNotes(notes: CallNotes) {
  if (notes.wrongPerson) return "wrong_person" as const
  if (notes.agreed.some((a) => !a.superseded)) return "agreed" as const
  if (notes.callback) return "callback_requested" as const
  if (notes.proposed.some((p) => p.by === "callee"))
    return "alternative_proposed" as const
  if (notes.end === "declined") return "declined" as const
  return "unclear" as const
}

// One thing Tavi says. end: hang up once it has played
export type Reply = { seq: number; text: string; end: boolean }

export type DialogueOptions = {
  spec: VoiceTaskSpec
  policy?: VoicePolicy
  model: LanguageModel
  // Used after two invalid tool calls in a row, once per call (§5)
  escalation?: LanguageModel | null
  // The call's date in the owner's timezone; "tomorrow" is relative to it
  today: string
  maxCallSeconds: number
  now?: () => number
  // Each model request, for metering (voice_usage llm)
  onModelCall?: (call: {
    n: number
    modelId: string
    usage: LanguageModelUsage
    providerMetadata: unknown
  }) => void | Promise<void>
  // Tests only: the fixed limit of turns without progress in one state
  unhandledTurns?: number
}

// Fixed guards and budgets (§9, SELF_IMPROVEMENT §2): never from a bundle
const MAX_TOOL_CALLS_PER_TURN = 2
const MAX_MODEL_TURNS = 40
const MAX_OUTPUT_TOKENS = 120
const CLOSE_AT = 0.8
const UNHANDLED_TURNS = 3
const INVALID_TO_ESCALATE = 2
const INVALID_TO_CLOSE = 3
const MAX_SAY = 300

const TOOLS: Record<DialogueState, CallToolName[]> = {
  opening: [],
  confirm_person: ["note_wrong_person", "note_callback_request", "end_call"],
  negotiate: ["note_proposed_time", "note_question_for_owner", "end_call"],
  confirm_details: ["note_agreement", "end_call"],
  unresolved: ["note_question_for_owner", "end_call"],
  closing: ["end_call"],
}

export class Dialogue {
  state: DialogueState = "opening"
  readonly turns: Turn[] = []
  readonly notes: CallNotes = {
    proposed: [],
    agreed: [],
    questions: [],
    wrongPerson: null,
    callback: null,
    optOut: null,
    flags: [],
    rejected: [],
    end: null,
  }
  modelCalls = 0
  escalated = false

  private readonly policy: VoicePolicy
  private readonly lang: Language
  private readonly now: () => number
  private readonly startedAt: number
  private readonly owner: string
  private readonly recipient: string
  private disclosureHeard = false
  private disclosureSeq: number | null = null
  // The read-back waiting for a yes
  private pending: { date: string; time: string; readBackTurnSeq: number } | null = null
  // The day the callee last named: "Friday?" then "3 pm" is Friday at 3
  private calleeDate: string | null = null
  private unhandled = 0
  private invalidStreak = 0
  private closingRepeats = 0
  // Refusals from the last model turn, told to the model once
  private feedback: string[] = []
  // What this turn's tool calls recorded
  private turnNotes: {
    proposed: CallNotes["proposed"][number] | null
    agreed: boolean
    end: EndReason | null
  } = { proposed: null, agreed: false, end: null }

  constructor(private readonly options: DialogueOptions) {
    this.policy = options.policy ?? ACTIVE_POLICY
    this.lang = languageFor(options.spec.language)
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    this.owner = options.spec.owner.displayName
    this.recipient = options.spec.recipient.label.replace(/^(my|our)\s+/i, "")
  }

  /* ─────────────────────────── speaking ─────────────────────────── */

  private words(key: keyof VoicePolicy["wording"], extra: Record<string, string> = {}) {
    return fill(this.policy.wording[key], {
      owner: this.owner,
      recipient: this.recipient,
      ...extra,
    })
  }

  private say(text: string, end = false): Reply {
    const seq = this.turns.length
    this.turns.push({ seq, speaker: "tavi", text, confidence: null })
    return { seq, text, end }
  }

  private close(reason: EndReason, ...lines: string[]): Reply {
    this.state = "closing"
    this.notes.end = reason
    return this.say(lines.join(" "), true)
  }

  private move(state: DialogueState) {
    if (state !== this.state) this.unhandled = 0
    this.state = state
  }

  // The fixed disclosure, never generated (§3, T-DLG-01)
  opening(): Reply {
    const reply = this.say(this.lang.disclosure(this.owner))
    this.disclosureSeq = reply.seq
    return reply
  }

  // From the media stream's marks: whether a turn played to the end
  played(seq: number, complete: boolean) {
    if (seq === this.disclosureSeq && complete) this.disclosureHeard = true
  }

  /* ─────────────────────────── listening ────────────────────────── */

  async hear(text: string, confidence: number | null = null): Promise<Reply | null> {
    if (this.notes.end && this.state === "closing" && this.closingRepeats > 0) return null
    const safe = this.lang.redact(text).slice(0, 4000)
    const seq = this.turns.length
    this.turns.push({ seq, speaker: "callee", text: safe, confidence })
    this.calleeDate =
      this.lang.normalize(safe, this.options.today).date ?? this.calleeDate
    const is = this.lang.is

    // Safety first, in any state (CONVERSATION §8)
    if (is.emergency(safe)) {
      this.notes.flags.push("emergency mentioned")
      return this.close("emergency", this.lang.fixed.emergency)
    }
    if (is.optOut(safe)) {
      this.notes.optOut = { turnSeq: seq }
      return this.close("opt_out", this.lang.fixed.optOut)
    }
    // Nothing else until the disclosure has been heard in full (S28)
    if (!this.disclosureHeard) return this.opening()

    if (this.state === "closing") return this.afterClosing(safe)
    const elapsed = (this.now() - this.startedAt) / 1000
    if (elapsed >= CLOSE_AT * this.options.maxCallSeconds) {
      return this.close("time_limit", this.words("closing"))
    }
    if (is.wrongPerson(safe)) {
      this.notes.wrongPerson = { turnSeq: seq }
      return this.close("wrong_person", this.words("wrongPerson"), this.words("closing"))
    }
    if (is.injection(safe)) this.notes.flags.push("callee attempted to redirect")
    if (is.askingIfAi(safe)) return this.say(this.lang.fixed.isAi(this.owner))
    if (is.sensitive(safe)) {
      this.notes.flags.push("sensitive request")
      return this.say(this.words("cantSensitive"))
    }
    if (is.contactRequest(safe)) {
      this.notes.questions.push({
        question: `Asked for ${this.owner}'s contact details`,
        turnSeq: seq,
      })
      return this.say(this.words("cantShareContact"))
    }

    switch (this.state) {
      case "opening":
        return this.afterDisclosure(safe)
      case "confirm_person":
        return this.confirmPerson(safe)
      case "negotiate":
        return this.negotiate(safe, confidence)
      case "confirm_details":
        return this.confirmDetails(safe, confidence)
      case "unresolved":
        return this.close("done", this.words("checkWithOwner"), this.words("closing"))
    }
  }

  private afterDisclosure(text: string) {
    this.move("confirm_person")
    // "Yes, go ahead" or a greeting: ask who they are; anything else
    // ("I'm driving") is the model's to read
    if (this.lang.is.affirmative(text) || /^\W*(hello|hi|haan|ji)\b/i.test(text)) {
      return this.say(this.words("confirmPerson"))
    }
    return this.confirmPerson(text)
  }

  private async confirmPerson(text: string) {
    if (this.lang.is.affirmative(text)) return this.purpose()
    const said = await this.think()
    if (this.notes.end) return this.ended()
    if (this.notes.wrongPerson) {
      return this.close("wrong_person", this.words("wrongPerson"), this.words("closing"))
    }
    if (this.notes.callback) {
      return this.close("callee_request", this.words("callback"), this.words("closing"))
    }
    if (this.turnNotes.end) return this.close(this.turnNotes.end, this.words("closing"))
    return this.unhandledReply(said)
  }

  // Tavi states the goal. A meeting's preferred time is said in full, so
  // the sentence is also its read-back
  private purpose(): Reply {
    const goal = this.options.spec.goal
    if (goal.type === "schedule_meeting") {
      const reply = this.say(
        this.words("meeting", {
          when: `on ${this.lang.speak(goal.date, goal.preferred)}`,
          place: goal.place ? ` at ${goal.place}` : "",
        })
      )
      this.notes.proposed.push({
        date: goal.date,
        time: goal.preferred,
        by: "tavi",
        turnSeq: reply.seq,
      })
      this.pending = { date: goal.date, time: goal.preferred, readBackTurnSeq: reply.seq }
      this.move("confirm_details")
      return reply
    }
    // A message or a question: their answer is in the transcript for the
    // outcome; Tavi closes after it. ponytail: no follow-up questions on
    // these goals yet; give the model a turn if calls show it's needed
    if (goal.type === "deliver_message") {
      const message = this.words("message", { message: goal.message })
      if (!goal.askForReply) return this.close("done", message, this.words("closing"))
      this.move("unresolved")
      return this.say(`${message} ${this.words("askReply")}`)
    }
    this.move("unresolved")
    return this.say(this.words("question", { question: goal.question }))
  }

  private unsure(text: string, confidence: number | null) {
    if (confidence === null || confidence >= this.policy.thresholds.lowConfidence)
      return false
    const m = this.lang.normalize(text, this.options.today)
    return Boolean(m.time || m.date || /\d/.test(text))
  }

  private async negotiate(text: string, confidence: number | null) {
    if (this.unsure(text, confidence)) return this.say(this.words("repeat"))
    const said = await this.think()
    if (this.notes.end) return this.ended()
    const proposal = this.turnNotes.proposed
    if (proposal) {
      if (!this.allowed(proposal.date, proposal.time)) {
        return this.close("done", this.words("checkWithOwner"), this.words("closing"))
      }
      const reply = this.say(
        this.words("readBack", { when: this.lang.speak(proposal.date, proposal.time) })
      )
      this.pending = {
        date: proposal.date,
        time: proposal.time,
        readBackTurnSeq: reply.seq,
      }
      this.move("confirm_details")
      return reply
    }
    if (this.turnNotes.end) return this.close(this.turnNotes.end, this.words("closing"))
    return this.unhandledReply(said)
  }

  private async confirmDetails(text: string, confidence: number | null) {
    if (this.unsure(text, confidence)) return this.say(this.words("repeat"))
    const m = this.lang.normalize(text, this.options.today)
    const pending = this.pending!
    // Another time or day is a correction, never a yes: back to negotiating (§3)
    if (this.namesOther(m, pending)) {
      this.move("negotiate")
      return this.negotiate(text, null)
    }
    const said = await this.think()
    if (this.notes.end) return this.ended()
    if (this.turnNotes.agreed) {
      return this.close("done", this.words("agreed"), this.words("closing"))
    }
    if (this.turnNotes.end) return this.close(this.turnNotes.end, this.words("closing"))
    // A yes the model didn't record: read it back again rather than guess
    if (this.lang.is.affirmative(text)) {
      if (++this.unhandled >= (this.options.unhandledTurns ?? UNHANDLED_TURNS)) {
        return this.close("done", this.words("checkWithOwner"), this.words("closing"))
      }
      const reply = this.say(
        this.words("readBack", { when: this.lang.speak(pending.date, pending.time) })
      )
      this.pending = { ...pending, readBackTurnSeq: reply.seq }
      return reply
    }
    this.move("negotiate")
    return this.unhandledReply(said)
  }

  // After the goodbye: a new time supersedes the agreement (S10); anything
  // else hears the goodbye once more
  private async afterClosing(text: string) {
    const m = this.lang.normalize(text, this.options.today)
    const live = this.notes.agreed.filter((a) => !a.superseded)
    if (m.time && live.length > 0 && live.some((a) => a.time !== m.time)) {
      for (const a of live) a.superseded = true
      this.notes.end = null
      this.closingRepeats = 0
      this.move("negotiate")
      return this.negotiate(text, null)
    }
    if (this.closingRepeats++ > 0) return null
    return this.say(this.words("closing"), true)
  }

  private unhandledReply(said: string) {
    if (++this.unhandled >= (this.options.unhandledTurns ?? UNHANDLED_TURNS)) {
      return this.close("done", this.words("checkWithOwner"), this.words("closing"))
    }
    return this.say(said || this.words("repeat"))
  }

  // The model failed or ran out of budget during think()
  private ended() {
    const handOff = this.notes.end === "model_failed"
    return this.close(this.notes.end!, this.words(handOff ? "handOff" : "closing"))
  }

  // A time Tavi may agree to: the owner's preferred time, or one inside an
  // acceptable window if the owner allowed accepting (§3 guards)
  private allowed(date: string, time: string) {
    const { goal, authority } = this.options.spec
    if (goal.type !== "schedule_meeting" || date !== goal.date) return false
    if (time === goal.preferred) return true
    return (
      authority.mayAcceptWithinAcceptable &&
      goal.acceptable.some((w) => w.from <= time && time <= w.to)
    )
  }

  /* ──────────────────────────── the model ───────────────────────── */

  private prompt(allowed: CallToolName[]) {
    const { goal, authority, mustNot } = this.options.spec
    const goalText =
      goal.type === "schedule_meeting"
        ? `Meet on ${goal.date} at ${goal.preferred}${goal.place ? ` at ${goal.place}` : ""}. Times ${this.owner} accepts that day: ${goal.acceptable.map((w) => `${w.from}–${w.to}`).join(", ") || `only ${goal.preferred}`}.`
        : goal.type === "deliver_message"
          ? `Pass on this message: "${goal.message}".`
          : `Ask: "${goal.question}".`
    const may = [
      authority.mayAcceptWithinAcceptable && "agree to a time inside the accepted times",
      authority.mayProposeAlternatives && "suggest other times inside the accepted times",
      authority.mayDiscuss.length > 0 && `talk about ${authority.mayDiscuss.join(", ")}`,
    ].filter(Boolean)
    const lastTavi = this.turns.findLast((t) => t.speaker === "tavi")
    const values = {
      owner: this.owner,
      recipient: this.recipient,
      today: this.options.today,
      goal: goalText,
      authority: may.length ? may.join("; ") : "nothing beyond the goal",
      mustNot: mustNot.length ? mustNot.join("; ") : "nothing beyond the rules",
      state: this.state,
      tools: allowed.join(", ") || "none",
      calleeTurn: String(this.turns.length - 1),
      taviTurn: String(lastTavi?.seq ?? 0),
      pending: [
        this.pending
          ? `\nYou read back ${this.pending.date} ${this.pending.time} in turn ${this.pending.readBackTurnSeq}.`
          : "",
        ...this.feedback.map((f) => `\nYour last tool call wasn't recorded: ${f}`),
      ].join(""),
    }
    return fill(this.policy.prompts.dialogue, {
      ...values,
      job: fill(this.policy.prompts.states[this.state] ?? "", values),
    })
  }

  private messages(): ModelMessage[] {
    return this.turns.map((t) =>
      t.speaker === "callee"
        ? { role: "user" as const, content: t.text }
        : { role: "assistant" as const, content: t.text }
    )
  }

  // One model request for the callee's latest turn. Returns what to say;
  // the tool calls it made are in turnNotes (accepted) and notes.rejected
  private async think(): Promise<string> {
    this.turnNotes = { proposed: null, agreed: false, end: null }
    if (this.modelCalls >= MAX_MODEL_TURNS) {
      this.notes.end = "budget"
      return ""
    }
    const allowed = TOOLS[this.state]
    const model =
      this.escalated && this.options.escalation
        ? this.options.escalation
        : this.options.model
    const instructions = this.prompt(allowed)
    this.feedback = []
    let result
    try {
      result = await generateText({
        model,
        instructions,
        messages: this.messages(),
        tools: createCallTools(this.handlers(allowed)),
        stopWhen: isStepCount(1),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
      })
    } catch {
      this.notes.flags.push("model unavailable")
      this.notes.end = "model_failed"
      return ""
    }
    this.modelCalls += 1
    await this.options.onModelCall?.({
      n: this.modelCalls,
      modelId: typeof model === "string" ? model : model.modelId,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
    })
    let invalid = 0
    for (const part of result.steps.flatMap((step) => step.content)) {
      if (part.type === "tool-call" && part.invalid) {
        invalid += 1
        this.notes.rejected.push({ tool: part.toolName, reason: "invalid input" })
        this.feedback.push(`${part.toolName} had invalid input`)
      }
    }
    this.invalidStreak = invalid > 0 ? this.invalidStreak + invalid : 0
    if (this.invalidStreak >= INVALID_TO_CLOSE) {
      this.notes.end = "model_failed"
      return ""
    }
    if (
      this.invalidStreak >= INVALID_TO_ESCALATE &&
      this.options.escalation &&
      !this.escalated
    ) {
      this.escalated = true
      this.notes.flags.push("escalated")
    }
    // Never speak a number the callee's words couldn't be stored with
    return this.lang.redact(result.text.replace(/\s+/g, " ").trim()).slice(0, MAX_SAY)
  }

  // Each tool's guard (§3, §5); a refusal goes back to the model as text
  private handlers(allowed: CallToolName[]): CallToolHandlers {
    let calls = 0
    const refuse = (tool: string, reason: string) => {
      this.notes.rejected.push({ tool, reason })
      this.feedback.push(reason)
      return `Not recorded: ${reason}`
    }
    const gate = (tool: CallToolName) => {
      if (!allowed.includes(tool)) return `${tool} isn't available now (${this.state})`
      if (++calls > MAX_TOOL_CALLS_PER_TURN)
        return `Only ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn`
      return null
    }
    const turnOf = (seq: number) => this.turns.find((t) => t.seq === seq)

    return {
      note_proposed_time: ({ date, time, by, turnSeq }) => {
        const blocked = gate("note_proposed_time")
        if (blocked) return refuse("note_proposed_time", blocked)
        const turn = turnOf(turnSeq)
        if (!turn || turn.speaker !== by) {
          return refuse("note_proposed_time", `turn ${turnSeq} isn't the ${by}'s`)
        }
        // The time must be in the words of the turn it cites
        const m = this.lang.normalize(turn.text, this.options.today)
        if (m.time !== time) {
          return refuse("note_proposed_time", `turn ${turnSeq} doesn't say ${time}`)
        }
        const expected =
          m.date ??
          (by === "callee" ? this.calleeDate : null) ??
          this.pending?.date ??
          this.meetingDate()
        if (date !== expected) {
          return refuse("note_proposed_time", `turn ${turnSeq} doesn't say ${date}`)
        }
        const note = { date, time, by, turnSeq }
        this.notes.proposed.push(note)
        this.turnNotes.proposed = note
        return "Recorded. Kriya reads it back to the callee."
      },

      note_agreement: ({ date, time, readBackTurnSeq, confirmTurnSeq }) => {
        const blocked = gate("note_agreement")
        if (blocked) return refuse("note_agreement", blocked)
        const p = this.pending
        const lastTavi = this.turns.findLast((t) => t.speaker === "tavi")
        if (
          !p ||
          p.date !== date ||
          p.time !== time ||
          p.readBackTurnSeq !== readBackTurnSeq ||
          lastTavi?.seq !== readBackTurnSeq
        ) {
          return refuse("note_agreement", "that isn't the time you read back last")
        }
        const confirm = this.turns.at(-1)!
        if (confirm.seq !== confirmTurnSeq || confirm.speaker !== "callee") {
          return refuse("note_agreement", "confirmTurnSeq isn't the callee's latest turn")
        }
        if (
          !this.lang.is.affirmative(confirm.text) ||
          this.namesOther(this.lang.normalize(confirm.text, this.options.today), p)
        ) {
          return refuse("note_agreement", "the callee didn't clearly say yes")
        }
        if (!this.allowed(date, time)) {
          return refuse("note_agreement", `outside what ${this.owner} allowed`)
        }
        this.notes.agreed.push({
          date,
          time,
          readBackTurnSeq,
          confirmTurnSeq,
          superseded: false,
        })
        this.turnNotes.agreed = true
        return "Agreement recorded."
      },

      note_question_for_owner: ({ question, turnSeq }) => {
        const blocked = gate("note_question_for_owner")
        if (blocked) return refuse("note_question_for_owner", blocked)
        if (!turnOf(turnSeq)) return refuse("note_question_for_owner", "no such turn")
        this.notes.questions.push({ question: this.lang.redact(question), turnSeq })
        return "Recorded for the owner."
      },

      note_wrong_person: ({ turnSeq }) => {
        const blocked = gate("note_wrong_person")
        if (blocked) return refuse("note_wrong_person", blocked)
        this.notes.wrongPerson = { turnSeq }
        return "Recorded."
      },

      note_callback_request: ({ when, turnSeq }) => {
        const blocked = gate("note_callback_request")
        if (blocked) return refuse("note_callback_request", blocked)
        this.notes.callback = { when: when ?? null, turnSeq }
        return "Recorded. The owner decides whether to call again."
      },

      end_call: ({ reason }) => {
        const blocked = gate("end_call")
        if (blocked) return refuse("end_call", blocked)
        this.turnNotes.end = reason
        return "Tavi says goodbye and the call ends."
      },
    }
  }

  // "Friday works better" names another day: not a yes to Wednesday
  private namesOther(
    m: { date: string | null; time: string | null },
    read: { date: string; time: string }
  ) {
    return Boolean((m.time && m.time !== read.time) || (m.date && m.date !== read.date))
  }

  private meetingDate() {
    const goal = this.options.spec.goal
    return goal.type === "schedule_meeting" ? goal.date : this.options.today
  }
}
