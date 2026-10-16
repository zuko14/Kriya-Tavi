import { describe, expect, it } from "vitest"

import { previewOf } from "@/lib/agent/messages"
import type { KriyaMessage } from "@/lib/agent/tools"
import { suggestionsFor } from "@/lib/templates"

const reply = (text: string) => ({ parts: [{ type: "text", text }] }) as KriyaMessage

describe("thread previews", () => {
  it("read as plain text, not Markdown", () => {
    const text = [
      "## Compound Interest",
      "**Simple interest** pays only on the *principal*.",
      "---",
      "### 1. Launch",
      "> Your app, for `₹499`",
      "- [Docs](https://example.com) and more",
      "| Year | Amount |",
      "```js\nconsole.log(1)\n```",
    ].join("\n")
    expect(previewOf(reply(text))).toBe(
      "Compound Interest Simple interest pays only on the principal. 1. Launch Your app, for ₹499 Docs and more Year Amount"
    )
  })

  it("leaves snake_case and arithmetic alone", () => {
    expect(previewOf(reply("Set max_tokens to 2*3 = 6"))).toBe(
      "Set max_tokens to 2*3 = 6"
    )
  })
})

describe("empty-thread suggestions", () => {
  it("fit the agent's role", () => {
    expect(suggestionsFor({ role: "Proposals, emails and client work" })[0]).toMatch(
      /invoice/
    )
    // A custom agent is matched by the words in its role and orders
    expect(
      suggestionsFor({ role: "My coding buddy", instructions: "Help me debug code" })[0]
    ).toMatch(/security/)
    expect(suggestionsFor({ role: "Cricket fan" })).toContain(
      "Plan my week: three priorities a day, with time for breaks."
    )
  })
})
