import type { TaskResult } from "../bench/run"
import { HarnessProfile, profileDiff, profileId } from "./profile"

// KRHE's Propose stage (RECURSIVE_HARNESS_EVOLUTION.md §4). Candidates are
// one-factor changes of the incumbent, so a measured effect can be put down
// to one change (Compose then joins changes that each held up). Which
// factors come first is decided by the incumbent's own failures, from
// fields the bench records; ties keep a fixed order. No model call, no
// randomness: the same evidence always proposes the same candidates.

type Report = { seedVersion: string; results: TaskResult[] }

export const MAX_CANDIDATES = 5

type Move = {
  name: string
  apply: (p: HarnessProfile) => HarnessProfile
  hypothesis: string
  // How strongly the incumbent's failures point at this move
  signal: (s: Signals) => number
  overhead: string
}

type Signals = {
  failed: number
  timedOut: number
  tampered: number
  multiFailed: number
  passed: number
  costly: boolean
}

const MOVES: Move[] = [
  {
    name: "loop-on",
    apply: (p) => ({ ...p, loop: true }),
    hypothesis:
      "Checking work with the project's own tests turns some failures into fixed passes",
    signal: (s) => s.failed,
    overhead: "verify runs and plan/step builders: more tokens and time per task",
  },
  {
    name: "loop-v2-on",
    // Only on top of the loop: with the loop off this would change two factors at once
    apply: (p) => (p.loop ? { ...p, loopV2: true } : p),
    hypothesis:
      "Dependency-aware steps, classified failures and set-aside attempts fix multi-part and repeated failures",
    signal: (s) => s.multiFailed * 2 + s.tampered,
    overhead: "one extra check run when tests changed; no extra model calls",
  },
  {
    // One factor: the turn budget's size (steps and minutes together)
    name: "more-steps",
    apply: (p) => ({
      ...p,
      maxSteps: Math.min(400, p.maxSteps * 2),
      turnMinutes: Math.min(120, p.turnMinutes * 2),
    }),
    hypothesis: "Tasks that ran out of time or steps pass with a larger turn budget",
    signal: (s) => s.timedOut * 3,
    overhead: "longer turns on hard tasks; the spend reservation still bounds them",
  },
  {
    name: "anchor-on",
    apply: (p) => ({ ...p, anchor: true }),
    hypothesis:
      "Keeping the request word for word stops long sessions losing a requirement in compaction",
    signal: (s) => s.timedOut + s.multiFailed,
    overhead: "the request repeated in each prompt",
  },
  {
    name: "minimal-tools",
    apply: (p) => ({ ...p, minimalTools: !p.minimalTools }),
    hypothesis:
      "A shorter tool list costs less per task for the same passes (or the full list passes more)",
    signal: (s) => (s.costly ? s.passed : 0),
    overhead: "none; fewer schema tokens when on",
  },
]

function signals(reports: Report[]): Signals {
  const rows = reports.flatMap((r) => r.results.filter((t) => t.status !== "invalid"))
  const failed = rows.filter((t) => t.status === "failed")
  const costs = rows
    .map((t) => t.costMicroInr)
    .filter((c): c is bigint => typeof c === "bigint")
  return {
    failed: failed.length,
    timedOut: failed.filter((t) => t.agentTimedOut).length,
    tampered: rows.filter((t) => t.tampered).length,
    multiFailed: failed.filter((t) => t.level === "multi" || t.level === "cap").length,
    passed: rows.length - failed.length,
    // shortcut: "costly" is any metered spend; a per-task cost baseline comes with more runs
    costly: costs.length > 0,
  }
}

/**
 * @param seen ids of profiles already evaluated (any verdict): never proposed again
 * @returns at most `k` distinct, valid candidates, each with its diff and hypothesis
 */
export function propose(
  incumbent: HarnessProfile,
  reports: Report[],
  { k = 3, seen = new Set<string>() } = {}
) {
  const s = signals(reports)
  const out: Array<{
    id: string
    move: string
    profile: HarnessProfile
    diff: ReturnType<typeof profileDiff>
    hypothesis: string
    signal: number
    overhead: string
  }> = []
  const ids = new Set([profileId(incumbent), ...seen])
  const ranked = MOVES.map((m, order) => ({ m, order, score: m.signal(s) })).sort(
    (a, b) => b.score - a.score || a.order - b.order
  )
  for (const { m, score } of ranked) {
    if (out.length >= Math.min(k, MAX_CANDIDATES)) break
    const parsed = HarnessProfile.safeParse(m.apply(incumbent))
    if (!parsed.success) continue
    const id = profileId(parsed.data)
    if (ids.has(id)) continue
    ids.add(id)
    out.push({
      id,
      move: m.name,
      profile: parsed.data,
      diff: profileDiff(incumbent, parsed.data),
      hypothesis: m.hypothesis,
      signal: score,
      overhead: m.overhead,
    })
  }
  return { signals: s, candidates: out }
}
