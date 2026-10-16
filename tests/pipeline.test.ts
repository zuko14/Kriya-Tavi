import { randomBytes } from "node:crypto"

import { APICallError, simulateReadableStream, type UIMessageChunk } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueApproval, enqueueTurn, streamTask, TurnError } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"
import { GOOGLE_SERVICES } from "@/lib/connectors"
import { seal } from "@/lib/secrets"

import { asUser, createTestDb, createUser, type TestDb } from "./db/harness"

// The whole task path on a real Postgres: enqueue through RLS, claim with the
// queue function, run in the worker on a scripted model, meter, charge, and
// replay the stream to its owner (and to no one else).

// Failures still to throw: the SDK retries a provider error twice itself
let failures = 0
// Squad members' model calls wait here until both have started: a squad that
// ran them one after another would time out instead
let membersStarted = 0
let bothStarted = () => {}
let together = Promise.resolve()

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 120,
      noCache: 120,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 8, text: 8, reasoning: undefined },
  },
  // What lib/models' extractor puts here from OpenRouter's usage.cost
  providerMetadata: {
    openrouter: {
      usage: JSON.stringify({
        costMicroUsd: 91,
        upstreamCostMicroUsd: null,
        isByok: false,
        raw: null,
      }),
    },
  },
})

type Chunk =
  | ReturnType<typeof finish>
  | { type: "text-start" | "text-end"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }

const reply = (...deltas: string[]): Chunk[] => [
  { type: "text-start" as const, id: "t1" },
  ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
  { type: "text-end" as const, id: "t1" },
  finish("stop"),
]

// Plain replies, except for a message containing SPLIT_ME in a squad: the
// lead splits it with `assign`, each member answers its part, and the lead
// sums up what came back
async function script(prompt: unknown): Promise<Chunk[]> {
  const text = JSON.stringify(prompt)
  if (text.includes("Your part in the squad")) {
    if (++membersStarted === 2) bothStarted()
    await Promise.race([
      together,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("members ran one at a time")), 2_000)
      ),
    ])
    return reply(text.includes("You are Arjun") ? "Arjun's part." : "Kabir's part.")
  }
  if (text.includes("SPLIT_ME") && !text.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call" as const,
        toolCallId: "call-1",
        toolName: "assign",
        input: JSON.stringify({
          assignments: [
            { agentId: "a2", brief: "Price the venues" },
            { agentId: "a3", brief: "Draft the invite" },
          ],
        }),
      },
      finish("tool-calls"),
    ]
  }
  if (text.includes("SPLIT_ME")) return reply("Combined.")
  if (text.includes("BOOK_IT") && !text.includes('"role":"tool"')) {
    return [
      {
        type: "tool-call" as const,
        toolCallId: "call-cal",
        toolName: "calendar_create_event",
        input: JSON.stringify({
          title: "Dentist",
          start: "2026-10-20T15:00:00",
          end: "2026-10-20T15:30:00",
        }),
      },
      finish("tool-calls"),
    ]
  }
  if (text.includes("BOOK_IT")) return reply("Booked.")
  return reply("Namaste, ", "done.")
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
          if (failures > 0) {
            failures--
            throw new APICallError({
              message: "Provider overloaded",
              url: "https://openrouter.ai/api/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true,
            })
          }
          return {
            stream: simulateReadableStream({ chunks: await script(options.prompt) }),
          }
        },
      }),
  }
})

let pg: TestDb
let user: string

const message = (id: string, text = "Hello"): KriyaMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as KriyaMessage

async function claim() {
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  const id = rowsOf<{ id: string }>(
    await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
  )[0]?.id
  const { rows } = await pg.query<Record<string, unknown>>(
    "select * from kriya.tasks where id = $1",
    [id]
  )
  const row = rows[0]
  // Map snake_case columns onto the Task type the worker receives
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value,
    ])
  ) as unknown as schema.Task
}

const worker = {
  workerId: "w1",
  leaseSeconds: 30,
  shutdown: new AbortController().signal,
}

async function readAll(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.OPENROUTER_FALLBACK_MODEL = "test/fallback-model"
  process.env.KRIYA_FX_USD_INR = "84.25"
  process.env.KRIYA_FX_SOURCE = "test rate"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  membersStarted = 0
  together = new Promise<void>((resolve) => (bothStarted = resolve))
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'Research', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

describe("task pipeline", () => {
  it("runs a turn end to end and records what it cost", async () => {
    const queued = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: message("m1"),
      idempotencyKey: "k1",
    })
    expect(queued.status).toBe("queued")
    expect(queued.tier).toBe("budget")

    const task = await claim()
    await runTask(task, worker)

    const {
      rows: [done],
    } = await pg.query<{ status: string; model: string }>(
      "select status, model from kriya.tasks where id = $1",
      [queued.id]
    )
    expect(done).toEqual({ status: "succeeded", model: "test/budget-model" })

    const { rows: saved } = await pg.query<{
      role: string
      parts: { type: string; text?: string }[]
    }>(
      "select role, parts from kriya.messages where thread_id = 't1' order by created_at"
    )
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(saved[1].parts.find((p) => p.type === "text")?.text).toBe("Namaste, done.")

    const { rows: usage } = await pg.query<{
      cost_micro_usd: string
      input_tokens: number
      usage_status: string
    }>(
      "select cost_micro_usd::text, input_tokens, usage_status from kriya.usage_events where task_id = $1",
      [queued.id]
    )
    expect(usage).toEqual([
      { cost_micro_usd: "91", input_tokens: 120, usage_status: "reported" },
    ])

    const { rows: charge } = await pg.query<{
      status: string
      provider_cost_micro_inr: string
      charge_micro_inr: string
      fx_usd_inr: string
    }>(
      "select status, provider_cost_micro_inr::text, charge_micro_inr::text, fx_usd_inr::text from kriya.charges where task_id = $1",
      [queued.id]
    )
    // 91 micro-USD at ₹84.25 = 7667 micro-INR, at 1× markup on the free plan
    expect(charge).toEqual([
      {
        status: "final",
        provider_cost_micro_inr: "7667",
        charge_micro_inr: "7667",
        fx_usd_inr: "84.2500",
      },
    ])

    // The owner can replay the stream; anyone else gets nothing
    const replay = await readAll(streamTask(user, queued.id))
    const text = replay
      .flatMap((c) => (c.type === "text-delta" ? [c.delta] : []))
      .join("")
    expect(text).toBe("Namaste, done.")
    const stranger = await createUser(pg)
    expect(await readAll(streamTask(stranger, queued.id))).toEqual([])

    // The same message sent again is the same task, not a second charge
    const again = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: message("m1"),
      idempotencyKey: "k1",
    })
    expect(again.id).toBe(queued.id)
  })

  it("runs a squad's sub-agents at the same time and combines their work", async () => {
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a2', $1, 'Arjun', 'Venues', 'g2'), ('a3', $1, 'Kabir', 'Writing', 'g3')",
        [user]
      )
      await tx.query(
        "insert into kriya.squads (id, user_id, name) values ('s1', $1, 'Launch')",
        [user]
      )
      await tx.query(
        "insert into kriya.squad_members (squad_id, agent_id, user_id, position) values ('s1', 'a1', $1, 0), ('s1', 'a2', $1, 1), ('s1', 'a3', $1, 2)",
        [user]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, squad_id) values ('t2', $1, 's1')",
        [user]
      )
    })

    const queued = await enqueueTurn({
      userId: user,
      threadId: "t2",
      message: message("m1", "SPLIT_ME: plan the launch party"),
    })
    await runTask(await claim(), worker)

    const {
      rows: [done],
    } = await pg.query<{ status: string }>(
      "select status from kriya.tasks where id = $1",
      [queued.id]
    )
    expect(done.status).toBe("succeeded")

    const { rows: saved } = await pg.query<{
      parts: {
        type: string
        text?: string
        state?: string
        output?: { results: { name: string; status: string; text: string }[] }
      }[]
    }>("select parts from kriya.messages where thread_id = 't2' and role = 'assistant'")
    const assign = saved[0].parts.find((p) => p.type === "tool-assign")
    expect(assign?.state).toBe("output-available")
    expect(assign?.output?.results.map((r) => [r.name, r.status, r.text])).toEqual([
      ["Arjun", "done", "Arjun's part."],
      ["Kabir", "done", "Kabir's part."],
    ])
    expect(saved[0].parts.findLast((p) => p.type === "text")?.text).toBe("Combined.")

    // Lead twice, each member once: every call metered against the one task
    const { rows: usage } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.usage_events where task_id = $1",
      [queued.id]
    )
    expect(usage[0].n).toBe(4)

    // The person saw progress while the members worked, not only the end
    const replay = await readAll(streamTask(user, queued.id))
    expect(
      replay.some((c) => c.type === "tool-output-available" && c.preliminary === true)
    ).toBe(true)
  })

  describe("a tool call that changes the person's calendar", () => {
    const google = vi.fn(async () =>
      Response.json({
        id: "evt1",
        summary: "Dentist",
        htmlLink: "https://calendar.google.com/event?eid=evt1",
        start: { dateTime: "2026-10-20T15:00:00+05:30" },
        end: { dateTime: "2026-10-20T15:30:00+05:30" },
      })
    )

    beforeEach(async () => {
      google.mockClear()
      vi.stubGlobal("fetch", google)
      process.env.KRIYA_TOKEN_KEY = randomBytes(32).toString("base64")
      await pg.query(
        "insert into kriya.connections (id, user_id, provider, account, scopes, access_token, expires_at) values ('c1', $1, 'google', 'me@example.com', $2, $3, now() + interval '1 hour')",
        [user, GOOGLE_SERVICES.calendar.scopes, seal("ya29.token", `${user}:google`)]
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function askToBook() {
      await enqueueTurn({
        userId: user,
        threadId: "t1",
        message: message("m1", "BOOK_IT"),
      })
      await runTask(await claim(), worker)
      const { rows } = await pg.query<{
        parts: { type: string; state?: string; approval?: { id: string } }[]
      }>("select parts from kriya.messages where thread_id = 't1' and role = 'assistant'")
      return rows[0].parts.find((p) => p.type === "tool-calendar_create_event")!
    }

    async function saved() {
      const { rows } = await pg.query<{
        role: string
        parts: { type: string; state?: string; text?: string }[]
      }>(
        "select role, parts from kriya.messages where thread_id = 't1' order by created_at"
      )
      return rows
    }

    it("waits for approval, then runs it once in the worker", async () => {
      const call = await askToBook()
      // Nothing happened yet: the call is waiting for the person
      expect(call.state).toBe("approval-requested")
      expect(google).not.toHaveBeenCalled()

      // An approval the agent never asked for is refused
      await expect(
        enqueueApproval({
          userId: user,
          threadId: "t1",
          approvalId: "forged",
          approved: true,
        })
      ).rejects.toMatchObject({ status: 409 })
      // So is someone else answering for this thread
      const stranger = await createUser(pg)
      await expect(
        enqueueApproval({
          userId: stranger,
          threadId: "t1",
          approvalId: call.approval!.id,
          approved: true,
        })
      ).rejects.toMatchObject({ status: 409 })

      const task = await enqueueApproval({
        userId: user,
        threadId: "t1",
        approvalId: call.approval!.id,
        approved: true,
      })
      expect(task?.status).toBe("queued")
      await runTask(await claim(), worker)

      expect(google).toHaveBeenCalledTimes(1)
      const [url, init] = google.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain("/calendar/v3/calendars/primary/events?sendUpdates=none")
      expect(init.method).toBe("POST")
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer ya29.token"
      )

      // The same reply carried on: the event, then the answer
      const messages = await saved()
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
      const parts = messages[1].parts
      expect(parts.find((p) => p.type === "tool-calendar_create_event")?.state).toBe(
        "output-available"
      )
      expect(parts.findLast((p) => p.type === "text")?.text).toBe("Booked.")

      // Kept as evidence, and marked so the task is never retried blindly
      const { rows: evidence } = await pg.query<{ side_effect: boolean }>(
        "select side_effect from kriya.tool_executions where tool_name = 'calendar_create_event'"
      )
      expect(evidence).toEqual([{ side_effect: true }])

      // Answering twice changes nothing
      await expect(
        enqueueApproval({
          userId: user,
          threadId: "t1",
          approvalId: call.approval!.id,
          approved: true,
        })
      ).rejects.toMatchObject({ status: 409 })
    })

    it("never runs a call the person declined", async () => {
      const call = await askToBook()
      await enqueueApproval({
        userId: user,
        threadId: "t1",
        approvalId: call.approval!.id,
        approved: false,
      })
      await runTask(await claim(), worker)
      expect(google).not.toHaveBeenCalled()
      const parts = (await saved())[1].parts
      expect(parts.find((p) => p.type === "tool-calendar_create_event")?.state).toBe(
        "output-denied"
      )
    })
  })

  it("refuses another user's thread", async () => {
    const other = await createUser(pg)
    await expect(
      enqueueTurn({ userId: other, threadId: "t1", message: message("x") })
    ).rejects.toMatchObject({
      status: 404,
    })
  })

  it("retries a provider failure on the fallback model, then succeeds", async () => {
    // The first call and both SDK retries fail; the task-level retry then
    // moves to the fallback model
    failures = 3
    const queued = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: message("m1"),
    })
    await runTask(await claim(), worker)
    const {
      rows: [retry],
    } = await pg.query<{ status: string; model: string; attempts: number }>(
      "select status, model, attempts from kriya.tasks where id = $1",
      [queued.id]
    )
    expect(retry).toEqual({ status: "queued", model: "test/fallback-model", attempts: 1 })

    await pg.query("update kriya.tasks set available_at = now() where id = $1", [
      queued.id,
    ])
    await runTask(await claim(), worker)
    const {
      rows: [done],
    } = await pg.query<{ status: string; attempts: number }>(
      "select status, attempts from kriya.tasks where id = $1",
      [queued.id]
    )
    expect(done).toEqual({ status: "succeeded", attempts: 2 })
  })

  it("enforces the plan's daily task limit on the server", async () => {
    await pg.query("update kriya.plans set max_tasks_per_day = 1 where id = 'free'")
    const first = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: message("m1"),
    })
    await runTask(await claim(), worker)
    expect(first.id).toBeTruthy()
    const blocked = enqueueTurn({ userId: user, threadId: "t1", message: message("m2") })
    await expect(blocked).rejects.toBeInstanceOf(TurnError)
    await expect(blocked).rejects.toMatchObject({ status: 402, code: "daily_limit" })
  })

  it("stops a task at its deadline and says why", async () => {
    const queued = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: message("m1"),
    })
    const task = await claim()
    await runTask({ ...task, deadlineAt: new Date(Date.now() - 1) }, worker)
    const {
      rows: [row],
    } = await pg.query<{ status: string; error_code: string }>(
      "select status, error_code from kriya.tasks where id = $1",
      [queued.id]
    )
    expect(row).toEqual({ status: "failed", error_code: "deadline" })
  })
})
