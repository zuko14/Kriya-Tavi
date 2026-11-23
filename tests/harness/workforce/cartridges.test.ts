import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W1 (docs/kriya-harness/upgrade_2.0/IMPLEMENTATION_PLAN.md):
// the fifteen kriya-role-* cartridges, their strict blocks, and serving only
// with harness.workforce on. WT-CAR-*, WT-SK-02/03, WT-CT-01.

vi.mock("server-only", () => ({}))

import * as skillBody from "@/app/api/harness/v1/skills/[id]/[version]/route"
import * as skills from "@/app/api/harness/v1/skills/route"
import {
  CARTRIDGE_ROLES,
  CONTRACT_NAMES,
  DETECTOR_IDS,
  GATE_IDS,
  cartridgeId,
} from "@/lib/harness/cartridge-ids"
import { buildCartridges, CartridgeFile } from "@/lib/harness/cartridges"
import { contractJson, SkillsResponse } from "@/lib/harness/contract"
import {
  HARNESS_CARTRIDGES,
  HARNESS_DEFAULTS,
  HARNESS_ROLE_DEFAULTS,
  HARNESS_SKILLS_ROOT,
  defaultSkillSet,
  loadDefaultSkill,
} from "@/lib/harness/default-skills"
import { CATALOG, CATALOG_V2 } from "@/lib/skill-library"
import { HARNESS_ROLE_CARTRIDGES } from "@/skills-harness"

import type { TestDb } from "../../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../setup"

const raw = (id: string) =>
  fs.readFileSync(path.join(HARNESS_SKILLS_ROOT, id, "SKILL.md"), "utf8")

describe("WT-CAR-01: the role set", () => {
  it("is one kriya-role-<role> per role, active, needing no Kriya tool, apart from every other catalogue", () => {
    expect(HARNESS_ROLE_DEFAULTS.map((s) => s.id).sort()).toEqual(
      CARTRIDGE_ROLES.map(cartridgeId).sort()
    )
    const others = new Set(
      [...CATALOG, ...CATALOG_V2, ...HARNESS_DEFAULTS].map((s) => s.id)
    )
    for (const s of HARNESS_ROLE_DEFAULTS) {
      expect(s.status).toBe("active")
      expect([...s.tools.all, ...s.tools.any, ...s.tools.uses]).toEqual([])
      expect(others.has(s.id), s.id).toBe(false)
      expect(HARNESS_CARTRIDGES.get(s.id)?.role, s.id).toBe(
        s.id.replace("kriya-role-", "")
      )
    }
  })
})

describe("WT-CAR-02: cartridge texts", () => {
  it("fit their budget, load through the library loader, and hold no link or shell block", () => {
    for (const s of HARNESS_ROLE_DEFAULTS) {
      const text = raw(s.id)
      expect(text).toMatch(new RegExp(`^---\\nname: ${s.id}\\n`))
      expect(text.length, s.id).toBeLessThanOrEqual(s.limits.maxChars)
      expect(HARNESS_CARTRIDGES.get(s.id)?.maxPromptChars).toBe(s.limits.maxChars)
      const body = loadDefaultSkill(s.id, s.version)
      expect(body, s.id).toMatch(/^# /)
      expect(body, s.id).not.toMatch(/https?:\/\//)
      expect(body, s.id).not.toMatch(/```(sh|bash|zsh|shell|powershell|cmd|console)\b/)
    }
  })

  it("skill folders hold only files the loader reads (the block lives in cartridges/)", () => {
    for (const s of HARNESS_ROLE_DEFAULTS)
      expect(fs.readdirSync(path.join(HARNESS_SKILLS_ROOT, s.id)).sort(), s.id).toEqual([
        "SKILL.md",
        "kriya.json",
      ])
  })
})

describe("WT-CAR-03: evals agree with keywords", () => {
  it("an ask to activate names a keyword; an ask to skip names none", () => {
    for (const s of HARNESS_ROLE_DEFAULTS)
      for (const e of s.evals) {
        const hit = s.activation.keywords.some((k) =>
          new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(e.ask)
        )
        expect(hit, `${s.id}: ${e.ask}`).toBe(e.expect === "activate")
      }
  })
})

describe("WT-CAR-04: buildCartridges refuses anything wrong", () => {
  const good = HARNESS_ROLE_CARTRIDGES as Array<Record<string, unknown>>
  const backend = good.find((c) => c.id === "kriya-role-backend")!
  const swap = (patch: Record<string, unknown>) =>
    good.map((c) => (c === backend ? { ...backend, ...patch } : c))

  it("accepts the shipped set", () => {
    expect(buildCartridges(HARNESS_ROLE_DEFAULTS, good).size).toBe(CARTRIDGE_ROLES.length)
  })

  it.each([
    ["an unknown gate", { gates: ["G-MAKE-IT-PASS"] }],
    ["no gate", { gates: [] }],
    ["an unknown detector", { detectors: [{ id: "XX-ANY", severity: "error" }] }],
    ["an extra field (e.g. a command)", { command: "exit 0" }],
    ["a mode or risk field", { mode: "full" }],
    ["a budget above the ceiling", { maxPromptChars: 9000 }],
    ["a glob with a space or shell character", { globs: ["*.ts; rm"] }],
  ])("refuses %s", (_what, patch) => {
    expect(() => buildCartridges(HARNESS_ROLE_DEFAULTS, swap(patch))).toThrow()
  })

  it("refuses an id that isn't its role's, a repeated role, a budget unlike the manifest's, and a manifest with no block", () => {
    expect(() =>
      buildCartridges(HARNESS_ROLE_DEFAULTS, swap({ id: "kriya-role-frontend" }))
    ).toThrow()
    expect(() =>
      buildCartridges(HARNESS_ROLE_DEFAULTS, swap({ maxPromptChars: 3000 }))
    ).toThrow(/maxPromptChars/)
    expect(() =>
      buildCartridges(
        HARNESS_ROLE_DEFAULTS,
        good.filter((c) => c !== backend)
      )
    ).toThrow(/no cartridge block/)
    expect(() =>
      buildCartridges(HARNESS_ROLE_DEFAULTS, [...good, { ...backend }])
    ).toThrow(/twice/)
  })

  it("the schema has no field for a command, URL, tool, mode, approval, limit or pass condition", () => {
    expect(Object.keys(CartridgeFile.shape).sort()).toEqual(
      [
        "detectors",
        "escalateAfter",
        "gates",
        "globs",
        "id",
        "judgement",
        "maxPromptChars",
        "owns",
        "reads",
        "role",
      ].sort()
    )
  })
})

describe("WT-CT-01: the contract", () => {
  it("exports the id lists the client copies", () => {
    expect(contractJson().cartridgeIds).toEqual({
      roles: [...CARTRIDGE_ROLES],
      gates: [...GATE_IDS],
      detectors: [...DETECTOR_IDS],
      contracts: [...CONTRACT_NAMES],
    })
  })
})

let pg: TestDb
let newUser: () => Promise<string>

const list = async (token: string) => {
  const res = await skills.GET(call("GET", "/skills", { token }))
  return { etag: res.headers.get("etag"), ...SkillsResponse.parse(await res.json()) }
}
const body = (token: string, id: string, version: string) =>
  skillBody.GET(call("GET", `/skills/${id}/${version}`, { token }))

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(() =>
  harnessEnv({
    KRIYA_AGENTS_SKILL_LIBRARY: "on",
    KRIYA_HARNESS_DEFAULT_SKILLS: "on",
    KRIYA_HARNESS_WORKFORCE: undefined,
    KRIYA_EDITING_SKILLS: undefined,
    KRIYA_SKILLS_DISABLED: undefined,
  })
)

describe("WT-SK-02/03: served only with harness.workforce on", () => {
  it("off (the default): the same set object, no role skill, no cartridge field, no body", async () => {
    expect(await defaultSkillSet()).toBe(HARNESS_DEFAULTS)
    const device = await deviceFor(pg, await newUser())
    const { skills: served } = await list(device.token)
    expect(served.some((s) => s.id.startsWith("kriya-role-"))).toBe(false)
    expect(served.some((s) => "cartridge" in s || "invocation" in s)).toBe(false)
    expect((await body(device.token, "kriya-role-backend", "1.0.0")).status).toBe(404)
  })

  it("on: the roles follow the defaults with their blocks, kept out of the model's catalogue; skills.disabled applies", async () => {
    const off = await list((await deviceFor(pg, await newUser())).token)
    harnessEnv({
      KRIYA_AGENTS_SKILL_LIBRARY: "on",
      KRIYA_HARNESS_DEFAULT_SKILLS: "on",
      KRIYA_HARNESS_WORKFORCE: "on",
      KRIYA_EDITING_SKILLS: undefined,
      KRIYA_SKILLS_DISABLED: "kriya-role-game",
    })
    const device = await deviceFor(pg, await newUser())
    const on = await list(device.token)
    const ids = on.skills.map((s) => s.id)
    expect(ids.slice(0, HARNESS_DEFAULTS.length)).toEqual(
      HARNESS_DEFAULTS.map((s) => s.id)
    )
    const roles = on.skills.filter((s) => s.id.startsWith("kriya-role-"))
    expect(roles.map((s) => s.id)).toEqual(
      HARNESS_ROLE_DEFAULTS.map((s) => s.id).filter((id) => id !== "kriya-role-game")
    )
    for (const r of roles) {
      expect(r.invocation).toEqual({ modelInvocable: false })
      expect(r.cartridge?.role).toBe(r.id.replace("kriya-role-", ""))
      expect(r.cartridge && "id" in r.cartridge).toBe(false)
    }
    for (const s of on.skills.filter((s) => !s.id.startsWith("kriya-role-")))
      expect("cartridge" in s || "invocation" in s, s.id).toBe(false)
    expect(on.etag).not.toBe(off.etag)
    const res = await body(device.token, "kriya-role-backend", "1.0.0")
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/^# Backend: design the failure modes first/)
    expect((await body(device.token, "kriya-role-game", "1.0.0")).status).toBe(404)
  })

  it("on without harness.defaultSkills: nothing is served", async () => {
    harnessEnv({
      KRIYA_AGENTS_SKILL_LIBRARY: "on",
      KRIYA_HARNESS_DEFAULT_SKILLS: undefined,
      KRIYA_HARNESS_WORKFORCE: "on",
    })
    const device = await deviceFor(pg, await newUser())
    expect((await list(device.token)).skills.some((s) => s.id.startsWith("kriya-"))).toBe(
      false
    )
  })
})
