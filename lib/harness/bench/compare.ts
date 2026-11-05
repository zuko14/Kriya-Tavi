import fs from "node:fs/promises"
import { parseArgs } from "node:util"

import type { TaskResult } from "./run"
import { armSummary, compareArms } from "./stats"

// npx tsx lib/harness/bench/compare.ts --a noloop-1.json,noloop-2.json --b loop-1.json,loop-2.json
//
// Two arms of KriyaBench runs on the same seed set (harness upgrade U4,
// BENCHMARK_PLAN.md §4): each arm's pooled pass rate with its 95% interval,
// pass^k, spend per passed task (when the runs were metered), and the paired
// comparison run by run. Reads reports only; runs nothing.

const { values } = parseArgs({
  options: { a: { type: "string" }, b: { type: "string" } },
})
if (!values.a) {
  console.error("Usage: --a <report.json,…> [--b <report.json,…>]")
  process.exit(2)
}

type Stored = {
  seedVersion: string
  agent: string
  results: (TaskResult & { costMicroInr?: string | null })[]
}

async function load(list: string) {
  return Promise.all(
    list.split(",").map(async (file) => {
      const report = JSON.parse(await fs.readFile(file, "utf8")) as Stored
      // Reports store bigints as strings
      const results = report.results.map((r) => ({
        ...r,
        costMicroInr: typeof r.costMicroInr === "string" ? BigInt(r.costMicroInr) : null,
      })) as TaskResult[]
      return { ...report, results }
    })
  )
}

const pct = (perMille: number) => `${perMille / 10}%`
const inr = (micro: bigint | null) =>
  micro === null ? "unknown" : `₹${(Number(micro) / 1e6).toFixed(2)}`
function show(name: string, s: ReturnType<typeof armSummary>) {
  const ci = s.passCiPerMille
    ? `${pct(s.passCiPerMille[0])}–${pct(s.passCiPerMille[1])}`
    : "n/a"
  console.log(
    `${name}: ${s.passed}/${s.attempts} over ${s.runs} run(s) = ${pct(s.passPerMille)} (95% ${ci}); pass^${s.runs} ${pct(s.passAllRunsPerMille)} of ${s.tasks} tasks; spend ${inr(s.costMicroInr)}, per passed ${inr(s.costPerPassedMicroInr)}`
  )
  if (s.evidence) {
    const e = s.evidence
    console.log(
      `  records (${e.tasks} tasks): verified and passed ${pct(e.verifiedPerMille)}; said verified but failed ${e.falseVerified}; left unfinished ${e.unfinished}; blocked ${e.blocked}; recovered steps ${e.recoveredSteps}; check runs ${e.checkRuns} (${e.failedRuns} failed); builders ${e.builders} (${e.builderSteps} steps); stalled ${e.stalled}; interrupted ${e.interrupted}`
    )
  }
}

const a = await load(values.a)
show("A", armSummary(a))
if (values.b) {
  const b = await load(values.b)
  const c = compareArms(a, b)
  show("B", c.b)
  console.log(
    `Paired (${c.pairs} task runs): both ${c.both}, neither ${c.neither}, only A ${c.onlyA}, only B ${c.onlyB}; exact sign test p = ${c.p.toFixed(3)}${c.p < 0.05 ? "" : " (no difference shown at 95%)"}`
  )
}
