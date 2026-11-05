import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { ModelMessage } from "ai"

import { privateContentSeen, untrustedSeen } from "@/lib/agent/tools"
import { available, TOOLS } from "@/components/workspace/places"
import { SETTINGS } from "@/lib/config"
import { FLOW_CONTEXT, FLOW_PRIVATE } from "@/lib/flows/marker"
import type { Features } from "@/queries/features"

// ST-REG: everything in track S ships off, and off changes nothing.

const defs = SETTINGS as unknown as Record<
  string,
  { fallback?: string; pattern?: RegExp }
>
const user = (content: string): ModelMessage[] => [{ role: "user", content }]

describe("ST-REG", () => {
  it("every studio.* switch ships off, and every default passes its own check", () => {
    const keys = Object.keys(defs).filter((k) => k.startsWith("studio."))
    expect(keys.sort()).toEqual([
      "studio.copilot",
      "studio.copilotDaily",
      "studio.dailyRuns",
      "studio.deviceFlows",
      "studio.flows",
      "studio.maxConcurrentNodes",
      "studio.maxNodeRuns",
    ])
    for (const key of ["studio.flows", "studio.copilot", "studio.deviceFlows"])
      expect(defs[key].fallback, key).toBe("off")
    for (const key of keys)
      expect(defs[key].pattern?.test(defs[key].fallback!), key).toBe(true)
  })

  it("off, navigation has no Flows", () => {
    const off = { flows: false } as Features
    expect(available(TOOLS, off).some((t) => t.href === "/flows")).toBe(false)
    expect(
      available(TOOLS, { flows: true } as Features).some((t) => t.href === "/flows")
    ).toBe(true)
  })

  it("the guards are unchanged for anything without a marker", () => {
    expect(privateContentSeen(user("Summarise my salary slip"))).toBe(false)
    expect(untrustedSeen(user("Summarise my salary slip"))).toBe(false)
  })

  it("the markers only ever make a thread stricter (SD-11)", () => {
    expect(privateContentSeen(user(`Brief. ${FLOW_PRIVATE}.`))).toBe(true)
    expect(untrustedSeen(user(`Brief. ${FLOW_CONTEXT}.`))).toBe(true)
    // Quoting earlier steps alone isn't a private read
    expect(privateContentSeen(user(`Brief. ${FLOW_CONTEXT}.`))).toBe(false)
  })
})
