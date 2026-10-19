import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { expireApprovals, recordApprovals } from "@/lib/agent/approvals"
import {
  deriveEpisode,
  receiptHash,
  verifyChain,
  writeEpisode,
} from "@/lib/agent/episodes"
import { enqueueApproval } from "@/lib/agent/queue"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// "What I did" comes from verified tool runs only (AT-VER-01), chained per
// person so an edit shows (K1: AT-RCP-01, AT-RCP-03); approvals are indexed
// for the Inbox (AT-INB-01) and expire as declined without a task
// (AT-INB-02, AT-INB-03).

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

const verified = {
  status: "verified" as const,
  method: "api_readback" as const,
  evidence: [{ kind: "provider_id" as const, value: "s1" }],
}

const run = (
  id: string,
  toolName: string,
  over: Partial<{ status: string; input: unknown; verification: unknown }> = {}
) => ({
  id,
  toolName,
  status: "succeeded",
  input: {},
  verification: null,
  ...over,
})

describe("deriving the record (AT-VER-01)", () => {
  it("lists only succeeded runs whose own check verified them", () => {
    const episode = deriveEpisode(
      [
        run("e1", "schedule_create", {
          input: { rule: { freq: "weekly", at: "09:00", days: [1] } },
          verification: verified,
        }),
        run("e2", "calendar_create_event", { input: { title: "Dentist" } }),
        run("e3", "gmail_draft", { status: "failed", verification: verified }),
        run("e4", "memory_write"),
        run("e5", "web_fetch"),
        run("e6", "schedule_create", { verification: { ...verified, status: "failed" } }),
      ],
      "Done.",
      []
    )
    expect(episode.done).toEqual([
      {
        executionId: "e1",
        tool: "schedule_create",
        title: "Started a schedule: Every Monday at 9:00 am",
        risk: "R2",
        verification: verified,
      },
    ])
    expect(episode.unconfirmed).toEqual([
      {
        claim: 'Added "Dentist" to your calendar',
        reason: "Ran, but wasn't checked afterwards.",
        executionId: "e2",
      },
      {
        claim: "Started a schedule: a new time",
        reason: "Ran, but the check afterwards failed.",
        executionId: "e6",
      },
    ])
    expect(episode.titles).toBe("Started a schedule: Every Monday at 9:00 am")
  })

  it("adds claims from the reply that no run backs, and citation checks", () => {
    const episode = deriveEpisode(
      [],
      'I\'ve added it to your calendar. It "opens on 1 Nov" [1].',
      ["Applications open on 2 Nov."]
    )
    expect(episode.unconfirmed).toEqual([
      {
        claim: "I've added it to your calendar.",
        reason: "No matching action ran.",
      },
    ])
    expect(episode.checks[0]).toMatchObject({ status: "unsupported" })
  })
})

describe("the receipt hash (AT-RCP-03)", () => {
  const record = {
    seq: 1,
    taskId: "t",
    createdAt: "2026-10-18T08:00:00.000Z",
    done: [
      {
        executionId: "e1",
        tool: "schedule_create",
        title: "Started a schedule",
        risk: "R2",
        verification: verified,
      },
    ],
  }

  it("covers the runs and their checks, not any text a model wrote", () => {
    const hash = receiptHash(null, record)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // Titles come from tool inputs; they're shown, not hashed
    expect(
      receiptHash(null, {
        ...record,
        done: [{ ...record.done[0], title: "Something else" }],
      })
    ).toBe(hash)
    expect(receiptHash("prev", record)).not.toBe(hash)
    expect(
      receiptHash(null, {
        ...record,
        done: [{ ...record.done[0], verification: { ...verified, status: "failed" } }],
      })
    ).not.toBe(hash)
  })
})

let pg: TestDb
let user: string

// A finished task: episodes are written as a task ends
async function task(thread = "t1") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
    [user, thread]
  )
  return rows[0].id
}

async function execution(taskId: string, toolName: string, verification: unknown) {
  await pg.query(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, status, input, verification)
     values ($1, $2, 1, $3, $4, 'succeeded', '{}', $5)`,
    [taskId, user, `call-${taskId}`, toolName, JSON.stringify(verification)]
  )
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Disha', 'Study', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

const episodeFor = (taskId: string) =>
  writeEpisode({ userId: user, taskId, threadId: "t1", agentId: "a1", reply: null })

describe("the receipt chain (AT-RCP-01)", () => {
  it("stays one unbroken chain when many tasks finish at once", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => task()))
    for (const id of ids) await execution(id, "schedule_create", verified)
    await Promise.all(ids.map(episodeFor))
    const { rows } = await pg.query<{ seq: number }>(
      "select seq from kriya.episodes order by seq"
    )
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(await verifyChain(user)).toEqual({ ok: true, records: 10, deleted: [] })
  })

  it("records nothing for a task that did and claimed nothing", async () => {
    const id = await task()
    await episodeFor(id)
    expect((await pg.query("select 1 from kriya.episodes")).rows).toEqual([])
  })

  it("shows the person's deletion as a gap and a changed record as a mismatch", async () => {
    const ids = await Promise.all([task(), task(), task()])
    for (const id of ids) {
      await execution(id, "schedule_create", verified)
      await episodeFor(id)
    }
    await asUser(pg, user, (tx) =>
      tx.query(
        `update kriya.episodes set deleted_at = now(), done = '[]', unconfirmed = '[]', checks = '[]', titles = null, summary = null where seq = 2`
      )
    )
    const intact = await verifyChain(user)
    expect(intact).toMatchObject({ ok: true, records: 3 })
    expect(intact.deleted.map((d) => d.seq)).toEqual([2])

    // Someone with database access rewrites record 3 behind the guard
    await pg.exec("alter table kriya.episodes disable trigger episodes_guard")
    await pg.query(
      `update kriya.episodes set done = jsonb_set(done, '{0,tool}', '"gmail_draft"') where seq = 3`
    )
    await pg.exec("alter table kriya.episodes enable trigger episodes_guard")
    expect(await verifyChain(user)).toMatchObject({ ok: false, firstMismatch: 3 })
  })
})

const waiting = (approvalId: string): KriyaMessage =>
  ({
    id: "r1",
    role: "assistant",
    parts: [
      {
        type: "tool-schedule_create",
        toolCallId: "c1",
        state: "approval-requested",
        input: {
          prompt: "Plan my week",
          rule: { freq: "weekly", at: "09:00", days: [1] },
        },
        approval: { id: approvalId },
      },
    ],
  }) as unknown as KriyaMessage

async function endWaiting(approvalId: string) {
  const taskId = await task()
  const reply = waiting(approvalId)
  await pg.query(
    "insert into kriya.messages (thread_id, id, user_id, role, parts) values ('t1', 'r1', $1, 'assistant', $2)",
    [user, JSON.stringify(reply.parts)]
  )
  await recordApprovals({ id: taskId, userId: user, threadId: "t1", reply })
}

const approvalRow = async (id: string) =>
  (
    await pg.query<{
      status: string
      risk_class: string
      title: string
      preview: unknown
    }>("select status, risk_class, title, preview from kriya.approvals where id = $1", [
      id,
    ])
  ).rows[0]

describe("the approvals index (AT-INB-01…03)", () => {
  it("indexes each approval a reply waits on, and records the person's answer", async () => {
    await endWaiting("ap1")
    expect(await approvalRow("ap1")).toMatchObject({
      status: "pending",
      risk_class: "R2",
      title: "Start a schedule: Every Monday at 9:00 am",
      preview: { cadence: "Every Monday at 9:00 am", runsPerMonth: 5 },
    })
    const queued = await enqueueApproval({
      userId: user,
      threadId: "t1",
      approvalId: "ap1",
      approved: true,
    })
    expect(queued?.status).toBe("queued")
    expect((await approvalRow("ap1")).status).toBe("approved")
  })

  it("expires an unanswered approval as declined, starts nothing, and refuses it after", async () => {
    await endWaiting("ap2")
    await pg.query("update kriya.approvals set expires_at = now() - interval '1 minute'")
    expect(await expireApprovals()).toBe(1)
    expect((await approvalRow("ap2")).status).toBe("expired")
    const { rows } = await pg.query<{ parts: { state: string; approval: unknown }[] }>(
      "select parts from kriya.messages where id = 'r1'"
    )
    expect(rows[0].parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: "ap2", approved: false, reason: "Expired" },
    })
    // No task was queued for it
    const active = await pg.query("select 1 from kriya.tasks where status = 'queued'")
    expect(active.rows).toEqual([])
    await expect(
      enqueueApproval({ userId: user, threadId: "t1", approvalId: "ap2", approved: true })
    ).rejects.toMatchObject({ status: 409, code: "stale" })
  })

  it("refuses an answered approval even if its message part were still waiting", async () => {
    await endWaiting("ap3")
    await pg.query("update kriya.approvals set status = 'declined'")
    await expect(
      enqueueApproval({ userId: user, threadId: "t1", approvalId: "ap3", approved: true })
    ).rejects.toMatchObject({ status: 409, code: "stale" })
  })
})
