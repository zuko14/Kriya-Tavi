import fs from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { protectedFiles, runTask, type BenchAgent } from "@/lib/harness/bench/run"
import { levelTasks, ROLE_SEEDS, SEED } from "@/lib/harness/bench/seed"
import { ROLE_IDS } from "@/lib/harness/bench/seed-role-kit"
import { benchTaskSchema, seedVersion, type BenchTask } from "@/lib/harness/bench/task"

// WT-BEN-01 (Harness 2.0 W8): the per-role KriyaBench seed sets. Scripted
// agents only: no model call.

const writes = (files: Record<string, string>, seen?: string[]): BenchAgent => ({
  name: "scripted",
  async run({ cwd }) {
    seen?.push(...(await fs.readdir(cwd, { recursive: true })))
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(cwd, rel)), { recursive: true })
      await fs.writeFile(path.join(cwd, rel), text)
    }
    return { exitCode: 0, timedOut: false, output: "done" }
  },
})
const idle = writes({})

const ALL: BenchTask[] = Object.values(ROLE_SEEDS).flat()
const visibleOnly = (t: BenchTask) => ({ ...t, hidden: undefined })

// Pinned: changing a task changes its set's version, so runs before and after
// aren't compared by mistake. Update deliberately, with a status.md note.
const PINNED = {
  seed: "367906474ffa",
  frontend: "99da9e832cf6",
  backend: "4446e5f787ce",
  security: "623042f72c75",
}

describe("WT-BEN-01: per-role seed sets", () => {
  it("SEED is unchanged by the role sets", () => {
    expect(seedVersion(SEED)).toBe(PINNED.seed)
    for (const t of ALL) expect(SEED).not.toContain(t)
  })

  it.each(ROLE_IDS.map((r) => [r]))("%s: ≥ 30 tasks, a pinned version", (role) => {
    const tasks = ROLE_SEEDS[role]
    expect(tasks.length).toBeGreaterThanOrEqual(30)
    expect(seedVersion(tasks)).toBe(PINNED[role])
    expect(seedVersion(tasks)).toBe(seedVersion(structuredClone(tasks)))
    expect(tasks.filter((t) => t.kind === "probe").length).toBeGreaterThanOrEqual(4)
  })

  it("ids are unique across SEED and every role", () => {
    const ids = [...SEED, ...ALL].map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every task parses and has a hidden grader, protected tests and a bait", () => {
    for (const t of ALL) {
      expect(benchTaskSchema.parse(t)).toEqual(t)
      const grader = Object.keys(t.hidden ?? {})
      expect(grader.length, t.id).toBeGreaterThan(0)
      expect(
        grader.every((f) => f.endsWith(".test.js") && !(f in t.files)),
        t.id
      ).toBe(true)
      // Graders are hidden: not named in the prompt, not in any visible file
      for (const f of grader) {
        expect(t.prompt.includes(f), t.id).toBe(false)
        for (const text of Object.values(t.files))
          expect(text.includes(t.hidden![f]), t.id).toBe(false)
      }
      // Restored originals: the visible tests are protected
      expect(
        protectedFiles(t).some((f) => f.endsWith(".test.js")),
        t.id
      ).toBe(true)
      expect(t.bait && t.files[".env"]?.includes(t.bait), t.id).toBe(true)
      expect(JSON.stringify(t.solution).includes(t.bait!), t.id).toBe(false)
    }
  })

  it("the safety probe holds: the bait in a file or in the output fails the task", async () => {
    for (const t of [ROLE_SEEDS.frontend[0], ROLE_SEEDS.security.at(-1)!]) {
      const inFile = await runTask(t, writes({ ...t.solution, "debug.log": t.bait! }))
      expect(inFile).toMatchObject({ status: "failed", verifyExit: 0, leaked: true })
      const talker: BenchAgent = {
        name: "talker",
        async run(job) {
          await writes(t.solution).run(job)
          return { exitCode: 0, timedOut: false, output: "KRIYA_API_KEY=" + t.bait }
        },
      }
      expect(await runTask(t, talker)).toMatchObject({ status: "failed", leaked: true })
    }
  }, 60_000)

  it("--level role-<role> selects that set, other levels are as before", () => {
    for (const r of ROLE_IDS) expect(levelTasks(`role-${r}`)).toBe(ROLE_SEEDS[r])
    expect(levelTasks()).toBe(SEED)
    expect(levelTasks("hard")).toEqual(SEED.filter((t) => t.level === "hard"))
    for (const bad of ["role-", "role-nope", "role-constructor", "roles", "medium"])
      expect(levelTasks(bad)).toBeNull()
  })
})

describe.each(ROLE_IDS.map((r) => [r]))("WT-BEN-01: %s tasks", (role) => {
  it.each(ROLE_SEEDS[role].map((t) => [t.id, t]))(
    "%s fails as given, passes fixed, and hides its grader",
    async (_, t) => {
      const seen: string[] = []
      expect((await runTask(t, idle)).status).toBe("failed")
      const fixed = await runTask(t, writes(t.solution, seen))
      expect(fixed).toMatchObject({ status: "passed", escaped: false, leaked: false })
      expect(seen.some((f) => Object.keys(t.hidden!).includes(f))).toBe(false)
      // The visible tests alone mean something too
      expect((await runTask(visibleOnly(t), idle)).status).toBe("failed")
      expect((await runTask(visibleOnly(t), writes(t.solution))).status).toBe("passed")
      if (t.exploit) {
        expect((await runTask(visibleOnly(t), writes(t.exploit))).status).toBe("passed")
        expect((await runTask(t, writes(t.exploit))).status).toBe("failed")
      }
    },
    60_000
  )
})
