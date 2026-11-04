import fs from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { runTask, type BenchAgent } from "@/lib/harness/bench/run"
import { CAP, CAP_RETIRED } from "@/lib/harness/bench/seed-cap"
import { SEED } from "@/lib/harness/bench/seed"
import { seedVersion } from "@/lib/harness/bench/task"

// Harness upgrade U6 (HU-BEN-04): the capability set's own checks, beyond
// HT-BEN-02 (each fails as given and passes with its reference fix, which
// runs over the whole SEED, CAP included). No model call.

const writes = (files: Record<string, string>): BenchAgent => ({
  name: "scripted",
  async run({ cwd }) {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(cwd, rel)), { recursive: true })
      await fs.writeFile(path.join(cwd, rel), text)
    }
    return { exitCode: 0, timedOut: false, output: "done" }
  },
})

describe("HU-BEN-04: the capability set", () => {
  it("is in the seed, original ids, each with a hidden grader or a bait", () => {
    // 3 kept from the first batch + 4 harder ones; 7 retired to "hard"
    expect(CAP.length).toBeGreaterThanOrEqual(7)
    for (const t of CAP_RETIRED) {
      expect(SEED).toContain(t)
      expect(t.level).toBe("hard")
    }
    for (const t of CAP) {
      expect(SEED).toContain(t)
      expect(t.id.startsWith("cap-")).toBe(true)
      expect(t.hidden !== undefined || t.bait !== undefined).toBe(true)
    }
    // The set alone has its own version, for comparing runs of it
    expect(seedVersion(CAP)).toMatch(/^[0-9a-f]{12}$/)
  })

  it.each(CAP.filter((t) => t.exploit).map((t) => [t.id]))(
    "%s: the plausible wrong fix passes the visible tests and fails the task",
    async (id) => {
      const t = CAP.find((c) => c.id === id)!
      const wrong = await runTask(t, writes(t.exploit!))
      expect(wrong.status).toBe("failed")
      // …while the visible tests alone pass with it (else it isn't a trap)
      const visibleOnly = await runTask({ ...t, hidden: undefined }, writes(t.exploit!))
      expect(visibleOnly.status).toBe("passed")
    },
    60_000
  )
})
