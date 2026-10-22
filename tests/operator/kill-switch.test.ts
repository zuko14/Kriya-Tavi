import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The owner's kill list (O1, operator.disabledTools) through the real
// runner on the scripted model. OT-REG-01: unset, or naming no tool the
// belt has, changes nothing. OT-CAP-03: a listed tool is offered to
// neither the lead nor an `assign` member, and never runs even when the
// model calls it.

const offered: string[][] = []
const prompts: string[] = []

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage,
})
const say = (text: string) => [
  { type: "text-start" as const, id: "t1" },
  { type: "text-delta" as const, id: "t1", delta: text },
  { type: "text-end" as const, id: "t1" },
  finish("stop"),
]
type Chunk =
  | ReturnType<typeof finish>
  | ReturnType<typeof say>[number]
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
const call = (toolName: string, input: unknown): Chunk[] => [
  {
    type: "tool-call",
    toolCallId: `call-${toolName}`,
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
]

function script(prompt: string): Chunk[] {
  const answered = prompt.includes('"role":"tool"')
  if (prompt.includes("Your part, from")) return say("Part done.")
  if (prompt.includes("SAVE_NOTE") && !answered)
    return call("memory_write", { note: "Killed tools never run" })
  if (prompt.includes("SPLIT_WORK") && !answered)
    return call("assign", { assignments: [{ agentId: "a2", brief: "Look into it" }] })
  return say("Done.")
}

vi.mock("@/lib/models", async (original) => {
  const actual = await original<typeof import("@/lib/models")>()
  return {
    ...actual,
    isGatewayConfigured: () => true,
    createGatewayModel: (modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doStream: async (options) => {
          offered.push((options.tools ?? []).map((t) => t.name))
          prompts.push(JSON.stringify(options.prompt.filter((m) => m.role === "system")))
          return {
            stream: simulateReadableStream({
              chunks: script(JSON.stringify(options.prompt)),
            }),
          }
        },
      }),
  }
})

let pg: TestDb
let user: string

const kill = (names: string | undefined) => {
  if (names === undefined) delete process.env.KRIYA_OPERATOR_DISABLED_TOOLS
  else process.env.KRIYA_OPERATOR_DISABLED_TOOLS = names
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

async function turn(text: string, threadId = "t1") {
  await enqueueTurn({
    userId: user,
    threadId,
    message: {
      id: `m${Math.random()}`,
      role: "user",
      parts: [{ type: "text", text }],
    } as KriyaMessage,
  })
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  const id = rowsOf<{ id: string }>(
    await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
  )[0]?.id
  const { rows } = await pg.query<Record<string, unknown>>(
    "select * from kriya.tasks where id = $1",
    [id]
  )
  const task = Object.fromEntries(
    Object.entries(rows[0]).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value,
    ])
  ) as unknown as schema.Task
  await runTask(task, {
    workerId: "w1",
    leaseSeconds: 30,
    shutdown: new AbortController().signal,
  })
  return id
}

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  kill(undefined)
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      `insert into kriya.agents (id, user_id, name, role, glyph) values
        ('a1', $1, 'Lekha', 'r', 'g'), ('a2', $1, 'Ravi', 'r', 'g')`,
      [user]
    )
    await tx.query(
      "insert into kriya.squads (id, user_id, name) values ('s1', $1, 'Crew')",
      [user]
    )
    await tx.query(
      `insert into kriya.squad_members (squad_id, agent_id, user_id, position) values
        ('s1', 'a1', $1, 0), ('s1', 'a2', $1, 1)`,
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    // A squad thread, for `assign`
    await tx.query(
      "insert into kriya.threads (id, user_id, squad_id) values ('t2', $1, 's1')",
      [user]
    )
  })
})

afterEach(() => kill(undefined))

describe("unset kill list (OT-REG-01)", () => {
  it("offers the same tools and prompt as a list naming no belt tool", async () => {
    await turn("hello")
    kill("instagram_publish")
    await turn("hello")
    expect(offered[0]).toContain("memory_write")
    expect(offered[1]).toEqual(offered[0])
    expect(prompts[1]).toBe(prompts[0])
  })
})

describe("killed tools (OT-CAP-03)", () => {
  it("leave the lead's belt; the rest stays", async () => {
    kill("memory_write")
    await turn("hello")
    expect(offered[0]).not.toContain("memory_write")
    expect(offered[0]).toContain("memory_forget")
  })

  it("never run, even when the model calls one", async () => {
    kill("memory_write")
    const taskId = await turn("SAVE_NOTE")
    const { rows: notes } = await pg.query("select 1 from kriya.memories")
    expect(notes).toEqual([])
    // Not even started: the SDK has no such tool to run
    const { rows: runs } = await pg.query(
      "select status from kriya.tool_executions where tool_name = 'memory_write'"
    )
    expect(runs).toEqual([])
    // The model is told and carries on; the task isn't retried or failed
    const { rows } = await pg.query<{ status: string; attempts: number }>(
      "select status, attempts from kriya.tasks where id = $1",
      [taskId]
    )
    expect(rows[0]).toEqual({ status: "succeeded", attempts: 1 })
  })

  it("leave an assign member's belt too", async () => {
    kill("memory_write")
    await turn("SPLIT_WORK", "t2")
    const member = offered.find((names) => !names.includes("assign"))
    expect(member).toBeDefined()
    expect(member).toContain("memory_forget")
    expect(member).not.toContain("memory_write")
  })

  it("with the list unset, a member still has it (control)", async () => {
    await turn("SPLIT_WORK", "t2")
    const member = offered.find((names) => !names.includes("assign"))
    expect(member).toContain("memory_write")
  })
})
