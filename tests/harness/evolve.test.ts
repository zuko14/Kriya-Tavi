import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { TaskResult } from "@/lib/harness/bench/run"
import { compose } from "@/lib/harness/evolve/compose"
import { gate } from "@/lib/harness/evolve/gate"
import {
  applicable,
  approveLesson,
  type Lesson,
  recordEvidence,
} from "@/lib/harness/evolve/library"
import {
  BASELINE,
  HarnessProfile,
  pinnedEnv,
  profileDiff,
  profileId,
  SWITCH_FLAG,
  toEnv,
} from "@/lib/harness/evolve/profile"
import { propose } from "@/lib/harness/evolve/propose"

// KRHE (RECURSIVE_HARNESS_EVOLUTION.md), HU-EV-*: profiles, the gate,
// Propose, Compose and the lesson library. Recorded reports and scripted
// rows only: no agent, no model call.

const row = (id: string, passed: boolean, extra: Partial<TaskResult> = {}) =>
  ({
    id,
    status: passed ? "passed" : "failed",
    level: "cap",
    costMicroInr: BigInt(1_000_000),
    durationMs: 1000,
    escaped: false,
    leaked: false,
    tampered: false,
    agentTimedOut: false,
    ...extra,
  }) as TaskResult
// n tasks; the first `pass` pass
const run = (
  n: number,
  pass: number,
  extra: (i: number) => Partial<TaskResult> = () => ({})
) => ({
  seedVersion: "s1",
  results: Array.from({ length: n }, (_, i) => row(`t${i}`, i < pass, extra(i))),
})
const runs = (
  k: number,
  n: number,
  pass: number,
  extra?: (i: number) => Partial<TaskResult>
) => Array.from({ length: k }, () => run(n, pass, extra))

describe("HU-EV-01 profiles", () => {
  it("are exactly the client's switches and limits; protected controls can't be named", () => {
    expect(HarnessProfile.parse(BASELINE)).toEqual(BASELINE)
    for (const field of [
      "mode",
      "approval",
      "sandbox",
      "riskClass",
      "maxSpendMicroInr",
      "egress",
    ])
      expect(HarnessProfile.safeParse({ ...BASELINE, [field]: "x" }).success).toBe(false)
    expect(
      HarnessProfile.safeParse({ ...BASELINE, loop: false, loopV2: true }).success
    ).toBe(false)
    expect(HarnessProfile.safeParse({ ...BASELINE, maxSteps: 10_000 }).success).toBe(
      false
    )
    expect(HarnessProfile.safeParse({ ...BASELINE, maxSteps: 1.5 }).success).toBe(false)
  })
  it("have a content id independent of key order, and map to the client's environment", () => {
    const reordered = Object.fromEntries(
      Object.entries(BASELINE).reverse()
    ) as HarnessProfile
    expect(profileId(reordered)).toBe(profileId(BASELINE))
    expect(profileId({ ...BASELINE, anchor: true })).not.toBe(profileId(BASELINE))
    expect(toEnv(BASELINE)).toEqual({
      KRIYA_LOOP: "on",
      KRIYA_LOOP_V2: "off",
      KRIYA_BUDGET: "on",
      KRIYA_ANCHOR: "off",
      KRIYA_MINIMAL: "off",
      KRIYA_MAX_STEPS: "150",
      KRIYA_TURN_MINUTES: "60",
      KRIYA_MAX_REPEATS: "10",
    })
    expect(
      ["--loop", "--no-loop", "--loop-v2", "--no-budget", "--anchor"].every((f) =>
        SWITCH_FLAG.test(f)
      )
    ).toBe(true)
    expect(["--mode", "auto", "--loopy"].some((f) => SWITCH_FLAG.test(f))).toBe(false)
    expect(profileDiff(BASELINE, { ...BASELINE, anchor: true })).toEqual([
      { key: "anchor", from: false, to: true },
    ])
  })
})

describe("HU-EV-02 the gate", () => {
  it("rejects any safety regression whatever the pass gain", () => {
    const g = gate(
      runs(3, 10, 2),
      runs(3, 10, 10, (i) => ({ escaped: i === 0 }))
    )
    expect(g.verdict).toBe("reject")
    expect(g.reasons[0]).toMatch(/worse on escaped/)
  })
  it("holds on too little evidence", () => {
    expect(gate(runs(2, 10, 2), runs(2, 10, 9)).verdict).toBe("hold")
    expect(gate(runs(3, 3, 0), runs(3, 3, 3)).verdict).toBe("hold")
  })
  it("adopts a shown gain at no extra cost per pass; canaries a shown gain that costs more", () => {
    expect(gate(runs(3, 10, 4), runs(3, 10, 9)).verdict).toBe("adopt")
    const dear = gate(
      runs(3, 10, 4),
      runs(3, 10, 9, () => ({ costMicroInr: BigInt(3_000_000) }))
    )
    expect(dear.verdict).toBe("canary")
    expect(dear.reasons.join(" ")).toMatch(/cost per passed task \+/)
  })
  it("rejects a shown loss; holds a tie; canaries an unshown gain that costs no more", () => {
    expect(gate(runs(3, 10, 9), runs(3, 10, 4)).verdict).toBe("reject")
    expect(gate(runs(3, 10, 5), runs(3, 10, 5)).verdict).toBe("hold")
    expect(gate(runs(3, 10, 5), runs(3, 10, 6)).verdict).toBe("canary")
    // Unmetered: cost unknown, so an unshown gain is held, never guessed
    expect(
      gate(
        runs(3, 10, 5, () => ({ costMicroInr: null })),
        runs(3, 10, 6, () => ({ costMicroInr: null }))
      ).verdict
    ).toBe("hold")
  })
  it("reports every metric beside the verdict", () => {
    const m = gate(runs(3, 10, 4), runs(3, 10, 9)).metrics
    expect(m).toMatchObject({
      runs: 3,
      pairs: 30,
      onlyIncumbent: 0,
      onlyCandidate: 15,
      costChangePerMille: -555,
    })
    expect(m.candidate.safety).toEqual({
      escaped: 0,
      leaked: 0,
      constraintBroken: 0,
      tampered: 0,
      invalid: 0,
      timedOut: 0,
    })
  })
})

describe("HU-EV-03 Propose", () => {
  it("proposes distinct one-factor candidates, ranked by the incumbent's failures, deterministically", () => {
    const timeouts = runs(3, 10, 4, (i) => ({ agentTimedOut: i >= 4 }))
    const a = propose({ ...BASELINE, loop: false, budget: false }, timeouts, { k: 3 })
    expect(a).toEqual(
      propose({ ...BASELINE, loop: false, budget: false }, timeouts, { k: 3 })
    )
    expect(a.candidates.map((c) => c.move)).toEqual([
      "more-steps",
      "anchor-on",
      "loop-on",
    ])
    expect(a.candidates[0].diff.map((d) => d.key)).toEqual(["maxSteps", "turnMinutes"])
    expect(new Set(a.candidates.map((c) => c.id)).size).toBe(3)
    // With the loop off, v2 isn't proposed: it would change two factors at once
    expect(
      propose({ ...BASELINE, loop: false }, timeouts, { k: 5 }).candidates.some(
        (c) => c.move === "loop-v2-on"
      )
    ).toBe(false)
    expect(
      propose(BASELINE, timeouts, { k: 5 }).candidates.find(
        (c) => c.move === "loop-v2-on"
      )?.diff
    ).toEqual([{ key: "loopV2", from: false, to: true }])
    for (const c of a.candidates)
      expect(HarnessProfile.safeParse(c.profile).success).toBe(true)
  })
  it("never proposes the incumbent, a measured profile, or more than the cap", () => {
    const first = propose(BASELINE, runs(3, 10, 4), { k: 9 })
    expect(first.candidates.length).toBeLessThanOrEqual(5)
    // loop is already on: no "loop-on" candidate (it would be the incumbent)
    expect(first.candidates.some((c) => c.move === "loop-on")).toBe(false)
    const seen = new Set(first.candidates.map((c) => c.id))
    expect(propose(BASELINE, runs(3, 10, 4), { k: 9, seen }).candidates).toEqual([])
  })
})

describe("HU-EV-04 Compose", () => {
  const a = { ...BASELINE, anchor: true }
  const b = { ...BASELINE, loopV2: true }
  const c = { ...BASELINE, anchor: true, maxSteps: 300 }
  it("joins changes that held up on different fields into a new candidate to probe", () => {
    const out = compose(BASELINE, [
      { profile: a, verdict: "canary", margin: 2 },
      { profile: b, verdict: "adopt", margin: 5 },
      { profile: { ...BASELINE, minimalTools: true }, verdict: "reject", margin: 9 },
    ])
    expect(out.profile).toEqual({ ...BASELINE, anchor: true, loopV2: true })
    expect(out.note).toMatch(/probe and gate it/)
  })
  it("drops the smaller-margin change on a conflict; composes nothing from one or none", () => {
    const out = compose(BASELINE, [
      { profile: a, verdict: "adopt", margin: 1 },
      { profile: c, verdict: "adopt", margin: 3 },
      { profile: b, verdict: "adopt", margin: 2 },
    ])
    expect(out.profile).toEqual({
      ...BASELINE,
      anchor: true,
      maxSteps: 300,
      loopV2: true,
    })
    expect(out.dropped).toEqual([
      { id: profileId(a), why: "anchor already set by a change with a larger margin" },
    ])
    expect(
      compose(BASELINE, [{ profile: a, verdict: "adopt", margin: 1 }]).profile
    ).toBeUndefined()
    expect(compose(BASELINE, [{ profile: a, verdict: "hold", margin: 1 }]).note).toMatch(
      /keep the incumbent/
    )
  })
})

describe("HU-EV-05 lessons", () => {
  const scope = {
    model: "m1",
    seedVersion: "s1",
    agent: "kriya run",
    incumbentId: profileId(BASELINE),
  }
  const change = profileDiff(BASELINE, { ...BASELINE, anchor: true })
  const add = (
    lessons: Lesson[],
    incumbent: number,
    candidate: number,
    reports: string[],
    extra?: (i: number) => Partial<TaskResult>
  ) =>
    recordEvidence(lessons, {
      scope,
      change,
      result: gate(runs(3, 10, incumbent), runs(3, 10, candidate, extra)),
      reports,
      at: "2026-11-04T00:00:00Z",
    })

  it("go proposed → validated on two independent cohorts; the same reports twice are one cohort", () => {
    let { lessons, lesson } = add([], 4, 9, ["r1", "r2"])
    expect(lesson.status).toBe("proposed")
    expect(lesson.statement).toMatch(
      /^On m1, seed s1: anchor false → true passed 15 pairs/
    )
    ;({ lessons, lesson } = add(lessons, 4, 9, ["r2", "r1"]))
    expect(lesson.evidence).toHaveLength(1)
    ;({ lessons, lesson } = add(lessons, 3, 8, ["r3", "r4"]))
    expect(lesson.status).toBe("validated")
    expect(applicable(lessons, "m1")).toEqual([])
    const approved = approveLesson(lessons, lesson.id, "2026-11-04T01:00:00Z")
    expect(applicable(approved, "m1").map((l) => l.id)).toEqual([lesson.id])
    expect(applicable(approved, "m2")).toEqual([])
    // Contradicted later, even when approved: deprecated
    const after = recordEvidence(approved, {
      scope,
      change,
      result: gate(runs(3, 10, 9), runs(3, 10, 3)),
      reports: ["r5"],
      at: "2026-11-05T00:00:00Z",
    })
    expect(after.lesson.status).toBe("deprecated")
    expect(applicable(after.lessons, "m1")).toEqual([])
  })
  it("only a validated lesson can be approved; a safety failure rejects it", () => {
    const { lessons, lesson } = add([], 4, 9, ["r1"])
    expect(() => approveLesson(lessons, lesson.id, "x")).toThrow(
      /only a validated lesson/
    )
    expect(add([], 4, 9, ["r9"], (i) => ({ leaked: i === 0 })).lesson.status).toBe(
      "rejected"
    )
  })
})

// The gate on KriyaBench-R runs recorded on 2026-11-04 (BENCHMARK_PLAN §6.3,
// DeepSeek V4.1 Flash 1017, capability set 989dcfbc9eab, K = 3)
describe("HU-EV-06 the gate on recorded evidence", () => {
  const dir = path.join(process.cwd(), "docs/kriya-harness/harness_upgradation/bench")
  const load = (arm: string) =>
    [1, 2, 3].map((n) => {
      const r = JSON.parse(
        fs.readFileSync(path.join(dir, `r-cap2-${arm}-${n}.json`), "utf8")
      )
      return {
        ...r,
        results: r.results.map((t: TaskResult & { costMicroInr: string | null }) => ({
          ...t,
          costMicroInr: t.costMicroInr === null ? null : BigInt(t.costMicroInr),
        })),
      }
    })
  it("holds B4 against B3 (4–0, p = 0.125, +43% per pass): the evidence alone wouldn't have promoted it", () => {
    const g = gate(load("b3"), load("b4"))
    expect(g.verdict).toBe("hold")
    expect(g.metrics).toMatchObject({
      pairs: 21,
      onlyIncumbent: 0,
      onlyCandidate: 4,
      costChangePerMille: 434,
    })
    expect(g.metrics.p).toBeCloseTo(0.125, 3)
  })
  it("holds B5 against B4 (0–5, p = 0.0625): a loss not shown at 95% is not a rejection", () => {
    const g = gate(load("b4"), load("b5"))
    expect(g.verdict).toBe("hold")
    expect(g.metrics).toMatchObject({ onlyIncumbent: 5, onlyCandidate: 0 })
  })
})

// The bench CLI's --profile is pinnedEnv plus the profile in the report
// (lib/harness/bench/cli.ts); tested here without spawning a bench, which
// loaded the parallel suite enough to time out HT-BEN-02's hard-perf-dedupe
describe("HU-EV-07 a run pinned to a profile", () => {
  it("gets the profile's environment, and refuses a switch flag that would un-pin it", () => {
    const p = { ...BASELINE, anchor: true, maxSteps: 300 }
    expect(pinnedEnv(["node", "kriya.js", "run", "--mode", "auto"], p)).toMatchObject({
      KRIYA_ANCHOR: "on",
      KRIYA_MAX_STEPS: "300",
    })
    for (const flag of ["--loop", "--no-budget", "--loop-v2"])
      expect(() => pinnedEnv(["node", "kriya.js", "run", flag], p)).toThrow(
        `take ${flag} out of --agent`
      )
  })
})
