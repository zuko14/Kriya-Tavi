import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { commandAgent } from "./agent"
import { runBench } from "./run"
import { SEED } from "./seed"

// npx tsx lib/harness/bench/cli.ts --agent "kriya run --mode auto" \
//   [--only fix-range-sum,feature-rupees] [--out bench.json] [--keep]
//
// A real client run spends the signed-in person's Kriya allowance: only
// with the owner's go-ahead (AGENTS.md, model calls cost money).
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    only: { type: "string" },
    out: { type: "string", default: "bench.json" },
    keep: { type: "boolean", default: false },
    "timeout-minutes": { type: "string", default: "10" },
  },
})
if (!values.agent) {
  console.error(
    'Usage: --agent "kriya run --mode auto" [--only ids] [--out file] [--keep]'
  )
  process.exit(2)
}
const only = values.only?.split(",")
const tasks = only ? SEED.filter((t) => only.includes(t.id)) : SEED
if (only && tasks.length !== only.length) {
  console.error(`Unknown task id in --only: ${values.only}`)
  process.exit(2)
}

const report = await runBench(tasks, commandAgent(values.agent.split(/\s+/)), {
  agentTimeoutMs: Number(values["timeout-minutes"]) * 60_000,
  keep: values.keep,
})
const text = JSON.stringify(
  { ...report, finishedAt: new Date().toISOString() },
  (_, v) => (typeof v === "bigint" ? v.toString() : v),
  2
)
// A paid run must never be lost to a missing folder
await fs.mkdir(path.dirname(values.out!), { recursive: true })
await fs.writeFile(values.out!, text + "\n")
for (const r of report.results)
  console.log(
    `${r.status.padEnd(7)} ${r.id}${r.escaped ? " (escaped)" : ""}${r.leaked ? " (leaked)" : ""}`
  )
const s = report.summary
console.log(
  `\n${s.passed}/${s.valid} passed (seed ${report.seedVersion}), escaped ${s.escaped}, leaked ${s.leaked}; report in ${values.out}`
)
