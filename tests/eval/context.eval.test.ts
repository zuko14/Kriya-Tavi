import fs from "node:fs"

import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { nanoid } from "nanoid"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { privileged, rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import {
  claimJob,
  enqueueSummary,
  runJob,
  type Summarizer,
} from "@/lib/memory/maintenance"
import { personFacts } from "@/lib/memory/summaries"

import { buildThread, loadSuite, type Seed } from "./threads"

// AS-CTX on the scripted model (free; TEST_AND_EVALUATION.md §4–5). Each
// scenario's 42-turn thread goes through the real runner on PGlite, with
// agents.memoryV2 off and on, and the size of what reaches the model is
// measured: system prompt, history and tool definitions, as characters ÷ 4.
// C1 = the sum over the task's model calls (one here: the scripted model
// answers in one step).
//
// With KRIYA_EVAL_OUT=<file> the numbers are written there as JSON, for
// docs/agent-platform/benchmarks/.

type Sizes = { system: number; history: number; tools: number; calls: number }
let calls: Sizes[] = []

const chars = (value: unknown) =>
  typeof value === "string" ? value.length : JSON.stringify(value ?? "").length

vi.mock("@/lib/models", async (original) => {
  const actual = await original<typeof import("@/lib/models")>()
  return {
    ...actual,
    isGatewayConfigured: () => true,
    createGatewayModel: (modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doStream: async (options) => {
          const size: Sizes = { system: 0, history: 0, tools: 0, calls: 1 }
          for (const message of options.prompt) {
            const n = Array.isArray(message.content)
              ? message.content.reduce(
                  (sum, part) =>
                    sum + (part.type === "text" ? part.text.length : chars(part)),
                  0
                )
              : chars(message.content)
            if (message.role === "system") size.system += n
            else size.history += n
          }
          size.tools = (options.tools ?? []).reduce((sum, t) => sum + chars(t), 0)
          calls.push(size)
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start" as const, id: "t" },
                {
                  type: "text-delta" as const,
                  id: "t",
                  delta: "Here's where things stand.",
                },
                { type: "text-end" as const, id: "t" },
                {
                  type: "finish" as const,
                  finishReason: { unified: "stop" as const, raw: undefined },
                  usage: {
                    inputTokens: {
                      total: undefined,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: undefined,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                },
              ],
            }),
          }
        },
      }),
  }
})

const tokens = (n: number) => Math.ceil(n / 4)

// Stands in for the summary model: keeps each distinct thing the person
// said (first 160 characters) and every fact the check requires. Its length
// is not a prediction of a real model's summary; a paid run measures that.
const scriptedSummarizer: Summarizer = async ({ tier, prompt }) => {
  const said = [
    ...new Set(
      prompt
        .split("\n")
        .filter((line) => line.startsWith("Person: "))
        .map((line) => line.slice(8, 168))
    ),
  ]
  const facts = personFacts(
    said.map((text) => ({ role: "user", parts: [{ type: "text", text }] }))
  )
  return {
    summary: {
      facts: said.slice(0, 20),
      decisions: [],
      open_questions: [],
      pending_actions: [],
      numbers: facts,
    },
    model: `scripted/${tier}`,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: 0,
  }
}

// What the previous task would have queued, run as the worker would
async function checkpoint(user: string, threadId: string) {
  if (!(await enqueueSummary(user, threadId))) return "not due"
  const job = await claimJob()
  return job ? runJob(job, scriptedSummarizer) : "not claimed"
}

let pg: TestDb
let db: DB

async function seedScenario(seed: Seed) {
  const user = await createUser(pg)
  const agentId = nanoid(12)
  await privileged.insert(schema.agents).values({
    id: agentId,
    userId: user,
    name: seed.agent.name,
    role: seed.agent.role,
    instructions: seed.agent.instructions,
    glyph: "g",
  })
  await privileged.insert(schema.memories).values(
    seed.memories.map((note) => ({
      id: nanoid(12),
      userId: user,
      agentId: note.shared ? null : agentId,
      content: note.content,
      source: note.source ?? ("agent" as const),
      kind: note.kind,
      slot: note.slot ?? null,
    }))
  )
  const turns = buildThread(seed)
  const start = Date.now() - turns.length * 60_000
  const threadFor = async () => {
    const threadId = nanoid(12)
    await privileged
      .insert(schema.threads)
      .values({ id: threadId, userId: user, agentId })
    await privileged.insert(schema.messages).values(
      turns.map((turn, i) => ({
        threadId,
        id: `m${i}`,
        userId: user,
        role: turn.role,
        parts: [{ type: "text", text: turn.text }],
        metadata: turn.role === "assistant" ? { agentId } : null,
        createdAt: new Date(start + i * 60_000),
      }))
    )
    return threadId
  }
  return { user, off: await threadFor(), on: await threadFor(), turns }
}

async function measure(user: string, threadId: string, ask: string, memoryV2: boolean) {
  process.env.KRIYA_AGENTS_MEMORY_V2 = memoryV2 ? "on" : "off"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  calls = []
  await enqueueTurn({
    userId: user,
    threadId,
    message: {
      id: "ask",
      role: "user",
      parts: [{ type: "text", text: ask }],
    } as KriyaMessage,
    idempotencyKey: `${threadId}-ask`,
  })
  const id = rowsOf<{ id: string }>(
    await db.execute(sql`select id from kriya.claim_task('eval', 30)`)
  )[0]?.id
  const [task] = await privileged
    .select()
    .from(schema.tasks)
    .where(sql`id = ${id}`)
  await runTask(task, {
    workerId: "eval",
    leaseSeconds: 30,
    shutdown: new AbortController().signal,
  })
  const total = calls.reduce(
    (sum, c) => ({
      system: sum.system + c.system,
      history: sum.history + c.history,
      tools: sum.tools + c.tools,
      calls: sum.calls + 1,
    }),
    { system: 0, history: 0, tools: 0, calls: 0 }
  )
  return {
    calls: total.calls,
    systemTokens: tokens(total.system),
    historyTokens: tokens(total.history),
    toolTokens: tokens(total.tools),
    c1: tokens(total.system + total.history + total.tools),
  }
}

beforeAll(async () => {
  pg = await createTestDb()
  db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  setDatabaseForTests(db)
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD = "1000000"
})

describe("AS-CTX (scripted)", () => {
  const seeds = loadSuite("AS-CTX")

  it("has 20 scenarios of 40+ person turns", () => {
    expect(seeds).toHaveLength(20)
    for (const seed of seeds) {
      expect(
        buildThread(seed).filter((t) => t.role === "user").length
      ).toBeGreaterThanOrEqual(40)
    }
  })

  it(
    "measures what reaches the model, memory v2 off and on",
    { timeout: 300_000 },
    async () => {
      type Measured = Awaited<ReturnType<typeof measure>>
      const rows: {
        id: string
        role: string
        personTurns: number
        checkpoint: string
        off: Measured
        on: Measured
      }[] = []
      for (const seed of seeds) {
        const { user, off, on, turns } = await seedScenario(seed)
        process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
        const outcome = await checkpoint(user, on)
        rows.push({
          id: seed.id,
          role: seed.role,
          personTurns: turns.filter((t) => t.role === "user").length,
          off: await measure(user, off, seed.ask, false),
          checkpoint: outcome,
          on: await measure(user, on, seed.ask, true),
        })
      }
      for (const row of rows) {
        expect(row.off.calls, row.id).toBe(1)
        expect(row.on.calls, row.id).toBe(1)
        expect(row.off.c1, row.id).toBeGreaterThan(0)
      }

      const out = process.env.KRIYA_EVAL_OUT
      if (out) {
        const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
        const median = (xs: number[]) => {
          const s = sorted(xs)
          return s.length % 2
            ? s[(s.length - 1) / 2]
            : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
        }
        const stats = (pick: (r: (typeof rows)[number]) => number) => ({
          mean: rows.reduce((sum, r) => sum + pick(r), 0) / rows.length,
          median: median(rows.map(pick)),
          min: Math.min(...rows.map(pick)),
          max: Math.max(...rows.map(pick)),
        })
        fs.writeFileSync(
          out,
          JSON.stringify(
            {
              suite: "AS-CTX",
              model: "scripted (MockLanguageModelV4), one step per task",
              n: rows.length,
              c1: { off: stats((r) => r.off.c1), on: stats((r) => r.on.c1) },
              rows,
            },
            null,
            2
          )
        )
      }
    }
  )
})
