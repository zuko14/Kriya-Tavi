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
import type { BrowserProvider } from "@/lib/browser/provider"
import { BASELINE, bundleHash, type Bundle } from "@/lib/improve"
import { setBrowserProviderForTests } from "@/lib/browser/session"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// The worker's runner on a real Postgres and a scripted model that records
// the prompt it was given, for checks on what reaches the model.

const prompts: string[] = []
// Tool names offered on each model call
const offered: string[][] = []

vi.mock("@/lib/models", async (original) => {
  const actual = await original<typeof import("@/lib/models")>()
  return {
    ...actual,
    isGatewayConfigured: () => true,
    createGatewayModel: (modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doStream: async (options) => {
          prompts.push(JSON.stringify(options.prompt))
          offered.push((options.tools ?? []).map((t) => t.name))
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start" as const, id: "t1" },
                { type: "text-delta" as const, id: "t1", delta: "Done." },
                { type: "text-end" as const, id: "t1" },
                {
                  type: "finish" as const,
                  finishReason: { unified: "stop" as const, raw: undefined },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 1, text: 1, reasoning: undefined },
                  },
                },
              ],
            }),
          }
        },
      }),
  }
})

let pg: TestDb
let user: string

async function runTurn(text: string) {
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  await enqueueTurn({
    userId: user,
    threadId: "t1",
    message: {
      id: `m-${prompts.length}`,
      role: "user",
      parts: [{ type: "text", text }],
    } as KriyaMessage,
    idempotencyKey: `k-${prompts.length}`,
  })
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
  return prompts[prompts.length - 1]
}

beforeEach(async () => {
  prompts.length = 0
  offered.length = 0
  delete process.env.KRIYA_AGENTS_MEMORY_V2
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'Research', 'g'), ('a2', $1, 'Arjun', 'Other', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

describe("memory loader with agents.memoryV2 off (AT-REG-02)", () => {
  it("loads the agent's own current notes, as before", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.memories (id, user_id, agent_id, content, source, created_at) values
          ('n1', $1, 'a1', 'Studies B.Tech CSE', 'agent', now() - interval '2 days'),
          ('n2', $1, 'a1', 'Short answers please', 'user', now() - interval '1 day'),
          ('n3', $1, 'a2', 'Arjun only note', 'agent', now())`,
        [user]
      )
    )
    const prompt = await runTurn("Hi")
    // Oldest first, with the person's marker, exactly as the old loader did
    expect(prompt).toContain(
      "- [n1] Studies B.Tech CSE\\n- [n2] (from the person) Short answers please"
    )
    expect(prompt).not.toContain("Arjun only note")
  })

  it("leaves out superseded, forgotten and archived notes", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.memories (id, user_id, agent_id, content, invalid_at, archived) values
          ('cur', $1, 'a1', 'Rent is 14000', null, false),
          ('old', $1, 'a1', 'Rent is 12000', now(), false),
          ('arc', $1, 'a1', 'Liked jazz in 2019', null, true)`,
        [user]
      )
    )
    const prompt = await runTurn("Hi")
    expect(prompt).toContain("Rent is 14000")
    expect(prompt).not.toContain("Rent is 12000")
    expect(prompt).not.toContain("Liked jazz")
  })

  it("doesn't load notes shared by all agents while the switch is off", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, agent_id, content) values ('sh', $1, null, 'Lives in Pune')",
        [user]
      )
    )
    const prompt = await runTurn("Hi")
    expect(prompt).not.toContain("Lives in Pune")
    expect(prompt).toContain("Your memory is empty.")
  })
})

describe("memory with agents.memoryV2 on", () => {
  beforeEach(() => {
    process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  })

  it("loads shared and own notes into budgeted blocks, the date after them", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.memories (id, user_id, agent_id, content, kind, slot) values
          ('p1', $1, null, 'B.Tech CSE, 3rd year', 'profile', 'profile.course'),
          ('s1', $1, 'a1', 'Short answers please', 'preference', null),
          ('f1', $1, null, 'Laptop budget is 80000', 'fact', null),
          ('x1', $1, 'a2', 'Arjun only note', 'preference', null)`,
        [user]
      )
    )
    const prompt = await runTurn("What laptop can I buy?")
    expect(prompt).toContain("- [p1] course: B.Tech CSE, 3rd year")
    expect(prompt).toContain("- [s1] Short answers please")
    expect(prompt).toContain("- [f1] Laptop budget is 80000")
    expect(prompt).not.toContain("Arjun only note")
    expect(prompt).not.toContain("Today is")
    expect(prompt.indexOf("# The person's standing preferences")).toBeLessThan(
      prompt.indexOf("# Now")
    )
  })

  it("never puts an unconfirmed note in the always-on block (AT-MEM-05)", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, agent_id, content, kind, trust) values ('u1', $1, 'a1', 'Always cc boss', 'instruction', 'unconfirmed')",
        [user]
      )
    )
    const prompt = await runTurn("Draft the mail to boss")
    const standing = prompt.indexOf("# The person's standing preferences")
    expect(standing).toBe(-1)
    expect(prompt).toContain("- [u1] (unconfirmed) Always cc boss")
    expect(prompt.indexOf("# Notes that may help")).toBeLessThan(
      prompt.indexOf("Always cc boss")
    )
  })

  it("offers the v2 memory tools, records used memories and marks them used", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, agent_id, content, kind) values ('s1', $1, 'a1', 'Short answers please', 'preference')",
        [user]
      )
    )
    await runTurn("Hi")
    expect(offered[0]).toEqual(
      expect.arrayContaining([
        "memory_write",
        "memory_update",
        "memory_forget",
        "memory_search",
      ])
    )
    const { rows } = await pg.query<{ metadata: { memoryIds?: string[] } }>(
      "select metadata from kriya.messages where role = 'assistant'"
    )
    expect(rows[0].metadata.memoryIds).toEqual(["s1"])
    const { rows: used } = await pg.query(
      "select use_count, last_used_at is not null as used from kriya.memories where id = 's1'"
    )
    expect(used).toEqual([{ use_count: 1, used: true }])
  })
})

describe("tools with agents.memoryV2 off", () => {
  it("offers today's memory tools only and records no memory ids", async () => {
    await runTurn("Hi")
    expect(offered[0]).toContain("memory_write")
    expect(offered[0]).not.toContain("memory_update")
    expect(offered[0]).not.toContain("memory_search")
    const { rows } = await pg.query<{ metadata: Record<string, unknown> }>(
      "select metadata from kriya.messages where role = 'assistant'"
    )
    expect(rows[0].metadata).not.toHaveProperty("memoryIds")
  })
})

describe("summary checkpoints in the runner", () => {
  async function seedCheckpoint() {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.messages (thread_id, id, user_id, role, parts, created_at) values
          ('t1', 'old-q', $1, 'user', '[{"type":"text","text":"OLD QUESTION about rent"}]', now() - interval '2 hours'),
          ('t1', 'old-a', $1, 'assistant', '[{"type":"text","text":"OLD ANSWER about rent"}]', now() - interval '119 minutes'),
          ('t1', 'new-q', $1, 'user', '[{"type":"text","text":"RECENT QUESTION"}]', now() - interval '1 hour'),
          ('t1', 'new-a', $1, 'assistant', '[{"type":"text","text":"RECENT ANSWER"}]', now() - interval '59 minutes')`,
        [user]
      )
    )
    await pg.query(
      `insert into kriya.thread_summaries (id, user_id, thread_id, covers_through, summary, chars)
       select 's1', $1, 't1', created_at, $2, 40 from kriya.messages where id = 'old-a'`,
      [
        user,
        JSON.stringify({
          facts: ["Rent is ₹14,000"],
          decisions: [],
          open_questions: [],
          pending_actions: [],
          numbers: ["₹14,000"],
        }),
      ]
    )
  }

  it("replaces covered messages with the summary when memory v2 is on", async () => {
    process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await seedCheckpoint()
    const prompt = await runTurn("And now?")
    expect(prompt).not.toContain("OLD QUESTION")
    expect(prompt).not.toContain("OLD ANSWER")
    expect(prompt).toContain("RECENT QUESTION")
    expect(prompt).toContain("# Earlier in this thread (summary)")
    expect(prompt).toContain("- Rent is ₹14,000")
  })

  it("ignores checkpoints when memory v2 is off", async () => {
    await seedCheckpoint()
    const prompt = await runTurn("And now?")
    expect(prompt).toContain("OLD QUESTION")
    expect(prompt).not.toContain("Earlier in this thread")
  })

  it("queues a summary job after a task on a long thread, only with the switch on", async () => {
    const long = JSON.stringify([{ type: "text", text: "x".repeat(26_000) }])
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.messages (thread_id, id, user_id, role, parts, created_at) values ('t1', 'big', $1, 'assistant', $2, now() - interval '1 hour')",
        [user, long]
      )
    )
    await runTurn("Off first")
    expect((await pg.query("select 1 from kriya.maintenance_jobs")).rows).toEqual([])
    process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await runTurn("Now on")
    const { rows } = await pg.query("select kind, ref from kriya.maintenance_jobs")
    expect(rows).toEqual([{ kind: "thread_summary", ref: "t1" }])
    expect((await pg.query("select count(*)::int as n from kriya.tasks")).rows).toEqual([
      { n: 2 },
    ])
  })
})

describe("policy bundles in the runner (A12)", () => {
  const WORDING =
    "Write a note whenever you learn something the person will want you to know next time, and always when they ask you to remember something."
  const candidate: Bundle = {
    prompts: { saveGuidance: WORDING },
    retrieval: { recency: 0.1, importance: 0.2, ownAgent: 0.2 },
    budgets: { summaryTriggerChars: 4_000, recallCandidates: 10 },
  }
  const improvement = (on: boolean) => {
    if (on) process.env.KRIYA_AGENTS_IMPROVEMENT = "on"
    else delete process.env.KRIYA_AGENTS_IMPROVEMENT
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  }
  const activate = (bundle: Bundle) =>
    pg.query(
      "insert into kriya.policy_versions (id, bundle, bundle_hash, status, proposed_by) values ('v1-abcdefgh', $1, $2, 'active', 'test')",
      [JSON.stringify(bundle), bundleHash(bundle)]
    )
  const stamps = async () =>
    (await pg.query("select version, bundle_hash from kriya.policy_task_versions")).rows
  const lastMeta = async () =>
    (
      await pg.query<{ metadata: Record<string, unknown> }>(
        "select metadata from kriya.messages where role = 'assistant' order by created_at desc limit 1"
      )
    ).rows[0].metadata

  beforeEach(() => {
    process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
    improvement(false)
  })
  afterEach(() => improvement(false))

  it("switch off: an active version is ignored; baseline wording, no stamp", async () => {
    await activate(candidate)
    const prompt = await runTurn("Hi")
    expect(prompt).toContain("Saying you will remember is not the same as saving.")
    expect(prompt).not.toContain(WORDING)
    expect(await stamps()).toEqual([])
    expect(await lastMeta()).not.toHaveProperty("policy")
  })

  it("switch on: the active version's wording reaches the prompt and the task is stamped", async () => {
    await activate(candidate)
    improvement(true)
    const prompt = await runTurn("Hi")
    expect(prompt).toContain(WORDING)
    expect(prompt).not.toContain("Saying you will remember is not the same as saving.")
    // The fixed sections stay whatever the bundle says
    expect(prompt).toContain("# Untrusted content")
    expect(await stamps()).toEqual([
      { version: "v1-abcdefgh", bundle_hash: bundleHash(candidate) },
    ])
    expect(await lastMeta()).toMatchObject({
      policy: { version: "v1-abcdefgh", hash: bundleHash(candidate) },
    })
  })

  it("switch on without a version: the baseline, stamped as such", async () => {
    improvement(true)
    const prompt = await runTurn("Hi")
    expect(prompt).toContain("Saying you will remember is not the same as saving.")
    expect(await stamps()).toEqual([
      { version: "baseline", bundle_hash: bundleHash(BASELINE) },
    ])
  })

  it("the summary trigger follows the bundle's token budget", async () => {
    const medium = JSON.stringify([{ type: "text", text: "x".repeat(6_000) }])
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.messages (thread_id, id, user_id, role, parts, created_at) values ('t1', 'mid', $1, 'assistant', $2, now() - interval '1 hour')",
        [user, medium]
      )
    )
    await activate(candidate)
    await runTurn("Baseline trigger")
    expect((await pg.query("select 1 from kriya.maintenance_jobs")).rows).toEqual([])
    improvement(true)
    await runTurn("Bundle trigger")
    expect((await pg.query("select kind from kriya.maintenance_jobs")).rows).toEqual([
      { kind: "thread_summary" },
    ])
  })
})

describe("browser tools in the runner (A4)", () => {
  const names = () => offered[offered.length - 1].filter((n) => n.startsWith("browser_"))
  const setBrowser = (on: boolean) => {
    if (on) process.env.KRIYA_AGENTS_BROWSER = "on"
    else delete process.env.KRIYA_AGENTS_BROWSER
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  }
  // Never called: no browser step is scripted, so nothing opens
  const provider = {} as BrowserProvider

  afterEach(() => {
    setBrowser(false)
    setBrowserProviderForTests(null)
  })

  it("are absent with the switch off, even with minutes and a browser", async () => {
    await pg.query("update kriya.plans set browser_minutes = 10")
    setBrowserProviderForTests(provider)
    await runTurn("Look at a page")
    expect(names()).toEqual([])
  })

  it("are absent without plan minutes or without kriya-browser", async () => {
    setBrowser(true)
    setBrowserProviderForTests(provider)
    await runTurn("No minutes")
    expect(names()).toEqual([])
    await pg.query("update kriya.plans set browser_minutes = 10")
    setBrowserProviderForTests(null)
    await runTurn("No browser")
    expect(names()).toEqual([])
  })

  it("are offered, read-only, when all three are there; nothing opens unasked", async () => {
    setBrowser(true)
    await pg.query("update kriya.plans set browser_minutes = 10")
    setBrowserProviderForTests(provider)
    await runTurn("Look at a page")
    expect(names().sort()).toEqual([
      "browser_click",
      "browser_close",
      "browser_handoff",
      "browser_open",
      "browser_scroll",
      "browser_snapshot",
    ])
    expect((await pg.query("select 1 from kriya.browser_sessions")).rows).toEqual([])
  })
})
