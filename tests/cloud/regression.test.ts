import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ai", async (original) =>
  (await import("./agent-seen")).aiMock(await original<typeof import("ai")>())
)
vi.mock("@/lib/models", async (original) =>
  (await import("./agent-mocks")).modelMock(await original())
)
vi.mock("@/lib/web", async (original) =>
  (await import("./agent-mocks")).webMock(await original())
)
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))

import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import { setWorkspaceProviderForTests } from "@/lib/cloud/session"
import { SETTINGS } from "@/lib/config"

import { model, say, switches, world, type World } from "../operator/golden/harness"
import { reset, seen } from "./agent-mocks"
import { FakeProvider } from "./fake-provider"

// CT-REG-01 (track C): every cloud.* switch ships off, every default passes
// its own check, and no setting holds a price by default (C1). With the
// switches off or unset, runTask hands the model today's approvals object
// itself, the belt and prompt are byte for byte the same, no workspace table
// is read and no provider is touched (C4).

const defs = SETTINGS as unknown as Record<
  string,
  { env: string | null; fallback?: string; pattern?: RegExp }
>
const CLOUD_KEYS = Object.keys(defs).filter((key) => key.startsWith("cloud."))

describe("CT-REG-01: the cloud.* settings", () => {
  it("are the CD-23 block", () => {
    expect(CLOUD_KEYS.sort()).toEqual([
      "cloud.commandTimeoutSeconds",
      "cloud.costMicroUsdPerHour",
      "cloud.image",
      "cloud.maxCheckpointMb",
      "cloud.maxImportMb",
      "cloud.maxRunning",
      "cloud.network",
      "cloud.orphanSeconds",
      "cloud.pausedHours",
      "cloud.provider",
      "cloud.publish",
      "cloud.retentionDays",
      "cloud.size",
      "cloud.workspaces",
    ])
  })

  it("ship off: both switches off, no provider, no price", () => {
    expect(defs["cloud.workspaces"].fallback).toBe("off")
    expect(defs["cloud.publish"].fallback).toBe("off")
    expect(defs["cloud.provider"].fallback).toBe("none")
    // Never invent a price (invariant 6): unset until the owner enters one
    expect(defs["cloud.costMicroUsdPerHour"].fallback).toBeUndefined()
  })

  it("every default passes its own check; each has its own variable", () => {
    for (const key of CLOUD_KEYS) {
      const { env, fallback, pattern } = defs[key]
      expect(env, key).toMatch(/^KRIYA_CLOUD_[A-Z_]+$/)
      expect(pattern, key).toBeInstanceOf(RegExp)
      if (fallback !== undefined) expect(pattern!.test(fallback), key).toBe(true)
    }
    const envs = CLOUD_KEYS.map((key) => defs[key].env)
    expect(new Set(envs).size).toBe(envs.length)
  })

  it("checks the values the owner may enter", () => {
    const ok = (key: string, value: string) => defs[key].pattern!.test(value)
    expect(ok("cloud.provider", "local")).toBe(true)
    expect(ok("cloud.provider", "docker")).toBe(false)
    // The workspaces.size check in SQL
    expect(ok("cloud.size", "8c-16g")).toBe(true)
    expect(ok("cloud.size", "9c-4g")).toBe(false)
    expect(ok("cloud.network", "offline")).toBe(true)
    expect(ok("cloud.network", "open")).toBe(false)
    expect(ok("cloud.commandTimeoutSeconds", "1800")).toBe(true)
    expect(ok("cloud.commandTimeoutSeconds", "1801")).toBe(false)
    expect(ok("cloud.commandTimeoutSeconds", "0")).toBe(false)
    expect(ok("cloud.maxRunning", "0")).toBe(false)
    expect(ok("cloud.orphanSeconds", "3599")).toBe(true)
    expect(ok("cloud.orphanSeconds", "29")).toBe(false)
    expect(ok("cloud.orphanSeconds", "3601")).toBe(false)
    expect(ok("cloud.costMicroUsdPerHour", "180000")).toBe(true)
    expect(ok("cloud.costMicroUsdPerHour", "0.18")).toBe(false)
    // Unpriced is unset, never zero
    expect(ok("cloud.costMicroUsdPerHour", "0")).toBe(false)
    expect(ok("cloud.image", "kriya-runner:1.0")).toBe(true)
    expect(ok("cloud.image", "bad image")).toBe(false)
  })
})

describe("CT-REG-01: runTask with the cloud switches off", () => {
  let w: World
  let provider: FakeProvider
  const sql: string[] = []
  const CLOUD_ENV = CLOUD_KEYS.map((key) => defs[key].env!)

  const setAll = (value: "off" | null) => {
    for (const key of CLOUD_KEYS) {
      if (defs[key].pattern?.source !== "^(on|off)$") continue
      if (value) process.env[defs[key].env!] = value
      else delete process.env[defs[key].env!]
    }
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  }

  beforeEach(async () => {
    reset()
    sql.length = 0
    w = await world()
    // Everything a workspace would need, so only the switch keeps it out
    provider = new FakeProvider()
    setWorkspaceProviderForTests(provider)
    process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
    await w.q("update kriya.plans set workspace_minutes = 600")
    const original = w.pg.query.bind(w.pg) as (...args: unknown[]) => Promise<unknown>
    ;(w.pg as unknown as { query: unknown }).query = (...args: unknown[]) => {
      if (typeof args[0] === "string") sql.push(args[0])
      return original(...args)
    }
  })

  afterEach(async () => {
    for (const name of CLOUD_ENV) delete process.env[name]
    setWorkspaceProviderForTests(null)
    switches(false)
    model.script = () => say("Done.")
    await provider.closeAll()
  })

  it("off equals unset: the same approvals object, belt and prompt; nothing of track C runs", async () => {
    model.script = () => say("Hello.")
    setAll(null)
    await w.turn("hello")
    setAll("off")
    await w.turn("hello")
    expect(seen.approvals).toHaveLength(2)
    for (const approvals of seen.approvals) expect(approvals).toBe(TOOL_APPROVALS)
    expect(seen.tools[1].names).toEqual(seen.tools[0].names)
    expect(seen.tools[0].names.filter((n) => n.startsWith("workspace_"))).toEqual([])
    expect(seen.prompts[1]).toBe(seen.prompts[0])
    expect(seen.prompts[0]).not.toContain("Cloud workspace")
    // The tables, not plans.workspace_minutes (the plan row is read whole)
    const tables =
      /"workspaces"|"workspace_sessions"|kriya\.workspace|open_workspace_session/
    expect(sql.filter((q) => tables.test(q))).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it("on, but the plan has no workspace minutes: still nothing", async () => {
    model.script = () => say("Hello.")
    setAll(null)
    await w.turn("hello")
    await w.q("update kriya.plans set workspace_minutes = 0")
    process.env.KRIYA_CLOUD_WORKSPACES = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await w.turn("hello")
    expect(seen.approvals[1]).toBe(TOOL_APPROVALS)
    expect(seen.tools[1].names).toEqual(seen.tools[0].names)
    expect(seen.prompts[1]).toBe(seen.prompts[0])
    expect(provider.calls).toEqual([])
  })
})
