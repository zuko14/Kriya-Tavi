import { describe, expect, it } from "vitest"

import { USE_CASES } from "@/db/schema"
import { SLOT_PATTERN } from "@/lib/memory/write"
import {
  agentTemplates,
  packFor,
  ROLE_PACKS,
  suggestionsFor,
  templatesFor,
} from "@/lib/templates"

// Role packs (A2, AD-14) are data. With them, everything that existed
// before must answer exactly as it did (recorded from the code before A2).

const BEFORE = {
  student: ["Vidya", "Arjun", "Meera", "Kabir", "Tara"],
  developer: ["Arjun", "Vidya", "Meera", "Kabir", "Tara"],
  founder: ["Arjun", "Meera", "Vidya", "Kabir", "Tara"],
  freelancer: ["Meera", "Kabir", "Vidya", "Arjun", "Tara"],
  creator: ["Tara", "Vidya", "Arjun", "Meera", "Kabir"],
  business: ["Meera", "Kabir", "Tara", "Vidya", "Arjun"],
  other: ["Meera", "Vidya", "Arjun", "Kabir", "Tara"],
  null: ["Vidya", "Arjun", "Meera", "Kabir", "Tara"],
}

describe("existing templates are unchanged", () => {
  it("templatesFor offers the same agents in the same order for every use case", () => {
    for (const [useCase, names] of Object.entries(BEFORE)) {
      const value = useCase === "null" ? null : useCase
      expect(
        templatesFor(value).map((t) => t.name),
        useCase
      ).toEqual(names)
    }
  })

  it("suggestionsFor gives each existing role its own suggestions", () => {
    for (const template of agentTemplates) {
      expect(suggestionsFor({ role: template.role })).toBe(template.suggestions)
    }
  })

  it("suggestionsFor custom agents is unchanged (keywords match existing templates only)", () => {
    const first = (role: string) => suggestionsFor({ role })[0]
    for (const role of [
      "Accountant",
      "GST and bills helper",
      "Career coach",
      "GitHub release helper",
      "Hiring",
      "Customer support",
    ]) {
      expect(first(role), role).toBe(
        "Plan my week: three priorities a day, with time for breaks."
      )
    }
    expect(first("Trend research")).toBe(
      "Compare the top 3 UPI apps on fees, safety and features."
    )
  })
})

describe("role packs", () => {
  it("covers every use case", () => {
    expect(Object.keys(ROLE_PACKS).sort()).toEqual([...USE_CASES].sort())
  })

  it.each([...USE_CASES])("the %s pack is complete and honest", (useCase) => {
    const pack = packFor(useCase)
    expect(pack.teamName.length).toBeGreaterThan(0)
    expect(pack.members.length).toBeGreaterThanOrEqual(2)
    expect(new Set(pack.members.map((m) => m.name)).size).toBe(pack.members.length)
    for (const member of pack.members) {
      expect(member.role.length, member.name).toBeGreaterThan(0)
      expect(member.instructions.length, member.name).toBeGreaterThan(40)
      expect(member.canDo, member.name).toHaveLength(3)
      expect(member.suggestions.length, member.name).toBeGreaterThanOrEqual(3)
    }
    expect(pack.slots.length).toBeGreaterThanOrEqual(3)
    expect(pack.slots.length).toBeLessThanOrEqual(5)
    for (const slot of pack.slots) {
      expect(slot.slot).toMatch(SLOT_PATTERN)
      expect(slot.slot.startsWith("profile.")).toBe(true)
    }
  })

  it("pack agents never promise to pay, file, send or post", () => {
    for (const pack of Object.values(ROLE_PACKS)) {
      for (const member of pack.members) {
        const promises = [...member.canDo, ...member.suggestions].join(" ")
        expect(promises, member.name).not.toMatch(
          /\b(I will|I'll) (pay|file|send|post|publish|submit)\b/i
        )
      }
    }
  })

  it("Lekha organises and drafts; she never computes final totals, pays or files", () => {
    const lekha = packFor("founder").members.find((m) => m.name === "Lekha")!
    expect(lekha.instructions).toMatch(/never pay/i)
    expect(lekha.instructions).toMatch(/file/i)
    expect(lekha.instructions).toMatch(/CA/)
  })

  it("pack roles get their own suggestions by exact role", () => {
    const disha = packFor("student").members.find((m) => m.name === "Disha")!
    expect(suggestionsFor({ role: disha.role })).toBe(disha.suggestions)
  })

  it("an unknown use case gets the general pack", () => {
    expect(packFor(undefined)).toBe(ROLE_PACKS.other)
  })
})
