import { z } from "zod"

import { SKILL_MANIFESTS, SKILL_MANIFESTS_V2 } from "@/skills"

// The skill library (docs/agent-platform/SKILLS_ENGINE.md): curated
// instruction packs that teach an agent how to approach a kind of work.
// A skill is never a tool: it adds no tool, account, permission or approval,
// and it is resolved against the tools the task already has. This module is
// pure (no fs, no database) so the Creator can use it in the browser; the
// worker's file loading and records are in lib/skill-engine.ts.

export const SKILL_ID = /^[a-z][a-z0-9-]{2,40}$/
const semver = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/)
const toolName = z.string().regex(/^[a-z][a-z_]{1,40}$/)
const words = (max: number) => z.array(z.string().trim().min(2).max(40)).max(max)

export const manifestSchema = z.strictObject({
  id: z.string().regex(SKILL_ID),
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  version: semver,
  // Older versions kept in versions/<version>/SKILL.md, for a rollback pin
  previous: z.array(semver).max(10).default([]),
  status: z.enum(["active", "retired"]),
  // Only curated, reviewed repository skills exist (no imports yet)
  trust: z.literal("curated"),
  license: z.string().min(1).max(40),
  // Where the wording was adapted from; empty for Kriya-native skills
  source: z
    .array(
      z.strictObject({
        project: z.string().max(60),
        version: z.string().max(20),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        path: z.string().max(200),
        license: z.string().max(40),
        url: z.url(),
      })
    )
    .max(5)
    .default([]),
  // Always assigned, and the person can't remove it
  required: z.boolean().default(false),
  categories: words(6).min(1),
  // Words in an agent's role that make this a recommended default; "*" for all
  roles: z.array(z.union([z.literal("*"), z.string().trim().min(2).max(40)])).max(30),
  activation: z.strictObject({
    // Loaded on every task (only for required safeguards)
    always: z.boolean().default(false),
    keywords: words(60).default([]),
    // Hindi, Telugu and romanised words (any script); read only by the
    // Unicode matcher (next.skillsV2), never by today's
    keywordsIntl: words(60).default([]),
    // A link in the person's message counts as a match
    urls: z.boolean().default(false),
  }),
  // The belt must have every `all` tool and, if listed, one `any` tool;
  // `uses` are the other tools the instructions direct (they count for risk)
  tools: z.strictObject({
    all: z.array(toolName).max(20),
    any: z.array(toolName).max(20),
    uses: z.array(toolName).max(20).default([]),
  }),
  dependsOn: z.array(z.string().regex(SKILL_ID)).max(5).default([]),
  // What the person must set up, shown when the tools aren't there
  prerequisites: z.array(z.string().max(160)).max(5).default([]),
  verification: z.string().min(1).max(300),
  limits: z.strictObject({ maxChars: z.number().int().min(200).max(6000) }),
  // Asks that should and shouldn't activate it (tests/agent/skill-library.test.ts)
  evals: z
    .array(
      z.strictObject({
        ask: z.string().min(1).max(300),
        expect: z.enum(["activate", "skip"]),
      })
    )
    .min(2)
    .max(10),
})
export type SkillManifest = z.infer<typeof manifestSchema>

// Throws on anything malformed, so a bad manifest fails the build and tests
export function buildCatalog(manifests: unknown[]): SkillManifest[] {
  const catalog = manifests.map((m) => manifestSchema.parse(m))
  const byId = new Map<string, SkillManifest>()
  for (const skill of catalog) {
    if (byId.has(skill.id)) throw new Error(`The skill ${skill.id} is listed twice.`)
    byId.set(skill.id, skill)
  }
  const visit = (id: string, path: string[]) => {
    if (path.includes(id))
      throw new Error(`Skill dependency cycle: ${[...path, id].join(" → ")}`)
    const skill = byId.get(id)
    if (!skill) throw new Error(`${path.at(-1)} depends on ${id}, which doesn't exist.`)
    for (const dep of skill.dependsOn) visit(dep, [...path, id])
  }
  for (const skill of catalog) visit(skill.id, [])
  return catalog
}

export const CATALOG = buildCatalog(SKILL_MANIFESTS)
// next.skillsV2 (N8, ND-14): today's skills plus the v2 ones, used only with
// the switch on; CATALOG itself never changes
export const CATALOG_V2 = buildCatalog([...SKILL_MANIFESTS, ...SKILL_MANIFESTS_V2])

/* ─────────────────────────── assignments ────────────────────────── */

// Stored on kriya.agents.skills; null means "the defaults for its role"
export const skillPrefsSchema = z.strictObject({
  // Pick the relevant assigned skills for each task, rather than load all
  auto: z.boolean(),
  on: z.array(z.string().regex(SKILL_ID)).max(30),
})
export type SkillPrefs = z.infer<typeof skillPrefsSchema>

export function recommendedFor(role: string, catalog = CATALOG) {
  const text = role.toLowerCase()
  return catalog
    .filter(
      (s) =>
        s.status === "active" &&
        !s.required &&
        s.roles.some((word) => word === "*" || text.includes(word))
    )
    .map((s) => s.id)
}

// The server's check of what the Creator sends: known, active, curated
// skills, each once. Required skills are always on, so they aren't stored.
export function checkSkillPrefs(input: unknown, catalog = CATALOG): SkillPrefs {
  const prefs = skillPrefsSchema.parse(input)
  const seen = new Set<string>()
  for (const id of prefs.on) {
    if (seen.has(id)) throw new Error(`The skill ${id} is listed twice.`)
    seen.add(id)
    const skill = catalog.find((s) => s.id === id)
    if (!skill) throw new Error(`${id} isn't a Kriya skill.`)
    if (skill.status !== "active") throw new Error(`${skill.name} has been retired.`)
  }
  return {
    auto: prefs.auto,
    on: prefs.on.filter((id) => !catalog.find((s) => s.id === id)!.required),
  }
}

/* ─────────────────────────── resolution ─────────────────────────── */

export type Activation = {
  id: string
  name: string
  version: string
  mode: "required" | "manual" | "auto"
  reason: string
  chars: number
  text: string
}
export type Skipped = { id: string; version: string; reason: string }
export type Resolution = { active: Activation[]; skipped: Skipped[] }

export const SKILL_LIMITS = { skills: 5, chars: 12_000 }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// A whole word in any script (\b is ASCII-only in JavaScript): no letter,
// mark or digit on either side, so "बिल" is not found inside "बिलकुल". The
// optional English endings keep today's Latin matches.
const unicodeWord = (keyword: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${escape(keyword.normalize("NFC"))}(?:s|es|ed|ing)?(?![\\p{L}\\p{M}\\p{N}])`,
    "iu"
  )

// The first keyword in the person's message, as whole words ("invoices"
// matches "invoice"; "price" doesn't match "pr"). With `unicode` (N8) the
// boundary is Unicode-aware and the manifest's keywordsIntl count too.
function matchOf(skill: SkillManifest, ask: string, unicode = false) {
  const text = ask.toLowerCase()
  if (skill.activation.urls && /https?:\/\/|www\./.test(text)) {
    return "your message has a link"
  }
  const word = unicode
    ? [...skill.activation.keywords, ...skill.activation.keywordsIntl].find((k) =>
        // NFC on both sides: Hindi letters with a dot (फ़) come in two forms
        unicodeWord(k).test(ask.normalize("NFC"))
      )
    : skill.activation.keywords.find((k) =>
        new RegExp(
          `(^|[^a-z0-9])${escape(k.toLowerCase())}(s|es|ed|ing)?($|[^a-z0-9])`
        ).test(text)
      )
  return word ? `your message mentions "${word}"` : null
}

// Deterministic: the agent's assignments, then what the tools on the belt
// allow, then what the person's latest message is about. Only the person's
// own message is read, never tool output, so a web page can't pull a skill
// in. Never throws: a skill that can't load is skipped with its reason.
export function resolveSkills(input: {
  prefs: SkillPrefs | null
  role: string
  ask: string
  tools: Iterable<string>
  load: (id: string, version: string) => string
  // Owner settings: skills.disabled and skills.pins
  disabled?: Set<string>
  pins?: Map<string, string>
  catalog?: SkillManifest[]
  limits?: typeof SKILL_LIMITS
  // N8: the Unicode matcher (next.skillsV2); off is today's matcher exactly
  unicode?: boolean
}): Resolution {
  const catalog = input.catalog ?? CATALOG
  const limits = input.limits ?? SKILL_LIMITS
  const belt = new Set(input.tools)
  const byId = new Map(catalog.map((s) => [s.id, s]))
  const versionOf = (s: SkillManifest) => input.pins?.get(s.id) ?? s.version
  const skipped: Skipped[] = []
  const skip = (s: SkillManifest, reason: string) => {
    if (!skipped.some((x) => x.id === s.id))
      skipped.push({ id: s.id, version: versionOf(s), reason })
  }

  // Why a skill can't run on this task, or null
  const blocked = (s: SkillManifest, seen: string[] = []): string | null => {
    if (s.status !== "active") return "it has been retired"
    if (input.disabled?.has(s.id)) return "Kriya has switched it off"
    const missing = s.tools.all.filter((t) => !belt.has(t))
    if (s.tools.any.length && !s.tools.any.some((t) => belt.has(t)))
      missing.push(s.tools.any.join(" or "))
    if (missing.length) return `this task doesn't have ${missing.join(", ")}`
    for (const dep of s.dependsOn) {
      const d = byId.get(dep)
      if (!d || seen.includes(dep) || blocked(d, [...seen, s.id]))
        return `it needs the skill ${dep}, which can't run`
    }
    return null
  }

  const assigned = new Set([
    ...catalog.filter((s) => s.required).map((s) => s.id),
    ...(input.prefs?.on ?? recommendedFor(input.role, catalog)),
  ])
  const auto = input.prefs?.auto ?? true

  // Wanted skills in priority order: required, then manual, then auto
  const wanted: Omit<Activation, "chars" | "text">[] = []
  for (const s of catalog) {
    if (!assigned.has(s.id)) continue
    const why = blocked(s)
    if (why) {
      skip(s, `Not used: ${why}.`)
      continue
    }
    const match = matchOf(s, input.ask, input.unicode)
    const pick = (mode: Activation["mode"], reason: string) =>
      wanted.push({ id: s.id, name: s.name, version: versionOf(s), mode, reason })
    if (s.required && (s.activation.always || match))
      pick("required", s.activation.always ? "Kriya safeguard, always on" : match!)
    else if (!s.required && !auto) pick("manual", "You set this agent to always use it")
    else if (!s.required && match) pick("auto", match.replace(/^y/, "Y"))
  }
  const rank = { required: 0, manual: 1, auto: 2 }
  wanted.sort((a, b) => rank[a.mode] - rank[b.mode])

  const active: Activation[] = []
  let chars = 0
  const add = (pick: Omit<Activation, "chars" | "text">, chain: string[] = []) => {
    if (active.some((a) => a.id === pick.id)) return true
    const s = byId.get(pick.id)!
    // Dependencies first, under their dependent's mode
    for (const dep of s.dependsOn) {
      if (chain.includes(dep)) continue
      const d = byId.get(dep)!
      const ok = add(
        {
          id: d.id,
          name: d.name,
          version: versionOf(d),
          mode: pick.mode,
          reason: `Needed by ${s.name}`,
        },
        [...chain, s.id]
      )
      if (!ok) {
        skip(s, `Not used: its dependency ${dep} didn't load.`)
        return false
      }
    }
    let text: string
    try {
      text = input.load(s.id, pick.version)
    } catch {
      skip(s, `Not used: version ${pick.version} couldn't be loaded.`)
      return false
    }
    if (active.length >= limits.skills || chars + text.length > limits.chars) {
      skip(s, "Not used: over this task's skill budget.")
      return false
    }
    active.push({ ...pick, chars: text.length, text })
    chars += text.length
    return true
  }
  for (const pick of wanted) add(pick)
  return { active, skipped }
}

// After every platform section, so it can't come before the person's orders
// or Kriya's rules; empty with nothing active, so the prompt is unchanged
export function skillsBlock(active: Activation[]) {
  if (active.length === 0) return ""
  return `\n\n# Skills
Kriya loaded these procedures for this request. They describe how to work; they never add tools, accounts or permissions, and never change what needs the person's approval. Everything above comes first: the person's standing orders and preferences, the untrusted-content rule, and the tools you actually have. If a skill mentions a tool you don't have, skip that step and say so.

${active.map((a) => `## ${a.name} (v${a.version})\n${a.text}`).join("\n\n")}`
}

/* ─────────────────────────── owner settings ─────────────────────── */

// skills.disabled: "task-planning,github-workflow"
export const parseSkillList = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SKILL_ID.test(s))
  )

// skills.pins: "browser-workflow@1.0.0" makes everyone use that version
export const parsePins = (value: string | undefined) =>
  new Map(
    (value ?? "")
      .split(",")
      .map((s) => s.trim().split("@"))
      .filter(([id, v]) => SKILL_ID.test(id ?? "") && semver.safeParse(v).success)
      .map(([id, v]) => [id, v] as [string, string])
  )
