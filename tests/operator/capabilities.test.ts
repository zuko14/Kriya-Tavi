import { describe, expect, it } from "vitest"
import type { z } from "zod"

import { GRANT_TOOLS, type Agent } from "@/db/schema"
import { CAPABILITIES, disabledTools, GRANTABLE } from "@/lib/agent/capabilities"
import { TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import {
  createAssignTool,
  createBrowserTools,
  createConnectorTools,
  createDelegateTool,
  createGoalTools,
  createKitTools,
  createLedgerTools,
  createMemoryTools,
  createMemoryToolsV2,
  createProposeCallTool,
  createRadarTools,
  createSkillTools,
  createWebTools,
  SIDE_EFFECT_TOOLS,
  type ToolEnv,
} from "@/lib/agent/tools"
import type { TaskBrowser } from "@/lib/browser/session"
import {
  GOOGLE_EXTRA_SERVICES,
  GOOGLE_SERVICES,
  type GoogleService,
} from "@/lib/connectors"
import { undoOf } from "@/lib/undo"

// The capability registry (track O, O1). OT-CAP-01: one entry per
// classified tool, and its risk, side effect and writes are the policy
// tables' own. OT-CAP-02: only the four tools of OD-03 can be granted, each
// pinning fields its input really has. Undo and verification say what the
// code does today.

const env: ToolEnv = {
  current: () => ({ id: "a1" }) as Agent,
  userId: "u1",
  threadId: "t1",
}

// Every tool any belt can hold, with every switch and connection on
const everyTool = () => ({
  ...createMemoryTools(env),
  ...createMemoryToolsV2(env),
  ...createWebTools(),
  ...createBrowserTools({} as TaskBrowser),
  ...createKitTools(env, {} as TaskBrowser),
  ...createConnectorTools(
    env,
    {
      google: [
        ...Object.keys(GOOGLE_SERVICES),
        ...Object.keys(GOOGLE_EXTRA_SERVICES),
      ] as GoogleService[],
      notion: true,
      github: true,
      meta: true,
    },
    { writes: true }
  ),
  ...createGoalTools(env, { watchers: true }),
  ...createRadarTools(env, { radar: true, facts: true }),
  ...createSkillTools(env, () => ({}), null),
  ...createLedgerTools(env),
  ...createProposeCallTool(env),
  ...createDelegateTool(() => ({ agentId: "a2", name: "B" })),
  ...createAssignTool(async function* () {}),
})

describe("registry (OT-CAP-01)", () => {
  it("has exactly one entry per classified tool", () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual(Object.keys(TOOL_CLASSES).sort())
  })

  it("takes risk, side effect and writes from the policy tables", () => {
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      expect(capability.tool, name).toBe(name)
      expect(capability.risk, name).toBe(TOOL_CLASSES[name])
      expect(capability.sideEffect, name).toBe(SIDE_EFFECT_TOOLS.has(name))
      expect(capability.writes, name).toEqual(TOOL_WRITES[name])
    }
  })

  it("covers every belt tool but propose_call, which has no class (OF-12)", () => {
    const unclassed = Object.keys(everyTool()).filter((name) => !(name in CAPABILITIES))
    expect(unclassed).toEqual(["propose_call"])
  })

  it("marks undoable exactly the tools lib/undo.ts can reverse", () => {
    const everything = {
      id: "e1",
      draftId: "d1",
      repo: "o/r",
      commentId: 1,
      number: 2,
      added: ["bug"],
      fileId: "f1",
      permissionIds: ["p1"],
      verification: { status: "verified", method: "api_readback", evidence: [] },
    }
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      expect(capability.undoable, name).toBe(undoOf(name, everything) !== null)
    }
  })

  it("records that Gmail drafts and calendar events read back what they made (OF-13)", () => {
    expect(CAPABILITIES.gmail_draft.verification).toBe("api_readback")
    expect(CAPABILITIES.calendar_create_event.verification).toBe("api_readback")
    expect(CAPABILITIES.sheets_append.verification).toBe("api_readback")
    expect(CAPABILITIES.kit_check.verification).toBe("page_check")
  })
})

describe("grantable tools (OT-CAP-02)", () => {
  it("are exactly the four of OD-03, each R2 or R3", () => {
    expect([...GRANTABLE].sort()).toEqual([
      "calendar_create_event",
      "gmail_draft",
      "sheets_append",
      "sheets_update",
    ])
    for (const name of GRANTABLE) {
      expect(["R2", "R3"], name).toContain(CAPABILITIES[name].risk)
    }
  })

  it("only grantable tools have pins, and every pin is a field of the tool's input", () => {
    const tools = everyTool() as Record<string, { inputSchema: unknown }>
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      expect(capability.grantable, name).toBe(GRANTABLE.has(name))
      if (!capability.grantable) {
        expect(capability.pins, name).toBeUndefined()
        continue
      }
      const fields = Object.keys((tools[name].inputSchema as z.ZodObject).shape)
      expect(Object.keys(capability.pins ?? {}).length, name).toBeGreaterThan(0)
      for (const pin of Object.keys(capability.pins ?? {})) {
        expect(fields, `${name}.${pin}`).toContain(pin)
      }
    }
  })

  it("matches the tools the database will store a grant for", () => {
    expect([...GRANTABLE].sort()).toEqual([...GRANT_TOOLS].sort())
  })

  it("never includes R4, R5, calls, browser or schedule tools", () => {
    for (const name of GRANTABLE) {
      expect(["R4", "R5"]).not.toContain(CAPABILITIES[name].risk)
      expect(name).not.toMatch(/^(browser_|schedule_|propose_call|skill_)/)
    }
  })
})

describe("kill list (operator.disabledTools)", () => {
  it("reads a comma-separated list; unset or empty is nothing", () => {
    expect(disabledTools(undefined)).toEqual(new Set())
    expect(disabledTools("")).toEqual(new Set())
    expect(disabledTools("instagram_publish, github_comment,,")).toEqual(
      new Set(["instagram_publish", "github_comment"])
    )
  })
})
