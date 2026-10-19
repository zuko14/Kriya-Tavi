import { describe, expect, it } from "vitest"

import {
  coveredCount,
  KEEP_PERSON_TURNS,
  missingFacts,
  personFacts,
  renderSummary,
  SUMMARY_MAX_CHARS,
  type SummaryMessage,
} from "@/lib/memory/summaries"

// Thread summary checkpoints (MEMORY_AND_CONTEXT.md §7): where the cut falls
// and the deterministic check a summary must pass

const text = (role: "user" | "assistant", value: string): SummaryMessage => ({
  role,
  parts: [{ type: "text", text: value }],
})
const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => [
    text("user", `question ${i}`),
    text("assistant", `answer ${i}`),
  ]).flat()

describe("coveredCount (AT-MEM-13)", () => {
  it("covers nothing until there are more person turns than are kept", () => {
    expect(coveredCount(turns(KEEP_PERSON_TURNS))).toBe(0)
  })

  it("keeps the last 6 person turns and cuts just before a person message", () => {
    const messages = turns(10)
    const cut = coveredCount(messages)
    expect(cut).toBe(8)
    expect(messages[cut].role).toBe("user")
    expect(messages.slice(cut).filter((m) => m.role === "user")).toHaveLength(
      KEEP_PERSON_TURNS
    )
  })

  it("never covers a reply with an approval part, or anything after it", () => {
    const messages = turns(10)
    messages[3] = {
      role: "assistant",
      parts: [{ type: "tool-calendar_create_event", state: "approval-responded" }],
    }
    // The cut moves back to the person message before the approval
    expect(coveredCount(messages)).toBe(2)
    messages[1] = {
      role: "assistant",
      parts: [{ type: "tool-gmail_draft", state: "approval-requested" }],
    }
    expect(coveredCount(messages)).toBe(0)
  })

  it("keeps a tool call and its result together (they live in one reply)", () => {
    const messages = turns(10)
    messages[5] = {
      role: "assistant",
      parts: [
        { type: "tool-web_search", state: "output-available" },
        { type: "text", text: "found it" },
      ],
    }
    const cut = coveredCount(messages)
    expect(messages[cut].role).toBe("user")
  })
})

describe("personFacts and missingFacts (AT-MEM-10)", () => {
  const covered = [
    text(
      "user",
      "Ravi owes ₹45,000, invoice sent on 2026-09-28; Neha owes Rs. 30,000 since 30/08/2026. Details at https://example.com/inv/42."
    ),
    // The agent's own numbers aren't the person's facts
    text("assistant", "So ₹75,000 in total, due by 13 October 2026."),
    text("user", "The wedding is on 6 December 2026, budget ₹1.5 lakh."),
  ]

  it("finds amounts, dates and URLs in what the person wrote", () => {
    expect(personFacts(covered)).toEqual([
      "₹45,000",
      "Rs. 30,000",
      "₹1.5 lakh",
      "2026-09-28",
      "30/08/2026",
      "6 December 2026",
      "https://example.com/inv/42",
    ])
  })

  const summary = {
    facts: ["Ravi owes ₹45,000 (invoice 2026-09-28)", "Wedding on 6 December 2026"],
    decisions: [],
    open_questions: [],
    pending_actions: ["Chase Neha"],
    numbers: ["Rs. 30,000", "30/08/2026", "https://example.com/inv/42", "₹1.5 lakh"],
  }

  it("passes a summary that keeps every one of them", () => {
    expect(missingFacts(covered, summary)).toEqual([])
  })

  it("rejects a summary that drops an amount, a date or a URL", () => {
    expect(
      missingFacts(covered, { ...summary, numbers: ["Rs. 30,000", "₹1.5 lakh"] })
    ).toEqual(["30/08/2026", "https://example.com/inv/42"])
    expect(
      missingFacts(covered, {
        ...summary,
        facts: ["Ravi owes money", "Wedding on 6 December 2026"],
      })
    ).toEqual(["₹45,000", "2026-09-28"])
  })

  it("ignores spacing differences inside an amount", () => {
    expect(
      missingFacts([text("user", "Budget ₹ 4,000")], {
        ...summary,
        numbers: ["₹4,000"],
      })
    ).toEqual([])
  })
})

describe("renderSummary", () => {
  it("writes only the non-empty sections", () => {
    expect(
      renderSummary({
        facts: ["Budget ₹6 lakh"],
        decisions: [],
        open_questions: ["Which tile?"],
        pending_actions: [],
        numbers: ["₹6 lakh"],
      })
    ).toBe(
      "Facts:\n- Budget ₹6 lakh\nOpen questions:\n- Which tile?\nNumbers, dates and links:\n- ₹6 lakh"
    )
    expect(SUMMARY_MAX_CHARS).toBe(3200)
  })
})
