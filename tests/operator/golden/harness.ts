import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"
import { claimDueSchedules, runDue } from "@/lib/schedules"

import { asUser, createTestDb, createUser, type TestDb } from "../../db/harness"

// Shared world for the golden jobs (O9, TEST_AND_EVALUATION §3): one person
// with an agent, a Google connection (Gmail and Sheets scopes; the
// connector calls themselves are mocked by each test file), every switch a
// job needs, and helpers to run turns and scheduled runs through the real
// runner on the scripted model. PGlite only; no network.

export type Chunk =
  | { type: "text-start" | "text-end"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish"
      finishReason: { unified: "stop" | "tool-calls"; raw: undefined }
      usage: unknown
    }

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const finish = (reason: "stop" | "tool-calls"): Chunk => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
})
export const say = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
]
export const call = (toolName: string, input: unknown, id: string): Chunk[] => [
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
]

// The scripted model: the test sets `script`. It sees only the current
// run, from its own (latest) user message on, and how many tool results
// that run already holds, so earlier runs in the thread don't steer it.
export const model = {
  script: (_run: string, _results: number): Chunk[] => say("Done."),
}
export const respond = (prompt: string) => {
  const run = prompt.slice(prompt.lastIndexOf('"role":"user"'))
  return model.script(run, run.split('"role":"tool"').length - 1)
}

const SWITCHES = {
  KRIYA_AGENTS_INBOX: "on",
  KRIYA_AGENTS_GOALS: "on",
  KRIYA_AGENTS_LEDGER: "on",
  KRIYA_AGENTS_CONNECTORS: "on",
  KRIYA_OPERATOR_MANDATES: "on",
  KRIYA_OPERATOR_GRANTS: "on",
  KRIYA_OPERATOR_REPORTS: "on",
  KRIYA_OPERATOR_CHECK_INS: "on",
  KRIYA_OPERATOR_PLAYBOOKS: "on",
  KRIYA_OPERATOR_CREWS: "on",
}
export function switches(on: boolean) {
  for (const key of Object.keys(SWITCHES)) {
    if (on) process.env[key] = "on"
    else delete process.env[key]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

export type World = Awaited<ReturnType<typeof world>>

export async function world() {
  switches(true)
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  const pg: TestDb = await createTestDb()
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  setDatabaseForTests(db)
  const user = await createUser(pg)
  await pg.query(
    "update kriya.plans set ledger_enabled = true, max_goals = 10, max_schedules = 20"
  )
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Lekha', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('chat', $1, 'a1')",
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
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    ]
  )

  const q = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    (await pg.query<T>(query, params)).rows

  // Claims the queued task, if any, and runs it to the end
  async function runQueued() {
    const id = rowsOf<{ id: string }>(
      await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
    )[0]?.id
    if (!id) return null
    const [row] = await q("select * from kriya.tasks where id = $1", [id])
    const task = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        v,
      ])
    ) as unknown as schema.Task
    await runTask(task, {
      workerId: "w1",
      leaseSeconds: 30,
      shutdown: new AbortController().signal,
    })
    return id
  }

  // The person writes in a thread; the task runs
  async function turn(text: string, threadId = "chat") {
    await enqueueTurn({
      userId: user,
      threadId,
      message: {
        id: `m${Math.random()}`,
        role: "user",
        parts: [{ type: "text", text }],
      } as KriyaMessage,
    })
    return runQueued()
  }

  // A job's schedule of this kind fires now, as the worker would; returns its task
  async function fire(goalId: string, kind: "once" | "recurring") {
    await q(
      `update kriya.schedules set next_run_at = now(), status = 'active'
       where goal_id = $1 and kind = $2`,
      [goalId, kind]
    )
    for (const run of await claimDueSchedules()) await runDue(run)
    return runQueued()
  }

  const job = async (id: string) =>
    (
      await q<Record<string, unknown>>("select * from kriya.mandates where id = $1", [id])
    )[0]

  return { pg, db, user, q, turn, runQueued, fire, job }
}

// An issued invoice of the person's, past due
export async function overdueInvoice(w: World, n: number) {
  const [row] = await w.q<{ id: string }>(
    `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, total_paise,
       status, fy, number, number_text, due_date)
     values ($1, '{"name":"Studio","state_code":"29"}', '{"name":"Client","state_code":"29"}', '29',
       '[{"description":"Design","qty_milli":1000,"rate_paise":100000,"tax_rate_bps":0}]', 100000, 100000,
       'issued', '2026-27', $2, $3, current_date - 20) returning id`,
    [w.user, n, `INV/${n}`]
  )
  return row.id
}
