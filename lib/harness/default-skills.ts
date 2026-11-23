import path from "node:path"

import { getSetting } from "@/lib/config"
import { buildCartridges, cartridgeBlock } from "@/lib/harness/cartridges"
import { readSkill } from "@/lib/skill-engine"
import { buildCatalog } from "@/lib/skill-library"
import {
  HARNESS_EDIT_SKILL_MANIFESTS,
  HARNESS_ROLE_CARTRIDGES,
  HARNESS_ROLE_SKILL_MANIFESTS,
  HARNESS_SKILL_MANIFESTS,
} from "@/skills-harness"

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
// Harness 2.0 role cartridges (upgrade_2.0/CARTRIDGES.md, W1), joined only
// with harness.workforce on; built with every other set so no id repeats
export const HARNESS_ROLE_DEFAULTS = buildCatalog([
  ...HARNESS_SKILL_MANIFESTS,
  ...HARNESS_EDIT_SKILL_MANIFESTS,
  ...HARNESS_ROLE_SKILL_MANIFESTS,
]).slice(HARNESS_DEFAULTS.length + HARNESS_EDIT_DEFAULTS.length)
export const HARNESS_CARTRIDGES = buildCartridges(
  HARNESS_ROLE_DEFAULTS,
  HARNESS_ROLE_CARTRIDGES
)
const ALL = [...HARNESS_DEFAULTS, ...HARNESS_EDIT_DEFAULTS, ...HARNESS_ROLE_DEFAULTS]

/** The default set for this request: with both switches off, exactly HARNESS_DEFAULTS (ET-SK-02, WT-SK-02). */
export async function defaultSkillSet() {
  const [editing, workforce] = await Promise.all([
    getSetting("editing.skills"),
    getSetting("harness.workforce"),
  ])
  // Both off: the very same object as before either switch existed (ET-SK-02)
  if (editing !== "on" && workforce !== "on") return HARNESS_DEFAULTS
  return [
    ...HARNESS_DEFAULTS,
    ...(editing === "on" ? HARNESS_EDIT_DEFAULTS : []),
    ...(workforce === "on" ? HARNESS_ROLE_DEFAULTS : []),
  ]
}

/** A cartridge's served block, or undefined for any other skill. */
export function cartridgeFor(id: string) {
  const c = HARNESS_CARTRIDGES.get(id)
  return c ? cartridgeBlock(c) : undefined
}

export const loadDefaultSkill = (id: string, version: string) =>
  readSkill(id, version, HARNESS_SKILLS_ROOT, ALL)
