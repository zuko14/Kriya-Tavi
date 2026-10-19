import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { eq, inArray, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { z } from "zod"

import { privileged, rowsOf } from "@/db"
import {
  auditEvents,
  policyTaskVersions,
  policyVersions,
  type PolicyVersion,
} from "@/db/schema"
import { SAVE_GUIDANCE } from "@/lib/agent/instructions"
// The on/off switch only; nothing here reads or writes limits
import { getSetting } from "@/lib/config"
import { RECALL_WEIGHTS } from "@/lib/memory/retrieve"
import { sensitiveKind } from "@/lib/memory/sensitive"
import { SUMMARY_TRIGGER_CHARS } from "@/lib/memory/summaries"

// Governed improvement (A12, AD-25; the voice track's SELF_IMPROVEMENT.md
// model). A candidate is a complete bundle of the tunable behaviour: prompt
// wording, retrieval weights, token budgets. It ships only after an offline
// gate, a shadow comparison and a canary, and rolls back on its own when a
// guard metric worsens. Production never changes a bundle by itself.
//
// Fixed, never in a bundle (the strict schema refuses any other key): risk
// classes and approval gates (lib/agent/policy.ts), site modes, R5 rules,
// quarantine and the untrusted-content section, the unconfirmed-note
// penalty, plan limits and cost budgets (lib/entitlements.ts, SQL), and
// every state machine. Those change only through a reviewed phase.

const weight = z.number().min(0).max(1)

export const bundleSchema = z.strictObject({
  prompts: z.strictObject({
    // Wording only: no headings, so a bundle can't add or replace a section
    saveGuidance: z
      .string()
      .min(100)
      .max(2000)
      .refine((text) => !/^\s*#/m.test(text), "Prompt wording can't add sections."),
  }),
  retrieval: z.strictObject({ recency: weight, importance: weight, ownAgent: weight }),
  budgets: z.strictObject({
    summaryTriggerChars: z.number().int().min(4_000).max(40_000),
    recallCandidates: z.number().int().min(5).max(50),
  }),
})
export type Bundle = z.infer<typeof bundleSchema>

// What runs when no version is active: today's code constants
export const BASELINE: Bundle = {
  prompts: { saveGuidance: SAVE_GUIDANCE },
  retrieval: { ...RECALL_WEIGHTS },
  budgets: { summaryTriggerChars: SUMMARY_TRIGGER_CHARS, recallCandidates: 20 },
}

// Same bundle, same hash, whatever the key order
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}
export const bundleHash = (bundle: Bundle) =>
  createHash("sha256").update(canonical(bundle)).digest("hex")

/* ───────────────────────────── offline gate ─────────────────────── */

// One scenario's numbers. Every metric is "higher is better" except the
// zero-tolerance ones, which count failures and must stay at 0.
export type Metrics = Record<string, number>

export type GateRules = {
  // Must improve on the active version's mean
  target: string
  // Counts that must be 0 in every scenario (e.g. M2 stale, M4, M5, P1)
  zero: string[]
  // How far another metric's mean may fall (default 0)
  tolerance?: Record<string, number>
  minRuns: number
}

export type GateReport = {
  pass: boolean
  n: number
  active: Metrics
  candidate: Metrics
  reasons: string[]
}

const mean = (rows: Metrics[], metric: string) =>
  rows.reduce((sum, row) => sum + (row[metric] ?? 0), 0) / Math.max(rows.length, 1)

export async function runSuite<S>(
  bundle: Bundle,
  scenarios: S[],
  run: (bundle: Bundle, scenario: S) => Promise<Metrics>
) {
  const rows: Metrics[] = []
  for (const scenario of scenarios) rows.push(await run(bundle, scenario))
  return rows
}

export function offlineGate(
  active: Metrics[],
  candidate: Metrics[],
  rules: GateRules
): GateReport {
  const metrics = [...new Set([...active, ...candidate].flatMap(Object.keys))]
  const summary = (rows: Metrics[]) =>
    Object.fromEntries(metrics.map((m) => [m, mean(rows, m)]))
  const a = summary(active)
  const c = summary(candidate)
  const reasons: string[] = []
  if (candidate.length < rules.minRuns || candidate.length !== active.length) {
    reasons.push(`needs ${rules.minRuns} paired runs, got ${candidate.length}`)
  }
  for (const m of rules.zero) {
    const failures = candidate.reduce((sum, row) => sum + (row[m] ?? 0), 0)
    if (failures > 0) reasons.push(`${m}: ${failures} (must be 0)`)
  }
  if (!(c[rules.target] > a[rules.target])) {
    reasons.push(
      `${rules.target} didn't improve (${a[rules.target]} → ${c[rules.target]})`
    )
  }
  for (const m of metrics) {
    if (m === rules.target || rules.zero.includes(m)) continue
    const allowed = rules.tolerance?.[m] ?? 0
    if (c[m] < a[m] - allowed) reasons.push(`${m} worse (${a[m]} → ${c[m]})`)
  }
  return {
    pass: reasons.length === 0,
    n: candidate.length,
    active: a,
    candidate: c,
    reasons,
  }
}

/* ───────────────────────────── shadow ───────────────────────────── */

// Both versions on the same inputs; the candidate's output is compared,
// never used
export const SHADOW_AGREEMENT = 0.98

export async function shadow<S, O>(
  scenarios: S[],
  active: Bundle,
  candidate: Bundle,
  run: (bundle: Bundle, scenario: S) => Promise<O>,
  same: (a: O, b: O) => boolean = isDeepStrictEqual
) {
  const disagreements: { index: number; active: O; candidate: O }[] = []
  for (const [index, scenario] of scenarios.entries()) {
    const a = await run(active, scenario)
    const c = await run(candidate, scenario)
    if (!same(a, c)) disagreements.push({ index, active: a, candidate: c })
  }
  const agreement = 1 - disagreements.length / Math.max(scenarios.length, 1)
  // Below the bar, the owner reviews every disagreement before a canary
  return {
    n: scenarios.length,
    agreement,
    pass: agreement >= SHADOW_AGREEMENT,
    disagreements,
  }
}

/* ───────────────────────────── canary ───────────────────────────── */

export const CANARY_STEPS = [5, 25, 100] as const

// Stable per person and version, so widening only adds people
export function inCanary(userId: string, versionId: string, percent: number) {
  const bucket = createHash("sha256")
    .update(`${versionId}:${userId}`)
    .digest()
    .readUInt32BE(0)
  return bucket % 100 < percent
}

// Guard metrics on live runs, canary against active. Any breach rolls back.
// A ratio guard with minDelta also fires from a zero base (0 % failed on
// active, 50 % on the canary); without it, a zero base (no cost data yet)
// can't be judged.
export type Guard = { metric: string; max?: number; maxRatio?: number; minDelta?: number }
export const GUARDS: Guard[] = [
  { metric: "severity1", max: 0 },
  { metric: "failedRate", maxRatio: 1.5, minDelta: 0.05 },
  { metric: "needsReviewRate", maxRatio: 1.5, minDelta: 0.05 },
  { metric: "costPerTask", maxRatio: 1.1 },
]

export function guardBreaches(active: Metrics, canary: Metrics, guards = GUARDS) {
  return guards.flatMap(({ metric, max, maxRatio, minDelta }) => {
    const value = canary[metric] ?? 0
    if (max !== undefined && value > max) return [`${metric} ${value} > ${max}`]
    const base = active[metric] ?? 0
    if (maxRatio === undefined || (base === 0 && minDelta === undefined)) return []
    const limit = Math.max(base * maxRatio, base + (minDelta ?? 0))
    return value > limit ? [`${metric} ${value} > ${limit} (active ${base})`] : []
  })
}

/* ───────────────────────────── lifecycle ────────────────────────── */

type Tx = Parameters<Parameters<typeof privileged.transaction>[0]>[0]

async function record(
  tx: Tx,
  actorId: string | null,
  action: string,
  id: string,
  details: Record<string, unknown>
) {
  await tx.insert(auditEvents).values({
    actorId,
    action,
    targetType: "policy_version",
    targetId: id,
    details,
  })
}

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(policyVersions).where(eq(policyVersions.id, id))
  if (!row) throw new Error(`No policy version ${id}.`)
  return row
}

const report = (row: PolicyVersion) =>
  (row.evalReport ?? {}) as { gate?: GateReport; shadow?: { pass: boolean } }

// A draft from an offline improver (a coding agent or a person)
export async function proposeVersion(input: {
  bundle: unknown
  parentId?: string | null
  targets: string[]
  proposedBy: string
}) {
  const bundle = bundleSchema.parse(input.bundle)
  const id = nanoid(12)
  await privileged.transaction(async (tx) => {
    await tx.insert(policyVersions).values({
      id,
      parentId: input.parentId ?? null,
      bundle,
      bundleHash: bundleHash(bundle),
      targets: input.targets,
      proposedBy: input.proposedBy,
    })
    await record(tx, null, "policy.propose", id, {
      by: input.proposedBy,
      targets: input.targets,
    })
  })
  return id
}

// Draft → shadow when the gate passed, else rejected
export async function recordGate(id: string, gate: GateReport) {
  return privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    const status = gate.pass ? "shadow" : "rejected"
    await tx
      .update(policyVersions)
      .set({ status, evalReport: { ...report(row), gate } })
      .where(eq(policyVersions.id, id))
    await record(tx, null, "policy.gate", id, { pass: gate.pass, reasons: gate.reasons })
    return status
  })
}

export async function recordShadow(
  id: string,
  result: { n: number; agreement: number; pass: boolean }
) {
  await privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    const shadowReport = { n: result.n, agreement: result.agreement, pass: result.pass }
    await tx
      .update(policyVersions)
      .set({ evalReport: { ...report(row), shadow: shadowReport } })
      .where(eq(policyVersions.id, id))
    await record(tx, null, "policy.shadow", id, shadowReport)
  })
}

// The owner moves a version one canary step on: shadow → 5 % → 25 % → 100 %
// = active (the previous active is retired, kept for rollback)
export async function advance(id: string, ownerId: string) {
  return privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    if (row.status === "shadow") {
      const { gate, shadow: shadowReport } = report(row)
      if (!gate?.pass || !shadowReport?.pass) {
        throw new Error("A canary needs a passed offline gate and shadow.")
      }
      await tx
        .update(policyVersions)
        .set({ status: "canary", canaryPercent: CANARY_STEPS[0], approvedBy: ownerId })
        .where(eq(policyVersions.id, id))
      await record(tx, ownerId, "policy.canary", id, { percent: CANARY_STEPS[0] })
      return "canary" as const
    }
    if (row.status !== "canary") throw new Error(`Can't advance a ${row.status} version.`)
    const next = CANARY_STEPS.find((step) => step > row.canaryPercent)!
    if (next < 100) {
      await tx
        .update(policyVersions)
        .set({ canaryPercent: next, approvedBy: ownerId })
        .where(eq(policyVersions.id, id))
      await record(tx, ownerId, "policy.canary", id, { percent: next })
      return "canary" as const
    }
    await tx
      .update(policyVersions)
      .set({ status: "retired" })
      .where(eq(policyVersions.status, "active"))
    await tx
      .update(policyVersions)
      .set({ status: "active", canaryPercent: 0, approvedBy: ownerId })
      .where(eq(policyVersions.id, id))
    await record(tx, ownerId, "policy.activate", id, {})
    return "active" as const
  })
}

// A canary goes back to 0 %; an active version hands back to its parent
// (or to BASELINE when it had none). actorId null = automatic.
export async function rollback(
  id: string,
  reason: string,
  actorId: string | null = null
) {
  await privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    if (row.status !== "canary" && row.status !== "active") {
      throw new Error(`Can't roll back a ${row.status} version.`)
    }
    await tx
      .update(policyVersions)
      .set({ status: "rolled_back", canaryPercent: 0 })
      .where(eq(policyVersions.id, id))
    if (row.status === "active" && row.parentId) {
      const parent = await load(tx, row.parentId)
      if (parent.status === "retired") {
        await tx
          .update(policyVersions)
          .set({ status: "active" })
          .where(eq(policyVersions.id, parent.id))
      }
    }
    await record(tx, actorId, "policy.rollback", id, { reason, from: row.status })
  })
}

// The worker's check on a canary's live numbers
export async function checkCanary(id: string, active: Metrics, canary: Metrics) {
  const breaches = guardBreaches(active, canary)
  if (breaches.length > 0) await rollback(id, breaches.join("; "))
  return breaches
}

export type Policy = { id: string; hash: string; bundle: Bundle }

export const BASELINE_POLICY: Policy = {
  id: "baseline",
  hash: bundleHash(BASELINE),
  bundle: BASELINE,
}

const policyOf = (row: PolicyVersion): Policy => ({
  id: row.id,
  hash: row.bundleHash,
  bundle: bundleSchema.parse(row.bundle),
})

// The bundle a person's next run uses: the canary for people in its bucket,
// else the active version, else the code baseline
export async function bundleFor(userId: string): Promise<Policy> {
  const rows = await privileged
    .select()
    .from(policyVersions)
    .where(inArray(policyVersions.status, ["canary", "active"]))
  const canary = rows.find((row) => row.status === "canary")
  if (canary && inCanary(userId, canary.id, canary.canaryPercent)) return policyOf(canary)
  const active = rows.find((row) => row.status === "active")
  return active ? policyOf(active) : BASELINE_POLICY
}

// What the runner and maintenance use: the baseline while agents.improvement
// is off, so the switch off behaves exactly as before A12
export async function activePolicy(userId: string): Promise<Policy> {
  if ((await getSetting("agents.improvement")) !== "on") return BASELINE_POLICY
  return bundleFor(userId)
}

// Attribution: which version a task ran on (once per task)
export async function stampTask(taskId: string, policy: Policy) {
  await privileged
    .insert(policyTaskVersions)
    .values({ taskId, version: policy.id, bundleHash: policy.hash })
    .onConflictDoNothing()
}

/* ───────────────────────────── guard job ────────────────────────── */

// Below this many finished tasks a canary isn't judged yet
export const MIN_CANARY_TASKS = 20
const GUARD_WINDOW_DAYS = 7

// Live numbers per version over the window, read-only:
// - failedRate: share of finished tasks that failed (canceled don't count)
// - costPerTask: mean reported cost
// - needsReviewRate (owner 2026-10-19): share of tasks that left a ledger
//   entry needing review (arithmetic mismatch, missing GSTIN) or a citation
//   without its verbatim quote. Skill replays that drifted aren't stored per
//   task, so they don't count yet.
// - severity1 (owner 2026-10-19): tasks that stored a sensitive value in
//   memory. Unapproved side effects, exfiltration attempts and token
//   decryption failures have no per-task record yet (the gates refuse them
//   before they happen), so they don't count yet.
export async function versionMetrics(version: string) {
  const window = sql`v.version = ${version}
      and v.created_at > now() - make_interval(days => ${GUARD_WINDOW_DAYS})`
  const result = await privileged.execute(sql`
    select count(*)::int as n,
      coalesce(avg(case when t.status = 'failed' then 1.0 else 0.0 end), 0)::float8 as "failedRate",
      coalesce(avg(coalesce(u.cost, 0)), 0)::float8 as "costPerTask",
      coalesce(avg(case when exists (
          select 1 from kriya.ledger_entries l where l.task_id = t.id and l.status = 'needs_review'
        ) or exists (
          select 1 from kriya.episodes e
          where e.task_id = t.id and e.checks @> '[{"status": "unsupported"}]'
        ) then 1.0 else 0.0 end), 0)::float8 as "needsReviewRate"
    from kriya.policy_task_versions v
    join kriya.tasks t on t.id = v.task_id
    left join lateral (
      select sum(cost_micro_usd) as cost from kriya.usage_events e where e.task_id = t.id
    ) u on true
    where ${window} and t.status in ('succeeded', 'failed')`)
  const [row] = rowsOf<{
    n: number
    failedRate: number
    costPerTask: number
    needsReviewRate: number
  }>(result)
  // The sensitive check is code (lib/memory/sensitive.ts), so it runs here
  const notes = rowsOf<{
    taskId: string
    content: string
    slot: string | null
    source: "agent" | "user" | "derived"
  }>(
    await privileged.execute(sql`
      select m.task_id as "taskId", m.content, m.slot, m.source
      from kriya.policy_task_versions v
      join kriya.memories m on m.task_id = v.task_id
      where ${window}`)
  )
  const severity1 = new Set(
    notes
      .filter((note) => sensitiveKind(note.content, note) !== null)
      .map((n) => n.taskId)
  ).size
  return { ...row, severity1 }
}

// The worker's step: judge the canary against the active version (or the
// baseline) once it has enough tasks; a breach rolls it back. A severity-1
// case rolls it back at once, whatever the count.
export async function guardCanary() {
  const rows = await privileged
    .select()
    .from(policyVersions)
    .where(inArray(policyVersions.status, ["canary", "active"]))
  const canary = rows.find((row) => row.status === "canary")
  if (!canary) return null
  const active = rows.find((row) => row.status === "active")?.id ?? "baseline"
  const [c, a] = [await versionMetrics(canary.id), await versionMetrics(active)]
  if (c.n < MIN_CANARY_TASKS && c.severity1 === 0) {
    return { id: canary.id, waiting: c.n, breaches: [] }
  }
  const breaches = await checkCanary(canary.id, a, c)
  return { id: canary.id, waiting: 0, breaches }
}

// The owner console's list, newest first
export async function listVersions() {
  return privileged
    .select()
    .from(policyVersions)
    .orderBy(sql`${policyVersions.createdAt} desc`)
    .limit(50)
}
