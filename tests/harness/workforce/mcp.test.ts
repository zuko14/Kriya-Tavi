import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W16, MCP P3a (upgrade_2.0/GROUNDING_AND_CONNECTORS.md §4): the
// registry servers a device may use. WT-MCP-01 (delivery and token isolation)
// and the shared hash vector the client pins (WT-MCP-02's other half).

vi.mock("server-only", () => ({}))

import * as mcp from "@/app/api/harness/v1/mcp/route"
import { McpServersResponse } from "@/lib/harness/contract"
import { definitionHash } from "@/lib/mcp/tools"

import type { TestDb } from "../../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../setup"

let pg: TestDb
let newUser: () => Promise<string>

const SEARCH = {
  name: "search",
  description: "Find docs",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  annotations: { readOnlyHint: true },
  extra: "ignored",
}

const server = (id: string, auth: string, status = "active") =>
  pg.query(
    `insert into kriya.mcp_servers (id, name, url, auth, client_id, secret_env, status)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      `Server ${id}`,
      `https://${id}.example.com/mcp`,
      auth,
      auth === "none" || auth === "oauth_cimd" ? null : "client-abc",
      auth === "oauth_confidential" ? "KRIYA_MCP_SECRET" : null,
      status,
    ]
  )
const tool = (
  serverId: string,
  name: string,
  def: Record<string, unknown>,
  ownerRisk = "R0",
  category: string | null = null
) =>
  pg.query(
    `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk, category)
     values ($1, $2, $3, $4, $5, 'A tool', $6, $7)`,
    [
      serverId,
      name,
      `mcp_${serverId}_${name}`,
      JSON.stringify(def),
      definitionHash(def),
      ownerRisk,
      category,
    ]
  )

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(async () => {
  harnessEnv({ KRIYA_HARNESS_MCP: "on", KRIYA_NEXT_MCP: "on" })
  await pg.exec(
    "delete from kriya.mcp_enablements; delete from kriya.mcp_tools; delete from kriya.mcp_servers"
  )
})

describe("WT-MCP-01: registry servers reach a device only when they need no sign-in, without any secret", () => {
  it("delivers the person's enabled, active, no-auth servers with pinned hashes and classes; R5 never", async () => {
    const user = await newUser()
    const { token } = await deviceFor(pg, user)
    await server("docs", "none")
    await server("oauth", "oauth_public")
    await server("secret", "oauth_confidential")
    await server("draft", "none", "draft")
    await server("other", "none")
    await tool("docs", "search", SEARCH)
    await tool(
      "docs",
      "create_note",
      { name: "create_note", description: "Create", inputSchema: { type: "object" } },
      // A no-sign-in server holds only R0/R1 tools (the registry's own rule); no read-only hint raises it to R3
      "R1"
    )
    await tool(
      "docs",
      "pay",
      { name: "pay", inputSchema: { type: "object" } },
      "R1",
      "payments"
    )
    await tool("oauth", "read", { name: "read", annotations: { readOnlyHint: true } })
    await tool("secret", "read", { name: "read", annotations: { readOnlyHint: true } })
    await tool("draft", "read", { name: "read", annotations: { readOnlyHint: true } })
    await tool("other", "read", { name: "read", annotations: { readOnlyHint: true } })
    for (const id of ["docs", "oauth", "secret", "draft"])
      await pg.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, $2)",
        [user, id]
      )
    const res = await mcp.GET(call("GET", "/mcp", { token }))
    expect(res.status).toBe(200)
    const body = McpServersResponse.parse(await res.json())
    expect(body.servers).toEqual([
      {
        id: "docs",
        name: "Server docs",
        url: "https://docs.example.com/mcp",
        tools: [
          {
            name: "create_note",
            definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            risk: "R3",
            readOnly: false,
          },
          {
            name: "search",
            definitionHash: definitionHash(SEARCH),
            risk: "R0",
            readOnly: true,
          },
        ],
      },
    ])
    expect(JSON.stringify(body)).not.toMatch(
      /client-abc|KRIYA_MCP_SECRET|clientId|secretEnv|scopes|token/i
    )
  })

  it("is 404 unless harness.mcp and next.mcp are both on, and needs a device", async () => {
    const user = await newUser()
    const { token } = await deviceFor(pg, user)
    harnessEnv({ KRIYA_HARNESS_MCP: "off", KRIYA_NEXT_MCP: "on" })
    expect((await mcp.GET(call("GET", "/mcp", { token }))).status).toBe(404)
    harnessEnv({ KRIYA_HARNESS_MCP: "on", KRIYA_NEXT_MCP: "off" })
    expect((await mcp.GET(call("GET", "/mcp", { token }))).status).toBe(404)
    harnessEnv({ KRIYA_HARNESS_MCP: "on", KRIYA_NEXT_MCP: "on" })
    expect((await mcp.GET(call("GET", "/mcp"))).status).toBe(401)
    expect(await (await mcp.GET(call("GET", "/mcp", { token }))).json()).toEqual({
      servers: [],
    })
  })

  it("WT-MCP-02 (server half): the hash vector the client pins", () => {
    expect(definitionHash(SEARCH)).toBe(
      "289809516b428c75b0d797af399488f47005c17d99b17e636e2131fac3ac9b49"
    )
  })
})
