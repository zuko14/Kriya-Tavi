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
  // From the sessions' own records; 0 for reports without them
  unfinished: number
  blocked: number
  falseVerified: number
  heavyContext: number
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
    name: "loop-guard-on",
    // Only on top of the loop: with the loop off this would change two factors at once
    apply: (p) => (p.loop ? { ...p, loopGuard: true } : p),
    hypothesis:
      "Sending an agent back to unfinished steps and stopping builders that can't help turns abandoned plans into passes and spends less on blocked ones",
    signal: (s) => s.unfinished * 3 + s.falseVerified * 3 + s.blocked * 2,
    overhead: "one checkpoint per builder; a notice when a plan is left unfinished",
  },
  {
    name: "strict-loop-on",
    apply: (p) => (p.loop ? { ...p, strictLoop: true } : p),
    hypothesis:
      "Cheap checks first, refused test weakening and step rollback stop false passes and broken edits piling up",
    signal: (s) => s.falseVerified * 4,
    overhead: "the fast rungs per check; one extra check run per bug fix",
  },
  {
    name: "defensive-on",
    apply: (p) => (p.loop ? { ...p, defensive: true } : p),
    hypothesis:
      "Tracing the blast radius and reviewing the diff catches regressions in code the task's own tests never touch",
    signal: (s) => s.falseVerified * 3 + s.blocked,
    overhead:
      "neighbouring test suites before each pass; a pre-mortem per multi-step plan",
  },
  {
    name: "recon-on",
    apply: (p) => ({ ...p, recon: true }),
    hypothesis: "Outlines and bounded reads keep long tasks from filling the context",
    signal: (s) => s.heavyContext * 2,
    overhead: "two more tools in the list; a refused read costs one round",
  },
  {
    name: "jit-tools-on",
    apply: (p) => (p.loop ? { ...p, jitTools: true } : p),
    hypothesis: "Builders without unneeded tool schemas cost less for the same passes",
    signal: () => 0,
    overhead: "KriyaBench B5 lost passes when tools were cut; this cuts only heavy ones",
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
    unfinished: rows.filter((t) => (t.trajectory?.open ?? 0) > 0).length,
    blocked: rows.filter((t) => (t.trajectory?.blocked ?? 0) > 0).length,
    falseVerified: failed.filter((t) => t.trajectory?.status === "verified").length,
    // shortcut: a fixed line for a builder's peak context; per-model limits come with real runs
    heavyContext: rows.filter((t) => (t.trajectory?.peakTokens ?? 0) > 100_000).length,
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
