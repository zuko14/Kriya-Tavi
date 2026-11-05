import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { HarnessProfile, pinnedEnv, profileId } from "../evolve/profile"
import { commandAgent } from "./agent"
import { runBench } from "./run"
import { SEED } from "./seed"

// npx tsx lib/harness/bench/cli.ts --agent "kriya run --mode auto" \
//   [--only fix-range-sum,feature-rupees | --level easy|hard|multi|cap] [--out bench.json] [--keep]
//   [--meter "kriya usage --json"] [--status "kriya verify status --json"] [--profile profile.json]
//
// --profile (KRHE, RECURSIVE_HARNESS_EVOLUTION.md): the run is pinned to a
// harness profile: its switches and limits go to the agent's environment,
// and the report records the profile, so evidence names what produced it.
//
// A real client run spends the signed-in person's Kriya allowance: only
// with the owner's go-ahead (AGENTS.md, model calls cost money).
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    only: { type: "string" },
    level: { type: "string" },
    out: { type: "string", default: "bench.json" },
    keep: { type: "boolean", default: false },
    "timeout-minutes": { type: "string", default: "10" },
    // e.g. "kriya usage --json": each task's spend from Kriya's ledger (U4)
    meter: { type: "string" },
    // e.g. "kriya verify status --json": each task's own record of the run
    status: { type: "string" },
    profile: { type: "string" },
  },
})
if (!values.agent) {
  console.error(
    'Usage: --agent "kriya run --mode auto" [--only ids | --level easy|hard|multi] [--out file] [--keep]'
  )
  process.exit(2)
}
const agentArgs = values.agent.split(/\s+/)
let profile: HarnessProfile | undefined
if (values.profile) {
  profile = HarnessProfile.parse(JSON.parse(await fs.readFile(values.profile, "utf8")))
  try {
    // A switch flag beats the environment in the client, so it would un-pin the run
    Object.assign(process.env, pinnedEnv(agentArgs, profile))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(2)
  }
}
const only = values.only?.split(",")
if (values.level && !["easy", "hard", "multi", "cap"].includes(values.level)) {
  console.error("--level is easy, hard, multi or cap")
  process.exit(2)
}
const tasks = SEED.filter(
  (t) => (!only || only.includes(t.id)) && (!values.level || t.level === values.level)
)
if (only && tasks.length !== only.length) {
  console.error(`Unknown task id in --only: ${values.only}`)
  process.exit(2)
}

const report = await runBench(
  tasks,
  commandAgent(agentArgs, values.meter?.split(/\s+/), values.status?.split(/\s+/)),
  {
    agentTimeoutMs: Number(values["timeout-minutes"]) * 60_000,
    keep: values.keep,
  }
)
const text = JSON.stringify(
  {
    ...report,
    ...(profile && { profile, profileId: profileId(profile) }),
    finishedAt: new Date().toISOString(),
  },
  (_, v) => (typeof v === "bigint" ? v.toString() : v),
  2
)
// A paid run must never be lost to a missing folder
await fs.mkdir(path.dirname(values.out!), { recursive: true })
await fs.writeFile(values.out!, text + "\n")
for (const r of report.results)
  console.log(
    `${r.status.padEnd(7)} ${r.id}${r.escaped ? " (escaped)" : ""}${r.leaked ? " (leaked)" : ""}${r.tampered ? " (tampered)" : ""}`
  )
const s = report.summary
const pct = (perMille: number | null) =>
  perMille === null ? "none run" : `${perMille / 10}%`
console.log(
  `\n${s.passed}/${s.valid} passed, 95% ${s.passCiPerMille ? `${s.passCiPerMille[0] / 10}–${s.passCiPerMille[1] / 10}%` : "n/a"} (easy ${pct(s.easyPerMille)}, hard ${pct(s.hardPerMille)}, multi ${pct(s.multiPerMille)}, cap ${pct(s.capPerMille)}; seed ${report.seedVersion}), escaped ${s.escaped}, leaked ${s.leaked}, tampered ${s.tampered}; report in ${values.out}`
)
