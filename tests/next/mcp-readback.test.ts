import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { readBack, verifySpecSchema } from "@/lib/mcp/verify"
import { reset as resetBreaker } from "@/lib/reliability/breaker"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import {
  fixtureFetch,
  fixtureHosts,
  registerFixture,
  startMcpFixture,
} from "../fixtures/mcp/server"

// N7 (ND-12, MCP_CONNECTIVITY §7), NT-MCP-05: an owner-written read-back.
// The pure mapping first, then through loadMcp against the fixture app: the
// side effect is read back by a pinned R0 tool of the same app, and only then.

vi.mock("@/lib/mcp/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/fetch")>()),
  guardedFetch: (server: { url: string }) => fixtureFetch(server),
}))

import { loadMcp } from "@/lib/mcp/registry"

const SPEC = {
  tool: "get_item",
  args: { id: "/structuredContent/id" },
  expect: { "/structuredContent/title": "/input/title" },
}
const FIRST: { input: unknown; structuredContent?: unknown } = {
  input: { title: "Hello" },
  structuredContent: { id: "item-1", title: "Hello" },
}

describe("verifySpecSchema", () => {
  it("takes the documented shape and nothing wider", () => {
    expect(verifySpecSchema.safeParse(SPEC).success).toBe(true)
    for (const bad of [
      { ...SPEC, extra: 1 },
      { ...SPEC, args: {} },
      { ...SPEC, args: { id: "/somewhere/else" } },
      { ...SPEC, args: { id: "/input/a~1b" } },
      { ...SPEC, expect: { "/input/title": "/input/title" } },
      { ...SPEC, expect: { "/structuredContent/title": "title" } },
      { ...SPEC, tool: "" },
    ])
      expect(verifySpecSchema.safeParse(bad).success).toBe(false)
  })
})

describe("readBack", () => {
  const reading = (structuredContent?: unknown, isError = false) => ({
    calls: [] as unknown[],
    read: async function (this: { calls: unknown[] }, args: Record<string, unknown>) {
      this.calls.push(args)
      return { structuredContent, isError }
    },
  })
  const run = (r: ReturnType<typeof reading>, first = FIRST) =>
    readBack(SPEC, first, (args) => r.read.call(r, args))

  it("match → verified, with the id it looked up", async () => {
    const r = reading({ id: "item-1", title: "Hello" })
    expect(await run(r)).toEqual({
      status: "verified",
      method: "api_readback",
      evidence: [{ kind: "provider_id", value: "item-1" }],
      note: "Checked: the app shows what was sent.",
    })
    expect(r.calls).toEqual([{ id: "item-1" }])
  })

  it("a different value → failed", async () => {
    const out = await run(reading({ id: "item-1", title: "Other" }))
    expect(out.status).toBe("failed")
    expect(out.evidence).toEqual([{ kind: "provider_id", value: "item-1" }])
  })

  it("can't read, or the answer lacks the field → unverified, never failed", async () => {
    const boom = await readBack(SPEC, FIRST, async () => {
      throw new Error("down")
    })
    expect(boom.status).toBe("unverified")
    expect((await run(reading(undefined, true))).status).toBe("unverified")
    expect((await run(reading({ id: "item-1" }))).status).toBe("unverified")
    // The first result named no id: nothing to look up, and no read happens
    const r = reading({ id: "x", title: "Hello" })
    const none = await run(r, { input: { title: "Hello" }, structuredContent: undefined })
    expect(none.status).toBe("unverified")
    expect(r.calls).toEqual([])
  })

  it("compares numbers, objects and key order exactly", async () => {
    const spec = {
      tool: "get",
      args: { id: "/structuredContent/id" },
      expect: { "/structuredContent/n": "/input/n", "/structuredContent/o": "/input/o" },
    }
    const first = { input: { n: 3, o: { a: 1, b: 2 } }, structuredContent: { id: 7 } }
    const ok = await readBack(spec, first, async () => ({
      structuredContent: { n: 3, o: { b: 2, a: 1 } },
    }))
    expect(ok.status).toBe("verified")
    expect(ok.evidence).toEqual([{ kind: "provider_id", value: "7" }])
    const off = await readBack(spec, first, async () => ({
      structuredContent: { n: "3", o: { a: 1, b: 2 } },
    }))
    expect(off.status).toBe("failed")
  })

  it("a pointer can't reach into prototypes", async () => {
    const out = await readBack(
      { ...SPEC, args: { id: "/input/__proto__" } },
      FIRST,
      async () => ({ structuredContent: {} })
    )
    expect(out.status).toBe("unverified")
  })
})

let pg: TestDb
let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let user: string
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)
const task = () => ({ id: "00000000-0000-0000-0000-000000000001", userId: user })
const open = { maxTools: 20, disabled: new Set<string>(), authFor: () => undefined }
const exec = (tool: { execute?: unknown }, input: unknown) =>
  (tool.execute as (i: unknown, o: unknown) => Promise<{ verification?: unknown }>)(
    input,
    { toolCallId: "c1", messages: [], context: {} }
  )

const pins = (verify: object | null = SPEC, reader = "R0") => [
  { name: "get_item", risk: reader },
  { name: "create_item", risk: "R3", verify: verify ?? undefined },
]

// Registers the app fresh and turns it on for the person (RLS wants it active first)
const app = async (list: ReturnType<typeof pins>) => {
  await q("delete from kriya.mcp_servers where id = 'tracker'")
  await registerFixture(q, "tracker", list)
  await asUser(pg, user, (tx) =>
    tx.query(
      "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
      [user]
    )
  )
}

describe("a read-back through the runner", () => {
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
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
        [user]
      )
    )
    fixture.state.items.clear()
    fixture.state.read = "ok"
    fixture.state.calls.length = 0
    resetBreaker()
  })

  it("NT-MCP-05: verified, failed, unverified", async () => {
    await app(pins())
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      const create = mcp.tools.mcp_tracker_create_item
      const done = await exec(create, { title: "Hello" })
      expect(done.verification).toMatchObject({
        status: "verified",
        method: "api_readback",
      })
      expect(fixture.state.calls.map((c) => c.name)).toEqual(["create_item", "get_item"])

      fixture.state.read = "different"
      expect((await exec(create, { title: "Hello" })).verification).toMatchObject({
        status: "failed",
      })
      fixture.state.read = "error"
      expect((await exec(create, { title: "Hello" })).verification).toMatchObject({
        status: "unverified",
      })
    } finally {
      await mcp.close()
    }
  })

  it('no spec → no verification (it stays "ran, but wasn\'t checked")', async () => {
    await app(pins(null))
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      const done = await exec(mcp.tools.mcp_tracker_create_item, { title: "Hello" })
      expect(done).not.toHaveProperty("verification")
      expect(fixture.state.calls.map((c) => c.name)).toEqual(["create_item"])
    } finally {
      await mcp.close()
    }
  })

  it("the reader must be pinned, unchanged, switched on and a read by its own hints", async () => {
    // Not pinned at all
    await app([{ name: "create_item", risk: "R3", verify: SPEC }])
    let mcp = (await loadMcp(task(), "a1", open))!
    try {
      expect(
        await exec(mcp.tools.mcp_tracker_create_item, { title: "x" })
      ).not.toHaveProperty("verification")
    } finally {
      await mcp.close()
    }
    // Pinned as a write (R3): not a read
    await app(pins(SPEC, "R3"))
    mcp = (await loadMcp(task(), "a1", open))!
    try {
      expect(
        await exec(mcp.tools.mcp_tracker_create_item, { title: "x" })
      ).not.toHaveProperty("verification")
    } finally {
      await mcp.close()
    }
    // Switched off by the kill list
    await app(pins())
    mcp = (await loadMcp(task(), "a1", {
      ...open,
      disabled: new Set(["mcp_tracker_get_item"]),
    }))!
    try {
      expect(
        await exec(mcp.tools.mcp_tracker_create_item, { title: "x" })
      ).not.toHaveProperty("verification")
    } finally {
      await mcp.close()
    }
    // The reader's definition changed since it was pinned
    await app(pins())
    await q("update kriya.mcp_tools set definition_hash = $1 where name = 'get_item'", [
      "0".repeat(64),
    ])
    mcp = (await loadMcp(task(), "a1", open))!
    try {
      expect(
        await exec(mcp.tools.mcp_tracker_create_item, { title: "x" })
      ).not.toHaveProperty("verification")
    } finally {
      await mcp.close()
    }
  })

  it("a spec the database holds but the schema refuses is ignored", async () => {
    await app(pins({ tool: "get_item", args: {}, expect: {} }))
    const mcp = (await loadMcp(task(), "a1", open))!
    try {
      expect(
        await exec(mcp.tools.mcp_tracker_create_item, { title: "x" })
      ).not.toHaveProperty("verification")
    } finally {
      await mcp.close()
    }
  })
})
