import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { recheckDeliveries } from "@/lib/delivery/recheck"
import { recheckTarget } from "@/lib/delivery/rules"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import {
  fixtureFetch,
  fixtureHosts,
  registerFixture,
  startMcpFixture,
} from "../fixtures/mcp/server"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/mcp/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/fetch")>()),
  guardedFetch: (server: { url: string }) => fixtureFetch(server),
}))

// The person's sign-in is its own tested path (mcp-connect); here the fixture needs none
const signIn = vi.hoisted(() => ({ state: "ok" as "ok" | "none" | "reconnect" }))
vi.mock("@/lib/mcp/live", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/live")>()),
  connectedAuth: () => async () =>
    signIn.state === "ok" ? undefined : signIn.state === "none" ? null : "reconnect",
}))

// N12 (ND-04, ND-12): an app run whose read-back couldn't read is read once
// more, 2–30 minutes later, through the same pinned R0 spec and the person's
// own connection. Against the fixture app; nothing leaves the machine.

const SPEC = {
  tool: "get_item",
  args: { id: "/structuredContent/id" },
  expect: { "/structuredContent/title": "/input/title" },
}
const unverified = {
  status: "unverified",
  method: "api_readback",
  evidence: [{ kind: "provider_id", value: "item-1" }],
}
const summary = JSON.stringify({ result: { id: "item-1", title: "Hello" } })

describe("recheckTarget for an app run", () => {
  const base = { toolName: "mcp_tracker_create_item", input: { title: "Hello" } }
  it("only an unverified read-back, with what the summary kept", () => {
    expect(
      recheckTarget({ ...base, verification: unverified, outputSummary: summary })
    ).toEqual({
      kind: "mcp",
      kriyaName: "mcp_tracker_create_item",
      input: { title: "Hello" },
      result: { id: "item-1", title: "Hello" },
    })
    // A cut summary leaves no result, but the run is still looked at
    expect(
      recheckTarget({ ...base, verification: unverified, outputSummary: '{"res…' })
    ).toMatchObject({ kind: "mcp", result: undefined })
    for (const verification of [
      null,
      { ...unverified, status: "verified" },
      { ...unverified, status: "failed" },
    ])
      expect(recheckTarget({ ...base, verification })).toBeNull()
  })
})

let pg: TestDb
let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let user: string
let n = 0
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)

// A finished app run of the person's, 10 minutes ago
async function appRun(
  o: { tool?: string; verification?: object | null; outputSummary?: string } = {}
) {
  n++
  await q(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g') on conflict do nothing",
    [user]
  )
  await q(
    "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1') on conflict do nothing",
    [user]
  )
  const { rows } = await q(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
    [user]
  )
  const taskId = (rows[0] as { id: string }).id
  const { rows: made } = await q(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect,
       status, input, output_summary, verification, finished_at)
     values ($1, $2, 1, $3, $4, true, 'succeeded', $5, $6, $7, now() - interval '10 minutes') returning id`,
    [
      taskId,
      user,
      `c${n}`,
      o.tool ?? "mcp_tracker_create_item",
      JSON.stringify({ title: "Hello" }),
      o.outputSummary ?? summary,
      o.verification === null ? null : JSON.stringify(o.verification ?? unverified),
    ]
  )
  return (made[0] as { id: string }).id
}

const checks = async () =>
  (await q("select execution_id, kind, status, note from kriya.delivery_checks"))
    .rows as {
    execution_id: string
    kind: string
    status: string
    note: string
  }[]

describe("the late re-check of an app run", () => {
  beforeAll(async () => {
    fixture = await startMcpFixture()
    fixtureHosts.set("tracker.fixture.example", fixture.url)
  })
  afterAll(() => fixture.close())

  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    user = await createUser(pg)
    n = 0
    fixture.state.items.clear()
    fixture.state.items.set("item-1", "Hello")
    fixture.state.read = "ok"
    await registerFixture(q, "tracker", [
      { name: "get_item", risk: "R0" },
      { name: "create_item", risk: "R3", verify: SPEC },
    ])
    signIn.state = "ok"
  })

  const tick = () => recheckDeliveries(new Date())

  it("verified once the app can be read; never a second row", async () => {
    const id = await appRun()
    expect(await tick()).toMatchObject({ candidates: 1, checked: 1, verified: 1 })
    expect(await checks()).toEqual([
      expect.objectContaining({
        execution_id: id,
        kind: "recheck",
        status: "verified",
        note: "Checked again: the app shows what was sent.",
      }),
    ])
    expect(await tick()).toMatchObject({ candidates: 0, checked: 0 })
  })

  it("failed when the app shows something else; unverified when it can't be read", async () => {
    fixture.state.read = "different"
    await appRun()
    expect(await tick()).toMatchObject({ checked: 1, failed: 1 })
    fixture.state.read = "error"
    await appRun()
    expect(await tick()).toMatchObject({ checked: 1, unverified: 1 })
  })

  it("a cut summary can't say what to look up: unverified, not a guess", async () => {
    await appRun({ outputSummary: '{"result":{"id":"item-1","ti…' })
    expect(await tick()).toMatchObject({ checked: 1, unverified: 1 })
  })

  it("a changed or removed read tool, or a suspended app: unverified, nothing called", async () => {
    await appRun()
    await q("update kriya.mcp_tools set definition_hash = $1 where name = 'get_item'", [
      "0".repeat(64),
    ])
    fixture.state.calls.length = 0
    expect(await tick()).toMatchObject({ checked: 1, unverified: 1 })
    expect(fixture.state.calls.map((c) => c.name)).not.toContain("get_item")
    await q("delete from kriya.delivery_checks")
    await q("update kriya.mcp_servers set status = 'suspended'")
    expect(await tick()).toMatchObject({ checked: 1, unverified: 1 })
  })

  it("not signed in to the app, or signed out: unverified, nothing called", async () => {
    for (const state of ["none", "reconnect"] as const) {
      signIn.state = state
      await appRun()
      fixture.state.calls.length = 0
      expect(await tick()).toMatchObject({ checked: 1, unverified: 1 })
      expect(fixture.state.calls).toEqual([])
      await q("delete from kriya.delivery_checks")
      await q("delete from kriya.tool_executions")
    }
  })

  it("a run with no spec, or a verified one, is left alone", async () => {
    await appRun({ verification: null })
    await appRun({ verification: { ...unverified, status: "verified" } })
    expect(await tick()).toMatchObject({ checked: 0, skipped: 1 })
    expect(await checks()).toEqual([])
  })
})
