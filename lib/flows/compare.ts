import type { TaskResult } from "@/lib/harness/bench/run"
import { gate } from "@/lib/harness/evolve/gate"

import type { Plan } from "./compile"
import { runPassed, type NodeRow } from "./engine"

// Compare (SD-13): two versions on the same cases, run for run, decided by
// KRHE's gate as it is. A flow has no hidden grader, so `passed` is what code
// can say: it completed and its checks held. Safety counters stay zero
// because they don't apply here, not because anything was measured.

export type CompareRun = {
  arm: "incumbent" | "candidate" | null
  caseIndex: number | null
  round: number | null
  status: string
  durationMs: number
  costMicroInr: bigint | null
  rows: NodeRow[]
}

const SETTLED = ["completed", "failed", "canceled"]

function report(
  seed: string,
  runs: CompareRun[],
  plan: Plan
): { seedVersion: string; results: TaskResult[] } {
  return {
    seedVersion: seed,
    results: runs.map((run) => ({
      id: `case-${run.caseIndex ?? 0}`,
      kind: "flow" as never,
      level: "flow" as never,
      status: runPassed(plan, run.status, run.rows) ? "passed" : "failed",
      verifyExit: null,
      escaped: false,
      leaked: false,
      tampered: false,
      constraintBroken: false,
      agentExit: null,
      agentTimedOut: false,
      durationMs: run.durationMs,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      costMicroInr: run.costMicroInr,
      agentOutputTail: "",
    })),
  }
}

/** The gate's verdict; only finished, complete rounds count */
export function compareVerdict(
  seed: string,
  runs: CompareRun[],
  plans: { incumbent: Plan; candidate: Plan }
) {
  const rounds = [...new Set(runs.map((r) => r.round ?? 0))].sort((a, b) => a - b)
  const arm = (name: "incumbent" | "candidate", round: number) =>
    runs.filter((r) => r.arm === name && (r.round ?? 0) === round)
  const finished = rounds.filter((round) =>
    [...arm("incumbent", round), ...arm("candidate", round)].every((r) =>
      SETTLED.includes(r.status)
    )
  )
  const side = (name: "incumbent" | "candidate") =>
    finished.map((round) => report(seed, arm(name, round), plans[name]))
  const pending = runs.filter((r) => !SETTLED.includes(r.status)).length
  if (finished.length === 0) return { pending, verdict: null }
  return { pending, verdict: gate(side("incumbent"), side("candidate")) }
}
