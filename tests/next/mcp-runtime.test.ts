import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { FOREIGN } from "@/lib/agent/tools"
import { reset as resetBreaker } from "@/lib/reliability/breaker"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import {
  fixtureFetch,
  fixtureHosts,
  registerFixture,
  startMcpFixture,
} from "../fixtures/mcp/server"

// loadMcp against the fixture server (N5, MCP_CONNECTIVITY §4): only pinned
// tools, the owner's words, drift, the kill list, the tool budget, R5,
// strict inputs, elicitation refused, a slow app dropped, ids-only logs.

vi.mock("@/lib/mcp/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/fetch")>()),
  guardedFetch: (server: { url: string }) => fixtureFetch(server),
}))
const logs = vi.hoisted(() => [] as [string, Record<string, unknown>][])
vi.mock("@/lib/log", async (original) => {
  const real = await original<typeof import("@/lib/log")>()
  return {
    ...real,
    log: {
      ...real.log,
      warn: (message: string, data: Record<string, unknown>) =>
        logs.push([message, data]),
    },
  }
})

import { loadMcp } from "@/lib/mcp/registry"

let pg: TestDb
let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let user: string
const task = () => ({ id: "00000000-0000-0000-0000-000000000001", userId: user })
const open = { maxTools: 20, disabled: new Set<string>(), authFor: () => undefined }
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
// Runs one belt tool as the AI SDK would
const exec = (tool: { execute?: unknown }, input: unknown) =>
  (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
    toolCallId: "c1",
    messages: [],
    context: {},
  })

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
  await asUser(pg, user, (tx) =>
    tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g'), ('a2', $1, 'B', 'r', 'g')",
      [user]
    )
  )
  fixture.state.drift = null
  fixture.state.calls.length = 0
  fixture.state.elicitAnswers.length = 0
  logs.length = 0
  resetBreaker()
})

const enable = (agentId: string | null = null, serverId = "tracker") =>
  asUser(pg, user, (tx) =>
    tx.query(
      "insert into kriya.mcp_enablements (user_id, server_id, agent_id) values ($1, $2, $3)",
      [user, serverId, agentId]
    )
  )

const TRACKER = [
  { name: "search_items", risk: "R0" },
  { name: "create_item", risk: "R3" },
  { name: "drifting", risk: "R0" },
]

describe("loadMcp", () => {
  it("gives nothing to a person who turned no app on", async () => {
    await registerFixture(q, "tracker", TRACKER)
    expect(await loadMcp(task(), "a1", open)).toBeNull()
  })

  it("NT-MCP-01/03: only pinned tools, with the owner's words, classed and wrapped", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable()
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      // poisoned, inject_result, elicit… exist on the server but were never pinned
      expect(Object.keys(mcp.tools).sort()).toEqual([
        "mcp_tracker_create_item",
        "mcp_tracker_drifting",
        "mcp_tracker_search_items",
      ])
      expect(mcp.tools.mcp_tracker_search_items.description).toBe(
        "Kriya: search items. (in Tracker)"
      )
      expect(Object.fromEntries(mcp.classes)).toEqual({
        mcp_tracker_search_items: "R0",
        mcp_tracker_create_item: "R3",
        mcp_tracker_drifting: "R0",
      })
      expect(mcp.approvals).toEqual({ mcp_tracker_create_item: "user-approval" })
      expect([...mcp.sideEffects]).toEqual(["mcp_tracker_create_item"])
      expect(mcp.apps).toEqual(["Tracker"])

      const out = await exec(mcp.tools.mcp_tracker_search_items, { query: "invoices" })
      expect(out).toEqual({ notice: FOREIGN, result: "Found 2 items for invoices." })
      const made = await exec(mcp.tools.mcp_tracker_create_item, { title: "Call back" })
      expect(made).toEqual({
        notice: FOREIGN,
        result: { id: "item-1", title: "Call back" },
      })
      expect(fixture.state.calls.map((c) => c.name)).toEqual([
        "search_items",
        "create_item",
      ])
    } finally {
      await mcp.close()
    }
  })

  it("only for the agent it was turned on for, and only while the app is active", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable("a2")
    expect(await loadMcp(task(), "a1", open)).toBeNull()
    const mine = (await loadMcp(task(), "a2", open))!
    await mine.close()
    expect(mine.apps).toEqual(["Tracker"])
    await q("update kriya.mcp_servers set status = 'suspended'")
    expect(await loadMcp(task(), "a2", open)).toBeNull()
  })

  it("leaves out an OAuth app the person hasn't connected (N6)", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable()
    expect(await loadMcp(task(), "a1", { ...open, authFor: undefined })).toBeNull()
    expect(fixture.state.calls).toEqual([])
  })

  it.each(["description", "annotations"] as const)(
    "NT-MCP-04: a tool whose %s changed leaves the belt and is marked drifted",
    async (change) => {
      await registerFixture(q, "tracker", TRACKER)
      await enable()
      fixture.state.drift = change
      const mcp = (await loadMcp(task(), "a1", open))!
      await mcp.close()
      expect(Object.keys(mcp.tools)).not.toContain("mcp_tracker_drifting")
      expect(Object.keys(mcp.tools)).toContain("mcp_tracker_search_items")
      const { rows } = await q(
        "select status, drifted_hash, definition_hash from kriya.mcp_tools where name = 'drifting'"
      )
      const row = rows[0] as {
        status: string
        drifted_hash: string
        definition_hash: string
      }
      expect(row.status).toBe("drifted")
      expect(row.drifted_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.drifted_hash).not.toBe(row.definition_hash)
      // NT-SEC-03: ids only
      expect(logs).toEqual([
        [
          "mcp tool drifted",
          { taskId: task().id, serverId: "tracker", tool: "mcp_tracker_drifting" },
        ],
      ])
    }
  )

  it("NT-MCP-06: the owner's kill list removes an app tool", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable()
    const mcp = (await loadMcp(task(), "a1", {
      ...open,
      disabled: new Set(["mcp_tracker_create_item"]),
    }))!
    await mcp.close()
    expect(Object.keys(mcp.tools)).not.toContain("mcp_tracker_create_item")
    expect(mcp.approvals).toEqual({})
  })

  it("NT-MCP-17: at most next.mcpMaxTools tools, and the prompt says which app was trimmed", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable()
    const mcp = (await loadMcp(task(), "a1", { ...open, maxTools: 2 }))!
    await mcp.close()
    expect(mcp.classes.size).toBe(2)
    expect(mcp.notes).toEqual([
      "Some of Tracker's tools were left out to keep the list short.",
    ])
  })

  it("NT-MCP-19: a payments pin never reaches the belt, even at R0", async () => {
    await registerFixture(q, "tracker", [
      { name: "search_items", risk: "R0" },
      { name: "pay_invoice", risk: "R0", category: "payments" },
    ])
    await enable()
    const mcp = (await loadMcp(task(), "a1", open))!
    await mcp.close()
    expect(Object.keys(mcp.tools)).toEqual(["mcp_tracker_search_items"])
  })

  it("NT-MCP-09: an unknown field or an input over 32 KB is refused before any request", async () => {
    await registerFixture(q, "tracker", TRACKER)
    await enable()
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      const run = (input: unknown) => exec(mcp.tools.mcp_tracker_create_item, input)
      await expect(run({ title: "x", to: "collector@evil.example" })).rejects.toThrow()
      await expect(run({ title: "x".repeat(40_000) })).rejects.toThrow(/too large/)
      expect(fixture.state.calls).toEqual([])
    } finally {
      await mcp.close()
    }
  })

  it("NT-MCP-16: an elicitation is refused and the call fails plainly", async () => {
    await registerFixture(q, "tracker", [{ name: "elicit", risk: "R0" }])
    await enable()
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      await expect(exec(mcp.tools.mcp_tracker_elicit, {})).rejects.toThrow(
        "Tracker said: The person didn't answer."
      )
      // The client answered with an error, never with what was asked for
      expect(fixture.state.elicitAnswers).toEqual([
        expect.objectContaining({ code: -32601 }),
      ])
    } finally {
      await mcp.close()
    }
  })

  it("NT-REL-04: a slow app is dropped after the open timeout; the rest still load", async () => {
    const slow = await startMcpFixture({ slowMs: 15_000 })
    fixtureHosts.set("slow.fixture.example", slow.url)
    try {
      await registerFixture(q, "tracker", TRACKER)
      await registerFixture(q, "slow", [{ name: "search_items", risk: "R0" }])
      await enable(null, "tracker")
      await enable(null, "slow")
      const started = Date.now()
      const mcp = (await loadMcp(task(), "a1", open))!
      await mcp.close()
      expect(Date.now() - started).toBeLessThan(13_000)
      expect(mcp.apps).toEqual(["Tracker"])
      expect(mcp.notes).toEqual(["Slow isn't reachable right now."])
      expect(logs.map(([message, data]) => [message, Object.keys(data).sort()])).toEqual([
        ["mcp server unavailable", ["error", "serverId", "taskId"]],
      ])
    } finally {
      await slow.close()
    }
  }, 20_000)
})
