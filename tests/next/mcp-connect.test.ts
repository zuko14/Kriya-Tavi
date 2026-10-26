import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { NextRequest } from "next/server"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { CONNECTION_PROVIDERS } from "@/db/schema"

import { connectedUser } from "../connectors/fixtures"
import { asUser, type TestDb } from "../db/harness"
import { fixtureHosts, registerFixture, startMcpFixture } from "../fixtures/mcp/server"

// N6 (ND-09, MCP_CONNECTIVITY §3): connecting to an app. The real start and
// callback routes, the SDK's OAuth flow and the sealed storage, against a
// fixture app that is its own authorization server. Nothing leaves the
// machine; the guarded fetch is swapped for one that sends each registry host
// to its local fixture.

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
const session = vi.hoisted(() => ({ user: null as string | null }))
vi.mock("@/lib/auth", () => ({
  authenticate: async () => (session.user ? { id: session.user } : null),
  appUrl: () => "https://kriya.test",
}))
vi.mock("@/lib/mcp/fetch", async (original) => {
  const { fixtureFetch } = await import("../fixtures/mcp/server")
  return {
    ...(await original<typeof import("@/lib/mcp/fetch")>()),
    guardedFetch: (server: { url: string }) => fixtureFetch(server),
  }
})
const logged = vi.hoisted(() => [] as string[])
vi.mock("@/lib/log", () => {
  const record = (level: string) => (message: string, data?: unknown) =>
    void logged.push(
      `${level} ${message} ${JSON.stringify(data ?? {}, (_k, v) => (v instanceof Error ? v.message : v))}`
    )
  return {
    log: {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
  }
})

import { GET as callback } from "@/app/api/connect/mcp/[serverId]/callback/route"
import { GET as start } from "@/app/api/connect/mcp/[serverId]/route"
import { GET as existingStart } from "@/app/api/connect/[provider]/route"
import {
  MCP_FLOW_COOKIE,
  mcpConnectFinish,
  mcpConnectStart,
  mcpDisconnect,
} from "@/lib/connectors"
import { loadMcp } from "@/lib/mcp/registry"

const ORIGIN = "https://tracker.fixture.example"
const REDIRECT = "https://kriya.test/api/connect/mcp/tracker/callback"
const PINS = [
  { name: "search_items", risk: "R0" },
  { name: "create_item", risk: "R3" },
]

let pg: TestDb
let alice: string
let fixture: Awaited<ReturnType<typeof startMcpFixture>>
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
const params = (id: string) => ({ params: Promise.resolve({ serverId: id }) })
const resetSettings = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)

beforeAll(async () => {
  fixture = await startMcpFixture({ oauth: { origin: ORIGIN } })
  fixtureHosts.set("tracker.fixture.example", fixture.url)
})
afterAll(() => fixture.close())

beforeEach(async () => {
  process.env.KRIYA_NEXT_MCP = "on"
  process.env.KRIYA_NEXT_MCP_CONNECT = "on"
  resetSettings()
  const world = await connectedUser([])
  pg = world.pg
  alice = world.userId
  session.user = alice
  logged.length = 0
  fixture.state.log.length = 0
  fixture.state.oauth.valid.clear()
  fixture.state.oauth.issued = 0
  fixture.state.oauth.refreshFails = false
  fixture.state.oauth.revokeStatus = 200
  fixture.state.oauth.tokenRequests.length = 0
  fixture.state.oauth.revoked.length = 0
  fixture.state.calls.length = 0
  await registerFixture(q, "tracker", PINS)
})
afterEach(() => {
  delete process.env.KRIYA_NEXT_MCP
  delete process.env.KRIYA_NEXT_MCP_CONNECT
  resetSettings()
})

const rows = async () =>
  (await q("select * from kriya.mcp_connections")).rows as {
    server_id: string
    access_token: string
    refresh_token: string | null
    scopes: string[]
    pin: Record<string, string>
    needs_reconnect: boolean
  }[]

// The person goes through both routes; `tweak` changes what the callback sees
async function connect(
  tweak: (url: URL, state: { cookie: string }) => void = () => {},
  id = "tracker"
) {
  const out = await start(
    new NextRequest(`https://kriya.test/api/connect/mcp/${id}`),
    params(id)
  )
  const authorize = new URL(out.headers.get("location")!)
  const cookie = out.cookies.get(MCP_FLOW_COOKIE)?.value ?? ""
  const back = new URL(`https://kriya.test/api/connect/mcp/${id}/callback`)
  back.searchParams.set("code", "code-ok")
  back.searchParams.set("state", authorize.searchParams.get("state") ?? "")
  back.searchParams.set("iss", `https://${id}.fixture.example`)
  const bag = { cookie }
  tweak(back, bag)
  const res = await callback(
    new NextRequest(back, { headers: { cookie: `${MCP_FLOW_COOKIE}=${bag.cookie}` } }),
    params(id)
  )
  return { out, authorize, cookie, res }
}

describe("NT-CON-01 the connect flow", () => {
  it("sends the person to the app's own sign-in with PKCE, then seals the tokens", async () => {
    const { out, authorize, cookie, res } = await connect()
    // Out: the app's authorization server, the S256 challenge, a state, our callback
    expect(out.status).toBe(307)
    expect(authorize.origin).toBe(ORIGIN)
    expect(authorize.pathname).toBe("/authorize")
    expect(authorize.searchParams.get("client_id")).toBe("kriya-fixture")
    expect(authorize.searchParams.get("response_type")).toBe("code")
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT)
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    // The verifier travels sealed, HttpOnly, for ten minutes, on its own path
    const set = out.cookies.get(MCP_FLOW_COOKIE)!
    expect(set).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/api/connect/mcp",
      maxAge: 600,
    })
    expect(cookie).toMatch(/^v2_/)

    // Back: stored, and only as ciphertext
    expect(res.headers.get("location")).toBe(
      "https://kriya.test/account?connected_app=tracker#apps"
    )
    const [row] = await rows()
    expect(row).toMatchObject({
      server_id: "tracker",
      scopes: ["read", "write"],
      needs_reconnect: false,
    })
    expect(row.access_token).toMatch(/^v2_/)
    expect(JSON.stringify(row)).not.toMatch(/at-1|rt-1/)
    expect(row.refresh_token).toMatch(/^v2_/)
    // The authorization server is pinned so a refresh can't be redirected elsewhere
    expect(row.pin).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/token` })
    // The exchange proved the verifier: S256(verifier) is the challenge
    const exchange = fixture.state.oauth.tokenRequests[0]
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      code: "code-ok",
      client_id: "kriya-fixture",
    })
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge")
    )
    expect(exchange.redirect_uri).toBe(REDIRECT)
  })

  it("the callback clears the cookie, and a second try without it stores nothing new", async () => {
    const { res } = await connect()
    expect(res.cookies.get(MCP_FLOW_COOKIE)?.value ?? "").toBe("")
    await q("delete from kriya.mcp_connections")
    const again = await callback(
      new NextRequest(
        `https://kriya.test/api/connect/mcp/tracker/callback?code=code-ok&state=x`
      ),
      params("tracker")
    )
    expect(again.headers.get("location")).toContain("app_error=expired")
    expect(await rows()).toEqual([])
  })

  it("only for a signed-in person and only with both switches on", async () => {
    session.user = null
    const anon = await start(
      new NextRequest("https://kriya.test/api/connect/mcp/tracker"),
      params("tracker")
    )
    expect(anon.headers.get("location")).toBe("https://kriya.test/login?next=/account")
    session.user = alice
    delete process.env.KRIYA_NEXT_MCP_CONNECT
    resetSettings()
    const off = await start(
      new NextRequest("https://kriya.test/api/connect/mcp/tracker"),
      params("tracker")
    )
    expect(off.headers.get("location")).toContain("app_error=unavailable")
    expect(fixture.state.log).toEqual([])
  })

  it("an app that isn't active, doesn't sign in, or isn't in the registry can't be connected", async () => {
    await q("update kriya.mcp_servers set status = 'suspended'")
    for (const id of ["tracker", "nowhere", "../x"]) {
      const res = await start(
        new NextRequest(`https://kriya.test/api/connect/mcp/${id}`),
        params(id)
      )
      expect(res.headers.get("location")).toMatch(/app_error=(unavailable|failed)/)
    }
    expect(fixture.state.log).toEqual([])
  })

  it("the person saying no stores nothing", async () => {
    const res = await callback(
      new NextRequest(
        "https://kriya.test/api/connect/mcp/tracker/callback?error=access_denied"
      ),
      params("tracker")
    )
    expect(res.headers.get("location")).toContain("app_error=denied")
    expect(await rows()).toEqual([])
  })
})

describe("NT-CON-02 a wrong state, issuer or authorization server stores nothing", () => {
  it.each([
    [
      "state",
      (url: URL) => url.searchParams.set("state", "forged-state-value-0000000000"),
    ],
    ["issuer", (url: URL) => url.searchParams.set("iss", "https://evil.example")],
    [
      "cookie",
      (_url: URL, bag: { cookie: string }) =>
        (bag.cookie = bag.cookie.slice(0, -4) + "AAAA"),
    ],
    ["code", (url: URL) => url.searchParams.set("code", "stolen-code")],
  ])("a wrong %s", async (_label, tweak) => {
    const { res } = await connect(tweak)
    expect(res.headers.get("location")).toMatch(/app_error=(expired|failed)/)
    expect(await rows()).toEqual([])
  })

  it("another person's cookie can't finish this person's attempt", async () => {
    const { cookie } = await connect((url) => url.searchParams.set("code", "x"))
    await q("delete from kriya.mcp_connections")
    const bob = await (await import("../db/harness")).createUser(pg)
    await expect(
      mcpConnectFinish(bob, "tracker", {
        redirectUri: REDIRECT,
        cookie,
        code: "code-ok",
        state: "whatever",
      })
    ).rejects.toThrow(/expired/)
    expect(await rows()).toEqual([])
  })

  it("an authorization server the owner didn't list is never contacted", async () => {
    const rogue = await startMcpFixture({
      oauth: {
        origin: "https://rogue.fixture.example",
        authorizationServer: "https://evil.example",
      },
    })
    fixtureHosts.set("rogue.fixture.example", rogue.url)
    try {
      await registerFixture(q, "rogue", PINS)
      await expect(
        mcpConnectStart(alice, "rogue", {
          redirectUri: REDIRECT.replace("tracker", "rogue"),
        })
      ).rejects.toThrow(/somewhere Kriya doesn't allow/)
      // Only the app's own discovery document was read; nothing from evil.example
      expect(rogue.state.log.map((l) => l.path)).toEqual([
        "/.well-known/oauth-protected-resource/mcp",
      ])
      expect(await rows()).toEqual([])
    } finally {
      await rogue.close()
    }
  })
})

describe("NT-CON-03 a token goes only to its own app", () => {
  it("two apps: each sees only its own token, never Kriya's, never anything else's", async () => {
    const other = await startMcpFixture({
      oauth: { origin: "https://notes.fixture.example", prefix: "n" },
    })
    fixtureHosts.set("notes.fixture.example", other.url)
    try {
      await registerFixture(q, "notes", PINS)
      await connect()
      await connect(() => {}, "notes")
      expect((await rows()).map((r) => r.server_id).sort()).toEqual(["notes", "tracker"])
      // Use both through a task, as the worker would
      await asUser(pg, alice, async (tx) => {
        await tx.query(
          "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g') on conflict do nothing",
          [alice]
        )
        for (const id of ["tracker", "notes"])
          await tx.query(
            "insert into kriya.mcp_enablements (user_id, server_id) values ($1, $2)",
            [alice, id]
          )
      })
      const mcp = (await loadMcp(
        { id: "00000000-0000-0000-0000-000000000009", userId: alice },
        "a1",
        {
          maxTools: 20,
          disabled: new Set(),
        }
      ))!
      await mcp.close()
      expect(Object.keys(mcp.tools).sort()).toEqual([
        "mcp_notes_create_item",
        "mcp_notes_search_items",
        "mcp_tracker_create_item",
        "mcp_tracker_search_items",
      ])
      const seen = (log: typeof fixture.state.log) =>
        new Set(log.map((l) => l.authorization).filter(Boolean))
      for (const a of seen(fixture.state.log)) expect(a).toMatch(/^Bearer at-\d+$/)
      for (const a of seen(other.state.log)) expect(a).toMatch(/^Bearer n-at-\d+$/)
      // Nothing of Kriya's: no person, no key, no session in any request
      for (const l of [...fixture.state.log, ...other.state.log]) {
        expect(`${l.authorization} ${l.body}`).not.toContain(alice)
        expect(l.body).not.toMatch(/KRIYA|sb-|v2_/)
      }
    } finally {
      await other.close()
    }
  })
})

describe("NT-CON-04 the existing accounts are untouched", () => {
  it("still four providers, and /api/connect/google still answers from its own handler", async () => {
    expect([...CONNECTION_PROVIDERS]).toEqual(["google", "notion", "github", "meta"])
    // The static mcp folder sits beside [provider] (App Router: static wins)
    const root = path.join(process.cwd(), "app", "api", "connect")
    expect(fs.readdirSync(root).sort()).toEqual(["[provider]", "mcp"])
    // Signed in, with Google not set up on this server: the old handler's answer
    const res = await existingStart(
      new NextRequest("https://kriya.test/api/connect/google"),
      { params: Promise.resolve({ provider: "google" }) }
    )
    expect(res.headers.get("location")).toBe(
      "https://kriya.test/account?connect_error=unavailable#connections"
    )
    session.user = null
    const anon = await existingStart(
      new NextRequest("https://kriya.test/api/connect/google"),
      { params: Promise.resolve({ provider: "google" }) }
    )
    expect(anon.headers.get("location")).toBe("https://kriya.test/login?next=/account")
  })
})

describe("NT-CON-06 disconnect", () => {
  async function connected() {
    await connect()
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g') on conflict do nothing",
        [alice]
      )
      await tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker') on conflict do nothing",
        [alice]
      )
    })
  }
  const counts = async () => ({
    connections: (await q("select 1 from kriya.mcp_connections")).rows.length,
    enablements: (await q("select 1 from kriya.mcp_enablements")).rows.length,
  })

  it("revokes at the app, then deletes the sign-in and the agent choices", async () => {
    await connected()
    await mcpDisconnect(alice, "tracker")
    expect(fixture.state.oauth.revoked).toEqual(["rt-1"])
    expect(await counts()).toEqual({ connections: 0, enablements: 0 })
  })

  it("deletes them even when the revocation fails", async () => {
    await connected()
    fixture.state.oauth.revokeStatus = 500
    await mcpDisconnect(alice, "tracker")
    expect(await counts()).toEqual({ connections: 0, enablements: 0 })
    await connected()
    await mcpDisconnect(alice, "tracker", {
      fetch: async () => {
        throw new Error("socket hang up")
      },
    })
    expect(await counts()).toEqual({ connections: 0, enablements: 0 })
  })

  it("only this person's, and nothing to do when never connected", async () => {
    await connected()
    const bob = await (await import("../db/harness")).createUser(pg)
    await mcpDisconnect(bob, "tracker")
    expect((await counts()).connections).toBe(1)
    expect(fixture.state.oauth.revoked).toEqual([])
  })
})

describe("the worker uses what was connected", () => {
  const task = {
    id: "00000000-0000-0000-0000-000000000009",
    get userId() {
      return alice
    },
  }
  async function ready() {
    await connect()
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g') on conflict do nothing",
        [alice]
      )
      await tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker') on conflict do nothing",
        [alice]
      )
    })
    fixture.state.log.length = 0
  }
  const load = () => loadMcp(task, "a1", { maxTools: 20, disabled: new Set() })
  const run = (mcp: NonNullable<Awaited<ReturnType<typeof load>>>) =>
    (
      mcp.tools.mcp_tracker_search_items.execute as (
        i: unknown,
        o: unknown
      ) => Promise<unknown>
    )({ query: "x" }, { toolCallId: "c1", messages: [], context: {} })

  it("calls the app with the person's own token", async () => {
    await ready()
    const mcp = (await load())!
    expect(await run(mcp)).toMatchObject({ result: "Found 2 items for x." })
    await mcp.close()
    expect(new Set(fixture.state.log.map((l) => l.authorization))).toEqual(
      new Set(["Bearer at-1"])
    )
  })

  it("refreshes an expired token on its own and keeps the new one sealed", async () => {
    await ready()
    const before = (await rows())[0].access_token
    fixture.state.oauth.expire()
    const mcp = (await load())!
    expect(await run(mcp)).toMatchObject({ result: "Found 2 items for x." })
    await mcp.close()
    const refresh = fixture.state.oauth.tokenRequests.at(-1)!
    expect(refresh).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "kriya-fixture",
    })
    const [row] = await rows()
    expect(row.access_token).not.toBe(before)
    expect(row.access_token).toMatch(/^v2_/)
    expect(JSON.stringify(row)).not.toMatch(/at-2|rt-2/)
    expect(row.needs_reconnect).toBe(false)
  })

  it("a refresh that fails marks it needs-reconnect, stops calling the app, and reconnecting clears it", async () => {
    await ready()
    fixture.state.oauth.expire()
    fixture.state.oauth.refreshFails = true
    expect(await load()).toBeNull()
    expect((await rows())[0].needs_reconnect).toBe(true)
    // Not tried again until the person reconnects
    fixture.state.log.length = 0
    expect(await load()).toBeNull()
    expect(fixture.state.log).toEqual([])
    fixture.state.oauth.refreshFails = false
    await connect()
    expect((await rows())[0].needs_reconnect).toBe(false)
    const mcp = (await load())!
    expect(mcp.apps).toEqual(["Tracker"])
    await mcp.close()
  })
})

describe("NT-SEC-02 nothing sensitive in the logs", () => {
  it("through connect, refresh, failure and disconnect, no token, code, verifier or person appears", async () => {
    const { authorize } = await connect()
    await connect((url) => url.searchParams.set("iss", "https://evil.example"))
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g') on conflict do nothing",
        [alice]
      )
      await tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker') on conflict do nothing",
        [alice]
      )
    })
    fixture.state.oauth.expire()
    fixture.state.oauth.refreshFails = true
    await loadMcp({ id: "00000000-0000-0000-0000-000000000009", userId: alice }, "a1", {
      maxTools: 20,
      disabled: new Set(),
    })
    await mcpDisconnect(alice, "tracker")
    const text = logged.join("\n")
    expect(logged.length).toBeGreaterThan(0)
    for (const secret of [
      "at-1",
      "rt-1",
      "code-ok",
      authorize.searchParams.get("state")!,
      "v2_",
      alice,
    ])
      expect(text, secret).not.toContain(secret)
    for (const entry of logged)
      expect(entry).toMatch(/^(info|warn|error|debug) [a-z ]+ \{/)
  })
})
