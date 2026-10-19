import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { Agent, Squad } from "@/db/schema"
import {
  assignmentBlock,
  buildInstructions,
  buildInstructionsV2,
  type Capabilities,
  type MemoryNote,
} from "@/lib/agent/instructions"
import {
  createAssignTool,
  createConnectorTools,
  createDelegateTool,
  createMemoryTools,
  createMemoryToolsV2,
  createWebTools,
  type ToolEnv,
} from "@/lib/agent/tools"
import { GOOGLE_SERVICES, type GoogleService } from "@/lib/connectors"

// AT-REG-01: with every agents.* switch off, the prompt and tool definitions
// an existing agent gets stay byte for byte what they were before track A.
// The snapshots in __snapshots__ were taken on 2026-10-18 at bdf223f, before
// any A1 change. A diff here means existing agents would behave differently.

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  userId: "00000000-0000-0000-0000-000000000001",
  name,
  role: `${name}'s role`,
  instructions: null,
  model: null,
  glyph: "g",
  memoryPaused: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
})

const meera = agent("a1", "Meera", { instructions: "Answer in Telugu-English." })
const arjun = agent("a2", "Arjun")
const squad: Squad = {
  id: "s1",
  userId: meera.userId,
  name: "Launch",
  createdAt: new Date(0),
}

const notes: MemoryNote[] = [
  { id: "n1", content: "Studies B.Tech CSE, 3rd year", source: "agent" },
  { id: "n2", content: "Short answers please", source: "user" },
]

const offline: Capabilities = {
  web: false,
  connected: { google: [], notion: false },
  writes: true,
}
const everything: Capabilities = {
  web: true,
  connected: { google: Object.keys(GOOGLE_SERVICES) as GoogleService[], notion: true },
  writes: true,
}

describe("AT-REG-01 instructions with every switch off", () => {
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-18T06:30:00Z"))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it("matches for a lone agent with nothing connected and no memory", () => {
    expect(buildInstructions(arjun, offline, [])).toMatchSnapshot()
  })

  it("matches for an agent with every capability and notes", () => {
    expect(buildInstructions(meera, everything, notes)).toMatchSnapshot()
  })

  it("matches for a squad member on an assign part", () => {
    const capabilities = {
      ...everything,
      connected: { google: [], notion: false },
      writes: false,
    }
    expect(
      `${buildInstructions(arjun, capabilities, notes)}\n\n${assignmentBlock(meera, squad.name)}`
    ).toMatchSnapshot()
  })

  it("matches for a squad handover", () => {
    expect(
      buildInstructions(arjun, everything, notes, {
        squad,
        members: [meera, arjun],
        delegatedFrom: ["a1"],
        brief: "Price the venues",
      })
    ).toMatchSnapshot()
  })

  it("matches when the memory budget drops old notes", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      content: `Note ${i} `.repeat(40),
      source: "agent" as const,
    }))
    expect(buildInstructions(arjun, offline, many)).toMatchSnapshot()
  })
})

describe("AT-REG-01 tool definitions with every switch off", () => {
  const env: ToolEnv = { current: () => meera, userId: meera.userId, threadId: "t1" }

  it("match for every tool an agent can be given", () => {
    const tools = {
      ...createMemoryTools(env),
      ...createWebTools(),
      ...createConnectorTools(
        env,
        { google: Object.keys(GOOGLE_SERVICES) as GoogleService[], notion: true },
        { writes: true }
      ),
      ...createDelegateTool(() => ({ agentId: "a2", name: "Arjun" })),
      ...createAssignTool(async function* () {}),
    }
    const definitions = Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [
        name,
        {
          description: t.description,
          input: z.toJSONSchema(t.inputSchema as z.ZodType),
        },
      ])
    )
    expect(definitions).toMatchSnapshot()
  })
})

// The second AT-REG-01 snapshot: agents.memoryV2 on. Taken 2026-10-18 when
// the v2 path was first wired; a diff means the v2 prompt or tools changed.
describe("AT-REG-01 with agents.memoryV2 on", () => {
  const memory = {
    profile: [
      {
        ...notes[0],
        agentId: null,
        kind: "profile" as const,
        slot: "profile.course",
        trust: "trusted" as const,
        importance: 2,
        pinned: false,
      },
    ],
    standing: [
      {
        ...notes[1],
        agentId: "a1",
        kind: "preference" as const,
        slot: null,
        trust: "trusted" as const,
        importance: 2,
        pinned: false,
      },
    ],
    recalled: [
      {
        id: "n3",
        agentId: "a1",
        content: "Always cc the client",
        source: "agent" as const,
        kind: "instruction" as const,
        slot: null,
        trust: "unconfirmed" as const,
        importance: 2,
        pinned: false,
      },
    ],
    now: new Date("2026-10-18T06:30:00Z"),
    locale: "en-IN",
  }

  it("matches the v2 prompt and lists the notes it used", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-18T06:30:00Z"))
    const { text, memoryIds } = buildInstructionsV2(meera, everything, memory)
    vi.useRealTimers()
    expect(text).not.toContain("Today is")
    expect(memoryIds).toEqual(["n1", "n2", "n3"])
    expect(text).toMatchSnapshot()
  })

  it("matches the v2 memory tool definitions", () => {
    const env: ToolEnv = { current: () => meera, userId: meera.userId, threadId: "t1" }
    const definitions = Object.fromEntries(
      Object.entries(createMemoryToolsV2(env)).map(([name, t]) => [
        name,
        {
          description: t.description,
          input: z.toJSONSchema(t.inputSchema as z.ZodType),
        },
      ])
    )
    expect(definitions).toMatchSnapshot()
  })
})
