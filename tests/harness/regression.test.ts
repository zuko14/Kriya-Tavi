import { describe, expect, it } from "vitest"

import { SETTINGS } from "@/lib/config"

// HT-REG-01 (track H), settings part (H1): every harness.* switch ships off
// and every default passes its own check. The route and usageSummary parts
// come with the phases that add them (H2, H3).

const defs = SETTINGS as unknown as Record<
  string,
  { env: string | null; fallback?: string; pattern?: RegExp }
>
const HARNESS_KEYS = Object.keys(defs).filter((key) => key.startsWith("harness."))

describe("HT-REG-01: the harness.* settings", () => {
  it("are the HD-18 block", () => {
    expect(HARNESS_KEYS.sort()).toEqual([
      "harness.api",
      "harness.approvalTtlMinutes",
      "harness.deviceIdleDays",
      "harness.deviceWorld",
      "harness.gateway",
      "harness.handoff",
      "harness.installCommand",
      "harness.minClientVersion",
      "harness.mirror",
      "harness.releaseStage",
      "harness.rpm",
    ])
  })

  it("ship off, with HD-18's defaults", () => {
    for (const key of [
      "harness.api",
      "harness.gateway",
      "harness.mirror",
      "harness.handoff",
      "harness.deviceWorld",
    ])
      expect(defs[key].fallback, key).toBe("off")
    expect(defs["harness.minClientVersion"].fallback).toBe("0.0.0")
    expect(defs["harness.deviceIdleDays"].fallback).toBe("90")
    expect(defs["harness.approvalTtlMinutes"].fallback).toBe("30")
    expect(defs["harness.rpm"].fallback).toBe("60")
    // HD-02: Beta until the owner flips it after the gates
    expect(defs["harness.releaseStage"].fallback).toBe("beta")
    expect(defs["harness.releaseStage"].pattern?.test("production")).toBe(false)
  })

  it("every default passes its own check, and each reads its own variable", () => {
    for (const key of HARNESS_KEYS) {
      const def = defs[key]
      expect(def.env, key).toMatch(/^KRIYA_HARNESS_[A-Z_]+$/)
      if (def.fallback !== undefined && def.pattern)
        expect(def.pattern.test(def.fallback), key).toBe(true)
    }
    expect(defs["harness.api"].pattern?.test("maybe")).toBe(false)
    expect(defs["harness.rpm"].pattern?.test("0")).toBe(false)
    // Shown as a command to copy: one plain install line, nothing chained
    const install = defs["harness.installCommand"]
    expect(install.fallback).toBeUndefined()
    expect(install.pattern?.test("npm install -g @kriya-ai/harness")).toBe(true)
    expect(install.pattern?.test("npm i x && echo hi")).toBe(false)
    expect(install.pattern?.test("npm i x; echo hi")).toBe(false)
    expect(install.pattern?.test("curl https://x.example/i.sh | sh")).toBe(false)
  })
})
