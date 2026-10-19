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
import { gstinCheckChar } from "@/lib/gst"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The runner with agents.ledger (scripted model). Off, or a plan without
// the ledger: no ledger tool and the same prompt (AT-REG-01). On: the agent
// can draft an entry, which Kriya reconciles and leaves for the person to
// confirm (AT-LED-06 end to end).

const LEDGER_TOOLS = ["ledger_list", "ledger_draft_entry", "invoice_draft"]
const GSTIN = "29ABCDE1234F1Z" + gstinCheckChar("29ABCDE1234F1Z")

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
  if (prompt.includes("DRAFT_BILL") && !prompt.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call",
        toolCallId: "call-l",
        toolName: "ledger_draft_entry",
        input: JSON.stringify({
          myStateCode: "29",
          entries: [
            {
              date: "2026-10-05",
              counterparty: "Fixture Power Ltd",
              gstin: GSTIN,
              documentNo: "EB-1",
              lines: [{ description: "Power", amountPaise: 100_000, taxRateBps: 1800 }],
              // The model's total is off by ₹10: Kriya flags it, doesn't use it
              totalPaise: 119_000,
            },
          ],
        }),
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

async function turn(text: string) {
  await enqueueTurn({
    userId: user,
    threadId: "t1",
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
}

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  delete process.env.KRIYA_AGENTS_LEDGER
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Lekha', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

afterEach(() => {
  delete process.env.KRIYA_AGENTS_LEDGER
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
})

describe("agents.ledger", () => {
  it("off: no ledger tool", async () => {
    await pg.query("update kriya.plans set ledger_enabled = true")
    await turn("hello")
    expect(offered[0].filter((n) => LEDGER_TOOLS.includes(n))).toEqual([])
  })

  it("on, but the plan has no ledger: no ledger tool, same prompt as off", async () => {
    await turn("hello")
    const off = prompts[0]
    process.env.KRIYA_AGENTS_LEDGER = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await turn("hello")
    expect(offered[1].filter((n) => LEDGER_TOOLS.includes(n))).toEqual([])
    expect(prompts[1]).toBe(off)
  })

  it("on with the plan: the tools are offered and a drafted bill waits for the person", async () => {
    process.env.KRIYA_AGENTS_LEDGER = "on"
    await pg.query("update kriya.plans set ledger_enabled = true")
    await turn("DRAFT_BILL")
    expect(LEDGER_TOOLS.every((n) => offered[0].includes(n))).toBe(true)
    const { rows } = await pg.query<Record<string, unknown>>(
      "select status, total_paise::int as total, created_by, review_reasons from kriya.ledger_entries"
    )
    expect(rows).toEqual([
      {
        status: "needs_review",
        total: 118_000,
        created_by: "agent",
        review_reasons: [
          "Value before tax plus taxes is ₹1,180.00; the bill says ₹1,190.00.",
        ],
      },
    ])
  })
})
