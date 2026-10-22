import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import type { KriyaMessage } from "@/lib/agent/tools"
import {
  claimJob,
  enqueueSummary,
  recoverJobs,
  runJob,
  type Summarizer,
} from "@/lib/memory/maintenance"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Thread summary jobs (AT-MNT-01, AT-MNT-02) on a real Postgres with a
// scripted summariser: never a task, never a charge, capped per day

// enqueueTurn refuses without a model gateway; no key on a clean machine
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

let pg: TestDb
let user: string
const rows = (query: string, params: unknown[] = []) =>
  pg.query<Record<string, unknown>>(query, params).then((r) => r.rows)

// 10 person turns, about 30,000 characters; the person's facts are in turn 0
async function seedThread(threadId = "t1") {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, 'a1')",
      [threadId, user]
    )
    for (let i = 0; i < 10; i++) {
      const person = i === 0 ? "Ravi owes ₹45,000 since 2026-09-28." : `Follow-up ${i}`
      await tx.query(
        `insert into kriya.messages (thread_id, id, user_id, role, parts, created_at) values
          ($1, $2, $3, 'user', $4, now() - make_interval(mins => $6)),
          ($1, $5, $3, 'assistant', $7, now() - make_interval(mins => $6) + interval '30 seconds')`,
        [
          threadId,
          `u${i}`,
          user,
          JSON.stringify([{ type: "text", text: person }]),
          `a${i}`,
          100 - i,
          JSON.stringify([{ type: "text", text: `Plan details ${i}. `.repeat(200) }]),
        ]
      )
    }
  })
}

const calls: string[] = []
const scripted =
  (numbers: string[], costMicroUsd: number | null = 40): Summarizer =>
  async ({ tier }) => {
    calls.push(tier)
    return {
      summary: {
        facts: ["Ravi owes money for the dashboard"],
        decisions: [],
        open_questions: [],
        pending_actions: ["Chase Ravi"],
        numbers,
      },
      model: `test/${tier}`,
      inputTokens: 900,
      outputTokens: 120,
      costMicroUsd,
    }
  }

beforeEach(async () => {
  calls.length = 0
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD = "1000"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await asUser(pg, user, (tx) =>
    tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'r', 'g')",
      [user]
    )
  )
})

describe("enqueueSummary and the job queue (AT-MNT-01)", () => {
  it("queues one job for a long thread, and never a task", async () => {
    await seedThread()
    expect(await enqueueSummary(user, "t1")).toBe(true)
    expect(await enqueueSummary(user, "t1")).toBe(false)
    expect(await rows("select kind, ref, status from kriya.maintenance_jobs")).toEqual([
      { kind: "thread_summary", ref: "t1", status: "queued" },
    ])
    expect(await rows("select id from kriya.tasks")).toEqual([])
  })

  it("leaves short threads alone", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ('t2', $1, 'a1')",
        [user]
      )
    )
    expect(await enqueueSummary(user, "t2")).toBe(false)
  })

  it("lets the person send a message while a summary job runs", async () => {
    await seedThread()
    await enqueueSummary(user, "t1")
    const job = await claimJob()
    expect(job?.ref).toBe("t1")
    const queued = await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: {
        id: "new",
        role: "user",
        parts: [{ type: "text", text: "Any update?" }],
      } as KriyaMessage,
      idempotencyKey: "k-new",
    })
    expect(queued.status).toBe("queued")
  })

  it("puts a job whose lease ran out back in the queue", async () => {
    await seedThread()
    await enqueueSummary(user, "t1")
    await claimJob()
    await pg.query(
      "update kriya.maintenance_jobs set lease_until = now() - interval '1 second'"
    )
    expect(await recoverJobs()).toBe(1)
    expect(await rows("select status, attempts from kriya.maintenance_jobs")).toEqual([
      { status: "queued", attempts: 1 },
    ])
  })
})

describe("runJob for thread summaries (AT-MNT-02, AT-MEM-10)", () => {
  it("writes a checkpoint up to the kept turns and meters it as platform cost", async () => {
    await seedThread()
    await enqueueSummary(user, "t1")
    const job = (await claimJob())!
    expect(await runJob(job, scripted(["₹45,000", "2026-09-28"]))).toBe("done")
    expect(calls).toEqual(["budget"])

    // Covers the first 4 person turns and their replies; the last 6 stay
    const [summary] = await rows(
      `select s.chars, s.model, s.covers_through = m.created_at as at_reply
       from kriya.thread_summaries s, kriya.messages m where m.id = 'a3'`
    )
    expect(summary).toMatchObject({ model: "test/budget", at_reply: true })
    expect(
      await rows(
        "select kind, quantity::int, cost_micro_usd::int from kriya.resource_usage"
      )
    ).toEqual([{ kind: "maintenance_model", quantity: 1020, cost_micro_usd: 40 }])
    expect(await rows("select id from kriya.charges")).toEqual([])
    expect(await rows("select status from kriya.maintenance_jobs")).toEqual([
      { status: "done" },
    ])
  })

  it("retries once on balanced, then writes no checkpoint if a fact is still missing", async () => {
    await seedThread()
    await enqueueSummary(user, "t1")
    const job = (await claimJob())!
    expect(await runJob(job, scripted(["₹45,000"]))).toBe("rejected")
    expect(calls).toEqual(["budget", "balanced"])
    expect(await rows("select id from kriya.thread_summaries")).toEqual([])
    const [failed] = await rows("select status, error from kriya.maintenance_jobs")
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("2026-09-28")
  })

  it.each([
    ["no cap set", "0", []],
    ["the cap reached today", "1000", [1000]],
    ["an unpriced call today", "1000", [null]],
  ])("waits for tomorrow with %s, without a model call", async (_, cap, earlier) => {
    process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD = cap
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    for (const [i, cost] of earlier.entries()) {
      await pg.query(
        "insert into kriya.resource_usage (request_key, user_id, kind, quantity, cost_micro_usd) values ($1, $2, 'maintenance_model', 1, $3)",
        [`earlier-${i}`, user, cost]
      )
    }
    await seedThread()
    await enqueueSummary(user, "t1")
    const job = (await claimJob())!
    expect(await runJob(job, scripted(["₹45,000", "2026-09-28"]))).toBe("deferred")
    expect(calls).toEqual([])
    const [waiting] = await rows(
      "select status, attempts, available_at > now() as later from kriya.maintenance_jobs"
    )
    expect(waiting).toEqual({ status: "queued", attempts: 0, later: true })
  })
})
