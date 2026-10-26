import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { reset as resetBreaker } from "@/lib/reliability/breaker"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import {
  FIXTURE_TOOLS,
  fixtureFetch,
  fixtureHosts,
  registerFixture,
  startMcpFixture,
} from "../fixtures/mcp/server"

// N7: the owner's registry (ND-06/07/12). NT-OWN-01…04: only the owner, audited,
// pins store the hash they showed, drift is re-approved by looking, nothing
// but counts and statuses on the page's data, unsafe addresses refused at
// save. NT-MCP-20: no activation without a recorded-response test. The daily
// drift check reads the app's tool list as the owner and nothing else.

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
const session = vi.hoisted(() => ({ owner: null as string | null }))
vi.mock("@/lib/auth", () => ({
  requireOwner: async () => {
    if (!session.owner) throw new Error("NEXT_NOT_FOUND")
    return { id: session.owner }
  },
}))
vi.mock("@/lib/mcp/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/fetch")>()),
  guardedFetch: (server: { url: string }) => fixtureFetch(server),
}))
vi.mock("@/lib/mcp/recorded", () => ({ RECORDED: { tracker: ["search_items"] } }))
const logs = vi.hoisted(() => [] as string[])
vi.mock("@/lib/log", async (original) => {
  const real = await original<typeof import("@/lib/log")>()
  return {
    ...real,
    log: {
      ...real.log,
      warn: (message: string, data: unknown) =>
        void logs.push(`${message} ${JSON.stringify(data)}`),
    },
  }
})

import {
  addServer,
  approveDrift,
  pinTool,
  setServerStatus,
  setToolStatus,
  updateServer,
} from "@/actions/owner-apps"
import { checkDrift, resetDriftClock } from "@/lib/mcp/drift"
import { registry } from "@/lib/mcp/owner"
import { definitionHash } from "@/lib/mcp/tools"

let pg: TestDb
let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let owner: string
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await q(sql, params)).rows as T[]
const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}
const SERVER = {
  id: "tracker",
  name: "Tracker",
  url: "https://tracker.fixture.example/mcp",
  auth: "none",
}
const definitionOf = (name: string) => FIXTURE_TOOLS.find((t) => t.name === name)!
const audited = async () =>
  (
    await rows<{ action: string }>("select action from kriya.audit_events order by id")
  ).map((r) => r.action)

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
  owner = await createUser(pg)
  session.owner = owner
  fixture.state.drift = null
  fixture.state.calls.length = 0
  logs.length = 0
  resetBreaker()
  resetDriftClock()
})

describe("NT-OWN-01 only the owner, always audited", () => {
  it("a person who isn't the owner reaches nothing", async () => {
    session.owner = null
    const none = form({})
    for (const action of [
      addServer,
      updateServer,
      setServerStatus,
      pinTool,
      approveDrift,
      setToolStatus,
    ])
      await expect(action(null, none)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(await rows("select 1 from kriya.mcp_servers")).toEqual([])
    expect(await audited()).toEqual([])
  })

  it("each change leaves an audit record naming ids and hashes, not definitions or notes", async () => {
    expect(
      await addServer(
        null,
        form({ ...SERVER, review: "Terms read 2026-10-25, secret-note" })
      )
    ).toEqual({ message: "Added as a draft." })
    expect(
      await pinTool(
        null,
        form({
          serverId: "tracker",
          name: "search_items",
          kriyaName: "mcp_tracker_search_items",
          description: "Search items.",
          ownerRisk: "R0",
        })
      )
    ).toEqual({ message: "Pinned." })
    expect(await updateServer(null, form({ id: "tracker", name: "Tracker 2" }))).toEqual({
      message: "Saved.",
    })
    expect(
      await setServerStatus(null, form({ id: "tracker", status: "active" }))
    ).toEqual({
      message: "Now active.",
    })
    expect(
      await setToolStatus(
        null,
        form({ serverId: "tracker", name: "search_items", status: "disabled" })
      )
    ).toEqual({ message: "Switched off." })
    expect(await audited()).toEqual([
      "mcp.server.add",
      "mcp.tool.pin",
      "mcp.server.update",
      "mcp.server.active",
      "mcp.tool.disabled",
    ])
    const text = JSON.stringify(await rows("select * from kriya.audit_events"))
    expect(text).not.toContain("secret-note")
    expect(text).not.toContain("Search items by text")
    expect(text).toContain(definitionHash(definitionOf("search_items")))
  })
})

describe("NT-OWN-04 unsafe addresses are refused at save", () => {
  it.each([
    ["http", "http://tracker.fixture.example/mcp"],
    ["a private name", "https://localhost/mcp"],
    ["a name with no dot", "https://intranet/mcp"],
    ["a Render name", "https://kriya.onrender.com/mcp"],
    ["an IP address", "https://203.0.113.5/mcp"],
    ["an IPv6 address", "https://[2001:db8::1]/mcp"],
    ["a password in the address", "https://user:pw@tracker.fixture.example/mcp"],
  ])("the address: %s", async (_label, url) => {
    const out = await addServer(null, form({ ...SERVER, url }))
    expect(out).toEqual({ error: "The address must be https and a public name." })
    expect(await rows("select 1 from kriya.mcp_servers")).toEqual([])
  })

  it("a sign-in address, a missing client id, a secret on a public client, a taken id", async () => {
    const oauth = { ...SERVER, auth: "oauth_public", clientId: "kriya" }
    expect(
      await addServer(null, form({ ...oauth, origins: "http://auth.fixture.example" }))
    ).toEqual({ error: "Sign-in addresses must be https." })
    expect(await addServer(null, form({ ...oauth, clientId: "" }))).toEqual({
      error: "This sign-in needs a client id.",
    })
    expect(
      await addServer(null, form({ ...oauth, secretEnv: "KRIYA_MCP_TRACKER_SECRET" }))
    ).toEqual({ error: "Only a confidential client has a secret name." })
    expect(await addServer(null, form(oauth))).toEqual({ message: "Added as a draft." })
    expect(await addServer(null, form(oauth))).toEqual({ error: "That id is taken." })
  })

  it("a changed address isn't an edit: the update leaves the address and sign-in alone", async () => {
    await addServer(null, form(SERVER))
    await updateServer(
      null,
      form({
        id: "tracker",
        name: "T",
        url: "https://evil.example/mcp",
        auth: "oauth_public",
      })
    )
    expect(await rows("select url, auth from kriya.mcp_servers")).toEqual([
      { url: SERVER.url, auth: "none" },
    ])
  })
})

const pinFields = (extra: Record<string, string> = {}) => ({
  serverId: "tracker",
  name: "search_items",
  kriyaName: "mcp_tracker_search_items",
  description: "Search items.",
  ownerRisk: "R0",
  ...extra,
})

describe("NT-OWN-02 pinning stores what the owner saw", () => {
  beforeEach(async () => {
    await addServer(null, form(SERVER))
  })

  it("reads the app as the owner and stores its definition and hash", async () => {
    await pinTool(null, form(pinFields({ idempotent: "on" })))
    const [tool] = await rows<{
      definition: Record<string, unknown>
      definition_hash: string
      idempotent: boolean
      status: string
      approved_by: string
    }>("select * from kriya.mcp_tools")
    expect(tool.definition_hash).toBe(definitionHash(definitionOf("search_items")))
    expect(tool.definition).toEqual(definitionOf("search_items"))
    expect(tool).toMatchObject({ idempotent: true, status: "pinned", approved_by: owner })
  })

  it("refuses what can't be pinned, with a reason", async () => {
    const out = (extra: Record<string, string>) => pinTool(null, form(pinFields(extra)))
    expect(await out({ name: "nothing_here" })).toEqual({
      error: "The app has no tool with that name.",
    })
    expect(await out({ kriyaName: "search_items" })).toMatchObject({
      error: expect.stringContaining("Kriya's name looks like"),
    })
    expect(await out({ kriyaName: "mcp_other_search_items" })).toEqual({
      error: "Kriya's name starts mcp_tracker_.",
    })
    expect(await out({ ownerRisk: "R3", idempotent: "on" })).toEqual({
      error: "Only a read (R0) can be repeated safely.",
    })
    // An app with no sign-in can't hold a write: the database says so
    expect(
      await out({
        name: "create_item",
        kriyaName: "mcp_tracker_create_item",
        ownerRisk: "R3",
      })
    ).toEqual({ error: "a server without sign-in can't hold R3 tools" })
    expect(await rows("select 1 from kriya.mcp_tools")).toEqual([])
    await out({})
    expect(await out({})).toEqual({ error: "That tool is already pinned." })
    expect(await out({ name: "get_item" })).toEqual({
      error: "Another tool already has that name in Kriya.",
    })
  })

  it("an app the owner can't sign in to yet: a pasted definition, held to what the app says later", async () => {
    await q("update kriya.mcp_servers set auth = 'oauth_public', client_id = 'kriya'")
    const pin = (extra: Record<string, string>) => pinTool(null, form(pinFields(extra)))
    expect(await pin({})).toEqual({
      error:
        "Sign in to this app yourself in Account → Apps first, or paste the definition.",
    })
    expect(
      await pin({
        definition: JSON.stringify({ ...definitionOf("search_items"), name: "x" }),
      })
    ).toEqual({ error: "The definition has a different name." })
    expect(await pin({ definition: "[1]" })).toEqual({
      error: "The definition is one tool's JSON object.",
    })
    expect(await pin({ definition: "{nope" })).toEqual({
      error: "The definition isn't valid JSON.",
    })
    expect(
      await pin({ definition: JSON.stringify(definitionOf("search_items")) })
    ).toEqual({
      message: "Pinned.",
    })
    // Fields that aren't the owner's to trust (the app's extras) are not stored
    await q("delete from kriya.mcp_tools")
    await pin({
      definition: JSON.stringify({ ...definitionOf("search_items"), _meta: { x: 1 } }),
    })
    const [{ definition }] = await rows<{ definition: object }>(
      "select definition from kriya.mcp_tools"
    )
    expect(definition).not.toHaveProperty("_meta")
  })

  it("a read-back must name a pinned R0 read of the same app, on a tool that changes something", async () => {
    await q("update kriya.mcp_servers set auth = 'oauth_public', client_id = 'kriya'")
    const create = (verify: object | string, extra: Record<string, string> = {}) =>
      pinTool(
        null,
        form(
          pinFields({
            name: "create_item",
            kriyaName: "mcp_tracker_create_item",
            ownerRisk: "R3",
            definition: JSON.stringify(definitionOf("create_item")),
            verify: typeof verify === "string" ? verify : JSON.stringify(verify),
            ...extra,
          })
        )
      )
    const spec = {
      tool: "get_item",
      args: { id: "/structuredContent/id" },
      expect: { "/structuredContent/title": "/input/title" },
    }
    expect(await create(spec)).toEqual({
      error: "The read-back tool must be a pinned read (R0) in this app.",
    })
    // get_item pinned as R3 is a write, not a read
    await pinTool(
      null,
      form(
        pinFields({
          name: "get_item",
          kriyaName: "mcp_tracker_get_item",
          ownerRisk: "R3",
          definition: JSON.stringify(definitionOf("get_item")),
        })
      )
    )
    expect(await create(spec)).toEqual({
      error: "The read-back tool must be a pinned read (R0) in this app.",
    })
    await q("delete from kriya.mcp_tools")
    await pinTool(
      null,
      form(
        pinFields({
          name: "get_item",
          kriyaName: "mcp_tracker_get_item",
          definition: JSON.stringify(definitionOf("get_item")),
        })
      )
    )
    expect(await create("{nope")).toEqual({ error: "The read-back isn't valid JSON." })
    expect(await create({ ...spec, args: {} })).toMatchObject({
      error: expect.any(String),
    })
    expect(await create(spec, { ownerRisk: "R0" })).toEqual({
      error: "A read-back belongs to a tool that changes something.",
    })
    expect(await create(spec)).toEqual({ message: "Pinned." })
    const [{ verify }] = await rows<{ verify: object }>(
      "select verify from kriya.mcp_tools where name = 'create_item'"
    )
    expect(verify).toEqual(spec)
  })

  it("a tool switched off is pinned afresh, from what the owner reads now", async () => {
    await pinTool(null, form(pinFields()))
    await setToolStatus(
      null,
      form({ serverId: "tracker", name: "search_items", status: "disabled" })
    )
    // Still the same: switching on again is allowed
    expect(
      await setToolStatus(
        null,
        form({ serverId: "tracker", name: "search_items", status: "pinned" })
      )
    ).toEqual({ message: "Switched on." })
    await setToolStatus(
      null,
      form({ serverId: "tracker", name: "search_items", status: "disabled" })
    )
    await q("update kriya.mcp_tools set definition_hash = $1", ["a".repeat(64)])
    expect(
      await setToolStatus(
        null,
        form({ serverId: "tracker", name: "search_items", status: "pinned" })
      )
    ).toEqual({ error: "The app changed this tool while it was off. Pin it again." })
    expect(
      await pinTool(null, form(pinFields({ description: "Search, again." })))
    ).toEqual({
      message: "Pinned.",
    })
    const [tool] = await rows<{
      definition_hash: string
      description: string
      status: string
    }>("select definition_hash, description, status from kriya.mcp_tools")
    expect(tool).toEqual({
      definition_hash: definitionHash(definitionOf("search_items")),
      description: "Search, again.",
      status: "pinned",
    })
  })
})

describe("drift: found, shown, approved only by looking", () => {
  beforeEach(async () => {
    await registerFixture(
      q,
      "tracker",
      [
        { name: "search_items", risk: "R0" },
        { name: "drifting", risk: "R0" },
      ],
      { auth: "none" }
    )
    await q("update kriya.mcp_servers set created_by = $1", [owner])
  })
  const state = () =>
    rows<{
      name: string
      status: string
      drifted_hash: string | null
      definition_hash: string
    }>(
      "select name, status, drifted_hash, definition_hash from kriya.mcp_tools order by name"
    )

  it("the daily check marks a changed tool, once, and leaves the rest", async () => {
    expect(await checkDrift()).toEqual({ servers: 1, drifted: 0, skipped: 0, errors: 0 })
    fixture.state.drift = "description"
    // Checked once a day per app
    expect(await checkDrift()).toMatchObject({ servers: 0 })
    expect(await checkDrift(new Date(Date.now() + 25 * 3600 * 1000))).toEqual({
      servers: 1,
      drifted: 1,
      skipped: 0,
      errors: 0,
    })
    const [drifting, search] = await state()
    expect(drifting).toMatchObject({ name: "drifting", status: "drifted" })
    expect(drifting.drifted_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(search).toMatchObject({
      name: "search_items",
      status: "pinned",
      drifted_hash: null,
    })
    // Ids only in the log, never the description
    expect(logs.join("\n")).toContain("mcp tool drifted")
    expect(logs.join("\n")).not.toContain("evil.example")
  })

  it("an app the owner isn't signed in to is left to the tasks; a paused one isn't looked at", async () => {
    await q("update kriya.mcp_servers set auth = 'oauth_public', client_id = 'kriya'")
    fixture.state.drift = "description"
    expect(await checkDrift()).toEqual({ servers: 0, drifted: 0, skipped: 1, errors: 0 })
    expect((await state()).map((t) => t.status)).toEqual(["pinned", "pinned"])
    await q("update kriya.mcp_servers set status = 'suspended'")
    resetDriftClock()
    expect(await checkDrift()).toEqual({ servers: 0, drifted: 0, skipped: 0, errors: 0 })
  })

  it("an app that doesn't answer is counted, logged by id, and doesn't stop the others", async () => {
    await q("update kriya.mcp_servers set url = 'https://gone.fixture.example/mcp'")
    expect(await checkDrift()).toEqual({ servers: 0, drifted: 0, skipped: 0, errors: 1 })
    expect(logs.join("\n")).toContain("mcp drift check failed")
  })

  it("NT-OWN-02: approving stores the new definition and hash and re-pins", async () => {
    fixture.state.drift = "description"
    await checkDrift()
    const [{ drifted_hash }] = (await state()).filter((t) => t.name === "drifting")
    const approve = (seenHash: string) =>
      approveDrift(null, form({ serverId: "tracker", name: "drifting", seenHash }))

    // Approving what wasn't on the screen
    expect(await approve("b".repeat(64))).toEqual({
      error: "It changed again since you looked. Review it again.",
    })
    // The app changed again after the owner looked
    fixture.state.drift = "annotations"
    expect(await approve(drifted_hash!)).toEqual({
      error: "The app shows something else now. Review it again.",
    })
    expect((await state())[0].status).toBe("drifted")

    fixture.state.drift = "description"
    expect(await approve(drifted_hash!)).toEqual({
      message: "The new definition is pinned.",
    })
    const [after] = await rows<{
      status: string
      definition_hash: string
      drifted_hash: string | null
      definition: { description: string }
      approved_by: string
    }>("select * from kriya.mcp_tools where name = 'drifting'")
    expect(after).toMatchObject({
      status: "pinned",
      definition_hash: drifted_hash,
      drifted_hash: null,
      approved_by: owner,
    })
    expect(after.definition.description).toContain("evil.example")
    expect(await audited()).toEqual(["mcp.tool.approve_drift"])
    // Nothing to review any more
    expect(await approve(drifted_hash!)).toEqual({
      error: "That tool has nothing to review.",
    })
  })

  it("a tool can be switched off while it is drifted, and then it can't be switched back on", async () => {
    fixture.state.drift = "description"
    await checkDrift()
    await setToolStatus(
      null,
      form({ serverId: "tracker", name: "drifting", status: "disabled" })
    )
    const out = await setToolStatus(
      null,
      form({ serverId: "tracker", name: "drifting", status: "pinned" })
    )
    expect(out).toMatchObject({ error: expect.any(String) })
    expect((await state())[0].status).toBe("disabled")
  })
})

describe("NT-MCP-20 no activation without a recorded-response test", () => {
  const activate = () => setServerStatus(null, form({ id: "tracker", status: "active" }))
  beforeEach(async () => {
    await addServer(null, form(SERVER))
  })

  it("needs a pinned tool, and a recorded response for every one", async () => {
    expect(await activate()).toEqual({ error: "Pin at least one tool first." })
    await pinTool(null, form(pinFields()))
    await pinTool(
      null,
      form(pinFields({ name: "get_item", kriyaName: "mcp_tracker_get_item" }))
    )
    expect(await activate()).toEqual({
      error: "No recorded-response test yet for: get_item.",
    })
    await setToolStatus(
      null,
      form({ serverId: "tracker", name: "get_item", status: "disabled" })
    )
    expect(await activate()).toEqual({ message: "Now active." })
    // Pause, resume and retire are the owner's call and need no test
    expect(
      await setServerStatus(null, form({ id: "tracker", status: "suspended" }))
    ).toEqual({
      message: "Now suspended.",
    })
    expect(
      await setServerStatus(null, form({ id: "tracker", status: "active" }))
    ).toEqual({
      message: "Now active.",
    })
    expect(
      await setServerStatus(null, form({ id: "tracker", status: "retired" }))
    ).toEqual({
      message: "Now retired.",
    })
    expect(
      await setServerStatus(null, form({ id: "tracker", status: "active" }))
    ).toMatchObject({
      error: expect.stringContaining("can't go from retired to active"),
    })
  })

  it("no way around it: a new tool on a live app, or one pinned while it was paused", async () => {
    await pinTool(null, form(pinFields()))
    expect(await activate()).toEqual({ message: "Now active." })
    const getItem = pinFields({ name: "get_item", kriyaName: "mcp_tracker_get_item" })
    expect(await pinTool(null, form(getItem))).toEqual({
      error: "No recorded-response test yet for: get_item.",
    })
    await setServerStatus(null, form({ id: "tracker", status: "suspended" }))
    expect(await pinTool(null, form(getItem))).toEqual({ message: "Pinned." })
    expect(await activate()).toEqual({
      error: "No recorded-response test yet for: get_item.",
    })
  })

  it("every listed app has a recorded fixture for each of its tools", async () => {
    const { RECORDED } =
      await vi.importActual<typeof import("@/lib/mcp/recorded")>("@/lib/mcp/recorded")
    for (const [id, tools] of Object.entries(RECORDED)) {
      const file = path.join(process.cwd(), "tests/fixtures/mcp/recorded", `${id}.json`)
      expect(fs.existsSync(file), `${id}.json`).toBe(true)
      const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >
      for (const tool of tools) expect(recorded, `${id}.${tool}`).toHaveProperty(tool)
    }
  })
})

describe("NT-OWN-03 the owner's data is counts and statuses", () => {
  it("never a token, an input or an output; a definition only where it drifted", async () => {
    await registerFixture(q, "tracker", [
      { name: "search_items", risk: "R0" },
      { name: "create_item", risk: "R3", verify: { tool: "get_item" } },
      { name: "drifting", risk: "R0" },
    ])
    await q(
      "update kriya.mcp_tools set status = 'drifted', drifted_hash = $1 where name = 'drifting'",
      ["c".repeat(64)]
    )
    await q(
      `insert into kriya.mcp_connections (id, user_id, server_id, access_token, refresh_token)
       values ('c1', $1, 'tracker', 'v2_deadbeef.x.y.z', 'v2_cafef00d.x.y.z')`,
      [owner]
    )
    await q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [owner]
    )
    await q("insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')", [
      owner,
    ])
    const [{ id }] = await rows<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [owner]
    )
    await q(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, status, input, output_summary)
       values ($1, $2, 1, 'c1', 'mcp_tracker_create_item', 'succeeded', '{"title":"private-input"}', 'private-output')`,
      [id, owner]
    )

    const [tracker] = await registry()
    expect(tracker).toMatchObject({ id: "tracker", connections: 1, calls: 1 })
    expect(
      tracker.tools.map((t) => [t.name, t.status, t.readBack, t.definition !== null])
    ).toEqual([
      ["create_item", "pinned", true, false],
      ["drifting", "drifted", false, true],
      ["search_items", "pinned", false, false],
    ])
    const text = JSON.stringify(await registry())
    for (const secret of [
      "deadbeef",
      "cafef00d",
      "accessToken",
      "private-input",
      "private-output",
    ])
      expect(text).not.toContain(secret)
  })
})
