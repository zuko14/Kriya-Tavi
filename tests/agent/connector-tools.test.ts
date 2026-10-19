import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"

import type { Agent } from "@/db/schema"
import { classifyTool } from "@/lib/agent/policy"
import {
  createConnectorTools,
  privateContentSeen,
  SIDE_EFFECT_TOOLS,
  type Connected,
  type ToolEnv,
} from "@/lib/agent/tools"

// A8 tools appear only for what's connected (scope checks), never as write
// tools for an `assign` member, and are classed by lib/agent/policy.ts.

const env: ToolEnv = {
  current: () => ({ id: "a1" }) as Agent,
  userId: "u1",
  threadId: "t1",
}
const names = (connected: Connected, writes = true) =>
  Object.keys(createConnectorTools(env, connected, { writes }))
const A8 = /^(github_|sheets_|youtube_|instagram_)/

describe("A8 tool belt", () => {
  it("today's connections get no new tool", () => {
    const today = names({ google: ["calendar", "gmail", "drive"], notion: true })
    expect(today.filter((n) => A8.test(n))).toEqual([])
  })

  it("each scope or provider switches on only its own tools", () => {
    expect(names({ google: ["sheets"], notion: false })).toEqual([
      "sheets_read",
      "sheets_append",
      "sheets_update",
    ])
    expect(names({ google: ["youtube"], notion: false })).toEqual(["youtube_stats"])
    expect(names({ google: [], notion: false, meta: true })).toEqual([
      "instagram_insights",
      "instagram_publish",
    ])
    expect(names({ google: [], notion: false, github: true })).toHaveLength(7)
  })

  it("an assign member gets only the reads", () => {
    const reads = names(
      { google: ["sheets", "youtube"], notion: false, github: true, meta: true },
      false
    )
    expect(reads.every((n) => !SIDE_EFFECT_TOOLS.has(n))).toBe(true)
    expect(reads).toContain("github_read_pr")
    expect(reads).not.toContain("instagram_publish")
  })

  it("public actions are R4, sheet edits R3, reads R0", () => {
    const r4 = [
      "github_comment",
      "github_create_issue",
      "github_label",
      "github_open_pr",
      "instagram_publish",
    ]
    for (const tool of r4) expect(classifyTool(tool, {}), tool).toBe("R4")
    for (const tool of ["sheets_append", "sheets_update"])
      expect(classifyTool(tool, {}), tool).toBe("R3")
    for (const tool of [
      "github_search",
      "sheets_read",
      "youtube_stats",
      "instagram_insights",
    ])
      expect(classifyTool(tool, {}), tool).toBe("R0")
  })

  it("reading a private repository or sheet guards later web requests", () => {
    const after = (toolName: string) =>
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c", toolName, input: {} }],
        },
      ] as ModelMessage[]
    expect(privateContentSeen(after("github_read_issue"))).toBe(true)
    expect(privateContentSeen(after("sheets_read"))).toBe(true)
  })
})
