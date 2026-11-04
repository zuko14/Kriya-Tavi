import { createHash } from "node:crypto"

import type { gate } from "./gate"
import { RULES } from "./gate"
import type { profileDiff } from "./profile"

// KRHE's improvement library (RECURSIVE_HARNESS_EVOLUTION.md §6): what a
// change did, under what conditions, from which runs. A lesson is written
// by code from a gate result, never by a model. Lifecycle:
//
//   proposed  → one cohort of evidence
//   validated → two independent cohorts (different reports) agree, none contradicts
//   approved  → the owner approved it (approveLesson, run by the owner only)
//   deprecated→ later evidence significantly contradicts it (also when approved)
//   rejected  → a cohort failed a hard constraint (safety)
//
// Scope is explicit (model, seed set, agent command, the incumbent): a
// lesson is retrieved only for the same model; anything else is a guess.

export type Scope = {
  model: string
  seedVersion: string
  agent: string
  incumbentId: string
}
type Result = ReturnType<typeof gate>
type Evidence = {
  at: string
  reports: string[]
  runs: number
  pairs: number
  onlyIncumbent: number
  onlyCandidate: number
  p: number
  costChangePerMille: number | null
  verdict: Result["verdict"]
  reasons: string[]
}
export type Lesson = {
  id: string
  statement: string
  scope: Scope
  change: ReturnType<typeof profileDiff>
  status: "proposed" | "validated" | "approved" | "deprecated" | "rejected"
  evidence: Evidence[]
  approvedAt?: string
}

/** The content hash of a report file: evidence names exactly the runs it came from */
export const reportHash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

const key = (scope: Scope, change: Lesson["change"]) =>
  createHash("sha256")
    .update(JSON.stringify([scope.model, scope.seedVersion, scope.incumbentId, change]))
    .digest("hex")
    .slice(0, 12)

// +1 the change showed a gain, -1 a loss, 0 nothing shown
const direction = (e: Evidence) =>
  e.p < RULES.alpha ? Math.sign(e.onlyCandidate - e.onlyIncumbent) : 0

function statement(change: Lesson["change"], scope: Scope, e: Evidence) {
  const what = change.map((d) => `${d.key} ${d.from} → ${d.to}`).join(", ")
  const cost =
    e.costChangePerMille === null
      ? "cost unknown"
      : `cost per pass ${e.costChangePerMille >= 0 ? "+" : ""}${e.costChangePerMille / 10}%`
  return `On ${scope.model}, seed ${scope.seedVersion}: ${what} passed ${e.onlyCandidate} pairs the incumbent failed and failed ${e.onlyIncumbent} it passed (${e.pairs} pairs, p = ${e.p.toFixed(3)}), ${cost}.`
}

function status(lesson: Lesson): Lesson["status"] {
  const ev = lesson.evidence
  if (
    ev.some(
      (e) => e.verdict === "reject" && e.reasons.some((r) => r.startsWith("worse on"))
    )
  )
    return "rejected"
  const dirs = ev.map(direction)
  const first = dirs.find((d) => d !== 0) ?? 0
  if (first !== 0 && dirs.some((d) => d === -first)) return "deprecated"
  if (lesson.status === "approved") return "approved"
  const cohorts = new Set(
    ev
      .filter((e) => direction(e) === first && first !== 0)
      .map((e) => e.reports.join(","))
  )
  return cohorts.size >= 2 ? "validated" : "proposed"
}

/** Adds one gate result as evidence; returns the updated library and the lesson it touched */
export function recordEvidence(
  lessons: Lesson[],
  input: {
    scope: Scope
    change: Lesson["change"]
    result: Result
    reports: string[]
    at: string
  }
) {
  const { scope, change, result, reports, at } = input
  const m = result.metrics
  const e: Evidence = {
    at,
    reports: [...reports].sort(),
    runs: m.runs,
    pairs: m.pairs,
    onlyIncumbent: m.onlyIncumbent,
    onlyCandidate: m.onlyCandidate,
    p: m.p,
    costChangePerMille: m.costChangePerMille,
    verdict: result.verdict,
    reasons: result.reasons,
  }
  const id = key(scope, change)
  const old = lessons.find((l) => l.id === id)
  // The same reports twice are one cohort, not two
  if (old?.evidence.some((x) => x.reports.join(",") === e.reports.join(",")))
    return { lessons, lesson: old }
  const base: Lesson = old ?? {
    id,
    statement: "",
    scope,
    change,
    status: "proposed",
    evidence: [],
  }
  const next: Lesson = { ...base, evidence: [...base.evidence, e] }
  next.status = status(next)
  next.statement = statement(change, scope, e)
  return { lessons: [...lessons.filter((l) => l.id !== id), next], lesson: next }
}

/** The owner approves a validated lesson (CLI only, by the owner) */
export function approveLesson(lessons: Lesson[], id: string, at: string) {
  const l = lessons.find((x) => x.id === id)
  if (!l) throw new Error(`No lesson ${id}.`)
  if (l.status !== "validated")
    throw new Error(
      `Lesson ${id} is ${l.status}; only a validated lesson can be approved.`
    )
  return lessons.map((x) =>
    x.id === id ? { ...x, status: "approved" as const, approvedAt: at } : x
  )
}

/** Lessons that apply: same model, and approved, or (`all`) any not rejected or deprecated */
export function applicable(lessons: Lesson[], model: string, { all = false } = {}) {
  return lessons.filter(
    (l) =>
      l.scope.model === model &&
      (all
        ? l.status !== "rejected" && l.status !== "deprecated"
        : l.status === "approved")
  )
}
