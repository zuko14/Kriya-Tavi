import { describe, expect, it } from "vitest"

import {
  checkCitations,
  sourceTexts,
  unconfirmedClaims,
  verificationOf,
} from "@/lib/agent/verify"

// The verifier never trusts the reply's prose (AD-02, AD-33): a claimed
// action needs a matching run (AT-VER-02), and a cited quote must appear
// word for word in the cited tool output (AT-XCK-01).

describe("a tool's own verification", () => {
  it("reads a well-formed verification object and nothing else", () => {
    const verification = {
      status: "verified",
      method: "api_readback",
      evidence: [{ kind: "provider_id", value: "s1" }],
    }
    expect(verificationOf({ scheduleId: "s1", verification })).toEqual(verification)
    expect(verificationOf({ verification: { status: "done" } })).toBeNull()
    expect(verificationOf("text")).toBeNull()
    expect(verificationOf(null)).toBeNull()
  })
})

const ran = (tool: string) => ({ tool, status: "succeeded" as const })

describe("claims without a matching run (AT-VER-02)", () => {
  it("flags an action the reply claims but no tool did", () => {
    const claims = unconfirmedClaims(
      "Sure! I've added the dentist visit to your calendar for Monday. Anything else?",
      []
    )
    expect(claims).toEqual([
      {
        claim: "I've added the dentist visit to your calendar for Monday.",
        reason: "No matching action ran.",
      },
    ])
  })

  it("accepts a claim backed by a successful run", () => {
    expect(
      unconfirmedClaims("I added it to your calendar.", [ran("calendar_create_event")])
    ).toEqual([])
    expect(
      unconfirmedClaims("I've set up a weekly schedule for Mondays.", [
        ran("schedule_create"),
      ])
    ).toEqual([])
  })

  it("a failed run doesn't back a claim", () => {
    expect(
      unconfirmedClaims("I have drafted the email to Ravi.", [
        { tool: "gmail_draft", status: "failed" },
      ])
    ).toHaveLength(1)
  })

  it("says plainly that Kriya can't send mail or post", () => {
    expect(
      unconfirmedClaims("I emailed Ravi the invoice.", [ran("gmail_draft")])
    ).toEqual([
      {
        claim: "I emailed Ravi the invoice.",
        reason: "Kriya can't send email or post; at most a draft was saved.",
      },
    ])
    expect(unconfirmedClaims("I've posted it on LinkedIn.", [])[0].reason).toMatch(
      /can't send email or post/
    )
  })

  it("ignores plans, offers and denials", () => {
    expect(
      unconfirmedClaims(
        "I'll add it to your calendar once you approve. I haven't sent anything. Should I draft the email?",
        []
      )
    ).toEqual([])
  })
})

const page = "GATE 2027 registration closes on 7 October 2026. Fee: ₹1,800."

describe("citation check (K7, AT-XCK-01)", () => {
  it("supports a quote found word for word in the cited source", () => {
    expect(
      checkCitations('Registration "closes on 7 October 2026" [1].', [page])
    ).toEqual([
      {
        sentence: 'Registration "closes on 7 October 2026" [1].',
        status: "supported",
      },
    ])
  })

  it("marks a fabricated quote unsupported", () => {
    const [check] = checkCitations("The fee is “₹1,500 for all candidates” [1].", [page])
    expect(check).toMatchObject({
      status: "unsupported",
      reason: "Quote not found in source 1.",
    })
  })

  it("marks a citation with no quote, or to a source that doesn't exist", () => {
    expect(checkCitations("It closes on 7 October [1].", [page])[0].reason).toBe(
      "No quote for source 1."
    )
    expect(checkCitations('It "closes on 7 October 2026" [2].', [page])[0].reason).toBe(
      "Source 2 doesn't exist."
    )
  })

  it("flags an uncited ₹ amount or deadline when the reply drew on sources", () => {
    const checks = checkCitations(
      "The fee is ₹1,800. The last date is 7 October. Good luck!",
      [page]
    )
    expect(checks.map((c) => c.status)).toEqual(["unsupported", "unsupported"])
    expect(checks[0].reason).toBe("No citation for a money or deadline claim.")
  })

  it("doesn't flag the person's own numbers when nothing was read", () => {
    expect(checkCitations("Your budget is ₹80,000.", [])).toEqual([])
  })

  it("matches across spacing, case and curly quotes, in any script", () => {
    expect(
      checkCitations("अंतिम तिथि “7  अक्टूबर” है [1].", [
        "आवेदन की अंतिम तिथि 7 अक्टूबर है",
      ])[0].status
    ).toBe("supported")
  })
})

describe("sources from tool outputs", () => {
  it("collects the text of reading tools in call order", () => {
    expect(
      sourceTexts([
        { type: "tool-web_search", output: { results: [{ title: "x" }] } },
        { type: "tool-web_fetch", output: { title: "GATE", markdown: page } },
        { type: "text", text: "hi" },
        { type: "tool-drive_read", output: { name: "notes", text: "Rent ₹14,000" } },
      ])
    ).toEqual([`GATE\n${page}`, "notes\nRent ₹14,000"])
  })
})
