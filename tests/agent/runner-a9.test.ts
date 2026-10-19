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
import { setBrowserProviderForTests } from "@/lib/browser/session"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import { el, FixtureBrowser } from "./fixture-browser"

// The runner with agents.skills (scripted model, fixture browser). Off: no
// skill tool is offered and the prompt is unchanged. On: the agent calls
// skill_run once and every saved step runs in the browser without another
// model call (AT-SKL-01 end to end).

const SHOP = "https://shop.example.test/"
const PRICING = "https://shop.example.test/pricing"

const offered: string[][] = []
let modelCalls = 0

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
  if (prompt.includes("RUN_SKILL") && !prompt.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call",
        toolCallId: "call-s",
        toolName: "skill_run",
        input: JSON.stringify({ skillId: "sk1", slots: {} }),
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
          modelCalls++
          offered.push((options.tools ?? []).map((t) => t.name))
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
let fake: FixtureBrowser

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
  modelCalls = 0
  delete process.env.KRIYA_AGENTS_SKILLS
  process.env.KRIYA_AGENTS_BROWSER = "on"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await pg.query("update kriya.plans set browser_minutes = 10")
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    // Saved by an agent, approved by the person
    await tx.query(
      `insert into kriya.skills (id, version, user_id, agent_id, name, max_risk, steps)
       values ('sk1', 1, $1, 'a1', 'Check pricing', 'R0', $2)`,
      [
        user,
        JSON.stringify([
          { tool: "browser_open", input: { url: SHOP } },
          {
            tool: "browser_click",
            input: {},
            locator: { role: "link", name: "Pricing" },
          },
        ]),
      ]
    )
    await tx.query(
      "update kriya.skills set status = 'approved', approved_at = now() where id = 'sk1'"
    )
  })
  fake = new FixtureBrowser()
  fake.pages = {
    [SHOP]: { title: "Shop", elements: [el("e9", { name: "Pricing", href: PRICING })] },
    [PRICING]: { title: "Pricing", elements: [] },
  }
  setBrowserProviderForTests(fake)
})
afterEach(() => {
  setBrowserProviderForTests(null)
  delete process.env.KRIYA_AGENTS_BROWSER
})

describe("agents.skills off", () => {
  it("offers no skill tool", async () => {
    await turn("hello")
    expect(offered[0].some((name) => name.startsWith("skill_"))).toBe(false)
  })
})

describe("agents.skills on", () => {
  it("replays the saved steps inside one skill_run call", async () => {
    process.env.KRIYA_AGENTS_SKILLS = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await turn("RUN_SKILL")
    expect(offered[0]).toEqual(
      expect.arrayContaining(["skill_run", "skill_list", "skill_propose"])
    )
    // One call that asked for the skill, one that answered: none in between
    expect(modelCalls).toBe(2)
    expect(fake.calls).toEqual([`open ${SHOP}`, "click"])
    const { rows } = await pg.query<{ runs: number; successes: number }>(
      "select runs, successes from kriya.skills"
    )
    expect(rows).toEqual([{ runs: 1, successes: 1 }])
  })
})
