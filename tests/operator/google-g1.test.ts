import { randomBytes } from "node:crypto"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock("@/actions/connections", () => ({ disconnectAccount: async () => {} }))

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { Connections } from "@/components/account/connections"
import { getSetting } from "@/lib/config"
import { accessToken } from "@/lib/connectors"
import { configChecks } from "@/lib/readiness"
import { connectionHealth, jobsNeedGoogle } from "@/queries/connections"
import { getInbox } from "@/queries/inbox"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Google live in Testing mode, the code half (G1, GOOGLE_CONNECTIVITY §3.2,
// §6). OT-G1-01 readiness by name only; OT-G1-02 health derived from tool
// runs, never stored; OT-G1-03 the Inbox line for jobs; OT-G1-04 the
// Testing-mode note. No Google call: the reconnect message comes from the
// connector itself failing before any request.

const KEY = randomBytes(32).toString("base64")
const BASE = {
  DATABASE_URL: "postgres://db.internal/kriya",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
  KRIYA_APP_URL: "https://kriya.example",
  OPENROUTER_API_KEY: "or-key",
  KRIYA_TOKEN_KEY: KEY,
}
const ID = "client-id-value.apps.googleusercontent.com"
const SECRET = "client-secret-value"

describe("readiness by name (OT-G1-01)", () => {
  const google = (env: Record<string, string>) =>
    configChecks(env).filter((c) => c.id.startsWith("google."))

  it("no Google variables: a warning, not a failure", () => {
    expect(google(BASE)).toEqual([
      {
        id: "google.oauth",
        status: "warn",
        detail: expect.stringContaining("GOOGLE_CLIENT_ID"),
      },
    ])
  })

  it("one of the pair, or no token key: fails; all three: passes", () => {
    expect(google({ ...BASE, GOOGLE_CLIENT_ID: ID })[0]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("GOOGLE_CLIENT_SECRET"),
    })
    const noKey = { ...BASE, KRIYA_TOKEN_KEY: "" }
    expect(
      google({ ...noKey, GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: SECRET })[0]
    ).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("KRIYA_TOKEN_KEY"),
    })
    expect(
      google({ ...BASE, GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: SECRET })[0]
    ).toMatchObject({ id: "google.oauth", status: "pass" })
  })

  it("in production the callback needs an https app URL", () => {
    const prod = {
      ...BASE,
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: ID,
      GOOGLE_CLIENT_SECRET: SECRET,
    }
    expect(google({ ...prod, KRIYA_APP_URL: "http://kriya.example" })).toContainEqual(
      expect.objectContaining({ id: "google.appUrl", status: "fail" })
    )
    expect(google(prod)).toContainEqual(
      expect.objectContaining({ id: "google.appUrl", status: "pass" })
    )
  })

  it("never prints a value", () => {
    const text = JSON.stringify(
      configChecks({
        ...BASE,
        NODE_ENV: "production",
        GOOGLE_CLIENT_ID: ID,
        GOOGLE_CLIENT_SECRET: SECRET,
      })
    )
    for (const value of [ID, SECRET, KEY, BASE.KRIYA_APP_URL])
      expect(text).not.toContain(value)
  })
})

let pg: TestDb
let alice: string
let bob: string
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

// The exact message the connector throws when Google access has stopped working
async function reconnectMessage(user: string) {
  await q(
    `insert into kriya.connections (id, user_id, provider, scopes, access_token, expires_at)
     values ($1, $2, 'google', '{}', 'sealed', now() - interval '1 day')`,
    [`c-${user.slice(0, 8)}`, user]
  )
  const message = await accessToken(user, "google").then(
    () => "",
    (error: Error) => error.message
  )
  expect(message).toMatch(/^Google access has stopped working/)
  return message
}

// A task in `thread` whose tool run failed with `error`, `minutes` from now
// (updated_at is set by a trigger to now(), so a reconnect is always later)
async function failedRun(user: string, thread: string, error: string, minutes = 0) {
  const [task] = await q<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{"messageId":"m","agentId":"a1","channel":"schedule"}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded')
     returning id`,
    [user, thread]
  )
  await q(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status, error, finished_at)
     values ($1, $2, 1, $3, 'gmail_search', false, 'failed', $4, now() + make_interval(mins => $5))`,
    [task.id, user, `call-${Math.random()}`, error, minutes]
  )
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  for (const user of [alice, bob]) {
    await q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Lekha', 'r', 'g')",
      [`a-${user.slice(0, 8)}`, user]
    )
  }
  await q("insert into kriya.threads (id, user_id, agent_id) values ('chat', $1, $2)", [
    alice,
    `a-${alice.slice(0, 8)}`,
  ])
})
afterEach(() => {
  delete process.env.KRIYA_OPERATOR_MANDATES
  delete process.env.KRIYA_GOOGLE_TESTING_MODE
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
})

describe("connection health (OT-G1-02)", () => {
  it("needs reconnect only after a reconnect failure newer than the connection", async () => {
    const message = await reconnectMessage(alice)
    expect(await connectionHealth(alice)).toEqual({ google: "ok" })
    // Older than the connection: an earlier, already-fixed problem
    await failedRun(alice, "chat", message, -60)
    // Another kind of failure, and Notion's own message
    await failedRun(alice, "chat", "Gmail search failed (500).")
    await failedRun(
      alice,
      "chat",
      "Notion access has stopped working. Reconnect Notion in Account → Connected accounts."
    )
    expect(await connectionHealth(alice)).toEqual({ google: "ok" })
    await failedRun(alice, "chat", message)
    expect(await connectionHealth(alice)).toEqual({ google: "needs_reconnect" })
    // Bob's account is his own
    await reconnectMessage(bob)
    expect(await connectionHealth(bob)).toEqual({ google: "ok" })
    // Reconnecting rewrites the row, which moves updated_at past the failure
    await q("update kriya.connections set access_token = 'sealed-2' where user_id = $1", [
      alice,
    ])
    expect(await connectionHealth(alice)).toEqual({ google: "ok" })
  })
})

describe("the Inbox line (OT-G1-03)", () => {
  // A job on its own goal thread, in `status`
  async function job(id: string, status: string) {
    const agent = `a-${alice.slice(0, 8)}`
    await q("insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)", [
      `t-${id}`,
      alice,
      agent,
    ])
    await q(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ($1, $2, $3, $4, 'Collect')",
      [`g-${id}`, alice, agent, `t-${id}`]
    )
    await q(
      `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by)
       values ($1, $2, $3, $4, 'Get paid', '[{"id":"c1","text":"x","evidence":{"kind":"person_confirmed"}}]',
         now() + interval '7 days', 'agent')`,
      [id, alice, agent, `Job ${id}`]
    )
    await q("update kriya.mandates set status = 'active', goal_id = $2 where id = $1", [
      id,
      `g-${id}`,
    ])
    if (status !== "active")
      await q("update kriya.mandates set status = $2 where id = $1", [id, status])
  }

  it("appears only for active jobs whose thread had the failure", async () => {
    process.env.KRIYA_OPERATOR_MANDATES = "on"
    const message = await reconnectMessage(alice)
    await job("m1", "active")
    await job("m2", "paused")
    await failedRun(alice, "chat", message)
    await failedRun(alice, "t-m2", message)
    expect(await jobsNeedGoogle(alice)).toEqual([])
    expect((await getInbox(alice)).googleStopped).toEqual([])
    await failedRun(alice, "t-m1", message)
    expect(await jobsNeedGoogle(alice)).toEqual(["Job m1"])
    expect((await getInbox(alice)).googleStopped).toEqual(["Job m1"])
    // Bob sees nothing of it
    expect(await jobsNeedGoogle(bob)).toEqual([])
    // Reconnected: gone
    await q("update kriya.connections set access_token = 'sealed-2' where user_id = $1", [
      alice,
    ])
    expect(await jobsNeedGoogle(alice)).toEqual([])
  })

  it("isn't read with jobs off", async () => {
    const message = await reconnectMessage(alice)
    await job("m1", "active")
    await failedRun(alice, "t-m1", message)
    expect((await getInbox(alice)).googleStopped).toEqual([])
  })
})

describe("the Testing-mode note (OT-G1-04)", () => {
  const render = (testingMode: boolean) =>
    renderToStaticMarkup(
      createElement(Connections, {
        google: { account: "test@example.com", services: ["gmail"] },
        notion: null,
        available: { google: true, notion: false },
        health: {},
        testingMode,
      })
    )

  it("follows google.testingMode, off by default", async () => {
    expect(await getSetting("google.testingMode")).toBe("off")
    expect(render(false)).not.toContain("every 7 days")
    expect(render(true)).toContain("every 7 days")
    process.env.KRIYA_GOOGLE_TESTING_MODE = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    expect(await getSetting("google.testingMode")).toBe("on")
  })

  it("a stopped connection shows Reconnect on the same connect form", () => {
    const html = renderToStaticMarkup(
      createElement(Connections, {
        google: { account: "test@example.com", services: ["gmail"] },
        notion: null,
        available: { google: true, notion: false },
        health: { google: "needs_reconnect" },
      })
    )
    expect(html).toContain("Reconnect Google")
    expect(html).toContain("stopped working")
    expect(html).toContain('action="/api/connect/google"')
  })
})
