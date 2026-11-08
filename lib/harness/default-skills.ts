import path from "node:path"

import { getSetting } from "@/lib/config"
import { readSkill } from "@/lib/skill-engine"
import { buildCatalog } from "@/lib/skill-library"
import { HARNESS_EDIT_SKILL_MANIFESTS, HARNESS_SKILL_MANIFESTS } from "@/skills-harness"

// Kriya default skills (WORKSPACE_PANEL_SKILLS_PLUGINS.md §4): the curated
// kriya-* coding skills every device's agent gets with harness.defaultSkills
// on, validated like the library (lib/skill-library.ts) and read by the same
// loader (lib/skill-engine.ts readSkill), from skills-harness/.

export const HARNESS_SKILLS_ROOT = path.join(process.cwd(), "skills-harness")
export const HARNESS_DEFAULTS = buildCatalog(HARNESS_SKILL_MANIFESTS)
// The Editing Studio's kriya-edit-* skills (track E, ED13), joined to the set
// only with editing.skills on; built together so an id can't be listed twice
export const HARNESS_EDIT_DEFAULTS = buildCatalog([
  ...HARNESS_SKILL_MANIFESTS,
  ...HARNESS_EDIT_SKILL_MANIFESTS,
]).slice(HARNESS_DEFAULTS.length)
const ALL = [...HARNESS_DEFAULTS, ...HARNESS_EDIT_DEFAULTS]

/** The default set for this request: off, exactly HARNESS_DEFAULTS (ET-SK-02). */
export async function defaultSkillSet() {
  return (await getSetting("editing.skills")) === "on" ? ALL : HARNESS_DEFAULTS
}

export const loadDefaultSkill = (id: string, version: string) =>
  readSkill(id, version, HARNESS_SKILLS_ROOT, ALL)
