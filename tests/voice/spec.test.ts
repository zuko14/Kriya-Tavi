import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"

import { extractSpec } from "@/lib/voice/spec"

// Drafting a call from what the person typed (CONVERSATION §2, API §2): one
// structured model call, then code decides what's missing. A number the
// person didn't type is never used; ambiguity is asked, not guessed.

const usage = {
  inputTokens: { total: 400, noCache: 400, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 80, text: 80, reasoning: undefined },
}
const model = (out: Record<string, unknown>) =>
  new MockLanguageModelV4({
    modelId: "m/spec",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(out) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  })

const FULL = {
  recipientLabel: "my CA",
  recipientName: null,
  recipientPhone: "98765 43210",
  purpose: "Meet tomorrow about the tax review",
  goalType: "schedule_meeting",
  date: "2026-10-21",
  preferred: "15:00",
  acceptable: [{ from: "14:00", to: "17:00" }],
  message: null,
  question: null,
  mayAcceptWithinAcceptable: true,
  mayProposeAlternatives: true,
  reportAt: null,
}
const TEXT =
  "Call my CA on 98765 43210 and ask whether 3 PM tomorrow works; anything between 2 and 5 is fine"
const NOON = new Date("2026-10-20T12:00:00+05:30")

describe("extractSpec", () => {
  it("a complete request has nothing missing", async () => {
    const result = await extractSpec({
      text: TEXT,
      now: NOON,
      timezone: "Asia/Kolkata",
      model: model(FULL),
    })
    expect(result.missing).toEqual([])
    expect(result.draft).toMatchObject({
      recipientLabel: "my CA",
      recipientPhone: "98765 43210",
      goal: { type: "schedule_meeting", date: "2026-10-21", preferred: "15:00" },
      authority: { mayShareOwnerPhone: false },
    })
  })

  it("never uses a number the person didn't type", async () => {
    const result = await extractSpec({
      text: "Call my CA and ask whether 3 PM tomorrow works",
      now: NOON,
      timezone: "Asia/Kolkata",
      model: model(FULL),
    })
    expect(result.draft.recipientPhone).toBeUndefined()
    expect(result.missing).toContain("phone")
  })

  it("lists what the UI must ask", async () => {
    const result = await extractSpec({
      text: "Call someone on 98765 43210",
      now: NOON,
      timezone: "Asia/Kolkata",
      model: model({
        ...FULL,
        recipientLabel: null,
        date: null,
        preferred: "3pm",
        acceptable: [],
      }),
    })
    expect(result.missing).toEqual([
      "recipient",
      "date",
      "preferred_time",
      "acceptable_window",
    ])
  })

  it("'tomorrow' near midnight in the person's timezone is ambiguous", async () => {
    const result = await extractSpec({
      text: TEXT,
      now: new Date("2026-10-20T23:40:00+05:30"),
      timezone: "Asia/Kolkata",
      model: model(FULL),
    })
    expect(result.missing).toContain("ambiguous_date")
  })

  it("a model that returns nothing usable: everything is asked", async () => {
    const broken = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "sorry" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    })
    const result = await extractSpec({
      text: TEXT,
      now: NOON,
      timezone: "Asia/Kolkata",
      model: broken,
    })
    expect(result.missing).toEqual(["phone", "recipient", "goal"])
  })
})
