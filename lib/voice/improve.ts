import type { LanguageModel } from "ai"
import { and, eq, gte, inArray, sql } from "drizzle-orm"

import { privileged, rowsOf, withUser } from "@/db"
import {
  attemptMetrics,
  auditEvents,
  callAttempts,
  callOutcomes,
  conversationTurns,
  voiceCalls,
  voiceCases,
  voicePolicyVersions,
  voiceProfiles,
  voiceTasks,
  voiceUsage,
  type VoiceCaseCode,
} from "@/db/schema"
import { getSetting, setSetting } from "@/lib/config"
import { log } from "@/lib/log"

import type { CallNotes, Turn } from "./dialogue"
import { fxSettings, sumVoiceCost } from "./metering"
import { checkOutcome, extractOutcome, type Interpreted } from "./outcome"
import { policyHash, validatePolicy } from "./policy"
import { v1 } from "./policy/v1"
import type { VoiceTaskSpec } from "./schemas"

// The governed improvement loop (voice phase 10, D-17, SELF_IMPROVEMENT.md
// §3). Production never changes itself: the janitor computes signals,
// groups cases and rolls back on its own; promotion always needs the
// owner. Signals and cases carry numbers and codes only. Call content is
// read only for the shadow stage, only for owners who opted in.
//
// The gate, the shadow bar, the canary steps and the guard check below are
// the same formulas as track A's lib/improve.ts. Not imported: that file
// loads agent code that reaches lib/connectors, which voice code must never
// load (voice rule 10, T-REM-07). ponytail: two copies of ~50 pure lines;
// move both into one dependency-free module when track A's file may change.

type Tx = Parameters<Parameters<typeof privileged.transaction>[0]>[0]

/* ───────────────────────────── gates ────────────────────────────── */

// One scenario's numbers; "higher is better" except the zero-tolerance
// counts, which must stay at 0
export type Metrics = Record<string, number>
export type GateRules = {
  target: string
  zero: string[]
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
    if (c[m] < a[m] - (rules.tolerance?.[m] ?? 0))
      reasons.push(`${m} worse (${a[m]} → ${c[m]})`)
  }
  return {
    pass: reasons.length === 0,
    n: candidate.length,
    active: a,
    candidate: c,
    reasons,
  }
}

export const SHADOW_AGREEMENT = 0.98
export const CANARY_STEPS = [5, 25, 100] as const

// A ratio guard with minDelta also fires from a zero base
export type Guard = { metric: string; max?: number; maxRatio?: number; minDelta?: number }
export function guardBreaches(active: Metrics, canary: Metrics, guards: Guard[]) {
  return guards.flatMap(({ metric, max, maxRatio, minDelta }) => {
    const value = canary[metric] ?? 0
    if (max !== undefined && value > max) return [`${metric} ${value} > ${max}`]
    const base = active[metric] ?? 0
    if (maxRatio === undefined || (base === 0 && minDelta === undefined)) return []
    const limit = Math.max(base * maxRatio, base + (minDelta ?? 0))
    return value > limit ? [`${metric} ${value} > ${limit} (active ${base})`] : []
  })
}

/* ───────────────────────────── signals ──────────────────────────── */

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

// One attempt's numbers and codes (§3.1). Turn timing and flags are read,
// never their text
export async function attemptMetricsFor(attemptId: string) {
  const [row] = rowsOf<{
    id: string
    user_id: string
    policy_version: string
    status: string
    end_reason: string | null
    connected: boolean
    billable_seconds: number | null
    kind: "outreach" | "owner_report" | "verification"
    verifier_status: string | null
    result: string | null
    disclosure_played: boolean | null
    opt_out: boolean
  }>(
    await privileged.execute(sql`
      select a.id, a.user_id, a.policy_version, a.status, a.end_reason,
             a.connected_at is not null as connected, a.billable_seconds, c.kind,
             o.verifier_status, o.interpreted ->> 'result' as result,
             (o.observed ->> 'disclosure_played')::boolean as disclosure_played,
             exists (select 1 from kriya.call_suppressions s
                     where s.source_attempt_id = a.id and s.reason = 'recipient_opt_out') as opt_out
      from kriya.call_attempts a
      join kriya.voice_calls c on c.id = a.voice_call_id
      left join kriya.call_outcomes o on o.call_attempt_id = a.id
      where a.id = ${attemptId}`)
  )
  if (!row) return null
  const turns = await privileged
    .select({
      seq: conversationTurns.seq,
      speaker: conversationTurns.speaker,
      startMs: conversationTurns.startMs,
      endMs: conversationTurns.endMs,
      confidence: conversationTurns.sttConfidence,
      interrupted: conversationTurns.interrupted,
    })
    .from(conversationTurns)
    .where(eq(conversationTurns.callAttemptId, attemptId))
    .orderBy(conversationTurns.seq)
  // Callee stops → Tavi starts (L1)
  const gaps: number[] = []
  for (let i = 1; i < turns.length; i++) {
    const [before, turn] = [turns[i - 1], turns[i]]
    if (
      turn.speaker === "tavi" &&
      before.speaker === "callee" &&
      before.endMs != null &&
      turn.startMs != null
    )
      gaps.push(Math.max(0, turn.startMs - before.endMs))
  }
  const fx = await fxSettings()
  const cost = sumVoiceCost(
    await privileged
      .select()
      .from(voiceUsage)
      .where(eq(voiceUsage.callAttemptId, attemptId)),
    fx.rate
  )
  return {
    callAttemptId: row.id,
    userId: row.user_id,
    policyVersion: row.policy_version,
    kind: row.kind,
    attemptStatus: row.status,
    endReason: row.end_reason,
    connected: row.connected,
    verifierStatus: row.verifier_status,
    result: row.result,
    disclosurePlayed: row.connected ? row.disclosure_played : null,
    turns: turns.length,
    lowConfTurns: turns.filter(
      (t) => t.confidence !== null && Number(t.confidence) < v1.thresholds.lowConfidence
    ).length,
    bargeins: turns.filter((t) => t.interrupted).length,
    latencyP50Ms: quantile(gaps, 0.5),
    latencyP95Ms: quantile(gaps, 0.95),
    optOut: row.opt_out,
    wrongPerson: row.result === "wrong_person",
    billableSeconds: row.billable_seconds,
    // Null when anything is unmetered or unconvertible: never a partial sum
    costMicroInr: cost.unmetered || cost.needsRate ? null : cost.microInr,
  }
}

// Every verified attempt whose outcome is settled gets one row, once
export async function computeMissingMetrics(limit = 200) {
  const due = rowsOf<{ id: string }>(
    await privileged.execute(sql`
      select a.id from kriya.call_attempts a
      left join kriya.attempt_metrics m on m.call_attempt_id = a.id
      left join kriya.call_outcomes o on o.call_attempt_id = a.id
      where a.verified_at is not null and m.call_attempt_id is null
        and (o.id is null or o.verifier_status <> 'pending')
      order by a.verified_at limit ${limit}`)
  )
  for (const { id } of due) {
    const values = await attemptMetricsFor(id)
    if (values)
      await privileged.insert(attemptMetrics).values(values).onConflictDoNothing()
  }
  return due.length
}

// The owner's correction of an outcome (§3.2), through their own session:
// RLS lets them correct only their own attempts
export async function recordFeedback(
  userId: string,
  input: {
    callAttemptId: string
    field: "result" | "agreed_times" | "proposed_times" | "questions" | "other"
    was?: string
    shouldBe?: string
    source: "app" | "voice"
  }
) {
  // Only the granted columns: the id and time are the database's, so a
  // correction can't be backdated into another week's case
  await withUser(userId, (tx) =>
    tx.execute(sql`
      insert into kriya.voice_feedback (user_id, call_attempt_id, field, was, should_be, source)
      values (${userId}, ${input.callAttemptId}, ${input.field}, ${input.was ?? null},
              ${input.shouldBe ?? null}, ${input.source})`)
  )
  return { ok: true as const }
}

/* ───────────────────────────── cases ────────────────────────────── */

// §3.3: false agreement and disclosure problems are severity 1
export const SEVERITY: Record<VoiceCaseCode, 1 | 2 | 3> = {
  false_agreement: 1,
  disclosure_issue: 1,
  missed_proposal: 2,
  wrong_time_parse: 2,
  stt_entity_error: 2,
  report_not_delivered: 2,
  invalid_tool_call: 2,
  injection_attempt: 2,
  sensitive_request: 2,
  provider_mismatch: 2,
  cost_overrun: 2,
  provider_drift: 2,
  ambiguity_not_asked: 3,
  tts_mispronunciation: 3,
  talked_over: 3,
  slow_response: 3,
  wrong_person_handling: 3,
  other: 3,
}

// Signals and corrections of the last two weeks, grouped into one case per
// code, policy version and week (Monday, IST). Safe to run every tick
export async function groupCases() {
  const week = (column: string) =>
    sql.raw(`(date_trunc('week', ${column} at time zone 'Asia/Kolkata'))::date`)
  const signals = rowsOf<{
    code: VoiceCaseCode
    attempt_id: string
    policy_version: string
    week: string
  }>(
    await privileged.execute(sql`
      with m as (
        select * from kriya.attempt_metrics where created_at >= now() - interval '14 days'
      )
      select 'disclosure_issue' as code, call_attempt_id as attempt_id, policy_version, ${week("created_at")} as week
        from m where kind = 'outreach' and connected and disclosure_played is false
      union all
      select 'wrong_person_handling', call_attempt_id, policy_version, ${week("created_at")}
        from m where wrong_person
      union all
      select 'slow_response', call_attempt_id, policy_version, ${week("created_at")}
        from m where latency_p95_ms > 2500
      union all
      select 'talked_over', call_attempt_id, policy_version, ${week("created_at")}
        from m where bargeins >= 3
      union all
      select 'stt_entity_error', call_attempt_id, policy_version, ${week("created_at")}
        from m where low_conf_turns >= 2
      union all
      select 'report_not_delivered', m.call_attempt_id, m.policy_version, ${week("m.created_at")}
        from m join kriya.call_attempts a on a.id = m.call_attempt_id
        join kriya.voice_calls c on c.id = a.voice_call_id
        where m.kind = 'owner_report' and c.status = 'exhausted' and c.delivered_at is null
      union all
      select case f.field
               when 'result' then case when lower(coalesce(f.was, '')) = 'agreed'
                                        and lower(coalesce(f.should_be, '')) <> 'agreed'
                                       then 'false_agreement' else 'other' end
               when 'agreed_times' then 'wrong_time_parse'
               when 'proposed_times' then 'missed_proposal'
               when 'questions' then 'ambiguity_not_asked'
               else 'other' end,
             f.call_attempt_id, coalesce(am.policy_version, 'v1'), ${week("f.created_at")}
        from kriya.voice_feedback f
        left join kriya.attempt_metrics am on am.call_attempt_id = f.call_attempt_id
        where f.created_at >= now() - interval '14 days'`)
  )
  const groups = new Map<
    string,
    { code: VoiceCaseCode; version: string; week: string; ids: Set<string> }
  >()
  for (const s of signals) {
    const key = `${s.code}|${s.policy_version}|${s.week}`
    const group = groups.get(key) ?? {
      code: s.code,
      version: s.policy_version,
      week: String(s.week).slice(0, 10),
      ids: new Set<string>(),
    }
    group.ids.add(s.attempt_id)
    groups.set(key, group)
  }
  for (const g of groups.values()) {
    await privileged
      .insert(voiceCases)
      .values({
        code: g.code,
        severity: SEVERITY[g.code],
        policyVersion: g.version,
        week: g.week,
        attemptIds: [...g.ids],
      })
      .onConflictDoUpdate({
        target: [voiceCases.code, voiceCases.policyVersion, voiceCases.week],
        set: {
          attemptIds: sql`(select array(select distinct unnest(${voiceCases.attemptIds} || excluded.attempt_ids)))`,
        },
      })
  }
  return groups.size
}

// §3.4: a confirmed case gets its de-identified regression scenario
// (tests/voice/scenarios/<id>.json, written as a reviewed code change)
export async function linkScenario(caseId: string, scenarioId: string) {
  await privileged
    .update(voiceCases)
    .set({ scenarioIds: sql`array_append(${voiceCases.scenarioIds}, ${scenarioId})` })
    .where(eq(voiceCases.id, caseId))
}

/* ───────────────────────────── lifecycle ────────────────────────── */

async function audit(
  tx: Tx,
  actorId: string | null,
  action: string,
  id: string,
  details: Record<string, unknown>
) {
  await tx.insert(auditEvents).values({
    actorId,
    action,
    targetType: "voice_policy_version",
    targetId: id,
    details,
  })
}

async function load(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(voicePolicyVersions)
    .where(eq(voicePolicyVersions.id, id))
    .for("update")
  if (!row) throw new Error(`No voice policy version ${id}.`)
  return row
}

// A candidate (§3.5): a complete, valid bundle that targets cases which all
// have their regression scenario
export async function proposeVersion(input: {
  bundle: unknown
  parentId?: string
  targets: string[]
  proposedBy: string
}) {
  const checked = validatePolicy(input.bundle)
  if (!checked.ok) return { ok: false as const, errors: checked.errors }
  const bundle = checked.bundle
  if (bundle.version === v1.version) {
    return { ok: false as const, errors: ["version: v1 is the code bundle"] }
  }
  const cases = input.targets.length
    ? await privileged
        .select()
        .from(voiceCases)
        .where(inArray(voiceCases.id, input.targets))
    : []
  const without = cases.filter((c) => c.scenarioIds.length === 0).map((c) => c.id)
  if (cases.length !== input.targets.length || without.length) {
    return {
      ok: false as const,
      errors: [
        `every target needs a case with a regression scenario (${without.join(", ") || "missing case"})`,
      ],
    }
  }
  await privileged.transaction(async (tx) => {
    await tx.insert(voicePolicyVersions).values({
      id: bundle.version,
      parentId: input.parentId ?? v1.version,
      bundle,
      bundleHash: policyHash(bundle),
      targets: input.targets,
      proposedBy: input.proposedBy,
    })
    await audit(tx, null, "voice.policy.propose", bundle.version, {
      proposedBy: input.proposedBy,
    })
  })
  return { ok: true as const, id: bundle.version }
}

// The voice suite's gate (§3.6): zero-tolerance metrics stay at 0, the
// targeted one improves, nothing else gets worse beyond its tolerance
export const VOICE_GATE = (target: string): GateRules => ({
  target,
  zero: ["falseAgreement", "unauthorized", "duplicateRing", "disclosureMissed"],
  tolerance: { fieldAccuracy: 0.01 },
  minRuns: 50,
})

// Paired results of the offline suite, active vs candidate, as run by the
// offline improver (scripted model + voice:eval). A pass moves to shadow
export async function recordOfflineGate(
  id: string,
  active: Metrics[],
  candidate: Metrics[],
  rules: GateRules
) {
  const report = offlineGate(active, candidate, rules)
  await privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    if (row.status !== "draft") throw new Error(`Can't gate a ${row.status} version.`)
    await tx
      .update(voicePolicyVersions)
      .set({ evalReport: report, status: report.pass ? "shadow" : "draft" })
      .where(eq(voicePolicyVersions.id, id))
    await audit(tx, null, "voice.policy.gate", id, {
      pass: report.pass,
      reasons: report.reasons,
    })
  })
  return report
}

const sameOutcome = (a: Interpreted, b: Interpreted) =>
  a.result === b.result &&
  JSON.stringify(a.agreed_times.map((t) => [t.date, t.time])) ===
    JSON.stringify(b.agreed_times.map((t) => [t.date, t.time]))

// Shadow (§3.6): the candidate re-extracts outcomes from the stored turns of
// recent accepted calls; compared, never used. Only owners who opted in,
// and only transcripts still within their retention
export async function runShadow(
  id: string,
  models: { model: LanguageModel; escalation?: LanguageModel | null },
  limit = 100
) {
  const [row] = await privileged
    .select()
    .from(voicePolicyVersions)
    .where(eq(voicePolicyVersions.id, id))
  if (!row || row.status !== "shadow")
    throw new Error("Only a version in shadow runs there.")
  const checked = validatePolicy(row.bundle)
  if (!checked.ok) throw new Error(`Invalid bundle: ${checked.errors.join("; ")}`)
  const candidates = await privileged
    .select({
      attemptId: callAttempts.id,
      spec: voiceTasks.spec,
      interpreted: callOutcomes.interpreted,
    })
    .from(callAttempts)
    .innerJoin(voiceCalls, eq(voiceCalls.id, callAttempts.voiceCallId))
    .innerJoin(voiceTasks, eq(voiceTasks.id, voiceCalls.voiceTaskId))
    .innerJoin(callOutcomes, eq(callOutcomes.callAttemptId, callAttempts.id))
    .innerJoin(
      voiceProfiles,
      and(
        eq(voiceProfiles.userId, callAttempts.userId),
        eq(voiceProfiles.improvementOptIn, true)
      )
    )
    .where(
      and(
        eq(callOutcomes.verifierStatus, "accepted"),
        eq(voiceCalls.kind, "outreach"),
        gte(callAttempts.createdAt, sql`now() - interval '30 days'`)
      )
    )
    .limit(limit)
  const disagreements: string[] = []
  let n = 0
  for (const c of candidates) {
    const stored = c.interpreted as (Interpreted & { notes?: CallNotes }) | null
    const turns: Turn[] = (
      await privileged
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.callAttemptId, c.attemptId))
        .orderBy(conversationTurns.seq)
    ).map((t) => ({
      seq: t.seq,
      speaker: t.speaker as "tavi" | "callee",
      text: t.text,
      confidence: t.sttConfidence === null ? null : Number(t.sttConfidence),
    }))
    if (!stored?.notes || turns.length === 0) continue
    n++
    const spec = c.spec as VoiceTaskSpec
    const extracted = await extractOutcome({
      spec,
      turns,
      notes: stored.notes,
      ...models,
      policy: checked.bundle,
    }).catch(() => null)
    const mine =
      extracted &&
      checkOutcome(extracted.interpreted, { spec, turns, notes: stored.notes })
    if (!mine || !sameOutcome(mine.interpreted, stored)) disagreements.push(c.attemptId)
  }
  const agreement = n ? 1 - disagreements.length / n : 0
  // Attempt ids only: the report holds no content
  const report = {
    n,
    agreement,
    pass: n > 0 && agreement >= SHADOW_AGREEMENT,
    disagreements,
  }
  await privileged
    .update(voicePolicyVersions)
    .set({ shadowReport: report })
    .where(eq(voicePolicyVersions.id, id))
  return report
}

const openSevere = (tx: Tx, id: string) =>
  tx
    .select({ id: voiceCases.id })
    .from(voiceCases)
    .where(
      and(
        eq(voiceCases.policyVersion, id),
        eq(voiceCases.severity, 1),
        eq(voiceCases.status, "open")
      )
    )

// The owner moves a version one step: shadow → canary 5 % → 25 % → 100 % →
// active. Never automatic; an open severity-1 case blocks every step
export async function advance(id: string, ownerId: string) {
  const step = await privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    if ((await openSevere(tx, id)).length) {
      throw new Error("A severity-1 case is open for this version.")
    }
    if (row.status === "shadow") {
      const shadow = row.shadowReport as { pass?: boolean } | null
      const gate = row.evalReport as GateReport | null
      if (!gate?.pass || !shadow?.pass) {
        throw new Error("A canary needs a passed offline gate and shadow.")
      }
      await tx
        .update(voicePolicyVersions)
        .set({ status: "canary", canaryPercent: CANARY_STEPS[0], approvedBy: ownerId })
        .where(eq(voicePolicyVersions.id, id))
      await audit(tx, ownerId, "voice.policy.canary", id, { percent: CANARY_STEPS[0] })
      return { status: "canary" as const, percent: CANARY_STEPS[0] as number }
    }
    if (row.status !== "canary") throw new Error(`Can't advance a ${row.status} version.`)
    const next = CANARY_STEPS.find((p) => p > row.canaryPercent)
    if (next !== undefined) {
      await tx
        .update(voicePolicyVersions)
        .set({ canaryPercent: next, approvedBy: ownerId })
        .where(eq(voicePolicyVersions.id, id))
      await audit(tx, ownerId, "voice.policy.canary", id, { percent: next })
      return { status: "canary" as const, percent: next as number }
    }
    await tx
      .update(voicePolicyVersions)
      .set({ status: "retired" })
      .where(eq(voicePolicyVersions.status, "active"))
    await tx
      .update(voicePolicyVersions)
      .set({ status: "active", canaryPercent: 0, approvedBy: ownerId })
      .where(eq(voicePolicyVersions.id, id))
    await audit(tx, ownerId, "voice.policy.active", id, {})
    return { status: "active" as const, percent: 0 }
  })
  // The setting is written after the transaction: it uses its own connection
  if (step.status === "active") await setSetting("voice.policyVersion", id, ownerId)
  return step
}

// A canary goes back to 0 %; an active version hands back to its parent.
// actorId null: automatic (§3.6)
export async function rollback(id: string, reason: string, actorId: string | null) {
  const result = await privileged.transaction(async (tx) => {
    const row = await load(tx, id)
    if (row.status !== "canary" && row.status !== "active") return null
    await tx
      .update(voicePolicyVersions)
      .set({ status: "rolled_back", canaryPercent: 0 })
      .where(eq(voicePolicyVersions.id, id))
    if (row.status === "active" && row.parentId !== v1.version) {
      await tx
        .update(voicePolicyVersions)
        .set({ status: "active" })
        .where(eq(voicePolicyVersions.id, row.parentId))
    }
    await audit(tx, actorId, "voice.policy.rollback", id, {
      reason,
      from: row.status,
      to: row.parentId,
    })
    return { from: row.status, parent: row.parentId }
  })
  if (!result) return null
  if (result.from === "active") {
    await setSetting("voice.policyVersion", result.parent, actorId)
  }
  log.warn("voice policy rolled back", { version: id, from: result.from, reason })
  return result
}

// Guard metrics (§3.6), version against the baseline it would replace
export const VOICE_GUARDS: Guard[] = [
  { metric: "severity1", max: 0 },
  { metric: "needsReviewRate", maxRatio: 1.5, minDelta: 0.05 },
  { metric: "optOutRate", maxRatio: 2, minDelta: 0.05 },
]
// Ratio guards judge only versions with this many connected calls
const MIN_GUARD_CALLS = 20

async function versionMetrics(version: string): Promise<Metrics> {
  const [row] = rowsOf<{ calls: number; review: number; opt_out: number }>(
    await privileged.execute(sql`
      select count(*)::int as calls,
             count(*) filter (where verifier_status = 'needs_review')::int as review,
             count(*) filter (where opt_out)::int as opt_out
      from kriya.attempt_metrics
      where policy_version = ${version} and kind = 'outreach' and connected
        and created_at >= now() - interval '7 days'`)
  )
  const [severe] = rowsOf<{ n: number }>(
    await privileged.execute(sql`
      select count(*)::int as n from kriya.voice_cases
      where policy_version = ${version} and severity = 1 and status = 'open'`)
  )
  const calls = row?.calls ?? 0
  return {
    calls,
    severity1: severe?.n ?? 0,
    needsReviewRate: calls ? (row?.review ?? 0) / calls : 0,
    optOutRate: calls ? (row?.opt_out ?? 0) / calls : 0,
  }
}

// From the janitor: a canary or a stored active version rolls back on its
// own at a severity-1 case or a breached guard. v1 (code) never rolls back
export async function checkRollbacks() {
  const live = await privileged
    .select()
    .from(voicePolicyVersions)
    .where(inArray(voicePolicyVersions.status, ["canary", "active"]))
  const activeId = (await getSetting("voice.policyVersion")) ?? v1.version
  const rolled: string[] = []
  for (const row of live) {
    const mine = await versionMetrics(row.id)
    const base = await versionMetrics(row.status === "canary" ? activeId : row.parentId)
    const guards =
      mine.calls >= MIN_GUARD_CALLS
        ? VOICE_GUARDS
        : VOICE_GUARDS.filter((g) => g.max !== undefined)
    const breaches = guardBreaches(base, mine, guards)
    if (breaches.length) {
      await rollback(row.id, breaches.join("; "), null)
      rolled.push(row.id)
    }
  }
  return rolled
}
