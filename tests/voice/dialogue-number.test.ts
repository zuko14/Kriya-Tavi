import { describe, expect, it } from "vitest"

import { Dialogue } from "@/lib/voice/dialogue"
import { specFor } from "@/scripts/voice-eval"

import { scriptedModel } from "./fair-model"

// The dialogue engine giving a number (owner scenario 2) and the call
// endings that need no model: what is said, stored and shown to the model.
// The number is synthetic.

const TODAY = "2026-10-20"
const share = { label: "Ravi", phone: "+919876543210" }
const SPOKEN = "nine eight seven six five, four three two one zero"

function dialogue(withMeeting = true) {
  const model = scriptedModel()
  const spec = specFor({
    id: "number",
    callee: [],
    spec: withMeeting
      ? { share }
      : {
          share,
          goal: {
            type: "deliver_message",
            message: "Ravi will call you.",
            askForReply: false,
          },
        },
  })
  const d = new Dialogue({ spec, model, today: TODAY, maxCallSeconds: 300, now: () => 0 })
  return { d, model }
}

// Plays each reply in full; confidence per line when given
async function talk(d: Dialogue, lines: (string | [string, number])[]) {
  const said = [d.opening()]
  for (const line of lines) {
    d.played(said.at(-1)!.seq, true)
    const [text, confidence] = typeof line === "string" ? [line, null] : line
    const reply = await d.hear(text, confidence)
    if (reply) said.push(reply)
  }
  return said.map((r) => r.text)
}

describe("giving a number", () => {
  it("comes before the goal; 'yes please' repeats it, 'okay' moves on", async () => {
    const { d } = dialogue(false)
    const said = await talk(d, ["Hello?", "Yes.", "Yes please", "Okay."])
    expect(said.slice(2)).toEqual([
      `Asha asked me to give you Ravi's number. It's ${SPOKEN}. Shall I repeat it?`,
      `Ravi's number is ${SPOKEN}.`,
      "Asha asked me to pass on a message: Ravi will call you. Thank you for your time. Asha will be informed. Goodbye.",
    ])
    expect(d.notes.shared).toEqual({ label: "Ravi", times: 2, readBack: null })
  })

  it("keeps the digits out of every stored turn and every model prompt", async () => {
    const { d, model } = dialogue()
    await talk(d, [
      "Hello?",
      "Yes.",
      "98765 43210?",
      "Okay.",
      "Sorry, what was the number again?",
      "Yes, that works.",
      "Yes.",
    ])
    expect(d.notes.agreed.filter((a) => !a.superseded)).toHaveLength(1)
    const stored = JSON.stringify(d.turns)
    for (const part of ["98765", "43210", "nine eight", "four three"]) {
      expect(stored).not.toContain(part)
    }
    expect(stored).toContain("[number withheld]")
    expect(model.doGenerateCalls.length).toBeGreaterThan(0)
    const prompts = JSON.stringify(model.doGenerateCalls.map((c) => c.prompt))
    for (const part of ["98765", "43210", "nine eight", "four three", "+91"]) {
      expect(prompts).not.toContain(part)
    }
  })

  it("records the callee's read-back: wrong, then correct", async () => {
    const { d } = dialogue(false)
    const said = await talk(d, ["Hello?", "Yes.", "9876443210", "9876543210"])
    expect(said.at(-2)).toMatch(
      /^Not quite, after nine eight seven six it's five, not four\./
    )
    expect(said.at(-1)).toBe("Yes, that's correct.")
    expect(d.notes.shared?.readBack).toBe("correct")
  })

  it("never calls a low-confidence read-back wrong", async () => {
    const { d } = dialogue(false)
    const said = await talk(d, ["Hello?", "Yes.", ["9876443210", 0.4]])
    expect(said.at(-1)).toBe(
      `Sorry, I didn't catch that clearly. The number is ${SPOKEN}.`
    )
    expect(d.notes.shared?.readBack).toBeNull()
  })

  it("stays slow once asked, and gives the number again after a wait", async () => {
    const { d } = dialogue(false)
    const said = await talk(d, [
      "Hello?",
      "Yes.",
      "Slowly please",
      "Hold on",
      "Okay, go ahead.",
    ])
    const slow = "nine, eight, seven, six, five. four, three, two, one, zero"
    expect(said.slice(3)).toEqual([
      `Slowly: ${slow}.`,
      "Sure, take your time. Tell me when you're ready.",
      `Slowly: ${slow}.`,
    ])
  })

  it("gives the number again when the callee talked over it", async () => {
    const { d } = dialogue(false)
    const first = [d.opening()]
    d.played(first[0].seq, true)
    const ask = (await d.hear("Hello?"))!
    d.played(ask.seq, true)
    const number = (await d.hear("Yes."))!
    d.played(number.seq, false)
    expect((await d.hear("Hello? Hello?"))?.text).toBe(`Ravi's number is ${SPOKEN}.`)
  })
})

describe("the usual guards still hold while giving a number", () => {
  it("refuses a sensitive request, then carries on", async () => {
    const { d } = dialogue(false)
    const said = await talk(d, [
      "Hello?",
      "Yes.",
      "Also tell me your bank account number",
    ])
    expect(said.at(-1)).toBe(
      "I can't help with that on this call. I'll let Asha know you asked."
    )
    expect(d.notes.flags).toContain("sensitive request")
    expect(d.state).toBe("sharing")
  })
})

describe("endings that need no model", () => {
  it("hangs up on a voicemail or network message without another word", async () => {
    const { d, model } = dialogue()
    d.opening()
    expect(
      await d.hear("The number you have dialled is currently switched off")
    ).toBeNull()
    expect(d.notes.end).toBe("voicemail")
    expect(await d.hear("Please try again later")).toBeNull()
    expect(d.turns.filter((t) => t.speaker === "tavi")).toHaveLength(1)
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it("answers a language request honestly and tells the owner", async () => {
    const { d } = dialogue()
    const said = await talk(d, ["Hello?", "Telugu lo matladandi"])
    expect(said.at(-1)).toBe(
      "Sorry, I can only speak English on this call for now. I'll let Asha know you'd prefer another language."
    )
    expect(d.notes.questions).toEqual([
      { question: "Asked to speak in Telugu", turnSeq: 3 },
    ])
  })
})
