import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueApproval, enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The runner with the A3 switches: goal and schedule tools only with
// agents.goals on; with agents.inbox on, a reply that waits on approval is
// indexed for the Inbox (AT-INB-01) and every task ends with a derived
// record of what it did (AT-VER-01, AT-VER-02); the tool's verification is
// kept whole even when its output summary is cut (AT-VER-03). With both
// off, nothing new is offered or written.

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

// Every day and a real-length prompt, so the output runs past the 500-character summary
const EVERY_DAY = { freq: "weekly", at: "09:00", days: [1, 2, 3, 4, 5, 6, 7] }

const RUN_PROMPT =
  "Plan my study day: two DSA problems, one GATE previous-year paper section, and a 20-minute revision of yesterday's notes, then tell me what's left."

type Chunk =
  | ReturnType<typeof finish>
  | ReturnType<typeof say>[number]
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }

function script(prompt: string): Chunk[] {
  const answered = prompt.includes('"role":"tool"')
  if (prompt.includes("SCHEDULE_IT") && !answered) {
    return [
      {
        type: "tool-call" as const,
        toolCallId: "call-s",
        toolName: "schedule_create",
        input: JSON.stringify({ prompt: RUN_PROMPT, rule: EVERY_DAY }),
      },
      finish("tool-calls"),
    ]
  }
  if (prompt.includes("SCHEDULE_IT")) return say("I've set up a daily schedule for you.")
  if (prompt.includes("CLAIM_IT"))
    return say("I've added the dentist visit to your calendar.")
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

const worker = {
  workerId: "w1",
  leaseSeconds: 30,
  shutdown: new AbortController().signal,
}

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
  await runTask(task, worker)
  return task.id
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
  return claimAndRun()
}

const query = async <T>(text: string, params: unknown[] = []) =>
  (await pg.query<T>(text, params)).rows

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  for (const key of ["KRIYA_AGENTS_INBOX", "KRIYA_AGENTS_GOALS"]) delete process.env[key]
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
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

describe("switches off", () => {
  it("offers no goal or schedule tools and writes no approvals or records", async () => {
    await turn("CLAIM_IT")
    expect(
      offered[0].some((name) => name.startsWith("goal_") || name.startsWith("schedule_"))
    ).toBe(false)
    expect(await query("select 1 from kriya.episodes")).toEqual([])
    expect(await query("select 1 from kriya.approvals")).toEqual([])
    // No citation line (K7): the prompt is today's
    expect(prompts[0]).not.toContain("Kriya checks each quote")
  })
})

describe("switches on", () => {
  beforeEach(() => {
    process.env.KRIYA_AGENTS_INBOX = "on"
    process.env.KRIYA_AGENTS_GOALS = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  })

  it("waits for approval of a schedule, indexes it, then records the verified run", async () => {
    await turn("SCHEDULE_IT")
    expect(offered[0]).toContain("schedule_create")
    expect(prompts[0]).toContain("Kriya checks each quote against the source.")
    // Nothing was created: the call waits for the person (R2)
    expect(await query("select 1 from kriya.schedules")).toEqual([])
    const [approval] = await query<{ id: string; status: string; risk_class: string }>(
      "select id, status, risk_class from kriya.approvals"
    )
    expect(approval).toMatchObject({ status: "pending", risk_class: "R2" })

    await enqueueApproval({
      userId: user,
      threadId: "t1",
      approvalId: approval.id,
      approved: true,
    })
    const taskId = await claimAndRun()
    expect(await query("select status from kriya.approvals")).toEqual([
      { status: "approved" },
    ])
    expect(await query("select status from kriya.schedules")).toEqual([
      { status: "active" },
    ])

    // AT-VER-03: the summary is cut at 500 characters, the verification isn't
    const [run] = await query<{
      output_summary: string
      verification: schema.Verification
    }>(
      "select output_summary, verification from kriya.tool_executions where tool_name = 'schedule_create'"
    )
    expect(run.output_summary.endsWith("…")).toBe(true)
    expect(run.verification).toMatchObject({ status: "verified", method: "api_readback" })

    const [episode] = await query<{
      done: schema.EpisodeAction[]
      unconfirmed: unknown[]
    }>("select done, unconfirmed from kriya.episodes where task_id = $1", [taskId])
    expect(episode.done.map((d) => d.tool)).toEqual(["schedule_create"])
    // The reply's "I've set up a daily schedule" is backed by the run
    expect(episode.unconfirmed).toEqual([])
  })

  it("records a claimed action with no run as not confirmed", async () => {
    const taskId = await turn("CLAIM_IT")
    expect(
      await query("select done, unconfirmed from kriya.episodes where task_id = $1", [
        taskId,
      ])
    ).toEqual([
      {
        done: [],
        unconfirmed: [
          {
            claim: "I've added the dentist visit to your calendar.",
            reason: "No matching action ran.",
          },
        ],
      },
    ])
  })
})
