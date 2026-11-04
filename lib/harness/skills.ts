import { createHash } from "node:crypto"

import { eq } from "drizzle-orm"

import { withUser } from "@/db"
import { agents } from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { HARNESS_DEFAULTS, loadDefaultSkill } from "@/lib/harness/default-skills"
import { readSkill } from "@/lib/skill-engine"
import {
  CATALOG,
  CATALOG_V2,
  parsePins,
  parseSkillList,
  recommendedFor,
  type SkillManifest,
} from "@/lib/skill-library"
import { personalCatalog } from "@/lib/skill-studio"
import { PERSONAL_ID } from "@/lib/skill-studio/design"
import { loadSkillV2 } from "@/lib/skills-v2"

// The device agent's skills (H7, HD-10): the cloud's catalogue rules
// (run-task's skillLibrary and resolveSkills' assignments) with the device's
// belt, which holds no Kriya tool: required skills plus the agent's
// assigned ones (or its role's defaults), active, not switched off by the
// owner, needing no Kriya tool, their dependencies with them; owner pins;
// v2 and the person's Studio skills behind their switches. Bodies come from
// the same loaders as the cloud.

type Loader = (id: string, version: string) => string

export async function deviceSkills(device: DeviceUser) {
  const base = await librarySkills(device)
  if ((await getSetting("harness.defaultSkills")) !== "on") return base
  // Kriya default skills (skills-harness/): every device, whatever its
  // agent's assignments; the owner's skills.disabled applies to them too,
  // and an assigned library skill of the same id wins
  const disabled = parseSkillList(await getSetting("skills.disabled"))
  const have = new Set(base.skills.map((s) => s.id))
  const defaults = HARNESS_DEFAULTS.filter(
    (s) => s.status === "active" && !disabled.has(s.id) && !have.has(s.id)
  )
  const ids = new Set(defaults.map((s) => s.id))
  return {
    skills: [
      ...defaults.map((s) => ({
        id: s.id,
        name: s.name,
        version: s.version,
        description: s.description,
        activation: { always: s.activation.always, keywords: [...s.activation.keywords] },
      })),
      ...base.skills,
    ],
    load: ((id, version) =>
      ids.has(id) ? loadDefaultSkill(id, version) : base.load(id, version)) as Loader,
  }
}

async function librarySkills(device: DeviceUser) {
  const none = { skills: [], load: readSkill as Loader }
  if ((await getSetting("agents.skillLibrary")) !== "on" || !device.agentId) return none
  const [agent] = await withUser(device.id, (tx) =>
    tx
      .select({ skills: agents.skills, role: agents.role })
      .from(agents)
      .where(eq(agents.id, device.agentId!))
  )
  if (!agent) return none

  const v2 = (await getSetting("next.skillsV2")) === "on"
  let catalog = v2 ? CATALOG_V2 : CATALOG
  let load: Loader = v2 ? loadSkillV2 : readSkill
  if ((await getSetting("next.skillStudio")) === "on") {
    const personal = await personalCatalog(device.id).catch(() => null)
    if (personal?.manifests.length) {
      const base = load
      catalog = [...personal.manifests, ...catalog]
      load = (id, version) =>
        PERSONAL_ID.test(id) ? personal.load(id, version) : base(id, version)
    }
  }
  const disabled = parseSkillList(await getSetting("skills.disabled"))
  const pins = parsePins(await getSetting("skills.pins"))
  const byId = new Map(catalog.map((s) => [s.id, s]))

  const usable = (s: SkillManifest, seen: string[] = []): boolean =>
    s.status === "active" &&
    !disabled.has(s.id) &&
    s.tools.all.length === 0 &&
    s.tools.any.length === 0 &&
    s.dependsOn.every((dep) => {
      const d = byId.get(dep)
      return Boolean(d) && !seen.includes(dep) && usable(d!, [...seen, s.id])
    })
  const assigned = new Set([
    ...catalog.filter((s) => s.required).map((s) => s.id),
    ...(agent.skills?.on ?? recommendedFor(agent.role, catalog)),
  ])
  const chosen = new Map<string, SkillManifest>()
  const add = (s: SkillManifest) => {
    if (chosen.has(s.id)) return
    chosen.set(s.id, s)
    for (const dep of s.dependsOn) add(byId.get(dep)!)
  }
  for (const s of catalog) if (assigned.has(s.id) && usable(s)) add(s)

  return {
    skills: [...chosen.values()].map((s) => ({
      id: s.id,
      name: s.name,
      version: pins.get(s.id) ?? s.version,
      description: s.description,
      activation: {
        always: s.activation.always,
        keywords: [...s.activation.keywords, ...(v2 ? s.activation.keywordsIntl : [])],
      },
    })),
    load,
  }
}

export const etagOf = (value: unknown) =>
  `"${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}"`
