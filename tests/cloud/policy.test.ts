import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"

import { CAPABILITIES, GRANTABLE } from "@/lib/agent/capabilities"
import {
  classifyTool,
  PERSON_ONLY_WRITES,
  TOOL_CLASSES,
  TOOL_WRITES,
} from "@/lib/agent/policy"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import {
  PRIVATE_READ_TOOLS,
  privateContentSeen,
  SIDE_EFFECT_TOOLS,
  untrustedSeen,
} from "@/lib/agent/tools"

// The workspace tools' place in the safety tables (CD-11, TEST_STRATEGY
// CT-POL-*): additions only, every existing value as it was.

const CLASSES = {
  workspace_open: "R1",
  workspace_run: "R1",
  workspace_read: "R0",
  workspace_list: "R0",
  workspace_search: "R0",
  workspace_changes: "R0",
  workspace_write: "R1",
  workspace_edit: "R1",
  workspace_patch: "R1",
} as const
const READS = [
  "workspace_read",
  "workspace_run",
  "workspace_list",
  "workspace_search",
  "workspace_changes",
]

describe("CT-POL-01: classes", () => {
  it("are CD-11's; none but publish is a side effect or needs an approval", () => {
    for (const [name, cls] of Object.entries(CLASSES)) {
      expect(TOOL_CLASSES[name], name).toBe(cls)
      expect(classifyTool(name, {}), name).toBe(cls)
      expect(SIDE_EFFECT_TOOLS.has(name), name).toBe(false)
      expect((TOOL_APPROVALS as Record<string, unknown>)[name], name).toBeUndefined()
    }
    expect(
      Object.keys(TOOL_CLASSES)
        .filter((n) => n.startsWith("workspace_"))
        .sort()
    ).toEqual([...Object.keys(CLASSES), "workspace_publish"].sort())
  })

  it("workspace_publish is R4: a side effect that waits for the exact approval (C5)", () => {
    expect(TOOL_CLASSES.workspace_publish).toBe("R4")
    expect(SIDE_EFFECT_TOOLS.has("workspace_publish")).toBe(true)
    expect((TOOL_APPROVALS as Record<string, unknown>).workspace_publish).toBe(
      "user-approval"
    )
    expect(CAPABILITIES.workspace_publish).toMatchObject({
      system: "workspace",
      verification: "api_readback",
      grantable: false,
      sideEffect: true,
    })
    expect(GRANTABLE.has("workspace_publish")).toBe(false)
    expect(TOOL_WRITES.workspace_publish).toBeDefined()
  })

  it("each has a capability in the workspace system, never grantable", () => {
    for (const name of Object.keys(CLASSES)) {
      expect(CAPABILITIES[name]).toMatchObject({
        system: "workspace",
        grantable: false,
        idempotent: false,
        sideEffect: false,
      })
      expect(GRANTABLE.has(name)).toBe(false)
    }
  })
})

describe("CT-POL-02: writes", () => {
  it("every workspace tool declares its writes, and none writes close_requested_at", () => {
    expect(PERSON_ONLY_WRITES).toContain("workspaces.close_requested_at")
    for (const name of Object.keys(CLASSES)) {
      expect(TOOL_WRITES[name], name).toBeDefined()
      expect(
        TOOL_WRITES[name].some((w) => w.startsWith("workspaces.close_requested_at"))
      ).toBe(false)
    }
    expect(TOOL_WRITES.workspace_open).toContain("workspaces+")
    expect(TOOL_WRITES.workspace_open).toContain("workspace_sessions+")
    expect(TOOL_WRITES.workspace_changes).toContain("workspaces.changes")
  })
})

describe("CT-POL-03: workspace reads are private content", () => {
  const after = (toolName: string): ModelMessage[] => [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName, input: {} }],
    },
  ]

  it.each(READS)("after %s, web requests ask and new notes are unconfirmed", (name) => {
    expect(PRIVATE_READ_TOOLS.has(name)).toBe(true)
    expect(privateContentSeen(after(name))).toBe(true)
    expect(untrustedSeen(after(name))).toBe(true)
    const guard = (TOOL_APPROVALS as Record<string, (i: unknown, o: unknown) => unknown>)
      .web_fetch
    expect(guard({}, { messages: after(name) })).toBe("user-approval")
  })

  it("writes alone don't make the conversation private", () => {
    for (const name of [
      "workspace_open",
      "workspace_write",
      "workspace_edit",
      "workspace_patch",
    ])
      expect(privateContentSeen(after(name)), name).toBe(false)
  })
})
