import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The Editing Studio's skills (track E, ED13; SKILLS_AND_OPEN_SOURCE §4):
// ET-SK-01, each kriya-edit-* skill is chosen for its own tasks and not for
// others, and names no tool; ET-SK-02, they are served only with
// editing.skills on, and off the default set is exactly as before.

vi.mock("server-only", () => ({}))

import * as skillBody from "@/app/api/harness/v1/skills/[id]/[version]/route"
import * as skills from "@/app/api/harness/v1/skills/route"
import { SkillsResponse } from "@/lib/harness/contract"
import {
  defaultSkillSet,
  HARNESS_DEFAULTS,
  HARNESS_EDIT_DEFAULTS,
  HARNESS_SKILLS_ROOT,
  loadDefaultSkill,
} from "@/lib/harness/default-skills"
import { CATALOG, CATALOG_V2 } from "@/lib/skill-library"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../harness/setup"

const EDIT_IDS = [
  "core",
  "talking-head",
  "shorts",
  "longform",
  "podcast",
  "tutorial",
  "montage",
  "ad",
  "captions",
  "sound",
  "color",
  "motion",
  "3d",
  "data",
  "reference",
  "handoff",
  "story",
  "review",
].map((id) => `kriya-edit-${id}`)

const matches = (keywords: string[], ask: string) =>
  keywords.some((k) =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(ask)
  )

describe("ET-SK-01: the kriya-edit-* skills", () => {
  it("are the eighteen of SKILLS_AND_OPEN_SOURCE §4, active, Kriya-native, apart from every other set", () => {
    expect(HARNESS_EDIT_DEFAULTS.map((s) => s.id)).toEqual(EDIT_IDS)
    const others = new Set(
      [...CATALOG, ...CATALOG_V2, ...HARNESS_DEFAULTS].map((s) => s.id)
    )
    const notices = fs.readFileSync(path.join(HARNESS_SKILLS_ROOT, "NOTICES.md"), "utf8")
    expect(notices).toContain("kriya-edit-*")
    for (const s of HARNESS_EDIT_DEFAULTS) {
      expect(others.has(s.id), s.id).toBe(false)
      expect(s.status).toBe("active")
      expect(s.source).toEqual([])
      const raw = fs.readFileSync(
        path.join(HARNESS_SKILLS_ROOT, s.id, "SKILL.md"),
        "utf8"
      )
      expect(raw).toMatch(new RegExp(`^---\\nname: ${s.id}\\n`))
      expect(raw).toMatch(/source: Kriya-native/)
      expect(raw.length, s.id).toBeLessThanOrEqual(s.limits.maxChars)
      expect(loadDefaultSkill(s.id, s.version)).toMatch(/^# /)
    }
  })

  it("are chosen for their own tasks: each eval agrees with the skill's keywords", () => {
    for (const s of HARNESS_EDIT_DEFAULTS) {
      expect(
        s.evals.some((e) => e.expect === "activate"),
        s.id
      ).toBe(true)
      expect(
        s.evals.some((e) => e.expect === "skip"),
        s.id
      ).toBe(true)
      for (const e of s.evals)
        expect(matches(s.activation.keywords, e.ask), `${s.id}: ${e.ask}`).toBe(
          e.expect === "activate"
        )
    }
  })

  it("aren't chosen for a device's everyday coding asks, where a bare word like color, hook or resolve means something else", () => {
    const coding = [
      "Edit the config file to add a port",
      "Change the button color to blue",
      "Resolve the merge conflict in main",
      "Add a git hook that runs the linter",
      "Write a tutorial README for the API",
      "Shorten this function",
      "Make it look like the Figma mockup",
      "Refactor the folder structure of the repo",
      "Add a caption to the image in the README",
      "Write it in the style of the rest of the codebase",
      "Fix the chart rendering bug in the dashboard",
      "Reduce the noise in the log output",
    ]
    for (const ask of coding)
      for (const s of HARNESS_EDIT_DEFAULTS)
        expect(matches(s.activation.keywords, ask), `${s.id}: ${ask}`).toBe(false)
  })

  it("name no tool and carry no command: no editing tool exists on a device until ED14", () => {
    for (const s of HARNESS_EDIT_DEFAULTS) {
      expect(s.tools).toEqual({ all: [], any: [], uses: [] })
      const text = loadDefaultSkill(s.id, s.version)
      expect(text.match(/\b[a-z]+_[a-z_]+\b/g), s.id).toBeNull()
      expect(text, s.id).not.toMatch(/```|\bkriya edit\b|\bnpx?\b|\bffmpeg\b/i)
    }
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
    KRIYA_HARNESS_DEFAULT_SKILLS: "on",
    KRIYA_EDITING_SKILLS: undefined,
    KRIYA_SKILLS_DISABLED: undefined,
  })
)

describe("ET-SK-02: served only with editing.skills on", () => {
  it("off (the default): the default set is the same object, the list is as before, and no editing body is served", async () => {
    expect(await defaultSkillSet()).toBe(HARNESS_DEFAULTS)
    const device = await deviceFor(pg, await newUser())
    const ids = (await list(device.token)).skills.map((s) => s.id)
    expect(ids.filter((id) => id.startsWith("kriya-"))).toEqual(
      HARNESS_DEFAULTS.map((s) => s.id)
    )
    expect((await body(device.token, "kriya-edit-core", "1.0.0")).status).toBe(404)
  })

  it("on: the editing skills follow the defaults, with keywords; the owner's skills.disabled still applies", async () => {
    harnessEnv({
      KRIYA_AGENTS_SKILL_LIBRARY: "on",
      KRIYA_HARNESS_DEFAULT_SKILLS: "on",
      KRIYA_EDITING_SKILLS: "on",
      KRIYA_SKILLS_DISABLED: "kriya-edit-ad",
    })
    const device = await deviceFor(pg, await newUser())
    const served = (await list(device.token)).skills
    expect(served.map((s) => s.id).filter((id) => id.startsWith("kriya-"))).toEqual([
      ...HARNESS_DEFAULTS.map((s) => s.id),
      ...EDIT_IDS.filter((id) => id !== "kriya-edit-ad"),
    ])
    expect(
      served.find((s) => s.id === "kriya-edit-color")!.activation.keywords
    ).toContain("white balance")
    const res = await body(device.token, "kriya-edit-core", "1.0.0")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("# Edit like an editor")
    expect((await body(device.token, "kriya-edit-ad", "1.0.0")).status).toBe(404)
  })

  it("on, with the default skills off: nothing is served, editing or not", async () => {
    harnessEnv({
      KRIYA_AGENTS_SKILL_LIBRARY: "on",
      KRIYA_HARNESS_DEFAULT_SKILLS: undefined,
      KRIYA_EDITING_SKILLS: "on",
    })
    const device = await deviceFor(pg, await newUser())
    expect(
      (await list(device.token)).skills
        .map((s) => s.id)
        .filter((id) => id.startsWith("kriya-"))
    ).toEqual([])
  })
})
