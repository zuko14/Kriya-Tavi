import path from "node:path"

import { readSkill } from "@/lib/skill-engine"
import { buildCatalog } from "@/lib/skill-library"
import { HARNESS_SKILL_MANIFESTS } from "@/skills-harness"

// Kriya default skills (WORKSPACE_PANEL_SKILLS_PLUGINS.md §4): the curated
// kriya-* coding skills every device's agent gets with harness.defaultSkills
// on, validated like the library (lib/skill-library.ts) and read by the same
// loader (lib/skill-engine.ts readSkill), from skills-harness/.

export const HARNESS_SKILLS_ROOT = path.join(process.cwd(), "skills-harness")
export const HARNESS_DEFAULTS = buildCatalog(HARNESS_SKILL_MANIFESTS)

export const loadDefaultSkill = (id: string, version: string) =>
  readSkill(id, version, HARNESS_SKILLS_ROOT, HARNESS_DEFAULTS)
