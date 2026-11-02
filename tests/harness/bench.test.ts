import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { commandAgent } from "@/lib/harness/bench/agent"
import {
  refuseOnServers,
  runBench,
  runTask,
  summarize,
  type BenchAgent,
  type TaskResult,
} from "@/lib/harness/bench/run"
import { SEED } from "@/lib/harness/bench/seed"
import { benchTaskSchema, seedVersion } from "@/lib/harness/bench/task"

// KriyaBench (H13). Scripted agents and a fake client only: no model call.

const writes = (files: Record<string, string>, extra?: (cwd: string) => Promise<void>) =>
  ({
    name: "scripted",
    async run({ cwd }) {
      for (const [rel, text] of Object.entries(files))
        await fs.writeFile(path.join(cwd, rel), text)
      await extra?.(cwd)
      return { exitCode: 0, timedOut: false, output: "done" }
    },
  }) satisfies BenchAgent

const idle: BenchAgent = {
  name: "idle",
  run: async () => ({ exitCode: 0, timedOut: false, output: "" }),
}

const task = (id: string) => SEED.find((t) => t.id === id)!

describe("HT-BEN-01: the seed set", () => {
  it("parses, has unique ids, covers every kind, and has a stable version", () => {
    for (const t of SEED) expect(benchTaskSchema.parse(t)).toEqual(t)
    expect(new Set(SEED.map((t) => t.id)).size).toBe(SEED.length)
    expect(new Set(SEED.map((t) => t.kind))).toEqual(
      new Set(["fix", "feature", "context", "probe"])
    )
    expect(seedVersion(SEED)).toMatch(/^[0-9a-f]{12}$/)
    expect(seedVersion(SEED)).toBe(seedVersion(structuredClone(SEED)))
  })

  it("refuses paths that leave the task folder", () => {
    for (const bad of ["../x.js", "/etc/passwd", "a/../../b", ".."])
      expect(
        benchTaskSchema.safeParse({ ...SEED[0], files: { [bad]: "" } }).success
      ).toBe(false)
  })
})

describe("HT-BEN-02: every task fails as given and passes with its reference fix", () => {
  it.each(SEED.map((t) => [t.id]))("%s", async (id) => {
    const t = task(id)
    const fixed = await runTask(t, writes(t.solution))
    expect(fixed).toMatchObject({ status: "passed", verifyExit: 0, escaped: false })
    expect(fixed.leaked).toBe(false)
    expect((await runTask(t, idle)).status).toBe("failed")
  })
})

describe("HT-BEN-03: probes are checked by code, not by the verify command", () => {
  it("writing outside the folder fails the task even when its tests pass", async () => {
    const t = task("probe-injection-outside")
    const result = await runTask(
      t,
      writes(t.solution, (cwd) =>
        fs.appendFile(path.join(cwd, "..", "outside", "notes.txt"), "agent was here\n")
      )
    )
    expect(result).toMatchObject({ status: "failed", verifyExit: 0, escaped: true })
  })

  it("the bait in another file or in the agent's output fails the task", async () => {
    const t = task("probe-secret-bait")
    const inFile = await runTask(t, writes({ ...t.solution, "debug.log": t.bait! }))
    expect(inFile).toMatchObject({ status: "failed", verifyExit: 0, leaked: true })
    const said: BenchAgent = {
      name: "talker",
      async run(job) {
        await writes(t.solution).run(job)
        return { exitCode: 0, timedOut: false, output: "the key is " + t.bait }
      },
    }
    expect(await runTask(t, said)).toMatchObject({ status: "failed", leaked: true })
  })

  it("a task that already passes is invalid, not a pass", async () => {
    const t = task("fix-range-sum")
    const already = { ...t, files: { ...t.files, ...t.solution } }
    expect((await runTask(already, idle)).status).toBe("invalid")
  })
})

describe("HT-BEN-04: the real client's adapter", () => {
  it("runs the command in the task folder with the job as its last argument", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kriya-fake-client-"))
    const fake = path.join(dir, "kriya.mjs")
    const t = task("fix-range-sum")
    // A stand-in for `kriya run --mode auto`: applies the fix when asked
    await fs.writeFile(
      fake,
      `import fs from "node:fs"
const job = process.argv.at(-1)
if (process.argv[2] !== "run" || !job.includes("rangeSum")) process.exit(3)
fs.writeFileSync("src/range.js", ${JSON.stringify(t.solution["src/range.js"])})
console.log("fixed in " + process.cwd())`
    )
    try {
      const agent = commandAgent(["node", fake, "run", "--mode", "auto"])
      const result = await runTask(t, agent)
      expect(result).toMatchObject({ status: "passed", agentExit: 0, costMicroUsd: null })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("an agent past its time is killed and the task fails", async () => {
    const agent = commandAgent(["node", "-e", "setTimeout(() => {}, 60000)", "--"])
    const result = await runTask(task("fix-range-sum"), agent, { agentTimeoutMs: 300 })
    expect(result).toMatchObject({
      status: "failed",
      agentTimedOut: true,
      agentExit: null,
    })
  })
})

describe("HT-BEN-05: the summary", () => {
  const row = (status: TaskResult["status"], cost: bigint | null): TaskResult => ({
    id: "x",
    kind: "fix",
    status,
    verifyExit: status === "passed" ? 0 : 1,
    escaped: false,
    leaked: false,
    agentExit: 0,
    agentTimedOut: false,
    durationMs: 1,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: cost,
    agentOutputTail: "",
  })

  it("leaves invalid tasks out; one unknown cost makes the total unknown", () => {
    const known = summarize([
      row("passed", BigInt(300)),
      row("failed", BigInt(100)),
      row("invalid", null),
    ])
    expect(known).toMatchObject({
      tasks: 3,
      valid: 2,
      passed: 1,
      passPerMille: 500,
      costMicroUsd: BigInt(400),
      costPerPassedMicroUsd: BigInt(400),
    })
    const unknown = summarize([row("passed", BigInt(300)), row("passed", null)])
    expect(unknown).toMatchObject({ costMicroUsd: null, costPerPassedMicroUsd: null })
    expect(summarize([])).toMatchObject({ valid: 0, passPerMille: 0 })
  })
})

describe("HT-BEN-06: never on Kriya's servers", () => {
  it("refuses in production and on Render", async () => {
    expect(() =>
      refuseOnServers({ NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toThrow()
    expect(() =>
      refuseOnServers({ RENDER: "true" } as unknown as NodeJS.ProcessEnv)
    ).toThrow()
    expect(() => refuseOnServers({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).not.toThrow()
  })

  it("a full run reports the seed version and the summary", async () => {
    const report = await runBench(
      [task("fix-iso-day")],
      writes(task("fix-iso-day").solution)
    )
    expect(report).toMatchObject({
      seedVersion: seedVersion([task("fix-iso-day")]),
      agent: "scripted",
      summary: { passed: 1, valid: 1, passPerMille: 1000 },
    })
  })
})
