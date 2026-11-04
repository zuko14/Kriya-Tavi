import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import type { TaskResult } from "../bench/run"
import { compose } from "./compose"
import { gate } from "./gate"
import { approveLesson, type Lesson, recordEvidence, reportHash } from "./library"
import { HarnessProfile, profileDiff, profileId } from "./profile"
import { propose } from "./propose"

// KRHE offline (RECURSIVE_HARNESS_EVOLUTION.md §7): one turn of the
// recursion on recorded KriyaBench reports. Reads reports and profiles,
// writes only the files named (--json, --library, --out-dir); never runs an
// agent or calls a model. Probing a candidate is a KriyaBench run with
// --profile, which spends model allowance: the owner's go-ahead first.
//
//   evaluate --incumbent a1.json,a2.json,a3.json --candidate b1.json,… [--incumbent-profile p.json --candidate-profile q.json]
//            [--model <id> --library lessons.json] [--json gated.json]
//   propose  --incumbent-profile p.json --reports a1.json,… [--k 3] [--library lessons.json --model <id>] [--out-dir dir]
//   compose  --incumbent-profile p.json --gated g1.json,g2.json
//   approve  --library lessons.json --id <lesson id>        (the owner only)
//   lessons  --library lessons.json [--model <id>]

const [command, ...rest] = process.argv.slice(2)
const { values } = parseArgs({
  args: rest,
  options: {
    incumbent: { type: "string" },
    candidate: { type: "string" },
    reports: { type: "string" },
    "incumbent-profile": { type: "string" },
    "candidate-profile": { type: "string" },
    gated: { type: "string" },
    model: { type: "string" },
    library: { type: "string" },
    json: { type: "string" },
    "out-dir": { type: "string" },
    id: { type: "string" },
    k: { type: "string", default: "3" },
  },
})

type Stored = {
  seedVersion: string
  agent: string
  profile?: unknown
  results: TaskResult[]
}

async function load(list: string) {
  return Promise.all(
    list.split(",").map(async (file) => {
      const text = await fs.readFile(file, "utf8")
      const report = JSON.parse(text) as Stored
      const results = report.results.map((r) => ({
        ...r,
        costMicroInr: typeof r.costMicroInr === "string" ? BigInt(r.costMicroInr) : null,
      })) as TaskResult[]
      return { ...report, results, hash: reportHash(text) }
    })
  )
}

const readProfile = async (file: string) =>
  HarnessProfile.parse(JSON.parse(await fs.readFile(file, "utf8")))

/** The profile the runs were pinned to (bench --profile), or the one given; all runs must agree */
async function profileOf(reports: Stored[], file: string | undefined, which: string) {
  if (file) return readProfile(file)
  const ids = new Set(
    reports.map((r) => (r.profile ? profileId(HarnessProfile.parse(r.profile)) : "none"))
  )
  if (ids.size !== 1 || ids.has("none"))
    throw new Error(
      `The ${which} reports don't name one profile; pass --${which}-profile.`
    )
  return HarnessProfile.parse(reports[0].profile)
}

const readLibrary = async (file: string): Promise<Lesson[]> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")).lessons
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
const writeJson = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
  )
}
const need = (name: keyof typeof values) => {
  const v = values[name]
  if (typeof v !== "string" || !v) throw new Error(`${command} needs --${name}.`)
  return v
}

switch (command) {
  case "evaluate": {
    const a = await load(need("incumbent"))
    const b = await load(need("candidate"))
    const pa = await profileOf(a, values["incumbent-profile"], "incumbent")
    const pb = await profileOf(b, values["candidate-profile"], "candidate")
    const result = gate(a, b)
    console.log(
      `${result.verdict.toUpperCase()}: ${profileId(pb)} against ${profileId(pa)}`
    )
    for (const r of result.reasons) console.log(`  - ${r}`)
    console.log(
      JSON.stringify(
        result.metrics,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2
      )
    )
    if (values.json)
      await writeJson(values.json, {
        profile: pb,
        verdict: result.verdict,
        margin: result.metrics.onlyCandidate - result.metrics.onlyIncumbent,
      })
    if (values.library) {
      const library = await readLibrary(values.library)
      const { lessons, lesson } = recordEvidence(library, {
        scope: {
          model: need("model"),
          seedVersion: b[0].seedVersion,
          agent: b[0].agent,
          incumbentId: profileId(pa),
        },
        change: profileDiff(pa, pb),
        result,
        reports: [...a, ...b].map((r) => r.hash),
        at: new Date().toISOString(),
      })
      await writeJson(values.library, { version: 1, lessons })
      console.log(`Lesson ${lesson.id}: ${lesson.status}. ${lesson.statement}`)
    }
    break
  }
  case "propose": {
    const incumbent = await readProfile(need("incumbent-profile"))
    const reports = await load(need("reports"))
    // Changes already measured for this model are not proposed again
    const seen = new Set<string>()
    const measured =
      values.library && values.model ? await readLibrary(values.library) : []
    for (const l of measured)
      if (
        l.scope.model === values.model &&
        l.scope.incumbentId === profileId(incumbent)
      ) {
        const parsed = HarnessProfile.safeParse({
          ...incumbent,
          ...Object.fromEntries(l.change.map((d) => [d.key, d.to])),
        })
        if (parsed.success) seen.add(profileId(parsed.data))
      }
    const { signals, candidates } = propose(incumbent, reports, {
      k: Number(values.k),
      seen,
    })
    console.log(
      `Incumbent ${profileId(incumbent)}; failure signals ${JSON.stringify(signals)}`
    )
    for (const c of candidates) {
      console.log(
        `\n${c.id} (${c.move}, signal ${c.signal}): ${c.diff.map((d) => `${d.key} ${d.from} → ${d.to}`).join(", ")}\n  why: ${c.hypothesis}\n  cost: ${c.overhead}`
      )
      if (values["out-dir"]) {
        const file = path.join(values["out-dir"], `${c.id}.json`)
        await writeJson(file, c.profile)
        console.log(
          `  probe (paid; owner's go-ahead): npx tsx lib/harness/bench/cli.ts --agent "node $K run --mode auto" --profile ${file} --level cap --meter "node $K usage --json" --out <dir>/${c.id}-<run>.json  (×3, interleaved with the incumbent)`
        )
      }
    }
    if (!candidates.length)
      console.log(
        "No new candidate: every one-factor change was measured already. Keep the incumbent."
      )
    break
  }
  case "compose": {
    const incumbent = await readProfile(need("incumbent-profile"))
    const gated = await Promise.all(
      need("gated")
        .split(",")
        .map(async (f) => JSON.parse(await fs.readFile(f, "utf8")))
    )
    const out = compose(
      incumbent,
      gated.map((g) => ({ ...g, profile: HarnessProfile.parse(g.profile) }))
    )
    console.log(JSON.stringify(out, null, 2))
    break
  }
  case "approve": {
    const file = need("library")
    await writeJson(file, {
      version: 1,
      lessons: approveLesson(
        await readLibrary(file),
        need("id"),
        new Date().toISOString()
      ),
    })
    console.log(`Approved ${values.id}.`)
    break
  }
  case "lessons": {
    const library = await readLibrary(need("library"))
    for (const l of values.model
      ? library.filter((x) => x.scope.model === values.model)
      : library)
      console.log(`${l.id} ${l.status.padEnd(10)} ${l.statement}`)
    break
  }
  default:
    console.error(
      "Commands: evaluate, propose, compose, approve, lessons (see the top of lib/harness/evolve/cli.ts)"
    )
    process.exit(2)
}
