import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

// N11 exit check: every golden scenario NG-01…NG-24 of EVALUATION_PLAN §2 has
// a test in this folder, named by its id, so one can't be dropped quietly.

const dir = path.join(process.cwd(), "tests/next/golden")
const source = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".test.ts") && file !== "coverage.test.ts")
  .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
  .join("\n")

describe("golden scenarios", () => {
  it.each(Array.from({ length: 24 }, (_, i) => `NG-${String(i + 1).padStart(2, "0")}`))(
    "%s has a test",
    (id) => {
      expect(source).toMatch(new RegExp(`describe\\("${id} NSC-`))
    }
  )

  it("each is tied to its scenario in SCENARIOS.md", () => {
    const scenarios = fs.readFileSync(
      path.join(process.cwd(), "docs/next-platform/SCENARIOS.md"),
      "utf8"
    )
    for (const [, nsc, ng] of source
      .matchAll(/describe\("(NG-\d\d) (NSC-\d\d)/g)
      .map((m) => [m[0], m[2], m[1]] as const))
      expect(scenarios, `${ng} ↔ ${nsc}`).toMatch(
        new RegExp(`\\| ${nsc} .*\\| ${ng}\\s+\\|`)
      )
  })
})
