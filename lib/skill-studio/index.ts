import { generateText, type LanguageModel } from "ai"
import { and, eq, gte, sql } from "drizzle-orm"
import { customAlphabet } from "nanoid"
import type { z } from "zod"

import { privileged, withUser, type Tx } from "@/db"
import { agents, resourceUsage, userSkills, type UserSkill } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"
import { usageFromMetadata } from "@/lib/models"
import {
  CATALOG,
  CATALOG_V2,
  recommendedFor,
  type SkillManifest,
} from "@/lib/skill-library"

import {
  applyEdit,
  checkEvals,
  draftSchema,
  finalize,
  jsonInstructions,
  KNOWN_TOOLS,
  parseJsonReply,
  planPrompt,
  planSchema,
  PERSONAL_ID,
  reviewPrompt,
  reviewSchema,
  StudioError,
  STUDIO_LIMITS,
  storedManifestSchema,
  toManifest,
  writePrompt,
  type SkillDraft,
  type SkillEdit,
  type SkillPlan,
  type SkillReview,
} from "./design"

// Server and worker only (it reads the database). Skill Studio's server side (docs/next-platform/SKILL_STUDIO.md): the
// three model calls that design a skill, the person's rows, and the
// personal catalogue the runner, the Creator and the agent actions read.
// Everything a person does goes through withUser (invariant 1); only the
// metering row is privileged, scoped by the person's id.

export { StudioError } from "./design"

export async function studioOn() {
  return (
    (await getSetting("agents.skillLibrary")) === "on" &&
    (await getSetting("next.skillStudio")) === "on"
  )
}

// The library catalogue the runner and the Creator use today
export async function baseCatalog() {
  return (await getSetting("next.skillsV2")) === "on" ? CATALOG_V2 : CATALOG
}

const newId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10)

/* ───────────────────────────── design ───────────────────────────── */

type Stage = "plan" | "write" | "review"

// Room for a reasoning model's hidden reasoning as well as the JSON: at
// 8,000 DeepSeek V4.1 Flash ran out mid-reply on a review (finishReason
// "length", 2026-10-30). Worst case 40,000 output tokens, ~US$0.05 a design.
const OUTPUT_TOKENS: Record<Stage, number> = { plan: 8000, write: 16000, review: 16000 }

// One call that must answer with JSON. The schema goes in the instructions
// and code parses and checks the reply, because the OpenRouter adapter
// doesn't pass a response schema (no structuredOutputs, lib/models.ts) and
// some routes wrap JSON in a fence. One repair try with the error; each
// try's cost is a platform cost (resource_usage), never a customer charge.
async function call<T>(
  stage: Stage,
  input: {
    userId: string
    skillId: string
    model: LanguageModel
    instructions: string
    prompt: string
    schema: z.ZodType<T>
  }
): Promise<T> {
  let problem: string | null = null
  for (const attempt of [1, 2]) {
    const prompt: string = problem
      ? `${input.prompt}\n\nYour previous reply couldn't be used (${problem}). Reply again with only the JSON object.`
      : input.prompt
    const result = await generateText({
      model: input.model,
      instructions: `${input.instructions}\n\n${jsonInstructions(input.schema)}`,
      prompt,
      maxOutputTokens: OUTPUT_TOKENS[stage],
      maxRetries: 1,
    })
    await privileged
      .insert(resourceUsage)
      .values({
        requestKey: `skill-studio:${input.skillId}:${stage}${attempt > 1 ? "-retry" : ""}`,
        userId: input.userId,
        kind: "skill_design",
        quantity: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        costMicroUsd: usageFromMetadata(result.providerMetadata)?.costMicroUsd ?? null,
      })
      .onConflictDoNothing()
      .catch((error) => log.error("skill studio usage failed", { stage, error }))
    const parsed: { ok: true; value: T } | { ok: false; problem: string } =
      parseJsonReply(result.text, input.schema)
    if (parsed.ok) return parsed.value
    problem = parsed.problem
    // Sizes and reasons only: the reply carries the person's request
    log.error("skill studio reply unusable", {
      stage,
      attempt,
      finishReason: result.finishReason,
      chars: result.text.length,
      problem,
    })
  }
  throw new Error(`${stage}: ${problem}`)
}

// Plan from five lenses, write, then a strict review that rewrites; code
// checks the result (finalize) and runs its sample requests through the
// real resolver. Stored as a draft: nothing loads until the person approves.
export async function designSkill(input: {
  userId: string
  intent: string
  model: LanguageModel
  unicode?: boolean
}): Promise<UserSkill> {
  const { userId, intent, model } = input
  const modelId = typeof model === "string" ? model : model.modelId
  const skillId = `my-${newId()}`
  const base = { userId, skillId, model }

  let plan, draft
  try {
    plan = await call<SkillPlan>("plan", {
      ...base,
      instructions: planPrompt(),
      prompt: intent,
      schema: planSchema,
    })
    draft = await call<SkillDraft>("write", {
      ...base,
      instructions: writePrompt(),
      prompt: JSON.stringify({ request: intent, design: plan }),
      schema: draftSchema,
    })
  } catch (error) {
    log.error("skill studio design failed", { skillId, error })
    throw new StudioError(
      "Kriya couldn't design that skill just now. Try again in a minute."
    )
  }
  // The review improves a usable draft; without it the draft stands
  const review = await call<SkillReview>("review", {
    ...base,
    instructions: reviewPrompt(KNOWN_TOOLS),
    prompt: JSON.stringify({
      request: intent,
      name: draft.name,
      instructions: draft.instructions,
    }),
    schema: reviewSchema,
  }).catch((error) => {
    log.error("skill studio review failed", { skillId, error })
    return null
  })

  const final = finalize(draft, review)
  const checks = checkEvals(
    toManifest({ id: skillId, status: "active", version: 1, ...final }),
    final.body,
    input.unicode
  )
  // Shown to the person: cut long notes with an ellipsis, never mid-word
  const cut = (s: unknown, max: number) => {
    const t = String(s ?? "").trim()
    return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")}…`
  }
  const design = {
    domain: cut(plan.domain, 120),
    expert: cut(plan.expert, 500),
    perspectives: (plan.perspectives ?? []).slice(0, 6).map((p) => ({
      lens: cut(p.lens, 60),
      insight: cut(p.insight, 600),
    })),
    scenarios: (plan.scenarios ?? []).slice(0, 6).map((s) => cut(s, 300)),
    outOfScope: (plan.outOfScope ?? []).slice(0, 6).map((s) => cut(s, 300)),
    assumptions: (plan.assumptions ?? []).slice(0, 5).map((s) => cut(s, 300)),
    scores: review?.scores ?? null,
    issues: (review?.issues ?? []).slice(0, 8).map((s) => cut(s, 300)),
    removed: final.removed.slice(0, 10),
    checks,
  }

  return withUser(userId, async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(userSkills)
    // shortcut: a count before the insert, so two designs finishing at once
    // can pass one over the limit; the hourly rate limit keeps that rare
    if (n >= STUDIO_LIMITS.perPerson)
      throw new StudioError(
        `You have ${STUDIO_LIMITS.perPerson} skills. Delete one you don't use first.`
      )
    const [row] = await tx
      .insert(userSkills)
      .values({
        id: skillId,
        userId,
        intent,
        name: final.name,
        description: final.description,
        body: final.body,
        manifest: final.manifest,
        design,
        model: modelId.slice(0, 120),
      })
      .returning()
    return row
  })
}

/* ──────────────────────────── the rows ──────────────────────────── */

export async function listSkills(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(userSkills)
      .orderBy(sql`${userSkills.createdAt} desc`)
  )
}

async function own(tx: Tx, id: string) {
  if (!PERSONAL_ID.test(id)) throw new StudioError("Skill not found.")
  const [row] = await tx.select().from(userSkills).where(eq(userSkills.id, id))
  if (!row) throw new StudioError("Skill not found.")
  return row
}

// The person's edit, checked like a design. An active skill stays active
// with its version bumped: the person wrote the change themself.
export async function saveSkill(userId: string, id: string, edit: SkillEdit) {
  return withUser(userId, async (tx) => {
    const row = await own(tx, id)
    if (row.status === "retired") throw new StudioError("Restore the skill first.")
    const final = applyEdit(edit, storedManifestSchema.parse(row.manifest))
    const [saved] = await tx
      .update(userSkills)
      .set({
        name: final.name,
        description: final.description,
        body: final.body,
        manifest: final.manifest,
        ...(row.status === "active" && { version: row.version + 1 }),
        updatedAt: new Date(),
      })
      .where(eq(userSkills.id, id))
      .returning()
    return saved
  })
}

// The person's approval: the skill becomes active and is added to the
// agents they chose. An agent with no saved choice gets its role's defaults
// written down first, so nothing it used before changes.
export async function approveSkill(userId: string, id: string, agentIds: string[]) {
  const catalog = await baseCatalog()
  return withUser(userId, async (tx) => {
    const row = await own(tx, id)
    if (row.status === "retired") throw new StudioError("Restore the skill first.")
    // Checked again: what's stored must still pass today's rules
    applyEdit(
      {
        name: row.name,
        description: row.description,
        keywords: storedManifestSchema.parse(row.manifest).keywords,
        instructions: row.body,
      },
      storedManifestSchema.parse(row.manifest)
    )
    await tx
      .update(userSkills)
      .set({
        status: "active",
        approvedAt: row.approvedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userSkills.id, id))
    await assign(tx, id, agentIds, catalog)
  })
}

async function assign(tx: Tx, id: string, agentIds: string[], catalog: SkillManifest[]) {
  for (const agentId of new Set(agentIds)) {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId))
    if (!agent) throw new StudioError("Agent not found.")
    const prefs = agent.skills ?? { auto: true, on: recommendedFor(agent.role, catalog) }
    if (prefs.on.includes(id)) continue
    if (prefs.on.length >= 30)
      throw new StudioError(`${agent.name} already has 30 skills. Remove one first.`)
    await tx
      .update(agents)
      .set({ skills: { ...prefs, on: [...prefs.on, id] } })
      .where(eq(agents.id, agentId))
  }
}

// Off every agent that has it, so a retired or deleted skill leaves no trace
async function unassign(tx: Tx, id: string) {
  const holding = await tx
    .select({ id: agents.id, skills: agents.skills })
    .from(agents)
    .where(sql`${agents.skills} -> 'on' ? ${id}`)
  for (const agent of holding)
    await tx
      .update(agents)
      .set({ skills: { ...agent.skills!, on: agent.skills!.on.filter((s) => s !== id) } })
      .where(eq(agents.id, agent.id))
}

export async function retireSkill(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    await own(tx, id)
    await tx
      .update(userSkills)
      .set({ status: "retired", updatedAt: new Date() })
      .where(eq(userSkills.id, id))
    await unassign(tx, id)
  })
}

// Back to a draft: the person approves it again to use it
export async function restoreSkill(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    await own(tx, id)
    await tx
      .update(userSkills)
      .set({ status: "draft", approvedAt: null, updatedAt: new Date() })
      .where(eq(userSkills.id, id))
  })
}

export async function deleteSkill(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    await own(tx, id)
    await unassign(tx, id)
    await tx.delete(userSkills).where(eq(userSkills.id, id))
  })
}

/* ─────────────────────── the personal catalogue ─────────────────── */

export type PersonalCatalog = {
  manifests: SkillManifest[]
  load: (id: string, version: string) => string
}

// The person's active skills as library skills. A row that no longer
// passes the checks is left out (and logged), never loaded.
export async function personalCatalog(userId: string): Promise<PersonalCatalog> {
  const rows = await withUser(userId, (tx) =>
    tx.select().from(userSkills).where(eq(userSkills.status, "active"))
  )
  const manifests: SkillManifest[] = []
  const texts = new Map<string, { version: string; body: string }>()
  for (const row of rows) {
    try {
      const manifest = toManifest(row)
      manifests.push(manifest)
      texts.set(row.id, { version: manifest.version, body: row.body })
    } catch (error) {
      log.error("personal skill skipped", { skillId: row.id, error })
    }
  }
  return {
    manifests,
    load: (id, version) => {
      const text = texts.get(id)
      if (!text || text.version !== version)
        throw new Error(`${id} has no version ${version}.`)
      return text.body
    },
  }
}

// Designs started by this person in the last day (the daily cap, in SQL)
export async function designsToday(userId: string) {
  const [{ n }] = await privileged
    .select({ n: sql<number>`count(*)::int` })
    .from(resourceUsage)
    .where(
      and(
        eq(resourceUsage.userId, userId),
        eq(resourceUsage.kind, "skill_design"),
        sql`${resourceUsage.requestKey} like 'skill-studio:%:plan'`,
        gte(resourceUsage.createdAt, new Date(Date.now() - 86_400_000))
      )
    )
  return n
}
