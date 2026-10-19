import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"

import type { Agent } from "@/db/schema"
import {
  approvalFor,
  classifyTool,
  PERSON_ONLY_WRITES,
  TOOL_CLASSES,
  TOOL_WRITES,
} from "@/lib/agent/policy"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import {
  createAssignTool,
  createBrowserTools,
  createConnectorTools,
  createDelegateTool,
  createGoalTools,
  createMemoryTools,
  createMemoryToolsV2,
  createWebTools,
  SIDE_EFFECT_TOOLS,
  type ToolEnv,
} from "@/lib/agent/tools"
import type { TaskBrowser } from "@/lib/browser/session"

// Tool risk classes (AD-03) come from lib/agent/policy.ts. AT-POL-01: with
// every switch off, the approval map is today's for every existing tool.
// AT-POL-02: every tool has a class; an unknown one is refused. AT-POL-07:
// no tool writes a column only the person may set.

const env: ToolEnv = {
  current: () => ({ id: "a1" }) as Agent,
  userId: "u1",
  threadId: "t1",
}

const everyTool = () => ({
  ...createMemoryTools(env),
  ...createMemoryToolsV2(env),
  ...createWebTools(),
  ...createBrowserTools({} as TaskBrowser),
  ...createConnectorTools(
    env,
    { google: ["calendar", "gmail", "drive"], notion: true },
    { writes: true }
  ),
  ...createDelegateTool(() => ({ agentId: "a2", name: "B" })),
  ...createAssignTool(async function* () {}),
  ...createGoalTools(env),
})

// What today's runner had (run-task.ts before A3), written out by hand
const TODAY_APPROVED = ["calendar_create_event", "gmail_draft"]
const TODAY_GUARDED = ["web_search", "web_fetch", "browser_open"]

type Rule = (input: unknown, options: { messages: ModelMessage[] }) => unknown
const approvals = TOOL_APPROVALS as Record<string, unknown>
const none = { messages: [] as ModelMessage[] }
const afterMail = {
  messages: [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c", toolName: "gmail_read", input: {} },
      ],
    },
  ] as ModelMessage[],
}

describe("approval map (AT-POL-01)", () => {
  it("is today's for every tool that existed before A3", () => {
    const existing = Object.keys(everyTool()).filter(
      (name) => !name.startsWith("goal_") && !name.startsWith("schedule_")
    )
    for (const name of existing) {
      const rule = approvals[name]
      if (TODAY_APPROVED.includes(name)) expect(rule, name).toBe("user-approval")
      else if (TODAY_GUARDED.includes(name)) {
        expect((rule as Rule)({}, none), name).toBeUndefined()
        expect((rule as Rule)({}, afterMail), name).toBe("user-approval")
      } else expect(rule, name).toBeUndefined()
    }
  })

  it("SIDE_EFFECT_TOOLS are exactly the R3 and R4 tools", () => {
    const external = Object.keys(TOOL_CLASSES).filter((name) =>
      ["R3", "R4"].includes(classifyTool(name, {}))
    )
    expect([...SIDE_EFFECT_TOOLS].sort()).toEqual(external.sort())
  })

  it("a new schedule waits for approval, and so does a new rule; pausing doesn't", () => {
    expect(approvals.schedule_create).toBe("user-approval")
    const update = approvals.schedule_update as Rule
    expect(update({ scheduleId: "s", status: "paused" }, none)).toBeUndefined()
    expect(update({ scheduleId: "s", status: "ended" }, none)).toBeUndefined()
    expect(update({ scheduleId: "s", rule: { freq: "daily", at: "09:00" } }, none)).toBe(
      "user-approval"
    )
    expect(approvals.goal_create).toBeUndefined()
    expect(approvals.goal_update).toBeUndefined()
  })
})

describe("classes (AT-POL-02)", () => {
  it("every tool in the catalogue has a class", () => {
    for (const name of Object.keys(everyTool())) {
      expect(TOOL_CLASSES[name], name).toBeDefined()
    }
  })

  it("an unknown tool is R5 and refused", () => {
    expect(classifyTool("pay_now", {})).toBe("R5")
    expect(approvalFor(classifyTool("pay_now", {}))).toBe("refuse")
  })

  it("matches the catalogue for the A3 tools", () => {
    expect(classifyTool("goal_create", {})).toBe("R1")
    expect(classifyTool("goal_update", { status: "achieved" })).toBe("R1")
    expect(classifyTool("schedule_create", {})).toBe("R2")
    expect(classifyTool("schedule_update", { status: "paused" })).toBe("R1")
    expect(classifyTool("schedule_update", { rule: {} })).toBe("R2")
    expect(classifyTool("calendar_create_event", {})).toBe("R3")
    expect(classifyTool("gmail_draft", {})).toBe("R3")
  })
})

// Writes: "table+" / "table-" (inserts / deletes rows) or "table.column"
// (changes existing rows), with the values it can set ("table.column:a|b")
// or none for any value. Forbidden: "table", "table.column" or
// "table.column:value".
function collides(write: string, forbidden: string) {
  const [wTarget, wValues] = write.split(":")
  const [fTarget, fValue] = forbidden.split(":")
  const [wTable, wColumn] = wTarget.replace(/[+-]$/, "").split(".")
  const [fTable, fColumn] = fTarget.split(".")
  if (wTable !== fTable || (fColumn && wColumn !== fColumn)) return false
  return !fValue || !wValues || wValues.split("|").includes(fValue)
}

describe("person-only columns (AT-POL-07)", () => {
  it("every classified tool declares what it writes", () => {
    expect(Object.keys(TOOL_WRITES).sort()).toEqual(Object.keys(TOOL_CLASSES).sort())
  })

  it("no tool writes a column, or a value, that only the person may set", () => {
    for (const [tool, writes] of Object.entries(TOOL_WRITES)) {
      for (const write of writes) {
        for (const forbidden of PERSON_ONLY_WRITES) {
          expect(collides(write, forbidden), `${tool}: ${write} vs ${forbidden}`).toBe(
            false
          )
        }
      }
    }
  })

  it("would catch a tool that confirms a note, resumes a schedule or shares", () => {
    const caught = (write: string) => PERSON_ONLY_WRITES.some((f) => collides(write, f))
    expect(caught("memories.trust:trusted")).toBe(true)
    expect(caught("schedules.status:paused|active")).toBe(true)
    expect(caught("share_links.expires_at")).toBe(true)
    expect(caught("share_links+")).toBe(true)
    expect(caught("schedules.status:paused|ended")).toBe(false)
    expect(caught("memories+")).toBe(false)
  })
})
