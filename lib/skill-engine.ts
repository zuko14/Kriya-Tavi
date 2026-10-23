import fs from "node:fs"
import path from "node:path"

import { and, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { skillActivations, type Task } from "@/db/schema"
import { approvalFor, TOOL_CLASSES, type RiskClass } from "@/lib/agent/policy"
import {
  CATALOG,
  SKILL_ID,
  type Resolution,
  type SkillManifest,
} from "@/lib/skill-library"

// The worker's side of the skill library: reading instructions from the
// curated skills/ directory, and the activation audit trail. Skills are text
// only: a skill directory holding a script, a link or anything else Kriya
// doesn't read is refused, never run.

export const SKILLS_ROOT = path.join(process.cwd(), "skills")

const TOP = new Set([
  "SKILL.md",
  "kriya.json",
  "LICENSE",
  "LICENSE.md",
  "NOTICE",
  "NOTICE.md",
])
const ARCHIVE_DIR = /^versions(\/\d{1,3}\.\d{1,3}\.\d{1,3})?$/
const ARCHIVE_FILE = /^versions\/\d{1,3}\.\d{1,3}\.\d{1,3}\/SKILL\.md$/

function audit(dir: string, rel = "") {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isSymbolicLink())
      throw new Error(`${name} is a link; skills can't contain links.`)
    if (entry.isDirectory() && ARCHIVE_DIR.test(name)) audit(dir, name)
    else if (!entry.isFile() || !(TOP.has(name) || ARCHIVE_FILE.test(name)))
      throw new Error(`The skill has a file Kriya doesn't run: ${name}`)
  }
}

// The instructions of one version, without the frontmatter. Not cached: a
// few kilobytes per task, and every read is audited again.
export function readSkill(
  id: string,
  version: string,
  root = SKILLS_ROOT,
  catalog: SkillManifest[] = CATALOG
) {
  if (!SKILL_ID.test(id)) throw new Error("That isn't a skill id.")
  const skill = catalog.find((s) => s.id === id)
  if (!skill) throw new Error(`${id} isn't in the skill catalogue.`)
  if (version !== skill.version && !skill.previous.includes(version))
    throw new Error(`${id} has no version ${version}.`)
  const dir = path.join(/*turbopackIgnore: true*/ root, id)
  if (fs.lstatSync(dir).isSymbolicLink())
    throw new Error(`${id} is a link; skills can't be links.`)
  audit(dir)
  const raw = fs.readFileSync(
    version === skill.version
      ? path.join(dir, "SKILL.md")
      : path.join(dir, "versions", version, "SKILL.md"),
    "utf8"
  )
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${id}: SKILL.md has no frontmatter.`)
  const name = /^name:\s*(\S+)\s*$/m.exec(match[1])?.[1]
  if (name !== id) throw new Error(`${id}: SKILL.md's name is ${name ?? "missing"}.`)
  if (!/^description:\s*\S/m.test(match[1]))
    throw new Error(`${id}: SKILL.md's frontmatter has no description.`)
  const body = match[2].trim()
  if (!body) throw new Error(`${id}: SKILL.md is empty.`)
  if (body.length > skill.limits.maxChars)
    throw new Error(
      `${id}: SKILL.md is too long (${body.length} > ${skill.limits.maxChars}).`
    )
  return body
}

const RISK: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5"]

// Decided by code (AD-03) from the tools a skill directs, never declared:
// the highest class among them, and which of them wait for the person.
// A tool without a class (propose_call, OF-12) has its own confirmation.
export function skillRisk(skill: SkillManifest) {
  const tools = [...skill.tools.all, ...skill.tools.any, ...skill.tools.uses]
  const risk = tools
    .map((t) => TOOL_CLASSES[t])
    .filter(Boolean)
    .reduce<RiskClass>((a, b) => (RISK.indexOf(b) > RISK.indexOf(a) ? b : a), "R0")
  const approvals = tools.filter(
    (t) => !TOOL_CLASSES[t] || approvalFor(TOOL_CLASSES[t]) !== "none"
  )
  return { risk, approvals }
}

/* ───────────────────────────── records ──────────────────────────── */

// Worker bookkeeping (invariant 1): privileged, scoped by the task's user.
// The reason and sizes only, never the instructions or the person's message.
export async function recordActivations(
  task: Pick<Task, "id" | "userId">,
  attempt: number,
  agentId: string,
  { active, skipped }: Resolution
) {
  const rows = [
    ...active.map((a) => ({
      skillId: a.id,
      version: a.version,
      status: "active" as const,
      mode: a.mode,
      reason: a.reason.slice(0, 200),
      chars: a.chars,
    })),
    ...skipped.map((s) => ({
      skillId: s.id,
      version: s.version,
      status: "skipped" as const,
      mode: null,
      reason: s.reason.slice(0, 200),
      chars: 0,
    })),
  ].map((row) => ({ ...row, taskId: task.id, userId: task.userId, attempt, agentId }))
  if (rows.length === 0) return
  await privileged.insert(skillActivations).values(rows).onConflictDoNothing()
}

export async function settleActivations(
  task: Pick<Task, "id" | "userId">,
  attempt: number,
  outcome: "succeeded" | "failed" | "canceled"
) {
  await privileged
    .update(skillActivations)
    .set({ outcome })
    .where(
      and(
        eq(skillActivations.taskId, task.id),
        eq(skillActivations.userId, task.userId),
        eq(skillActivations.attempt, attempt)
      )
    )
}
