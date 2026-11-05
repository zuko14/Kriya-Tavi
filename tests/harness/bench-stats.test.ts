import { parseTrajectory } from "@/lib/harness/bench/trajectory"
import { describe, expect, it } from "vitest"

import { commandAgent } from "@/lib/harness/bench/agent"
import type { TaskResult } from "@/lib/harness/bench/run"
import {
  armSummary,
  compareArms,
  signTestP,
  wilsonPerMille,
} from "@/lib/harness/bench/stats"

// Harness upgrade U4 (HU-BEN-01…03): KriyaBench's statistics and spend
// meter. Pure arithmetic and a scripted meter: no model call.

const row = (id: string, passed: boolean, costMicroInr: bigint | null = null) =>
  ({ id, status: passed ? "passed" : "failed", costMicroInr }) as TaskResult
const report = (rows: TaskResult[], seedVersion = "s1") => ({
  seedVersion,
  results: rows,
})

describe("HU-BEN-01: intervals and the sign test", () => {
  it("Wilson 95% intervals match the published values", () => {
    // 12/12 is not "100%": the interval reaches down to ~75.8%
    expect(wilsonPerMille(12, 12)).toEqual([757, 1000])
    expect(wilsonPerMille(11, 12)).toEqual([646, 986])
    expect(wilsonPerMille(0, 10)).toEqual([0, 278])
    expect(wilsonPerMille(0, 0)).toBeNull()
  })

  it("the exact two-sided sign test on discordant pairs", () => {
    expect(signTestP(0, 0)).toBe(1)
    expect(signTestP(0, 6)).toBeCloseTo(0.03125, 6)
    expect(signTestP(1, 5)).toBeCloseTo(0.21875, 6)
    expect(signTestP(3, 3)).toBe(1)
  })
})

describe("HU-BEN-02: arms over several runs", () => {
  it("pooled rate, pass^k, spend per passed task; unknown spend stays unknown", () => {
    const a = [
      report([row("t1", true, BigInt(100)), row("t2", false, BigInt(50))]),
      report([row("t1", true, BigInt(120)), row("t2", true, BigInt(30))]),
    ]
    expect(armSummary(a)).toMatchObject({
      runs: 2,
      attempts: 4,
      passed: 3,
      passPerMille: 750,
      tasks: 2,
      // only t1 passed in both runs
      passAllRunsPerMille: 500,
      costMicroInr: BigInt(300),
      costPerPassedMicroInr: BigInt(100),
    })
    expect(armSummary([report([row("t1", true, null)])]).costMicroInr).toBeNull()
    expect(() => armSummary([report([]), report([], "s2")])).toThrow(
      /different seed sets/
    )
  })

  it("paired run by run; different seeds can't be compared", () => {
    const a = [report([row("t1", true), row("t2", false), row("t3", false)])]
    const b = [report([row("t1", true), row("t2", true), row("t3", true)])]
    expect(compareArms(a, b)).toMatchObject({
      pairs: 3,
      both: 1,
      onlyA: 0,
      onlyB: 2,
      p: 0.5,
    })
    expect(() => compareArms(a, [report([], "other")])).toThrow(/seed/)
  })
})

describe("HU-BEN-03: the spend meter around a run", () => {
  it("the ledger's difference; a failed meter or an unpriced request leaves it unknown", async () => {
    const meter = (used: number, unpriced = 0) => [
      "node",
      "-e",
      `console.log(JSON.stringify({ usedMicroInr: ${used}, unpriced: ${unpriced} }))`,
    ]
    // A meter that reads a counter file the "agent" moves on
    const file = `${process.env.TMPDIR ?? "/tmp"}/kriya-meter-${process.pid}.json`
    const fs = await import("node:fs/promises")
    await fs.writeFile(file, JSON.stringify({ usedMicroInr: 1000, unpriced: 0 }))
    const read = [
      "node",
      "-e",
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"))`,
    ]
    const spend = [
      "node",
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({ usedMicroInr: 1450, unpriced: 0 }))`,
    ]
    const turn = await commandAgent(spend, read).run({
      cwd: process.cwd(),
      prompt: "x",
      timeoutMs: 30_000,
    })
    expect(turn.costMicroInr).toBe(BigInt(450))
    await fs.rm(file, { force: true })

    const unpriced = await commandAgent(["node", "-e", ""], meter(5, 1)).run({
      cwd: process.cwd(),
      prompt: "x",
      timeoutMs: 30_000,
    })
    // Same reading before and after: 0 spent, and nothing unpriced in between
    expect(unpriced.costMicroInr).toBe(BigInt(0))
    const broken = await commandAgent(
      ["node", "-e", ""],
      ["node", "-e", "console.log('not json')"]
    ).run({ cwd: process.cwd(), prompt: "x", timeoutMs: 30_000 })
    expect(broken.costMicroInr).toBeNull()
    const none = await commandAgent(["node", "-e", ""]).run({
      cwd: process.cwd(),
      prompt: "x",
      timeoutMs: 30_000,
    })
    expect(none.costMicroInr).toBeNull()
  })
})

describe("HU-BEN-05: the session's own record", () => {
  it("parses `kriya verify status --json`, and nothing else", () => {
    const line = JSON.stringify({
      status: "partial",
      steps: [],
      runs: [],
      trajectory: { plans: 1, planned: 3, open: 2, builders: 1, classes: { syntax: 1 } },
    })
    expect(parseTrajectory(`warning\n${line}\n`)).toMatchObject({
      status: "partial",
      open: 2,
      builders: 1,
    })
    expect(parseTrajectory("Unknown verify command status")).toBeNull()
    expect(parseTrajectory("")).toBeNull()
  })

  it("the agent reads the status command in the task's folder; none, or an old client, is null", async () => {
    const job = { cwd: process.cwd(), prompt: "x", timeoutMs: 30_000 }
    const line = JSON.stringify({ status: "verified", trajectory: { builders: 2 } })
    const status = ["node", "-e", `console.log(${JSON.stringify(line)})`]
    const seen = await commandAgent(["node", "-e", ""], undefined, status).run(job)
    expect(seen.trajectory).toMatchObject({ status: "verified", builders: 2 })
    expect((await commandAgent(["node", "-e", ""]).run(job)).trajectory).toBeNull()
    const old = ["node", "-e", "console.log('Unknown verify command status.')"]
    expect(
      (await commandAgent(["node", "-e", ""], undefined, old).run(job)).trajectory
    ).toBeNull()
  })

  it("counts claims the grader disagrees with", () => {
    const rows = [
      { ...row("t1", true, null), trajectory: { status: "verified", builders: 2 } },
      { ...row("t2", false, null), trajectory: { status: "verified", builders: 3 } },
      { ...row("t3", false, null), trajectory: { status: "partial", open: 2 } },
      row("t4", true, null),
    ]
    expect(armSummary([report(rows)]).evidence).toMatchObject({
      tasks: 3,
      verifiedPerMille: 333,
      falseVerified: 1,
      unfinished: 1,
      builders: 5,
    })
    expect(armSummary([report([row("t1", true, null)])]).evidence).toBeNull()
  })
})
