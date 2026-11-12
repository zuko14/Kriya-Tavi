import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock("@/actions/editing", () => ({
  answerEditQuestion: async () => ({ ok: true }),
  dismissFound: async () => ({ ok: true }),
  startFromFound: async () => ({ ok: true }),
}))

import { EditCardView } from "@/components/editing/edit-card"
import type { EditCard } from "@/queries/editing-types"

// TP11: the order card is a decision card like the file and take cards: its prompt, each
// order as a button of at least 44 px (min-h-11), the default marked, and what silence does
describe("TP11: the order card", () => {
  it("renders each order as a tappable answer with the default marked", () => {
    const card = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "order",
      prompt: "Which order did you mean?",
      options: [
        { label: "Clip 2 (Intro), then clip 1" },
        { label: "Clip 1, then clip 2 (Intro)" },
      ],
      defaultOption: 0,
      deviceName: "laptop",
    } as unknown as EditCard
    const html = renderToStaticMarkup(createElement(EditCardView, { card }))
    expect(html).toContain("Which order did you mean?")
    expect(html).toContain("Editing · laptop")
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html.match(/min-h-11/g)).toHaveLength(2)
    expect(html).toContain("Clip 2 (Intro), then clip 1")
    expect(html).toContain("(default)")
    expect(html).toContain("your computer goes on with the default")
    expect(html).not.toContain("<video")
    // A label is the person's own text: shown as text, never as markup
    const tricky = renderToStaticMarkup(
      createElement(EditCardView, {
        card: { ...card, options: [{ label: "<b>x</b>" }, { label: "y" }] } as EditCard,
      })
    )
    expect(tricky).toContain("&lt;b&gt;x&lt;/b&gt;")
  })
})
