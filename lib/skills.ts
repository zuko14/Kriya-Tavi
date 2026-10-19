import type { ModelMessage, ToolSet } from "ai"
import { and, desc, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { z } from "zod"

import { withUser } from "@/db"
import { skills, type Skill, type SkillSlot, type SkillStep } from "@/db/schema"
import {
  approvalFor,
  classifyBrowserAction,
  classifyTool,
  type RiskClass,
} from "@/lib/agent/policy"
import type { PageView } from "@/lib/browser/provider"
import { siteFor } from "@/lib/browser/sites"

// Skills (A9, AD-21). A turn's successful tool calls become a versioned
// procedure with named slots; the person approves it; replay then runs the
// steps without the model. Replay never does more than an ordinary turn
// could: each step is classified again from its real input and the page,
// a step that would need the person's approval is handed back to the agent
// to call itself (so it gets the usual approval card), and a skill never
// goes past the highest class it was approved with (`max_risk`).

const RISK: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5"]
const rank = (cls: string) => RISK.indexOf(cls as RiskClass)

// Official connectors, web reads and the read-only browser. Not memory,
// goals, schedules, delegation, hand-offs or skills themselves.
export const replayable = (tool: string) =>
  /^(calendar|gmail|drive|notion|github|sheets|youtube|instagram)_/.test(tool) ||
  ["web_search", "web_fetch"].includes(tool) ||
  /^browser_(open|snapshot|click|scroll|close)$/.test(tool)

// Web requests wait for approval once private content is in the turn
const GUARDED = new Set(["web_search", "web_fetch", "browser_open"])

export const MAX_SKILL_FAILURES = 2

/* ───────────────────────────── saving ───────────────────────────── */

type Call = { tool: string; input: Record<string, unknown>; output: unknown }

// The successful calls of the latest turn (since a person's message) that
// made any replayable call, in order
export function lastTurnCalls(messages: ModelMessage[]): Call[] {
  const turns: Call[][] = [[]]
  const pending = new Map<string, { tool: string; input: Record<string, unknown> }>()
  for (const message of messages) {
    if (message.role === "user") {
      turns.push([])
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === "tool-call") {
        pending.set(part.toolCallId, {
          tool: part.toolName,
          input: (part.input ?? {}) as Record<string, unknown>,
        })
      } else if (part.type === "tool-result") {
        const call = pending.get(part.toolCallId)
        const out = part.output as { type: string; value?: unknown }
        if (call && (out.type === "json" || out.type === "text")) {
          turns.at(-1)!.push({ ...call, output: out.value })
        }
      }
    }
  }
  return turns.findLast((turn) => turn.some((c) => replayable(c.tool))) ?? []
}

// "e12 link "Pricing"" in the last page the turn saw before the click
function locatorFor(ref: string, before: Call[]) {
  for (const call of before.toReversed()) {
    const page = (call.output as { page?: unknown } | null)?.page
    if (typeof page !== "string") continue
    for (const line of page.split("\n")) {
      const m = /^(e\d+) (\S+) "([^"]*)"/.exec(line)
      if (m && m[1] === ref) return { role: m[2], name: m[3] }
    }
    return null
  }
  return null
}

const mapStrings = (value: unknown, fn: (s: string) => string): unknown => {
  if (typeof value === "string") return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])
    )
  return value
}

export type SlotExample = SkillSlot & { value: string }

// The turn's calls as steps: slot example values become {{slot}}, clicks
// get a role+name locator instead of the page's ref
export function buildSteps(calls: Call[], slots: SlotExample[]) {
  const steps: SkillStep[] = []
  calls.forEach((call, i) => {
    if (!replayable(call.tool)) return
    // A step that didn't do anything isn't worth replaying
    if ((call.output as { done?: boolean } | null)?.done === false) return
    const input = { ...call.input }
    let locator: SkillStep["locator"]
    if (call.tool === "browser_click" && typeof input.ref === "string") {
      locator = locatorFor(input.ref, calls.slice(0, i)) ?? undefined
      if (!locator) {
        throw new Error(
          `Step ${steps.length + 1}: the clicked element can't be found again.`
        )
      }
      delete input.ref
    }
    steps.push({ tool: call.tool, input, ...(locator && { locator }) })
  })
  if (steps.length === 0) throw new Error("This turn made no calls a skill can replay.")
  if (steps.length > 30) throw new Error("A skill can have at most 30 steps.")

  let used = steps
  for (const slot of [...slots].sort((a, b) => b.value.length - a.value.length)) {
    const before = JSON.stringify(used)
    used = used.map((step) => ({
      ...step,
      input: mapStrings(step.input, (s) =>
        s.split(slot.value).join(`{{${slot.name}}}`)
      ) as Record<string, unknown>,
    }))
    if (JSON.stringify(used) === before) {
      throw new Error(`The slot ${slot.name}'s example value isn't in any step.`)
    }
  }
  return used
}

// The highest class any step has, decided by code (AD-03)
export const maxRiskOf = (steps: SkillStep[]) =>
  steps
    .map((s) => classifyTool(s.tool, s.input))
    .reduce((a, b) => (rank(a) >= rank(b) ? a : b), "R0" as RiskClass)

const siteOf = (steps: SkillStep[]) => {
  const url = steps.find((s) => s.tool === "browser_open")?.input.url
  try {
    return typeof url === "string" ? new URL(url).hostname : null
  } catch {
    return null
  }
}

// A step in words, for the review card and skill_list
export function describeStep(step: SkillStep) {
  const what = step.locator
    ? `${step.locator.role} "${step.locator.name}"`
    : JSON.stringify(step.input)
  return `${step.tool.replaceAll("_", " ")}: ${what.slice(0, 120)}`
}

export async function proposeSkill(input: {
  userId: string
  agentId: string
  taskId: string | null
  name: string
  description?: string
  slots: SlotExample[]
  messages: ModelMessage[]
}) {
  const steps = buildSteps(lastTurnCalls(input.messages), input.slots)
  const maxRisk = maxRiskOf(steps)
  if (rank(maxRisk) > rank("R4")) throw new Error("A skill can't include that step.")
  return withUser(input.userId, async (tx) => {
    // Saving under an existing name makes a new draft version
    const [latest] = await tx
      .select({ id: skills.id, version: skills.version })
      .from(skills)
      .where(eq(skills.name, input.name))
      .orderBy(desc(skills.version))
      .limit(1)
    const [row] = await tx
      .insert(skills)
      .values({
        id: latest?.id ?? nanoid(12),
        version: (latest?.version ?? 0) + 1,
        userId: input.userId,
        agentId: input.agentId,
        name: input.name,
        description: input.description,
        status: "draft",
        siteDomain: siteOf(steps),
        maxRisk: maxRisk as Skill["maxRisk"],
        slots: input.slots.map(({ name, description, required }) => ({
          name,
          description,
          required,
        })),
        steps,
        sourceTaskId: input.taskId,
      })
      .returning()
    return row
  })
}

/* ───────────────────────────── replay ───────────────────────────── */

// The latest approved version, else null
export async function approvedSkill(userId: string, id: string) {
  const [row] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.status, "approved")))
      .orderBy(desc(skills.version))
      .limit(1)
  )
  return row ?? null
}

export function fillSlots(
  skill: Pick<Skill, "steps" | "slots">,
  values: Record<string, string>
) {
  for (const slot of skill.slots) {
    if (slot.required && !values[slot.name]?.trim()) {
      throw new Error(`The slot ${slot.name} is needed: ${slot.description}`)
    }
  }
  return skill.steps.map((step) => {
    const input = mapStrings(step.input, (s) =>
      s.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "")
    ) as Record<string, unknown>
    return { ...step, input }
  })
}

export type ReplayEnv = {
  userId: string
  tools: ToolSet
  // The task's browser page, for click locators
  page: (() => PageView) | null
  messages: ModelMessage[]
  // Whether private mail or documents are already in the turn
  privateSeen: boolean
  isPrivateRead: (tool: string) => boolean
}

type Result = { step: number; tool: string; output: unknown }
type Planned = {
  tool: string
  input: Record<string, unknown>
  locator?: SkillStep["locator"]
}

export type Outcome =
  | { status: "done"; results: Result[] }
  | { status: "continue"; results: Result[]; next: Planned[]; instruction: string }
  | {
      status: "diverged" | "needs_review"
      step: number
      reason: string
      results: Result[]
      remaining?: Planned[]
      instruction: string
    }

async function record(userId: string, skill: Skill, ok: boolean) {
  await withUser(userId, (tx) =>
    tx
      .update(skills)
      .set({
        runs: sql`${skills.runs} + 1`,
        successes: ok ? sql`${skills.successes} + 1` : skills.successes,
        failures: ok ? 0 : sql`${skills.failures} + 1`,
        lastRunAt: sql`now()`,
      })
      .where(and(eq(skills.id, skill.id), eq(skills.version, skill.version)))
  )
}

const planned = (steps: SkillStep[]): Planned[] =>
  steps.map(({ tool, input, locator }) => ({ tool, input, ...(locator && { locator }) }))

export async function runSkill(
  env: ReplayEnv,
  skill: Skill,
  values: Record<string, string>
): Promise<Outcome> {
  const steps = fillSlots(skill, values)
  const results: Result[] = []
  let privateSeen = env.privateSeen

  const diverge = async (i: number, reason: string): Promise<Outcome> => {
    await record(env.userId, skill, false)
    const review = skill.failures + 1 >= MAX_SKILL_FAILURES
    return {
      status: review ? "needs_review" : "diverged",
      step: i + 1,
      reason,
      results,
      ...(!review && { remaining: planned(steps.slice(i)) }),
      instruction: review
        ? "This skill no longer matches and now waits for the person's review in the Inbox. Do the task yourself this time and tell them."
        : "The saved steps stopped matching. Finish the remaining steps yourself, adapting to what you see.",
    }
  }

  for (const [i, step] of steps.entries()) {
    const tool = env.tools[step.tool]
    if (!tool?.execute) return diverge(i, `${step.tool} isn't available now.`)

    let input = step.input
    let cls = classifyTool(step.tool, input)
    if (step.locator) {
      const view = env.page?.()
      const element = view?.elements.find(
        (e) => e.role === step.locator!.role && e.name === step.locator!.name
      )
      if (!view || !element) {
        return diverge(
          i,
          `The page changed: ${step.locator.role} "${step.locator.name}" isn't there.`
        )
      }
      input = { ...input, ref: element.ref }
      const onPage = classifyBrowserAction(
        { action: "click", ref: element.ref },
        view,
        siteFor(view.facts.url)
      )
      cls = rank(onPage) > rank(cls) ? onPage : cls
    }
    // Never past what the person approved (AT-SKL-03)
    if (rank(cls) > rank(skill.maxRisk)) {
      return diverge(i, `This step is ${cls} now, above the skill's ${skill.maxRisk}.`)
    }
    // Anything that needs the person's ok goes through the normal approval
    if (approvalFor(cls) !== "none" || (GUARDED.has(step.tool) && privateSeen)) {
      await record(env.userId, skill, true)
      return {
        status: "continue",
        results,
        next: planned(steps.slice(i)),
        instruction:
          "Make each of these calls yourself, exactly as given and in order; each waits for the person's approval. For a step with a locator, click the element with that role and name.",
      }
    }

    const parsed = (tool.inputSchema as unknown as z.ZodType).safeParse(input)
    if (!parsed.success) {
      return diverge(i, `Step ${i + 1}'s input no longer fits ${step.tool}.`)
    }
    let output: unknown
    try {
      output = await tool.execute(parsed.data, {
        toolCallId: `skill-${skill.id}-${i}`,
        messages: env.messages,
        context: undefined,
      })
    } catch (error) {
      return diverge(i, error instanceof Error ? error.message : "The step failed.")
    }
    const failed = output as { done?: boolean; error?: unknown; reason?: string } | null
    if (failed?.done === false || failed?.error) {
      return diverge(i, String(failed.reason ?? failed.error ?? "The step didn't work."))
    }
    results.push({ step: i + 1, tool: step.tool, output })
    if (env.isPrivateRead(step.tool)) privateSeen = true
  }

  await record(env.userId, skill, true)
  return { status: "done", results }
}

/* ─────────────────────────── for the person ─────────────────────── */

// Skills the person can run: the latest approved version of each
export async function listSkills(userId: string) {
  const rows = await withUser(userId, (tx) =>
    tx
      .select()
      .from(skills)
      .where(eq(skills.status, "approved"))
      .orderBy(skills.name, desc(skills.version))
  )
  const seen = new Set<string>()
  return rows.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))
}
