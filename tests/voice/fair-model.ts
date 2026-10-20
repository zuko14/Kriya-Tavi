import type { LanguageModelV4Prompt } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

import { LANGUAGES } from "@/lib/voice/languages"

// A scripted stand-in for a competent dialogue model (L-text, EVALUATION_PLAN
// §1): it reads only what the real prompt gives it — the state, its job,
// turn numbers and the callee's latest words — and answers the way a good
// model should. Tests that need a model to misbehave pass their own script.

const en = LANGUAGES["en-IN"]

export type Content =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }

const USAGE = {
  inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

let ids = 0
export const call = (toolName: string, input: unknown): Content => ({
  type: "tool-call",
  toolCallId: `tc-${++ids}`,
  toolName,
  input: JSON.stringify(input),
})
export const say = (text: string): Content => ({ type: "text", text })

const textOf = (message: LanguageModelV4Prompt[number]) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .join("")

export type Seen = {
  system: string
  last: string
  // Everything the callee said, oldest first
  heard: string[]
  state: string
  calleeTurn: number
  taviTurn: number
  today: string
  meetDate: string | null
  readBack: { date: string; time: string; seq: number } | null
}

export function read(prompt: LanguageModelV4Prompt): Seen {
  const system = prompt
    .filter((m) => m.role === "system")
    .map(textOf)
    .join("\n")
  const users = prompt.filter((m) => m.role === "user")
  const back = /You read back (\S+) (\S+) in turn (\d+)/.exec(system)
  return {
    system,
    last: users.length ? textOf(users.at(-1)!) : "",
    heard: users.map(textOf),
    state: /Now: (\w+)\./.exec(system)?.[1] ?? "",
    calleeTurn: Number(/latest turn is turn (\d+)/.exec(system)?.[1] ?? -1),
    taviTurn: Number(/your last turn is turn (\d+)/.exec(system)?.[1] ?? -1),
    today: /Today is (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? "",
    meetDate: /Meet on (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? null,
    readBack: back ? { date: back[1], time: back[2], seq: Number(back[3]) } : null,
  }
}

export function fair(seen: Seen): Content[] {
  const { last, calleeTurn } = seen
  switch (seen.state) {
    case "confirm_person":
      if (/\b(later|busy|call back|driving)\b/i.test(last)) {
        return [say("Of course."), call("note_callback_request", { turnSeq: calleeTurn })]
      }
      return [say("Am I speaking with the right person?")]
    case "negotiate": {
      const m = en.normalize(last, seen.today)
      if (m.time) {
        // A day named in an earlier turn still holds
        const named = seen.heard
          .map((text) => en.normalize(text, seen.today).date)
          .findLast(Boolean)
        return [
          call("note_proposed_time", {
            date: m.date ?? named ?? seen.readBack?.date ?? seen.meetDate,
            time: m.time,
            by: "callee",
            turnSeq: calleeTurn,
          }),
        ]
      }
      if (/\b(no|can't|cannot|not possible|won't)\b/i.test(last)) {
        return [call("end_call", { reason: "declined" })]
      }
      return [say("What time would suit you?")]
    }
    case "confirm_details":
      if (seen.readBack && en.is.affirmative(last)) {
        return [
          call("note_agreement", {
            date: seen.readBack.date,
            time: seen.readBack.time,
            readBackTurnSeq: seen.readBack.seq,
            confirmTurnSeq: calleeTurn,
          }),
        ]
      }
      return [say("No problem.")]
    default:
      return [say("Thank you.")]
  }
}

// A model whose every answer comes from script(seen); records the prompts
export function scriptedModel(
  script: (seen: Seen) => Content[] = fair,
  modelId = "scripted/fair"
) {
  const prompts: Seen[] = []
  const model = new MockLanguageModelV4({
    modelId,
    doGenerate: async ({ prompt }) => {
      const seen = read(prompt)
      prompts.push(seen)
      const content = script(seen)
      return {
        content,
        finishReason: {
          unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage: USAGE,
        warnings: [],
      }
    },
  })
  return Object.assign(model, { prompts })
}
