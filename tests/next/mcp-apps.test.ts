import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { connectedUser } from "../connectors/fixtures"
import { asUser, createUser, type TestDb } from "../db/harness"
import { registerFixture } from "../fixtures/mcp/server"

// N6: what Account → Apps shows (queries/apps.ts) and what the person can do
// there (actions/apps.ts): which agents may use an app, disconnect, and that
// every one of these is the person's own and behind both switches.

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
const session = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.user }) }))

import { disableApp, disconnectApp, enableApp, setAppForAgent } from "@/actions/apps"
import { appChoices, appsForPerson } from "@/queries/apps"

let pg: TestDb
let alice: string
let bob: string
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
const resetSettings = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
const switches = (on: boolean) => {
  if (on) {
    process.env.KRIYA_NEXT_MCP = "on"
    process.env.KRIYA_NEXT_MCP_CONNECT = "on"
  } else {
    delete process.env.KRIYA_NEXT_MCP
    delete process.env.KRIYA_NEXT_MCP_CONNECT
  }
  resetSettings()
}

const connect = (user: string, server: string, extra = "") =>
  q(
    `insert into kriya.mcp_connections (id, user_id, server_id, access_token ${extra ? ", needs_reconnect" : ""})
     values ($1, $2, $3, 'v2_deadbeef.x.y.z' ${extra ? ", " + extra : ""})`,
    [`c-${user.slice(-4)}-${server}`, user, server]
  )
const enabled = async (user: string, server = "tracker") =>
  (
    (
      await asUser(pg, user, (tx) =>
        tx.query(
          "select agent_id from kriya.mcp_enablements where server_id = $1 order by agent_id nulls first",
          [server]
        )
      )
    ).rows as { agent_id: string | null }[]
  ).map((r) => r.agent_id)

beforeEach(async () => {
  switches(true)
  const world = await connectedUser([])
  pg = world.pg
  alice = world.userId
  bob = await createUser(pg)
  session.user = alice
  for (const [user, ids] of [
    [alice, ["a1", "a2", "a3"]],
    [bob, ["b1"]],
  ] as const)
    for (const id of ids)
      await asUser(pg, user, (tx) =>
        tx.query(
          "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, $3, 'r', 'g')",
          [id, user, `Agent ${id}`]
        )
      )
  // The registry: an app to connect to, one the owner paused, one that never
  // signs in, one nobody connected that is paused
  await registerFixture(q, "tracker", [
    { name: "search_items", risk: "R0" },
    { name: "create_item", risk: "R3" },
    { name: "pay_invoice", risk: "R0", category: "payments" },
  ])
  await registerFixture(q, "notes", [{ name: "search_items", risk: "R0" }])
  await registerFixture(q, "open", [{ name: "search_items", risk: "R0" }], {
    auth: "none",
  })
  await registerFixture(q, "idle", [{ name: "search_items", risk: "R0" }])
  await q(
    "update kriya.mcp_servers set status = 'suspended' where id in ('notes', 'idle')"
  )
  await connect(alice, "tracker")
  await connect(alice, "notes")
})
afterEach(() => switches(false))

describe("appsForPerson", () => {
  it("lists connectable apps and the person's paused ones, with tools in words", async () => {
    const { apps, agents } = await appsForPerson(alice)
    expect(apps.map((a) => a.id)).toEqual(["tracker", "notes"])
    expect(apps[0]).toMatchObject({
      id: "tracker",
      name: "Tracker",
      domain: "tracker.fixture.example",
      paused: false,
      connected: true,
      needsReconnect: false,
      enabled: [],
      // The payments tool never appears, even at R0
      reads: ["search items"],
      asks: ["create item"],
    })
    expect(apps[1]).toMatchObject({ id: "notes", paused: true, connected: true })
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2", "a3"])
  })

  it("another person sees the app unconnected and none of the first person's choices", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
        [alice]
      )
    )
    const { apps, agents } = await appsForPerson(bob)
    expect(apps.map((a) => [a.id, a.connected, a.enabled])).toEqual([
      ["tracker", false, []],
    ])
    expect(agents.map((a) => a.id)).toEqual(["b1"])
    expect((await appsForPerson(alice)).apps[0].enabled).toBe("all")
  })

  it("shows a sign-in that stopped working", async () => {
    await q(
      "update kriya.mcp_connections set needs_reconnect = true where server_id = 'tracker'"
    )
    expect((await appsForPerson(alice)).apps[0].needsReconnect).toBe(true)
  })

  it("never returns a definition, token or secret name", async () => {
    await q("update kriya.mcp_servers set secret_env = null")
    const text = JSON.stringify(await appsForPerson(alice))
    expect(text).not.toMatch(/inputSchema|definition|access_token|secret|v2_/)
  })
})

describe("appChoices (the agent dialog)", () => {
  it("only connected, working, unpaused apps; null with the switches off or none", async () => {
    expect((await appChoices(alice))?.map((a) => a.id)).toEqual(["tracker"])
    await q("update kriya.mcp_connections set needs_reconnect = true")
    expect(await appChoices(alice)).toBeNull()
    expect(await appChoices(bob)).toBeNull()
    switches(false)
    expect(await appChoices(alice)).toBeNull()
  })
})

describe("enableApp, disableApp, setAppForAgent", () => {
  it("all agents, or the ones named, replacing what was chosen before", async () => {
    expect(await enableApp("tracker", "all")).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual([null])
    expect(await enableApp("tracker", ["a1", "a3"])).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual(["a1", "a3"])
    expect(await disableApp("tracker", "a1")).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual(["a3"])
    expect(await disableApp("tracker")).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual([])
  })

  it("turning one agent off from 'all my agents' really turns it off", async () => {
    await enableApp("tracker", "all")
    expect(await disableApp("tracker", "a1")).toEqual({ ok: true })
    expect(await enabled(alice)).not.toContain(null)
    expect(await enabled(alice)).not.toContain("a1")
    expect((await enabled(alice)).length).toBeGreaterThan(0)
  })

  it("not another person's agent, not an app that isn't connected, not a paused one", async () => {
    expect(await enableApp("tracker", ["b1"])).toEqual({
      error: "Choose your own agents.",
    })
    expect(await enableApp("tracker", ["a1", "b1"])).toEqual({
      error: "Choose your own agents.",
    })
    expect(await enableApp("open", "all")).toEqual({ error: "Connect the app first." })
    expect(await enableApp("notes", "all")).toEqual({
      error: "That app is paused right now.",
    })
    expect(await enableApp("../x", "all")).toEqual({
      error: "That isn't an app Kriya knows.",
    })
    expect(await enableApp("tracker", [])).toEqual({
      error: "That isn't an app Kriya knows.",
    })
    expect(await enabled(alice)).toEqual([])
  })

  it("nothing happens with the switches off", async () => {
    switches(false)
    const off = { error: "Apps aren't switched on yet." }
    expect(await enableApp("tracker", "all")).toEqual(off)
    expect(await disableApp("tracker")).toEqual(off)
    expect(await setAppForAgent("tracker", "a1", true)).toEqual(off)
    expect(await enabled(alice)).toEqual([])
  })

  it("the agent dialog's checkbox: on for one agent, off even from 'all my agents'", async () => {
    expect(await setAppForAgent("tracker", "a2", true)).toEqual({ ok: true })
    expect(await setAppForAgent("tracker", "a2", true)).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual(["a2"])
    expect(await setAppForAgent("tracker", "a2", false)).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual([])
    await enableApp("tracker", "all")
    // Turning one off leaves the others on, by name
    expect(await setAppForAgent("tracker", "a2", false)).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual(["a1", "a3"])
    // Another person's agent, or an app not connected, is refused
    expect(await setAppForAgent("tracker", "b1", true)).toEqual({
      error: "Choose your own agent.",
    })
    expect(await enabled(alice)).toEqual(["a1", "a3"])
    expect(await setAppForAgent("open", "a1", true)).toEqual({
      error: "Connect the app first.",
    })
  })

  it("one person's choices never reach another's", async () => {
    await connect(bob, "tracker")
    await enableApp("tracker", "all")
    session.user = bob
    expect(await enabled(bob)).toEqual([])
    expect(await disableApp("tracker")).toEqual({ ok: true })
    expect(await enabled(alice)).toEqual([null])
  })
})

describe("disconnectApp", () => {
  it("forgets the sign-in and the agent choices", async () => {
    await enableApp("tracker", ["a1"])
    expect(await disconnectApp("tracker")).toEqual({ ok: true })
    expect(
      (await q("select 1 from kriya.mcp_connections where server_id = 'tracker'")).rows
    ).toEqual([])
    expect(await enabled(alice)).toEqual([])
    // The other app is still connected
    expect(
      (await q("select 1 from kriya.mcp_connections where server_id = 'notes'")).rows
    ).toHaveLength(1)
    expect(await disconnectApp("../x")).toEqual({
      error: "That isn't an app Kriya knows.",
    })
  })
})
