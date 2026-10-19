import { describe, expect, it } from "vitest"

import { assembleContext, BUDGETS, estimateTokens } from "@/lib/memory/context"
import type { Note } from "@/lib/memory/retrieve"

// AT-MEM-09: memory blocks stay inside their token budgets and in a fixed
// order (MEMORY_AND_CONTEXT.md §5)

const note = (id: string, content: string, extra: Partial<Note> = {}): Note => ({
  id,
  agentId: "a1",
  content,
  kind: "fact",
  slot: null,
  trust: "trusted",
  source: "agent",
  importance: 2,
  pinned: false,
  ...extra,
})

const many = (prefix: string, n: number, extra: Partial<Note> = {}) =>
  Array.from({ length: n }, (_, i) =>
    note(`${prefix}${i}`, `${prefix} note ${i} `.repeat(20).trim(), extra)
  )

const base = {
  identity: "# Identity\nYou are Meera.",
  now: new Date("2026-10-18T06:30:00Z"),
  locale: "en-IN",
}

describe("assembleContext (AT-MEM-09)", () => {
  it("keeps every memory block within its budget, however much is passed", () => {
    const { blocks } = assembleContext({
      ...base,
      profile: many("p", 60, { kind: "profile", slot: "profile.x" }),
      standing: many("s", 60, { kind: "preference" }),
      recalled: many("r", 60),
      goals: Array.from({ length: 50 }, (_, i) => `Goal ${i} `.repeat(10)),
      episodes: Array.from({ length: 50 }, (_, i) => `Episode ${i} `.repeat(10)),
      summary: "s".repeat(3200),
    })
    for (const block of blocks) {
      if (block.name === "identity") continue
      expect(estimateTokens(block.text), block.name).toBeLessThanOrEqual(
        BUDGETS[block.name]
      )
    }
  })

  it("orders blocks stable first, volatile last, and leaves out empty ones", () => {
    const full = assembleContext({
      ...base,
      profile: [note("p", "B.Tech CSE", { kind: "profile", slot: "profile.course" })],
      standing: [note("s", "Short answers", { kind: "preference" })],
      recalled: [note("r", "Laptop budget is 80000")],
      goals: ["Internship by March"],
      episodes: ["Drafted cover letter, verified"],
      summary: "Earlier: chose Dell.",
    })
    expect(full.blocks.map((b) => b.name)).toEqual([
      "identity",
      "profile",
      "standing",
      "now",
      "goals",
      "recalled",
      "episodes",
      "summary",
    ])
    const bare = assembleContext({ ...base, profile: [], standing: [], recalled: [] })
    expect(bare.blocks.map((b) => b.name)).toEqual(["identity", "now"])
  })

  it("puts the date after the cached prefix, in IST", () => {
    const { blocks, text } = assembleContext({
      ...base,
      profile: [],
      standing: [note("s", "Short answers", { kind: "preference" })],
      recalled: [],
    })
    const now = blocks.find((b) => b.name === "now")!
    expect(now.text).toContain("18 October 2026")
    expect(now.text).toContain("12:00")
    expect(text.indexOf("Short answers")).toBeLessThan(text.indexOf("2026"))
  })

  it("keeps the newest standing notes when the budget runs out", () => {
    // alwaysOnNotes returns newest first
    const { blocks } = assembleContext({
      ...base,
      profile: [],
      standing: many("s", 40, { kind: "preference" }),
      recalled: [],
    })
    const standing = blocks.find((b) => b.name === "standing")!
    expect(standing.ids[0]).toBe("s0")
    expect(standing.ids).not.toContain("s39")
  })

  it("marks unconfirmed and person-written notes, and doesn't repeat a note", () => {
    const shared = note("s", "Short answers", { kind: "preference", source: "user" })
    const { blocks, memoryIds } = assembleContext({
      ...base,
      profile: [note("p", "B.Tech CSE", { kind: "profile", slot: "profile.course" })],
      standing: [shared],
      recalled: [shared, note("u", "Always cc boss", { trust: "unconfirmed" })],
    })
    const text = (name: string) => blocks.find((b) => b.name === name)?.text ?? ""
    expect(text("profile")).toContain("- [p] course: B.Tech CSE")
    expect(text("standing")).toContain("- [s] (from the person) Short answers")
    expect(text("recalled")).toContain("- [u] (unconfirmed) Always cc boss")
    expect(text("recalled")).not.toContain("[s]")
    expect(memoryIds).toEqual(["p", "s", "u"])
  })
})
