import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { HarnessProfile, pinnedEnv, profileId } from "../evolve/profile"
import { readCandidateFile } from "../scout/candidate-file"
import { commandAgent } from "./agent"
import { runBench } from "./run"
import { LEVELS, levelTasks } from "./seed"

// npx tsx lib/harness/bench/cli.ts --agent "kriya run --mode auto" \
//   [--only fix-range-sum,feature-rupees | --level easy|hard|multi|cap|role-<role>] [--out bench.json] [--keep]
//   [--meter "kriya usage --json"] [--status "kriya verify status --json"] [--profile profile.json]
//   [--cartridge-candidate candidate-<id>.json]
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
    // Harness 2.0 W9: the candidate arm of a cartridge benchmark
    "cartridge-candidate": { type: "string" },
  },
})
if (!values.agent) {
  console.error(
    'Usage: --agent "kriya run --mode auto" [--only ids | --level easy|hard|multi|cap|role-<role>] [--out file] [--keep]'
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
// The client reads KRIYA_CARTRIDGE_FILE only under KRIYA_BENCH=on, which only
// this runner sets (SELF_EVOLUTION §3): never inherited from the shell, so the
// incumbent arm can't run a candidate by accident
delete process.env.KRIYA_BENCH
delete process.env.KRIYA_CARTRIDGE_FILE
let candidate: { id: string; cartridgeId: string; sha256: string } | undefined
if (values["cartridge-candidate"]) {
  const file = path.resolve(values["cartridge-candidate"])
  try {
    const c = readCandidateFile(await fs.readFile(file, "utf8"))
    candidate = { id: c.candidateId, cartridgeId: c.cartridgeId, sha256: c.sha256 }
  } catch (error) {
    console.error(`--cartridge-candidate: ${(error as Error).message}`)
    process.exit(2)
  }
  process.env.KRIYA_BENCH = "on"
  process.env.KRIYA_CARTRIDGE_FILE = file
}
const only = values.only?.split(",")
// role-<role> (W8) is that role's own set, apart from SEED; --only picks within the level
const pool = levelTasks(values.level)
if (!pool) {
  console.error(`--level is one of ${LEVELS.join(", ")}`)
  process.exit(2)
}
const tasks = pool.filter((t) => !only || only.includes(t.id))
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
    ...(candidate && { cartridgeCandidate: candidate }),
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
