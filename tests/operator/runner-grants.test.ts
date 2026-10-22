import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask, TOOL_APPROVALS } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"
import { jobsForExecutions } from "@/queries/episodes"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Jobs and grants through the real runner on the scripted model (O3, O4).
// OT-REG-01: with operator.mandates and operator.grants off, the belt, the
// prompt and the approval map are exactly today's. O3: the agent proposes
// a job; nothing is granted. OT-GRT-01…07: inside an active job's own
// thread a pinned draft runs without asking; everything else asks.

const offered: string[][] = []
const prompts: string[] = []
const approvalMaps: unknown[] = []
const drafts = vi.hoisted(() => ({
  calls: [] as unknown[],
  after: null as null | (() => Promise<void>),
}))
const failNext = vi.hoisted(() => ({ on: false }))

vi.mock("ai", async (original) => {
  const actual = await original<typeof import("ai")>()
  return {
    ...actual,
    streamText: ((options: Parameters<typeof actual.streamText>[0]) => {
      approvalMaps.push(options.toolApproval)
      return actual.streamText(options)
    }) as typeof actual.streamText,
  }
})
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock("@/lib/connectors", async (original) => ({
  ...(await original<typeof import("@/lib/connectors")>()),
  gmailDraft: async (_user: string, input: unknown) => {
    drafts.calls.push(input)
    await drafts.after?.()
    return { draftId: `d${drafts.calls.length}` }
  },
}))

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
const call = (toolName: string, input: unknown, id = `call-${toolName}`): Chunk[] => [
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
]
const draft = (to: string[], id: string) =>
  call("gmail_draft", { to, subject: "Reminder", body: "Invoice 12 is due." }, id)

const PROPOSAL = {
  title: "Get invoice 12 paid",
  objective: "Remind the client until paid.",
  criteria: [{ text: "Client agreed", evidence: { kind: "person_confirmed" } }],
  grants: [
    {
      tool: "gmail_draft",
      pins: { to: ["a@example.com"] },
      maxUses: 3,
      why: "Reminders",
    },
  ],
  dueInDays: 7,
}

function script(prompt: string): Chunk[] {
  const results = prompt.split('"role":"tool"').length - 1
  if (prompt.includes("PROPOSE_JOB") && results === 0)
    return call("mandate_propose", PROPOSAL)
  if (prompt.includes("DRAFT_ONE") && results === 0)
    return draft(["a@example.com"], "call-1")
  if (prompt.includes("DRAFT_NEW") && results === 0)
    return draft(["a@example.com", "x@evil.example"], "call-1")
  if (prompt.includes("DRAFT_TWICE") && results < 2)
    return draft(["a@example.com"], `call-${results + 1}`)
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
          const text = JSON.stringify(options.prompt)
          // OT-GRT-06: the provider fails right after a granted draft ran
          if (failNext.on && text.includes('"role":"tool"'))
            throw new Error("fetch failed")
          offered.push((options.tools ?? []).map((t) => t.name))
          prompts.push(JSON.stringify(options.prompt.filter((m) => m.role === "system")))
          return { stream: simulateReadableStream({ chunks: script(text) }) }
        },
      }),
  }
})

let pg: TestDb
let user: string
let grantId: string

const SWITCHES = [
  "KRIYA_OPERATOR_MANDATES",
  "KRIYA_OPERATOR_GRANTS",
  "KRIYA_AGENTS_GOALS",
  "KRIYA_AGENTS_INBOX",
]
const set = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}
const allOn = () =>
  set({
    KRIYA_OPERATOR_MANDATES: "on",
    KRIYA_OPERATOR_GRANTS: "on",
    KRIYA_AGENTS_GOALS: "on",
    KRIYA_AGENTS_INBOX: "on",
  })

async function turn(text: string, threadId = "tg") {
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

const q = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await pg.query<T>(query, params)).rows
const lastReply = async () =>
  (
    await q<{ parts: { type: string; state?: string; approval?: unknown }[] }>(
      "select parts from kriya.messages where role = 'assistant' order by created_at desc limit 1"
    )
  )[0]
const draftParts = async () =>
  (await lastReply()).parts.filter((part) => part.type === "tool-gmail_draft")

beforeEach(async () => {
  offered.length = 0
  prompts.length = 0
  approvalMaps.length = 0
  drafts.calls.length = 0
  drafts.after = null
  failNext.on = false
  set(Object.fromEntries(SWITCHES.map((key) => [key, undefined])))
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
    // An ordinary chat, and the job's goal thread
    await tx.query(
      `insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1'), ('tg', $1, 'a1')`,
      [user]
    )
  })
  await pg.query(
    `insert into kriya.connections (id, user_id, provider, scopes, access_token)
     values ('c1', $1, 'google', $2, 'sealed')`,
    [
      user,
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    ]
  )
  // An active job on goal g1 (thread tg) holding one pinned draft grant
  await pg.query(
    "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, 'a1', 'tg', 'Collect')",
    [user]
  )
  await pg.query(
    `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by)
     values ('m1', $1, 'a1', 'Get invoice 12 paid', 'Remind the client',
             '[{"id":"c1","text":"t","evidence":{"kind":"person_confirmed"}}]', now() + interval '7 days', 'agent')`,
    [user]
  )
  await pg.query(
    "update kriya.mandates set status = 'active', goal_id = 'g1' where id = 'm1'"
  )
  grantId = await setGrant(3)
})

const setGrant = async (maxUses: number) => {
  await pg.query("delete from kriya.grants")
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
     values ($1, 'm1', 'gmail_draft', '{"to":["a@example.com"]}', $2, now() + interval '7 days')
     returning id`,
    [user, maxUses]
  )
  return rows[0].id
}

afterEach(() => set(Object.fromEntries(SWITCHES.map((key) => [key, undefined]))))

describe("switches off (OT-REG-01)", () => {
  it("the approval map is TOOL_APPROVALS itself, and the draft asks, grant or not", async () => {
    await turn("DRAFT_ONE")
    expect(approvalMaps[0]).toBe(TOOL_APPROVALS)
    expect((await draftParts())[0].state).toBe("approval-requested")
    expect(drafts.calls).toEqual([])
    expect(await q("select * from kriya.grant_uses")).toEqual([])
  })

  it("belt and prompt are the same unset, or with jobs on but goals/inbox off", async () => {
    await turn("hello", "t1")
    set({ KRIYA_OPERATOR_MANDATES: "on", KRIYA_OPERATOR_GRANTS: "on" })
    await turn("hello", "t1")
    expect(offered[1]).toEqual(offered[0])
    expect(prompts[1]).toBe(prompts[0])
    expect(offered[0]).not.toContain("mandate_propose")
    expect(prompts[0]).not.toContain("**Jobs.**")
  })

  it("grants on without any grant for the thread still passes TOOL_APPROVALS", async () => {
    allOn()
    await turn("hello", "t1")
    expect(approvalMaps[0]).toBe(TOOL_APPROVALS)
  })
})

describe("proposing a job (O3)", () => {
  it("offers the tools and the Jobs line, and only writes a proposal", async () => {
    allOn()
    await turn("PROPOSE_JOB", "t1")
    expect(offered[0]).toEqual(
      expect.arrayContaining(["mandate_propose", "mandate_status"])
    )
    expect(prompts[0]).toContain("**Jobs.**")
    const jobs = await q<{ status: string; origin_thread_id: string }>(
      "select status, origin_thread_id from kriya.mandates where id <> 'm1'"
    )
    expect(jobs).toEqual([{ status: "proposed", origin_thread_id: "t1" }])
    // No approval asked for a proposal, and it granted nothing
    expect(await q("select * from kriya.approvals")).toEqual([])
    expect(await q<{ n: number }>("select count(*)::int as n from kriya.grants")).toEqual(
      [{ n: 1 }]
    )
  })
})

describe("grants in the runner (O4)", () => {
  beforeEach(allOn)

  it("a pinned draft in the job's thread runs without asking (OT-GRT-01)", async () => {
    const taskId = await turn("DRAFT_ONE")
    expect(drafts.calls).toHaveLength(1)
    // What the SDK records for an automatic approval (the ARCHITECTURE §5 unknown)
    // Observed on AI SDK 7.0.137: an automatic approval is saved on the part,
    // which recordApprovals (approval-requested only) leaves out
    const [part] = await draftParts()
    expect(part.state).toBe("output-available")
    expect(part.approval).toMatchObject({ approved: true, isAutomatic: true })
    expect(await q("select * from kriya.approvals")).toEqual([])
    const runs = await q<{ status: string; grant_id: string | null }>(
      "select status, grant_id from kriya.tool_executions where tool_name = 'gmail_draft'"
    )
    expect(runs).toEqual([{ status: "succeeded", grant_id: grantId }])
    expect(await q("select task_id, tool_call_id from kriya.grant_uses")).toEqual([
      { task_id: taskId, tool_call_id: "call-1" },
    ])
    expect((await q<{ uses: number }>("select uses from kriya.grants"))[0].uses).toBe(1)
    // "What I did" says which job allowed it
    const [run] = await q<{ id: string }>(
      "select id from kriya.tool_executions where tool_name = 'gmail_draft'"
    )
    expect(await jobsForExecutions(user, [run.id])).toEqual({
      [run.id]: "Get invoice 12 paid",
    })
  })

  it("a recipient outside the pins asks exactly as today (OT-GRT-02, OT-SEC-01)", async () => {
    await turn("DRAFT_NEW")
    expect((await draftParts())[0].state).toBe("approval-requested")
    expect(drafts.calls).toEqual([])
    expect(
      await q<{ tool_name: string }>("select tool_name from kriya.approvals")
    ).toEqual([{ tool_name: "gmail_draft" }])
    expect(await q("select * from kriya.grant_uses")).toEqual([])
  })

  it("the same grant does nothing in another thread (OT-GRT-04)", async () => {
    await turn("DRAFT_ONE", "t1")
    expect(approvalMaps[0]).toBe(TOOL_APPROVALS)
    expect((await draftParts())[0].state).toBe("approval-requested")
    expect(drafts.calls).toEqual([])
  })

  it("revoked between two calls of one task: the second asks (OT-GRT-05)", async () => {
    drafts.after = async () => {
      await pg.query("update kriya.grants set status = 'revoked', revoked_at = now()")
    }
    await turn("DRAFT_TWICE")
    expect(drafts.calls).toHaveLength(1)
    expect((await draftParts()).map((p) => p.state)).toEqual([
      "output-available",
      "approval-requested",
    ])
  })

  it("used up mid-task: the next call asks and the grant is exhausted (OT-GRT-07)", async () => {
    grantId = await setGrant(1)
    await turn("DRAFT_TWICE")
    expect(drafts.calls).toHaveLength(1)
    expect((await draftParts()).map((p) => p.state)).toEqual([
      "output-available",
      "approval-requested",
    ])
    expect(await q("select uses, status from kriya.grants")).toEqual([
      { uses: 1, status: "exhausted" },
    ])
  })

  it("a task that fails after a granted draft isn't retried: one use, one draft (OT-GRT-06)", async () => {
    failNext.on = true
    const taskId = await turn("DRAFT_ONE")
    expect(drafts.calls).toHaveLength(1)
    const [task] = await q<{ status: string; attempts: number }>(
      "select status, attempts from kriya.tasks where id = $1",
      [taskId]
    )
    expect(task).toEqual({ status: "failed", attempts: 1 })
    expect(await q("select uses from kriya.grants")).toEqual([{ uses: 1 }])
  })
})
