import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Kriya default skills (WORKSPACE_PANEL_SKILLS_PLUGINS.md §4), HT-DS-*:
// the kriya-* coding skills in skills-harness/, validated like the library,
// credited to their MIT sources, and served to every device's agent only
// with harness.defaultSkills on (default off).

vi.mock("server-only", () => ({}))

import * as skillBody from "@/app/api/harness/v1/skills/[id]/[version]/route"
import * as skills from "@/app/api/harness/v1/skills/route"
import { SkillsResponse } from "@/lib/harness/contract"
import {
  HARNESS_DEFAULTS,
  HARNESS_SKILLS_ROOT,
  loadDefaultSkill,
} from "@/lib/harness/default-skills"
import { CATALOG, CATALOG_V2 } from "@/lib/skill-library"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

describe("HT-DS-01: the default set", () => {
  it("is thirteen kriya-* skills, active, with no Kriya tool, apart from the cloud catalogue", () => {
    expect(HARNESS_DEFAULTS.map((s) => s.id).sort()).toEqual([
      "kriya-brainstorm",
      "kriya-browser-test",
      "kriya-debug",
      "kriya-git",
      "kriya-lean",
      "kriya-migrate",
      "kriya-plan",
      "kriya-research",
      "kriya-review",
      "kriya-security",
      "kriya-tdd",
      "kriya-verify",
      "kriya-visual",
    ])
    const cloud = new Set([...CATALOG, ...CATALOG_V2].map((s) => s.id))
    for (const s of HARNESS_DEFAULTS) {
      expect(s.status).toBe("active")
      expect(s.tools.all.concat(s.tools.any)).toEqual([])
      expect(cloud.has(s.id), s.id).toBe(false)
    }
  })

  it("credits every source with its MIT licence, and the notices carry each copyright", () => {
    const notices = fs.readFileSync(path.join(HARNESS_SKILLS_ROOT, "NOTICES.md"), "utf8")
    for (const holder of ["Jesse Vincent", "DietrichGebert", "Affaan Mustafa"])
      expect(notices).toContain(holder)
    for (const s of HARNESS_DEFAULTS) {
      expect(s.source.length, s.id).toBeGreaterThan(0)
      for (const src of s.source) expect(src.license).toBe("MIT")
      // The file carries the frontmatter; the loader serves the body
      const raw = fs.readFileSync(
        path.join(HARNESS_SKILLS_ROOT, s.id, "SKILL.md"),
        "utf8"
      )
      expect(raw).toMatch(new RegExp(`^---\\nname: ${s.id}\\n`))
      expect(raw).toMatch(/source: Written for Kriya Harness, based on /)
      expect(raw.length, s.id).toBeLessThanOrEqual(s.limits.maxChars)
      expect(loadDefaultSkill(s.id, s.version)).toMatch(/^# /)
    }
  })

  it("each skill's evals agree with its keywords (an ask to activate names one; an ask to skip names none)", () => {
    for (const s of HARNESS_DEFAULTS)
      for (const e of s.evals) {
        const ask = e.ask.toLowerCase()
        const hit = s.activation.keywords.some((k) =>
          new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(ask)
        )
        expect(hit, `${s.id}: ${e.ask}`).toBe(e.expect === "activate")
      }
  })

  it("names only tools Kriya Harness has", () => {
    const real =
      /\b(kriya_verify|kriya_plan|kriya_step|kriya undo|kriya rules|kriya verify use|browser_[a-z]+)\b/g
    const known = new Set([
      "kriya_verify",
      "kriya_plan",
      "kriya_step",
      "kriya undo",
      "kriya rules",
      "kriya verify use",
      "browser_open",
      "browser_read",
      "browser_screenshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_console",
      "browser_network",
    ])
    for (const s of HARNESS_DEFAULTS)
      for (const m of loadDefaultSkill(s.id, s.version).match(real) ?? [])
        expect(known.has(m), `${s.id}: ${m}`).toBe(true)
  })
})

let pg: TestDb
let newUser: () => Promise<string>

const list = async (token: string) =>
  SkillsResponse.parse(await (await skills.GET(call("GET", "/skills", { token }))).json())
const body = (token: string, id: string, version: string) =>
  skillBody.GET(call("GET", `/skills/${id}/${version}`, { token }))

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(() =>
  harnessEnv({
    KRIYA_AGENTS_SKILL_LIBRARY: "on",
    KRIYA_HARNESS_DEFAULT_SKILLS: undefined,
    KRIYA_SKILLS_DISABLED: undefined,
  })
)

describe("HT-DS-02: GET /skills serves the defaults only when the owner turns them on", () => {
  it("off by default: the list is the agent's own skills, and no default body is served", async () => {
    const device = await deviceFor(pg, await newUser())
    expect(
      (await list(device.token)).skills
        .map((s) => s.id)
        .filter((id) => id.startsWith("kriya-"))
    ).toEqual([])
    expect((await body(device.token, "kriya-verify", "1.0.0")).status).toBe(404)
  })

  it("on: every device gets them first, even with no agent; the owner's skills.disabled still applies", async () => {
    harnessEnv({
      KRIYA_AGENTS_SKILL_LIBRARY: "on",
      KRIYA_HARNESS_DEFAULT_SKILLS: "on",
      KRIYA_SKILLS_DISABLED: "kriya-git",
    })
    const device = await deviceFor(pg, await newUser())
    const served = (await list(device.token)).skills
    expect(served.map((s) => s.id)).toEqual(
      HARNESS_DEFAULTS.map((s) => s.id).filter((id) => id !== "kriya-git")
    )
    expect(served[0].activation.keywords.length).toBeGreaterThan(0)
    const res = await body(device.token, "kriya-verify", "1.0.0")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("# Verify before claiming done")
    expect((await body(device.token, "kriya-git", "1.0.0")).status).toBe(404)
    expect((await body(device.token, "kriya-verify", "9.9.9")).status).toBe(404)
  })
})
