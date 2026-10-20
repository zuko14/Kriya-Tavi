import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { buildInstructions, type Capabilities } from "@/lib/agent/instructions"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"

// Thread agents and phone calls (CHANGE_IMPACT §3 rows tools.ts, run-task.ts,
// instructions.ts). Without voice access an agent's tools and prompt are
// exactly as before (F4, F5); with it, propose_call drafts a call that only
// the person can confirm. The in-call tools are never an agent's.

const offered: string[][] = []
const prompts: string[] = []
const CALL_TOOLS = ["note_agreement", "note_proposed_time", "end_call"]

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
  if (prompt.includes("CALL_MY_CA") && !prompt.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call" as const,
        toolCallId: "call-p",
        toolName: "propose_call",
        input: JSON.stringify({
          recipientLabel: "my CA",
          recipientPhone: "98765 43210",
          purpose: "Ask whether 3 PM tomorrow works for the tax review",
          goal: {
            type: "schedule_meeting",
            date: "2026-10-21",
            preferred: "15:00",
            acceptable: [{ from: "14:00", to: "17:00" }],
          },
          authority: {
            mayAcceptWithinAcceptable: true,
            mayProposeAlternatives: true,
            mayShareOwnerPhone: false,
            mayDiscuss: [],
          },
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

async function grantVoice() {
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000`
  )
  await seed(pg, "voice_access", { user_id: user })
}

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "test-phone-hash-key-".padEnd(48, "k"))
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [user])
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

afterAll(() => {
  vi.unstubAllEnvs()
})

const LINE =
  "- **Phone calls.** You can draft a phone call with `propose_call`; the person confirms it in Kriya before anyone is called. You can't place calls yourself."

describe("T-AGT-01 propose_call only with voice access", () => {
  it("without access: no propose_call, no call tools, no phone line in the prompt", async () => {
    await turn("hello")
    expect(offered[0]).not.toContain("propose_call")
    expect(offered[0].filter((n) => CALL_TOOLS.includes(n))).toEqual([])
    expect(prompts[0]).not.toContain("propose_call")
  })

  it("an allow-listed user on a plan without voice is the same as no access", async () => {
    await seed(pg, "voice_access", { user_id: user })
    await turn("hello")
    expect(offered[0]).not.toContain("propose_call")
  })

  it("with access: propose_call drafts a call the person must confirm; never the call tools", async () => {
    await grantVoice()
    await turn("CALL_MY_CA tomorrow at 3")
    expect(offered[0]).toContain("propose_call")
    expect(offered[0].filter((n) => CALL_TOOLS.includes(n))).toEqual([])
    const tasks = await pg.query<{ status: string; thread_id: string }>(
      "select status, thread_id from kriya.voice_tasks"
    )
    // A draft: no approval, no call scheduled, nobody rung
    expect(tasks.rows).toEqual([{ status: "draft", thread_id: "t1" }])
    const calls = await pg.query("select 1 from kriya.voice_calls")
    expect(calls.rows).toHaveLength(0)
    const [execution] = (
      await pg.query<{ side_effect: boolean; output_summary: string }>(
        "select side_effect, output_summary from kriya.tool_executions where tool_name = 'propose_call'"
      )
    ).rows
    expect(execution.side_effect).toBe(false)
    expect(execution.output_summary).toMatch(/\/calls\//)
  })
})

describe("T-AGT-02 the prompt without voice is byte-identical", () => {
  it("with voice it gains exactly the capability line, nothing else", async () => {
    await turn("hello")
    const without = prompts[0]
    await grantVoice()
    await turn("hello")
    const withVoice = prompts[1]
    expect(withVoice).not.toBe(without)
    expect(withVoice.replace(JSON.stringify(`\n${LINE}`).slice(1, -1), "")).toBe(without)
  })

  it("buildInstructions: voice absent, false or present", () => {
    const agent = {
      id: "a1",
      name: "Lekha",
      role: "r",
      instructions: null,
    } as unknown as schema.Agent
    const caps: Capabilities = {
      web: false,
      connected: { google: [], notion: false },
      writes: true,
    }
    const base = buildInstructions(agent, caps, [])
    expect(buildInstructions(agent, { ...caps, voice: false }, [])).toBe(base)
    const voiced = buildInstructions(agent, { ...caps, voice: true }, [])
    expect(voiced.replace(`\n${LINE}`, "")).toBe(base)
    // The existing "can't … send messages" line stays as it was (F4)
    expect(voiced).toContain(
      "You can't run code, open websites interactively, send messages"
    )
    // A squad member on an assign part (writes off) gets no phone line
    expect(buildInstructions(agent, { ...caps, voice: true, writes: false }, [])).toBe(
      buildInstructions(agent, { ...caps, writes: false }, [])
    )
  })
})
