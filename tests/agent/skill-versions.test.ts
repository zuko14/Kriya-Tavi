import { describe, expect, it } from "vitest"

import { readSkill } from "@/lib/skill-engine"
import { CATALOG } from "@/lib/skill-library"

// A skill's wording changes only as a new version; every older version it
// lists stays readable, so an agent can be pinned back to it (SKILLS_ENGINE §4)
describe("skill versions", () => {
  it("every listed older version is kept and loads", () => {
    for (const skill of CATALOG)
      for (const version of skill.previous) {
        const old = readSkill(skill.id, version)
        expect(old.length, `${skill.id}@${version}`).toBeGreaterThan(200)
        expect(old, `${skill.id}@${version}`).not.toBe(readSkill(skill.id, skill.version))
      }
  })

  it("the 2026-10-26 revisions are 1.1.0 and keep 1.0.0", () => {
    for (const id of [
      "research-verification",
      "structured-data",
      "security-untrusted-content",
      "debugging-recovery",
    ]) {
      const skill = CATALOG.find((s) => s.id === id)!
      expect(skill.version, id).toBe("1.1.0")
      expect(skill.previous, id).toContain("1.0.0")
    }
  })
})
