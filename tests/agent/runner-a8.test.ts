import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueApproval, enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { connectedUser, REPO, serve } from "../connectors/fixtures"
import { asUser, type TestDb } from "../db/harness"

// The runner with the A8 switches (scripted model, fixture HTTP). With
// agents.connectors off, a person with GitHub connected gets today's tools
// and prompt (AT-REG-01). With it on, GitHub tools appear, a comment waits
// for approval (R4), and once approved it runs, reads back, and, with
// agents.undo on, records how to undo it.

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

function script(prompt: string): Chunk[] {
  if (prompt.includes("COMMENT_IT") && !prompt.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call" as const,
        toolCallId: "call-c",
        toolName: "github_comment",
        input: JSON.stringify({ repo: REPO, number: 7, body: "Thanks!" }),
      },
      finish("tool-calls"),
    ]
  }
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
          prompts.push(JSON.stringify(options.prompt))
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
let n = 0

async function claimAndRun() {
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
}

async function turn(text: string) {
  await enqueueTurn({
    userId: user,
    threadId: "t1",
    message: {
      id: `m${++n}`,
      role: "user",
      parts: [{ type: "text", text }],
    } as KriyaMessage,
  })
  await claimAndRun()
}

const resetSettings = () => {
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  for (const key of ["KRIYA_AGENTS_CONNECTORS", "KRIYA_AGENTS_UNDO"])
    delete process.env[key]
  resetSettings()
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  ;({ pg, userId: user } = await connectedUser(["github"]))
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Dev', 'Code', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("agents.connectors off", () => {
  it("offers no GitHub tool and says nothing about GitHub, though it's connected", async () => {
    await turn("hello")
    expect(offered[0].some((name) => name.startsWith("github_"))).toBe(false)
    expect(prompts[0]).not.toContain("GitHub")
  })
})

describe("agents.connectors and agents.undo on", () => {
  beforeEach(() => {
    process.env.KRIYA_AGENTS_CONNECTORS = "on"
    process.env.KRIYA_AGENTS_UNDO = "on"
    resetSettings()
  })

  it("waits for approval, then comments, reads back and records the undo", async () => {
    await turn("COMMENT_IT")
    expect(offered[0]).toEqual(
      expect.arrayContaining(["github_comment", "github_search"])
    )
    expect(prompts[0]).toContain("GitHub (`github_search`")
    // R4: nothing ran yet
    const ran = await pg.query(
      "select 1 from kriya.tool_executions where tool_name = 'github_comment'"
    )
    expect(ran.rows).toEqual([])

    const { rows: messages } = await pg.query<{
      parts: { type: string; approval?: { id: string } }[]
    }>("select parts from kriya.messages where role = 'assistant'")
    const approvalId = messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-github_comment")?.approval?.id
    expect(approvalId).toBeTruthy()

    const API = "^https:\\/\\/api\\.github\\.com\\/repos\\/octo-org\\/kriya-demo\\/issues"
    serve([
      {
        method: "POST",
        url: new RegExp(`${API}\\/7\\/comments$`),
        status: 201,
        body: { id: 9001, html_url: "https://github.com/c/9001" },
      },
      {
        url: new RegExp(`${API}\\/comments\\/9001$`),
        body: { id: 9001, body: "Thanks!" },
      },
    ])
    await enqueueApproval({
      userId: user,
      threadId: "t1",
      approvalId: approvalId!,
      approved: true,
    })
    await claimAndRun()

    const { rows } = await pg.query<{
      status: string
      side_effect: boolean
      verification: { status: string }
      undo: unknown
      undo_until: Date | null
    }>(
      "select status, side_effect, verification, undo, undo_until from kriya.tool_executions where tool_name = 'github_comment'"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      side_effect: true,
      verification: { status: "verified" },
      undo: { kind: "github_comment", repo: REPO, commentId: 9001 },
    })
    const left = new Date(rows[0].undo_until!).getTime() - Date.now()
    expect(left).toBeGreaterThan(9 * 60_000)
    expect(left).toBeLessThanOrEqual(10 * 60_000)
  })
})
