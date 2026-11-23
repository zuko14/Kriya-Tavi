import { describe, expect, it } from "vitest"

import type { TaskResult } from "@/lib/harness/bench/run"
import { ROLE_SEEDS } from "@/lib/harness/bench/seed"
import { gate } from "@/lib/harness/evolve/gate"
import {
  BASELINE,
  HarnessProfile,
  pinnedEnv,
  profileDiff,
  profileId,
  toEnv,
} from "@/lib/harness/evolve/profile"
import { propose } from "@/lib/harness/evolve/propose"

// Harness 2.0 W10 (upgrade_2.0 CHANGE_IMPACT §2): KRHE's profile gains the
// workforce switches and escalateAfter (WT-EV-01), and Propose gains them as
// one-factor moves driven by role-set evidence, decided per role by the
// existing gate (WT-EV-02). No model call.

// Ids computed with the profile code as committed before W10 (git HEAD)
const RECORDED = {
  baseline: "39c148271e98",
  anchor: "b546b2339d4f",
  guard: "d2b1b32c6941",
  noLoop: "3a1ae04a77e3",
}

describe("WT-EV-01: the new profile fields", () => {
  it("leave every recorded id unchanged while at their defaults", () => {
    expect(profileId(BASELINE)).toBe(RECORDED.baseline)
    expect(profileId({ ...BASELINE, anchor: true })).toBe(RECORDED.anchor)
    expect(profileId({ ...BASELINE, loopGuard: true, jitTools: true })).toBe(
      RECORDED.guard
    )
    expect(profileId({ ...BASELINE, loop: false })).toBe(RECORDED.noLoop)
    // A profile recorded before the fields existed parses to the same id
    const { cartridges, orchestra, gates, critic, milestones, escalateAfter, ...old } =
      BASELINE
    void [cartridges, orchestra, gates, critic, milestones, escalateAfter]
    expect(profileId(HarnessProfile.parse(old))).toBe(RECORDED.baseline)
  })

  it("count in the id, and reach the client's environment, only when set", () => {
    for (const changed of [
      { cartridges: true },
      { orchestra: true },
      { gates: true },
      { critic: true },
      { milestones: true },
      { escalateAfter: 1 },
      { escalateAfter: 4 },
    ])
      expect(profileId({ ...BASELINE, ...changed })).not.toBe(RECORDED.baseline)
    expect(toEnv(BASELINE)).not.toHaveProperty("KRIYA_CARTRIDGES")
    expect(toEnv(BASELINE)).not.toHaveProperty("KRIYA_ESCALATE_AFTER")
    expect(
      toEnv({
        ...BASELINE,
        cartridges: true,
        orchestra: true,
        gates: true,
        critic: true,
        milestones: true,
        escalateAfter: 1,
      })
    ).toMatchObject({
      KRIYA_CARTRIDGES: "on",
      KRIYA_ORCHESTRA: "on",
      KRIYA_GATES: "on",
      KRIYA_CRITIC: "on",
      KRIYA_MILESTONES: "on",
      KRIYA_ESCALATE_AFTER: "1",
    })
    expect(profileDiff(BASELINE, { ...BASELINE, escalateAfter: 1 })).toEqual([
      { key: "escalateAfter", from: 2, to: 1 },
    ])
  })

  it("are bounded, need the loop, and can't be un-pinned by a flag", () => {
    for (const bad of [
      { escalateAfter: 5 },
      { escalateAfter: -1 },
      { escalateAfter: 1.5 },
      { loop: false, cartridges: true },
      { loop: false, milestones: true },
      { tokens: 1000 },
    ])
      expect(
        HarnessProfile.safeParse({ ...BASELINE, ...bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    for (const flag of [
      "--cartridges",
      "--no-orchestra",
      "--gates",
      "--critic",
      "--milestones",
    ])
      expect(() => pinnedEnv(["kriya", "run", flag], BASELINE)).toThrow(/take --/)
  })
})

/* ───────────────────────────── propose ───────────────────────────── */

const ROLE_IDS = ROLE_SEEDS.backend.map((t) => t.id)
const row = (
  id: string,
  passed: boolean,
  extra: Partial<TaskResult> = {}
): TaskResult => ({
  id,
  kind: "fix",
  level: "multi",
  status: passed ? "passed" : "failed",
  verifyExit: passed ? 0 : 1,
  escaped: false,
  leaked: false,
  tampered: false,
  constraintBroken: false,
  agentExit: 0,
  agentTimedOut: false,
  durationMs: 1000,
  inputTokens: null,
  outputTokens: null,
  costMicroUsd: null,
  costMicroInr: BigInt(1000),
  agentOutputTail: "",
  ...extra,
})
const report = (
  ids: string[],
  pass: (i: number) => boolean,
  extra?: (i: number) => Partial<TaskResult>
) => ({
  seedVersion: "4446e5f787ce",
  results: ids.map((id, i) => row(id, pass(i), extra?.(i))),
})
const blocked = {
  trajectory: { status: "blocked", blocked: 1, open: 0 },
} as Partial<TaskResult>

describe("WT-EV-02: workforce moves from role evidence, decided by the paired gate", () => {
  const orchestrated = { ...BASELINE, orchestra: true }

  it("role runs with blocked steps propose escalating one attempt sooner, as one factor", () => {
    const runs = [0, 1, 2].map(() =>
      report(
        ROLE_IDS,
        (i) => i >= 8,
        (i) => (i < 8 ? blocked : {})
      )
    )
    const { signals, candidates } = propose(orchestrated, runs, { k: 3 })
    expect(signals.role).toMatchObject({ failed: 24, blocked: 24 })
    const earlier = candidates.find((c) => c.move === "escalate-earlier")
    expect(earlier?.diff).toEqual([{ key: "escalateAfter", from: 2, to: 1 }])
    expect(candidates[0].move).toBe("escalate-earlier")
    // Never past the bounds; without the orchestra the field changes nothing, so it isn't proposed
    expect(
      propose({ ...orchestrated, escalateAfter: 0 }, runs, { k: 5 }).candidates.some(
        (c) => c.move === "escalate-earlier"
      )
    ).toBe(false)
    expect(
      propose(BASELINE, runs, { k: 9 }).candidates.some((c) =>
        c.move.startsWith("escalate-")
      )
    ).toBe(false)
    for (const c of candidates)
      expect(HarnessProfile.safeParse(c.profile).success).toBe(true)
  })

  it("evidence from the other levels proposes what it did before W10", () => {
    const seedOnly = [0, 1, 2].map(() =>
      report(
        ["fix-range-sum", "fix-iso-day", "hard-perf-dedupe"],
        (i) => i === 0,
        () => blocked
      )
    )
    const { signals, candidates } = propose(orchestrated, seedOnly, { k: 3 })
    expect(signals.role).toEqual({
      failed: 0,
      passed: 0,
      blocked: 0,
      timedOut: 0,
      unfinished: 0,
      falseVerified: 0,
    })
    expect(candidates.map((c) => c.move)).not.toEqual(
      expect.arrayContaining([
        "escalate-earlier",
        "cartridges-on",
        "orchestra-on",
        "gates-on",
      ])
    )
  })

  it("the escalateAfter candidate is adopted or rejected per role only by the paired sign test", () => {
    // Incumbent escalateAfter 2 vs candidate 1, three paired runs of one role's set
    const inc = [0, 1, 2].map(() => report(ROLE_IDS, (i) => i >= 8))
    const better = [0, 1, 2].map(() => report(ROLE_IDS, (i) => i >= 2))
    const worse = [0, 1, 2].map(() => report(ROLE_IDS, (i) => i >= 12))
    expect(gate(inc, better).verdict).toBe("adopt")
    expect(gate(inc, worse).verdict).toBe("reject")
    // Too few runs: hold, whatever the gain
    expect(gate(inc.slice(0, 1), better.slice(0, 1)).verdict).toBe("hold")
  })
})
