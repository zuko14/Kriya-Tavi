import { tool } from "ai"
import { z } from "zod"

// The live call model's only tools (D-14, CONVERSATION_AND_VERIFICATION §5).
// They note what happened on the current call; none places a call, sends a
// message or reads anything, and end_call only ends this call. They run in
// kriya-voice, never on the web server. Kept apart from lib/agent/tools.ts
// (which re-exports them) so kriya-voice loads no connector or secret code,
// and never part of KriyaTools (F8). The dialogue engine decides whether a
// call is allowed: its handlers run the guards and answer the model.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm, 24-hour")
const turn = z.number().int().min(0).max(1000)

export const callToolInputs = {
  note_proposed_time: z.object({
    date,
    time,
    by: z.enum(["callee", "tavi"]),
    turnSeq: turn,
  }),
  note_agreement: z.object({
    date,
    time,
    readBackTurnSeq: turn,
    confirmTurnSeq: turn,
  }),
  note_question_for_owner: z.object({
    question: z.string().trim().min(1).max(300),
    turnSeq: turn,
  }),
  note_wrong_person: z.object({ turnSeq: turn }),
  note_callback_request: z.object({
    when: z.string().trim().max(80).optional(),
    turnSeq: turn,
  }),
  end_call: z.object({
    reason: z.enum(["done", "wrong_person", "declined", "callee_request", "time_limit"]),
  }),
}

export type CallToolName = keyof typeof callToolInputs
export type CallToolInput<K extends CallToolName> = z.infer<(typeof callToolInputs)[K]>

// Each answers the model with what was recorded, or why it wasn't
export type CallToolHandlers = {
  [K in CallToolName]: (input: CallToolInput<K>) => string
}

const DESCRIPTIONS: Record<CallToolName, string> = {
  note_proposed_time:
    "Record a specific meeting time someone proposed or accepted on this call, citing the turn it was said in.",
  note_agreement:
    "Record that the callee said yes to the exact time you just read back to them.",
  note_question_for_owner:
    "Record a question or request the callee wants the person you're calling for to answer.",
  note_wrong_person: "Record that this isn't the person you were asked to call.",
  note_callback_request: "Record that the callee asked to be called back, and when.",
  end_call: "End this call after Tavi says goodbye.",
}

export function createCallTools(h: CallToolHandlers) {
  const i = callToolInputs
  const d = DESCRIPTIONS
  return {
    note_proposed_time: tool({
      description: d.note_proposed_time,
      inputSchema: i.note_proposed_time,
      execute: async (input) => h.note_proposed_time(input),
    }),
    note_agreement: tool({
      description: d.note_agreement,
      inputSchema: i.note_agreement,
      execute: async (input) => h.note_agreement(input),
    }),
    note_question_for_owner: tool({
      description: d.note_question_for_owner,
      inputSchema: i.note_question_for_owner,
      execute: async (input) => h.note_question_for_owner(input),
    }),
    note_wrong_person: tool({
      description: d.note_wrong_person,
      inputSchema: i.note_wrong_person,
      execute: async (input) => h.note_wrong_person(input),
    }),
    note_callback_request: tool({
      description: d.note_callback_request,
      inputSchema: i.note_callback_request,
      execute: async (input) => h.note_callback_request(input),
    }),
    end_call: tool({
      description: d.end_call,
      inputSchema: i.end_call,
      execute: async (input) => h.end_call(input),
    }),
  }
}
