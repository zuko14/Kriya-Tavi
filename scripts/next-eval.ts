import { spawnSync } from "node:child_process"
import fs from "node:fs"

// `npm run next:eval -- --model <openrouter id> --go [--n 3] [--out file.json]`
// Paid (EVALUATION_PLAN §4): NG-01, 03, 05, 12 and 17 on a real model, n runs
// each, against PGlite, the fixture MCP app and faked connectors. It refuses
// without --go (the owner's go-ahead for spend) and without OPENROUTER_API_KEY
// in the shell. It loads no .env file and strips every database variable from
// the child, so it can never touch the live Supabase project. Never in CI.

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const model = flag("--model")
const n = flag("--n") ?? "3"
const out = flag("--out") ?? `next-eval-${Date.now()}.json`

if (!model || !args.includes("--go") || !/^[1-9]\d?$/.test(n)) {
  console.error(
    "Usage: OPENROUTER_API_KEY=… npm run next:eval -- --model <openrouter model id> --go [--n 3] [--out file.json]\n" +
      "--go says the owner approved the spend: 5 scenarios × n runs, each a few model calls."
  )
  process.exit(1)
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set in this shell.")
  process.exit(1)
}

const env = { ...process.env }
for (const key of Object.keys(env))
  if (/^(DATABASE|MIGRATION_DATABASE|SUPABASE|NEXT_PUBLIC_SUPABASE|DB_)/.test(key))
    delete env[key]
env.KRIYA_NEXT_EVAL_MODEL = model
env.KRIYA_NEXT_EVAL_N = n
env.KRIYA_EVAL_OUT = out

const run = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "tests/next/eval", "--reporter=verbose"],
  { env, stdio: "inherit" }
)

if (fs.existsSync(out)) {
  const { results } = JSON.parse(fs.readFileSync(out, "utf8")) as {
    results: { pass: boolean; costMicroUsd: number | null }[]
  }
  const passed = results.filter((r) => r.pass).length
  // Cumulative per world, so the last row of a run is its total; shown as reported
  const unpriced = results.filter((r) => r.costMicroUsd === null).length
  console.log(
    `\n${passed}/${results.length} runs passed · ${unpriced} without a reported cost · details in ${out}`
  )
  process.exit(passed === results.length && run.status === 0 ? 0 : 1)
}
process.exit(run.status ?? 1)
