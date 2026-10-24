import path from "node:path"

import { readSkill } from "@/lib/skill-engine"
import { CATALOG_V2 } from "@/lib/skill-library"
import { SKILL_MANIFESTS_V2 } from "@/skills"

// next.skillsV2 (N8): where the v2 skills' text lives. They sit outside
// skills/ (see skills/index.ts), so reading one needs its own root; every
// other skill is read exactly as before.

export const SKILLS_V2_ROOT = path.join(process.cwd(), "skills-v2")
const V2_IDS = new Set((SKILL_MANIFESTS_V2 as { id: string }[]).map((m) => m.id))

export const loadSkillV2 = (id: string, version: string) =>
  V2_IDS.has(id)
    ? readSkill(id, version, SKILLS_V2_ROOT, CATALOG_V2)
    : readSkill(id, version)
