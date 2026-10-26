import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { deliveryMetrics } from "@/lib/delivery/metrics"
import { deliveryOf, deliveryView } from "@/lib/delivery/status"
import { ineffectiveNote } from "@/lib/next"
import { deliveryForTasks } from "@/queries/episodes"

import { createTestDb, createUser, type TestDb } from "../db/harness"

vi.mock("server-only", () => ({}))

// N2 (ND-03, ND-17, ND-23): the delivery status from fixed records, a late
// check resolving exactly its own run, checks never crossing people, the
// owner metrics against hand-computed values, and the switch notes.

const verification = {
  status: "verified" as const,
  method: "api_readback" as const,
  evidence: [{ kind: "provider_id" as const, value: "x" }],
}
const done = (id: string) => ({
  executionId: id,
  tool: "t",
  title: "T",
  risk: "R3",
  verification,
})
const open = (id?: string) => ({
  claim: "Did a thing",
  reason: "Ran, but wasn't checked afterwards.",
  ...(id && { executionId: id }),
})
const unsupported = [
  { sentence: "It closes on 7 October", status: "unsupported" as const },
]
const supported = [{ sentence: "It closes on 7 October", status: "supported" as const }]
const check = (
  executionId: string,
  status: "verified" | "unverified" | "failed" | "gone"
) => ({
  executionId,
  status,
  kind: "recheck" as const,
})

describe("NT-DLV-01 deliveryOf", () => {
  const cases: [string, Parameters<typeof deliveryOf>[0], string][] = [
    [
      "a verified action, nothing else",
      { done: [done("e1")], unconfirmed: [], checks: [] },
      "delivered",
    ],
    [
      "verified, and a supported citation",
      { done: [done("e1")], unconfirmed: [], checks: supported },
      "delivered",
    ],
    [
      "verified, with an unchecked run",
      { done: [done("e1")], unconfirmed: [open("e2")], checks: [] },
      "partly",
    ],
    [
      "verified, with a claim no run backs",
      { done: [done("e1")], unconfirmed: [open()], checks: [] },
      "partly",
    ],
    [
      "verified, with an unsupported citation",
      { done: [done("e1")], unconfirmed: [], checks: unsupported },
      "partly",
    ],
    [
      "only an unchecked run",
      { done: [], unconfirmed: [open("e1")], checks: [] },
      "not_confirmed",
    ],
    [
      "only a claim no run backs",
      { done: [], unconfirmed: [open()], checks: [] },
      "not_confirmed",
    ],
    ["a plain answer", { done: [], unconfirmed: [], checks: [] }, "nothing_to_deliver"],
    [
      "an unsupported citation alone",
      { done: [], unconfirmed: [], checks: unsupported },
      "nothing_to_deliver",
    ],
  ]
  it.each(cases)("%s → %s", (_label, episode, expected) => {
    expect(deliveryOf(episode, []).status).toBe(expected)
  })
})

describe("NT-DLV-02 a later check", () => {
  it("resolves exactly its own run", () => {
    const episode = { done: [], unconfirmed: [open("e1"), open("e2")], checks: [] }
    const one = deliveryOf(episode, [check("e1", "verified")])
    expect(one.status).toBe("partly")
    expect(one.laterVerified).toEqual(["e1"])
    expect(one.open.map((c) => c.executionId)).toEqual(["e2"])
    expect(
      deliveryOf(episode, [check("e1", "verified"), check("e2", "verified")]).status
    ).toBe("delivered")
    // A check of some other run changes nothing
    expect(deliveryOf(episode, [check("zzz", "verified")]).status).toBe("not_confirmed")
  })

  it("a claim no run backs is never resolved by a check", () => {
    const episode = { done: [done("e1")], unconfirmed: [open()], checks: [] }
    expect(deliveryOf(episode, [check("e1", "verified")]).status).toBe("partly")
  })

  it("gone, failed and unverified never count as verified", () => {
    const episode = { done: [], unconfirmed: [open("e1")], checks: [] }
    for (const status of ["gone", "failed", "unverified"] as const)
      expect(deliveryOf(episode, [check("e1", status)])).toMatchObject({
        status: "not_confirmed",
        laterVerified: [],
      })
    expect(deliveryOf(episode, [check("e1", "gone")]).gone).toEqual(["e1"])
    // Verified later wins over an earlier "gone"
    expect(
      deliveryOf(episode, [check("e1", "gone"), check("e1", "verified")]).gone
    ).toEqual([])
  })

  it("deliveryView says when each verified run was checked, the latest check", () => {
    const early = new Date("2026-10-24T10:00:00Z")
    const late = new Date("2026-10-24T10:20:00Z")
    const view = deliveryView({ done: [], unconfirmed: [open("e1")], checks: [] }, [
      { ...check("e1", "verified"), checkedAt: early },
      { ...check("e1", "verified"), checkedAt: late },
    ])
    expect(view).toEqual({
      status: "delivered",
      laterVerified: [{ executionId: "e1", checkedAt: late.toISOString() }],
      gone: [],
    })
  })
})

describe("ND-23 switch notes", () => {
  const values = (on: Record<string, string>) => (key: string) => on[key] ?? null
  it("says why a switch that is on has no effect yet, and nothing otherwise", () => {
    expect(ineffectiveNote("next.delivery", values({ "next.delivery": "on" }))).toBe(
      "On, but has no effect yet: agents.inbox must be on."
    )
    expect(
      ineffectiveNote(
        "next.delivery",
        values({ "next.delivery": "on", "agents.inbox": "on" })
      )
    ).toBeNull()
    // Off is just off
    expect(ineffectiveNote("next.delivery", values({}))).toBeNull()
    expect(
      ineffectiveNote(
        "next.memoryRerank",
        values({ "next.memoryRerank": "on", "agents.memoryV2": "on" })
      )
    ).toBe("On, but has no effect yet: next.embeddingModel must be set.")
    expect(
      ineffectiveNote(
        "next.mcp",
        values({ "next.mcp": "on", "agents.inbox": "on" }),
        false
      )
    ).toBe("On, but has no effect yet: KRIYA_TOKEN_KEY must be set.")
    expect(ineffectiveNote("agents.inbox", values({ "agents.inbox": "on" }))).toBeNull()
  })
})

describe("NT-IMP-01 no framework imports", () => {
  it("lib/delivery, lib/reliability and lib/mcp import no next/*", () => {
    const files = ["lib/delivery", "lib/reliability", "lib/mcp"].flatMap((dir) =>
      fs
        .readdirSync(path.join(process.cwd(), dir), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(dir, file))
    )
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8")
      const specs = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1])
      expect(
        specs.filter((spec) => spec === "next" || spec.startsWith("next/")),
        file
      ).toEqual([])
    }
  })
})

/* ───────────────────────── database: scoping and metrics ───────────────────────── */

let pg: TestDb
let alice: string
let bob: string
let n = 0
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)

// One task for `user` with its record and (optionally) a charge and run rows
async function record(
  user: string,
  options: {
    done?: unknown[]
    unconfirmed?: unknown[]
    checks?: unknown[]
    charge?: { micro: number | null; status: "final" | "estimated" | "unpriced" }
    runs?: { id: string; verification?: string }[]
    deleted?: boolean
    daysAgo?: number
  } = {}
) {
  n++
  const thread = `t${user.slice(-4)}`
  await q(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3) on conflict do nothing",
    [thread, user, agentOf(user)]
  )
  const { rows } = await q(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
    [user, thread]
  )
  const task = (rows[0] as { id: string }).id
  for (const run of options.runs ?? [])
    await q(
      `insert into kriya.tool_executions (id, task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status)
       values ($1, $2, $3, 1, $4, 'calendar_create_event', true, 'succeeded')`,
      [run.id, task, user, `c${n}-${run.id}`]
    )
  await q(
    `insert into kriya.episodes (user_id, task_id, thread_id, done, unconfirmed, checks, seq, hash, created_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9), $10)`,
    [
      user,
      task,
      thread,
      JSON.stringify(options.done ?? []),
      JSON.stringify(options.unconfirmed ?? []),
      JSON.stringify(options.checks ?? []),
      n,
      `h${n}`,
      options.daysAgo ?? 1,
      options.deleted ? new Date() : null,
    ]
  )
  if (options.charge)
    await q(
      `insert into kriya.charges (user_id, task_id, markup_bps, cost_basis, charge_micro_inr, status)
       values ($1, $2, 0, 'provider', $3, $4)`,
      [user, task, options.charge.micro, options.charge.status]
    )
  return task
}
const later = (
  user: string,
  task: string,
  execution: string,
  status: string,
  kind = "recheck"
) =>
  q(
    `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
     values ($1, $2, $3, $4, $5)`,
    [user, task, execution, kind, status]
  )
const agentOf = (user: string) => `a${user.slice(-6)}`
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  for (const user of [alice, bob])
    await q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($2, $1, 'A', 'r', 'g')",
      [user, agentOf(user)]
    )
})

describe("NT-DLV-05 scoped checks", () => {
  it("another person's checks never reach a person's status", async () => {
    const aliceTask = await record(alice, {
      unconfirmed: [open(uuid(1))],
      runs: [{ id: uuid(1) }],
    })
    const bobTask = await record(bob, {
      unconfirmed: [open(uuid(2))],
      runs: [{ id: uuid(2) }],
    })
    await later(alice, aliceTask, uuid(1), "verified")
    await later(bob, bobTask, uuid(2), "verified")

    const own = await deliveryForTasks(alice, [aliceTask])
    expect(own.map((c) => [c.executionId, c.status])).toEqual([[uuid(1), "verified"]])
    // Asking for Bob's task as Alice returns nothing
    expect(await deliveryForTasks(alice, [bobTask])).toEqual([])
    expect(await deliveryForTasks(alice, [])).toEqual([])
    // And Bob's check, even listed by Alice's execution id, can't resolve it
    const view = deliveryOf(
      { done: [], unconfirmed: [open(uuid(1))], checks: [] },
      await deliveryForTasks(alice, [bobTask])
    )
    expect(view.status).toBe("not_confirmed")
  })
})

describe("NT-DLV-06 owner metrics equal hand-computed values", () => {
  it("NM1–NM6, NM8 and NM9 on seeded rows", async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    alice = await createUser(pg)
    bob = await createUser(pg)
    for (const user of [alice, bob])
      await q(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($2, $1, 'A', 'r', 'g')",
        [user, agentOf(user)]
      )

    // Two delivered (one priced final ₹3, one estimated ₹1), one delivered
    // but unpriced; one partly; two not confirmed, one of which a re-check
    // verifies (→ delivered, ₹2 final); one claim no run backs; a plain answer
    // (no record); an old record outside 7 days; a deleted record.
    await record(alice, {
      done: [done(uuid(10))],
      charge: { micro: 3_000_000, status: "final" },
    })
    await record(bob, {
      done: [done(uuid(11))],
      charge: { micro: 1_000_000, status: "estimated" },
    })
    await record(alice, {
      done: [done(uuid(12))],
      charge: { micro: null, status: "unpriced" },
    })
    await record(alice, { done: [done(uuid(13))], unconfirmed: [open(uuid(14))] })
    await record(bob, { unconfirmed: [open(uuid(15))], runs: [{ id: uuid(15) }] })
    const verifiedLater = await record(alice, {
      unconfirmed: [open(uuid(16))],
      runs: [{ id: uuid(16) }],
      charge: { micro: 2_000_000, status: "final" },
    })
    await later(alice, verifiedLater, uuid(16), "verified")
    const stillOpen = await record(bob, {
      unconfirmed: [open(uuid(17))],
      runs: [{ id: uuid(17) }],
    })
    await later(bob, stillOpen, uuid(17), "gone")
    await record(alice, { done: [done(uuid(18))], unconfirmed: [open()] })
    await record(alice, {
      done: [done(uuid(19))],
      daysAgo: 20,
      charge: { micro: 9_000_000, status: "final" },
    })
    await record(bob, { done: [done(uuid(20))], deleted: true })

    // 7 days: judged = delivered 4 (10, 11, 12, 16) + partly 2 (13, 18) + not_confirmed 2 (15, 17)
    const week = await deliveryMetrics(7)
    expect(week.statuses).toEqual({
      delivered: 4,
      partly: 2,
      not_confirmed: 2,
      nothing_to_deliver: 0,
    })
    expect(week.nm1).toEqual({ delivered: 4, n: 8 })
    expect(week.nm2).toEqual({ partly: 2, n: 8 })
    expect(week.nm3).toEqual({ notConfirmed: 2, n: 8 })
    // Two re-checks in the window: one verified, one gone
    expect(week.nm4).toEqual({ verified: 1, n: 2 })
    // One record makes a claim no run backs (18), of 8 records
    expect(week.nm5).toEqual({ unbacked: 1, n: 8 })
    // Delivered tasks 10 (₹3 final), 11 (₹1 estimated), 12 (unpriced), 16 (₹2 final)
    expect(week.nm6).toEqual({
      delivered: 4,
      priced: 3,
      unpriced: 1,
      finalMicroInr: 5_000_000,
      estimatedMicroInr: 1_000_000,
      perTaskMicroInr: 2_000_000,
    })
    // 30 days adds the old delivered record (₹9 final); the deleted one never counts
    const month = await deliveryMetrics(30)
    expect(month.nm1).toEqual({ delivered: 5, n: 9 })
    expect(month.nm6.perTaskMicroInr).toBe(Math.round(15_000_000 / 4))
    expect(week.nm8).toEqual({ unapproved: 0 })
    expect(week.nm9).toEqual([])
  })

  it("no records at all is no data, not zero rates", async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    const empty = await deliveryMetrics(7)
    expect(empty.nm1).toEqual({ delivered: 0, n: 0 })
    expect(empty.nm6).toMatchObject({ delivered: 0, perTaskMicroInr: null })
  })

  it("NM8 and NM9: app actions without an approval, and failures per app", async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    const user = await createUser(pg)
    await q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($2, $1, 'A', 'r', 'g')",
      [user, agentOf(user)]
    )
    await q("insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, $2)", [
      user,
      agentOf(user),
    ])
    const { rows } = await q(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
      [user]
    )
    const task = (rows[0] as { id: string }).id
    const run = (call: string, name: string, side: boolean, status = "succeeded") =>
      q(
        `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status, started_at)
         values ($1, $2, 1, $3, $4, $5, $6, now())`,
        [task, user, call, name, side, status]
      )
    // Approved before it ran
    await q(
      `insert into kriya.approvals (id, user_id, thread_id, task_id, tool_name, risk_class, title, status, expires_at, decided_at)
       values ('ap1', $1, 't1', $2, 'mcp_tracker_create_item', 'R4', 'x', 'approved', now() + interval '1 day', now() - interval '1 minute')`,
      [user, task]
    )
    await run("c1", "mcp_tracker_create_item", true)
    // Ran with no approval on record
    await run("c2", "mcp_tracker_delete_item", true)
    await run("c3", "mcp_tracker_search_items", false, "failed")
    await run("c4", "mcp_other_get", false)
    await run("c5", "gmail_draft", true)

    const m = await deliveryMetrics(7)
    expect(m.nm8).toEqual({ unapproved: 1 })
    expect(m.nm9).toEqual([
      { server: "other", failed: 0, n: 1 },
      { server: "tracker", failed: 1, n: 3 },
    ])
  })
})
