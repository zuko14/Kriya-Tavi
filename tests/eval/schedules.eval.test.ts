import fs from "node:fs"
import path from "node:path"

import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { expireApprovals } from "@/lib/agent/approvals"
import { classifyTool } from "@/lib/agent/policy"
import { enqueueApproval } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import { claimDueSchedules, recoverClaimedRuns, runDue } from "@/lib/schedules"
import { inboxCount } from "@/queries/inbox"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// AS-SCH (TEST_AND_EVALUATION §4): schedules, limits, approvals in the
// background and expiry, end to end on PGlite through the real scheduler,
// queue, runner, approvals index and episodes, with a scripted model (free
// run, no real model). Each scenario file gives a setup, steps and the end
// state; the suite measures
//   R1: due fires accounted for (enqueued, or skipped/failed with a reason)
//   P1: R2–R4 tool runs without the person's approval of that exact call
//   V1: "done" lines backed by a succeeded run whose own check verified it
// With KRIYA_EVAL_OUT=<file> the results are written as JSON.

type Rule = Record<string, unknown>
type Scenario = {
  id: string
  description: string
  setup: {
    schedules: {
      id: string
      rule: Rule
      prompt: string
      status?: "active" | "paused"
      overdueMinutes?: number
      goal?: boolean
      capMicroInr?: number
      maxRuns?: number
    }[]
    busy?: boolean
    plan?: { maxTasksPerDay?: number }
    goal?: { budgetMicroInr: number; spentMicroInr: number }
    fx?: string
  }
  steps: string[]
  expect: {
    outcomes?: Record<string, string[]>
    tasks?: number
    schedules?: Record<string, { status: string; pauseReason?: string }>
    nextRunInFuture?: string[]
    approvals?: string[]
    executions?: Record<string, number>
    inboxAtLeast?: number
    done?: string[]
    unconfirmed?: number
    scheduleCount?: number
    queued?: number
    staleRefused?: boolean
    taskBudget?: number
  }
}

const DIR = path.join(process.cwd(), "tests", "eval", "scenarios", "AS-SCH")
const scenarios: Scenario[] = fs
  .readdirSync(DIR)
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")))

/* ───────────────────────────── scripted model ───────────────────── */

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
  const answered = prompt.includes('"role":"tool"')
  if (prompt.includes("SCHEDULE_IT") && !answered) {
    return [
      {
        type: "tool-call",
        toolCallId: "call-review",
        toolName: "schedule_create",
        input: JSON.stringify({
          prompt: "Weekly review of my study plan",
          rule: { freq: "weekly", at: "18:00", days: [7] },
        }),
      },
      finish("tool-calls"),
    ]
  }
  if (prompt.includes("SCHEDULE_IT"))
    return say("I've set up a weekly schedule for Sundays.")
  if (prompt.includes("CLAIM_IT"))
    return say("I've added the mock test to your calendar.")
  return say("Here is today's plan.")
}

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => ({
        stream: simulateReadableStream({
          chunks: script(JSON.stringify(options.prompt)),
        }),
      }),
    }),
}))

/* ───────────────────────────── one scenario ─────────────────────── */

let pg: TestDb
let user: string
const worker = {
  workerId: "w1",
  leaseSeconds: 30,
  shutdown: new AbortController().signal,
}
const q = async <T>(text: string, params: unknown[] = []) =>
  (await pg.query<T>(text, params)).rows

async function setUp(scenario: Scenario) {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.KRIYA_AGENTS_INBOX = "on"
  process.env.KRIYA_AGENTS_GOALS = "on"
  if (scenario.setup.fx) process.env.KRIYA_FX_USD_INR = scenario.setup.fx
  else delete process.env.KRIYA_FX_USD_INR
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined

  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Disha', 'Study', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1'), ('t2', $1, 'a1')",
      [user]
    )
  })
  const { setup } = scenario
  if (setup.plan?.maxTasksPerDay !== undefined) {
    await pg.query("update kriya.plans set max_tasks_per_day = $1 where id = 'free'", [
      setup.plan.maxTasksPerDay,
    ])
  }
  if (setup.goal) {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.goals (id, user_id, agent_id, thread_id, title, monthly_budget_micro_inr) values ('g1', $1, 'a1', 't2', 'GATE', $2)",
        [user, setup.goal!.budgetMicroInr]
      )
    )
    const [spent] = await q<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, 't2', '{}', 'free', 'budget', now(), 10, 1000, 'succeeded') returning id`,
      [user]
    )
    await pg.query(
      "insert into kriya.charges (user_id, task_id, plan_id, cost_basis, markup_bps, charge_micro_inr, status) values ($1, $2, 'free', 'provider', 10000, $3, 'final')",
      [user, spent.id, setup.goal.spentMicroInr]
    )
  }
  if (setup.busy) {
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000)`,
      [user]
    )
  }
  for (const s of setup.schedules) {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at, status, cap_micro_inr, max_runs)
         values ($1, $2, 'a1', $3, $4, $5, $6, $7, now() - make_interval(mins => $8), now(), $9, $10, $11)`,
        [
          s.id,
          user,
          s.goal ? "t2" : "t1",
          s.goal ? "g1" : null,
          s.rule.freq === "once" ? "once" : "recurring",
          s.prompt,
          JSON.stringify(s.rule),
          s.overdueMinutes ?? 1,
          s.status ?? "active",
          s.capMicroInr ?? null,
          s.maxRuns ?? null,
        ]
      )
    )
  }
}

async function runTasks() {
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  for (;;) {
    const id = rowsOf<{ id: string }>(
      await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
    )[0]?.id
    if (!id) return
    const [row] = await q<Record<string, unknown>>(
      "select * from kriya.tasks where id = $1",
      [id]
    )
    const task = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        value,
      ])
    ) as unknown as schema.Task
    await runTask(task, worker)
  }
}

async function answer(approved: boolean) {
  const [pending] = await q<{ id: string; thread_id: string }>(
    "select id, thread_id from kriya.approvals where status = 'pending'"
  )
  await enqueueApproval({
    userId: user,
    threadId: pending.thread_id,
    approvalId: pending.id,
    approved,
  })
}

async function run(scenario: Scenario) {
  let staleRefused = false
  for (const step of scenario.steps) {
    switch (step) {
      case "tick":
        for (const r of await claimDueSchedules()) await runDue(r)
        break
      case "parallelTick": {
        const [a, b] = await Promise.all([claimDueSchedules(), claimDueSchedules()])
        for (const r of [...a, ...b]) await runDue(r)
        break
      }
      case "claimOnly":
        await claimDueSchedules()
        break
      case "ageClaims":
        await pg.query(
          "update kriya.schedule_runs set created_at = now() - interval '3 minutes' where outcome = 'claimed'"
        )
        break
      case "recover":
        await recoverClaimedRuns()
        break
      case "runTasks":
        await runTasks()
        break
      case "approve":
        await answer(true)
        break
      case "decline":
        await answer(false)
        break
      case "expire":
        await pg.query(
          "update kriya.approvals set expires_at = now() - interval '1 minute' where status = 'pending'"
        )
        await expireApprovals()
        break
      case "answerStale": {
        const [old] = await q<{ id: string; thread_id: string }>(
          "select id, thread_id from kriya.approvals"
        )
        await enqueueApproval({
          userId: user,
          threadId: old.thread_id,
          approvalId: old.id,
          approved: true,
        }).catch((error: { code?: string }) => {
          staleRefused = error.code === "stale"
        })
        break
      }
      default:
        throw new Error(`Unknown step ${step}`)
    }
  }
  return { staleRefused }
}

/* ───────────────────────────── checks ───────────────────────────── */

async function observe(scenario: Scenario, staleRefused: boolean) {
  const runs = await q<{ schedule_id: string; outcome: string }>(
    "select schedule_id, outcome from kriya.schedule_runs order by due_at"
  )
  const executions = await q<{
    id: string
    tool_call_id: string
    tool_name: string
    status: string
    input: unknown
    verification: schema.Verification | null
  }>(
    "select id, tool_call_id, tool_name, status, input, verification from kriya.tool_executions"
  )
  const parts = (
    await q<{ parts: { toolCallId?: string; approval?: { approved?: boolean } }[] }>(
      "select parts from kriya.messages where role = 'assistant'"
    )
  ).flatMap((m) => m.parts)
  const episodes = await q<{ done: schema.EpisodeAction[]; unconfirmed: unknown[] }>(
    "select done, unconfirmed from kriya.episodes"
  )

  // P1: every run of an R2–R4 tool needs an approved part for that exact call
  const consequential = executions.filter((e) =>
    ["R2", "R3", "R4"].includes(classifyTool(e.tool_name, e.input))
  )
  const unapproved = consequential.filter(
    (e) =>
      !parts.some((p) => p.toolCallId === e.tool_call_id && p.approval?.approved === true)
  ).length
  // V1: every "done" line points at a succeeded, verified run
  const done = episodes.flatMap((e) => e.done)
  const backed = done.filter((d) =>
    executions.some(
      (e) =>
        e.id === d.executionId &&
        e.status === "succeeded" &&
        e.verification?.status === "verified"
    )
  ).length

  const failures: string[] = []
  const check = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      )
    }
  }
  const x = scenario.expect
  for (const [id, outcomes] of Object.entries(x.outcomes ?? {})) {
    check(
      `outcomes ${id}`,
      runs.filter((r) => r.schedule_id === id).map((r) => r.outcome),
      outcomes
    )
  }
  if (x.tasks !== undefined) {
    const rows = await q(
      "select 1 from kriya.tasks where input ->> 'channel' = 'schedule'"
    )
    check("scheduled tasks", rows.length, x.tasks)
  }
  for (const [id, want] of Object.entries(x.schedules ?? {})) {
    const [row] = await q<{ status: string; pause_reason: string | null }>(
      "select status, pause_reason from kriya.schedules where id = $1",
      [id]
    )
    check(
      `schedule ${id}`,
      { status: row.status, ...(want.pauseReason && { pauseReason: row.pause_reason }) },
      want
    )
  }
  for (const id of x.nextRunInFuture ?? []) {
    const [row] = await q<{ next_run_at: Date | null }>(
      "select next_run_at from kriya.schedules where id = $1",
      [id]
    )
    check(
      `next run of ${id} in the future`,
      (row.next_run_at?.getTime() ?? 0) > Date.now(),
      true
    )
  }
  if (x.approvals) {
    const rows = await q<{ status: string }>(
      "select status from kriya.approvals order by created_at"
    )
    check(
      "approvals",
      rows.map((r) => r.status),
      x.approvals
    )
  }
  for (const [tool, n] of Object.entries(x.executions ?? {})) {
    check(
      `${tool} runs`,
      executions.filter((e) => e.tool_name === tool && e.status === "succeeded").length,
      n
    )
  }
  if (x.inboxAtLeast !== undefined) {
    const n = await inboxCount(user)
    check(`inbox has at least ${x.inboxAtLeast}`, n >= x.inboxAtLeast, true)
  }
  if (x.done) check("done", done.map((d) => d.tool).sort(), [...x.done].sort())
  if (x.unconfirmed !== undefined) {
    check(
      "not confirmed",
      episodes.reduce((n, e) => n + e.unconfirmed.length, 0),
      x.unconfirmed
    )
  }
  if (x.scheduleCount !== undefined) {
    check("schedules", (await q("select 1 from kriya.schedules")).length, x.scheduleCount)
  }
  if (x.queued !== undefined) {
    check(
      "queued tasks",
      (await q("select 1 from kriya.tasks where status = 'queued'")).length,
      x.queued
    )
  }
  if (x.staleRefused !== undefined)
    check("stale answer refused", staleRefused, x.staleRefused)
  if (x.taskBudget !== undefined) {
    const [row] = await q<{ cost_budget_micro_usd: number }>(
      "select cost_budget_micro_usd from kriya.tasks where input ->> 'channel' = 'schedule'"
    )
    check("task budget", row?.cost_budget_micro_usd, x.taskBudget)
  }

  return {
    id: scenario.id,
    pass: failures.length === 0,
    failures,
    runs: runs.length,
    accounted: runs.filter((r) => r.outcome !== "claimed").length,
    consequential: consequential.length,
    unapproved,
    done: done.length,
    backed,
  }
}

/* ───────────────────────────── the suite ────────────────────────── */

const results: Awaited<ReturnType<typeof observe>>[] = []

describe("AS-SCH (scripted, free)", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      await setUp(scenario)
      const { staleRefused } = await run(scenario)
      const result = await observe(scenario, staleRefused)
      results.push(result)
      expect(result.failures).toEqual([])
    })
  }

  it("R1 = 100 %, P1 = 0, V1 = 100 %", () => {
    const sum = (key: "runs" | "accounted" | "unapproved" | "done" | "backed") =>
      results.reduce((n, r) => n + r[key], 0)
    expect(results).toHaveLength(15)
    expect(sum("accounted")).toBe(sum("runs"))
    expect(sum("unapproved")).toBe(0)
    expect(sum("done")).toBeGreaterThan(0)
    expect(sum("backed")).toBe(sum("done"))
  })
})

afterAll(() => {
  for (const key of ["KRIYA_AGENTS_INBOX", "KRIYA_AGENTS_GOALS", "KRIYA_FX_USD_INR"]) {
    delete process.env[key]
  }
  const out = process.env.KRIYA_EVAL_OUT
  if (!out) return
  const sum = (
    key: "runs" | "accounted" | "consequential" | "unapproved" | "done" | "backed"
  ) => results.reduce((n, r) => n + r[key], 0)
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        suite: "AS-SCH",
        n: results.length,
        passed: results.filter((r) => r.pass).length,
        R1: `${sum("accounted")} / ${sum("runs")}`,
        P1: sum("unapproved"),
        consequentialRuns: sum("consequential"),
        V1: `${sum("backed")} / ${sum("done")}`,
        scenarios: results,
      },
      null,
      2
    )
  )
})
