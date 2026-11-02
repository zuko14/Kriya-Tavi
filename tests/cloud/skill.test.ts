import { describe, expect, it } from "vitest"

import { buildCatalog, CATALOG, CATALOG_V2, resolveSkills } from "@/lib/skill-library"
import { CLOUD_CODING, CLOUD_CODING_TEXT, withCloudCoding } from "@/lib/cloud/skill"

// The `cloud-coding` skill (CD-20, TEST_STRATEGY CT-SKL-*): injected per
// task like Skill Studio's skills, never a directory in skills-v2/, so the
// curated catalogues and their suites are untouched. That runTask injects it
// only with a workspace and the skill library on is in agent.test.ts.

const BELT = [
  "memory_write",
  "workspace_open",
  "workspace_run",
  "workspace_read",
  "workspace_edit",
  "workspace_changes",
]
const load = (id: string) => `text of ${id}`

describe("CT-SKL-02: the cloud-coding catalogue", () => {
  it("is a valid curated skill that says what the workspace changes", () => {
    expect(buildCatalog([CLOUD_CODING])).toHaveLength(1)
    expect(CLOUD_CODING.id).toBe("cloud-coding")
    expect(CLOUD_CODING_TEXT.length).toBeLessThanOrEqual(CLOUD_CODING.limits.maxChars)
    expect(CLOUD_CODING_TEXT).toContain("workspace_run")
    expect(CLOUD_CODING_TEXT).not.toMatch(/can't run code/)
  })

  it("replaces code-assistance; every other skill and both catalogues are as they were", () => {
    const v2 = withCloudCoding({ catalog: CATALOG_V2, load })
    expect(v2.catalog[0].id).toBe("cloud-coding")
    expect(v2.catalog.map((s) => s.id)).not.toContain("code-assistance")
    expect(v2.catalog.slice(1)).toEqual(
      CATALOG_V2.filter((s) => s.id !== "code-assistance")
    )
    // Not mutated: the curated catalogues still hold what they held
    expect(CATALOG_V2.map((s) => s.id)).toContain("code-assistance")
    expect(v2.load("cloud-coding", CLOUD_CODING.version)).toBe(CLOUD_CODING_TEXT)
    expect(v2.load("research-brief", "1.0.0")).toBe("text of research-brief")
    // Without next.skillsV2 the base is CATALOG
    expect(withCloudCoding({ load }).catalog.slice(1)).toEqual(CATALOG)
  })

  it("an agent that pinned code-assistance gets cloud-coding on a workspace turn", () => {
    const ask = "The tests in my repo fail; fix the bug and run them"
    const prefs = { on: ["code-assistance"], auto: true }
    const inWorkspace = resolveSkills({
      prefs,
      role: "engineer",
      ask,
      tools: BELT,
      unicode: true,
      ...withCloudCoding({ catalog: CATALOG_V2, load }),
    })
    const ids = inWorkspace.active.map((a) => a.id)
    expect(ids).toContain("cloud-coding")
    expect(ids).not.toContain("code-assistance")

    // The same turn without a workspace is today's
    const today = resolveSkills({
      prefs,
      role: "engineer",
      ask,
      tools: ["memory_write"],
      catalog: CATALOG_V2,
      unicode: true,
      load,
    })
    expect(today.active.map((a) => a.id)).toContain("code-assistance")
    expect(today.active.map((a) => a.id)).not.toContain("cloud-coding")
  })
})
