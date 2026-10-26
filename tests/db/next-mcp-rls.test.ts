import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270101000000_next_platform.sql: the owner's MCP registry is read-only
// to people (active servers' public columns), a person's app choices are
// their own, unauthenticated servers hold nothing above R1, and tool
// status follows its transitions (DATA_MODEL §6).

let pg: TestDb
let alice: string
let bob: string

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

const server = (id: string, status: string, auth = "oauth_public") =>
  pg.query(
    `insert into kriya.mcp_servers (id, name, url, auth, client_id, status, review, allowed_auth_origins)
     values ($1, $1, 'https://' || $1 || '.example.com/mcp', $2, 'kriya-client', $3, 'reviewed', '{https://auth.example.com}')`,
    [id, auth, status]
  )

const tool = (serverId: string, name: string, risk: string, extra = "") =>
  pg.query(
    `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk${extra ? ", idempotent" : ""})
     values ($1, $2, 'mcp_' || $1 || '_' || $2, '{"name":"x"}', $3, 'Does a thing', $4${extra ? `, ${extra}` : ""})`,
    [serverId, name, HASH_A, risk]
  )

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await server("tracker", "active")
  await server("drafty", "draft")
  await tool("tracker", "create_item", "R2")
  await tool("tracker", "get_item", "R0", "true")
  await tool("drafty", "list_items", "R0")
  for (const [user, agent] of [
    [alice, "a1"],
    [bob, "b1"],
  ]) {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
        [agent, user]
      )
    )
  }
})

describe("NT-DB-01 registry", () => {
  it("a person reads active servers' public columns only", async () => {
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query("select id, name, url, scopes, status from kriya.mcp_servers")
    )
    expect(rows).toEqual([
      {
        id: "tracker",
        name: "tracker",
        url: "https://tracker.example.com/mcp",
        scopes: [],
        status: "active",
      },
    ])
    for (const column of [
      "review",
      "client_id",
      "secret_env",
      "allowed_auth_origins",
      "auth",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(`select ${column} from kriya.mcp_servers`))
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("a person reads active servers' tools without their definitions", async () => {
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query(
        "select server_id, kriya_name, description, owner_risk, status from kriya.mcp_tools order by kriya_name"
      )
    )
    expect(rows.map((r) => (r as { kriya_name: string }).kriya_name)).toEqual([
      "mcp_tracker_create_item",
      "mcp_tracker_get_item",
    ])
    for (const column of ["definition", "definition_hash", "verify", "drifted_hash"]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(`select ${column} from kriya.mcp_tools`))
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("a person can't insert, update or delete servers or tools", async () => {
    for (const sql of [
      `insert into kriya.mcp_servers (id, name, url, auth) values ('evil', 'E', 'https://e.example.com', 'none')`,
      "update kriya.mcp_servers set url = 'https://evil.example.com'",
      "delete from kriya.mcp_servers",
      `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description)
       values ('tracker', 'x', 'mcp_tracker_xx', '{}', '${HASH_A}', 'x')`,
      "update kriya.mcp_tools set owner_risk = 'R0'",
      "delete from kriya.mcp_tools",
    ]) {
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow()
    }
    const { rows } = await pg.query<{ n: number }>(
      "select (select count(*) from kriya.mcp_servers)::int + (select count(*) from kriya.mcp_tools)::int as n"
    )
    expect(rows[0].n).toBe(5)
  })

  it("a secret is only ever an environment variable name", async () => {
    await expect(
      pg.query(
        `insert into kriya.mcp_servers (id, name, url, auth, client_id, secret_env)
         values ('conf', 'C', 'https://c.example.com', 'oauth_confidential', 'c', 'sk-live-123')`
      )
    ).rejects.toThrow()
    await pg.query(
      `insert into kriya.mcp_servers (id, name, url, auth, client_id, secret_env)
       values ('conf', 'C', 'https://c.example.com', 'oauth_confidential', 'c', 'KRIYA_MCP_CONF')`
    )
    // Confidential needs the name; others never have one
    await expect(
      pg.query(
        `insert into kriya.mcp_servers (id, name, url, auth, client_id)
         values ('conf2', 'C', 'https://c.example.com', 'oauth_confidential', 'c')`
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.mcp_servers (id, name, url, auth, secret_env)
         values ('open', 'O', 'https://o.example.com', 'none', 'KRIYA_MCP_OPEN')`
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.mcp_servers (id, name, url, auth) values ('plain', 'P', 'http://p.example.com', 'none')`
      )
    ).rejects.toThrow()
  })
})

describe("NT-DB-02 enablements", () => {
  it("a person turns an active server on for all agents or one of their own", async () => {
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
        [alice]
      )
      await tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id, agent_id) values ($1, 'tracker', 'a1')",
        [alice]
      )
    })
    // Once per server, and once per agent
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
          [alice]
        )
      )
    ).rejects.toThrow()
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query("select agent_id from kriya.mcp_enablements order by agent_id nulls first")
    )
    expect(rows).toEqual([{ agent_id: null }, { agent_id: "a1" }])
  })

  it("can't enable for another person, another person's agent or a server not active", async () => {
    for (const [sql, params] of [
      [
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
        [bob],
      ],
      [
        "insert into kriya.mcp_enablements (user_id, server_id, agent_id) values ($1, 'tracker', 'b1')",
        [alice],
      ],
      [
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'drafty')",
        [alice],
      ],
    ] as const) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql, [...params]))
      ).rejects.toThrow()
    }
  })

  it("another person sees, changes and removes nothing; the owner removes their own", async () => {
    const seen = await asUser(pg, bob, (tx) =>
      tx.query("select 1 from kriya.mcp_enablements")
    )
    expect(seen.rows).toEqual([])
    await asUser(pg, bob, (tx) => tx.query("delete from kriya.mcp_enablements"))
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.mcp_enablements set agent_id = null")
      )
    ).rejects.toThrow(/permission denied/)
    const count = async () =>
      (
        await pg.query<{ n: number }>(
          "select count(*)::int as n from kriya.mcp_enablements"
        )
      ).rows[0].n
    expect(await count()).toBe(2)
    await asUser(pg, alice, (tx) =>
      tx.query("delete from kriya.mcp_enablements where agent_id = 'a1'")
    )
    expect(await count()).toBe(1)
  })
})

describe("NT-DB-04 unauthenticated servers and idempotent reads", () => {
  it("a server without sign-in holds only R0/R1 pinned tools", async () => {
    await server("public", "active", "none")
    await tool("public", "search", "R1")
    await expect(tool("public", "post_item", "R2")).rejects.toThrow(/without sign-in/)
    // Raising a pinned tool's risk is refused the same way
    await expect(
      pg.query(
        "update kriya.mcp_tools set owner_risk = 'R3' where kriya_name = 'mcp_public_search'"
      )
    ).rejects.toThrow(/without sign-in/)
    // So is dropping sign-in from a server that holds a write tool
    await expect(
      pg.query(
        "update kriya.mcp_servers set auth = 'none', client_id = null where id = 'tracker'"
      )
    ).rejects.toThrow(/without sign-in/)
  })

  it("only an R0 tool can be marked idempotent", async () => {
    await expect(tool("tracker", "edit_item", "R2", "true")).rejects.toThrow()
  })
})

describe("NT-DB-05 transitions", () => {
  it("servers and tools move only along their transitions", async () => {
    await expect(
      pg.query("update kriya.mcp_servers set status = 'draft' where id = 'tracker'")
    ).rejects.toThrow(/can't go from active to draft/)
    await pg.query("update kriya.mcp_servers set status = 'retired' where id = 'drafty'")
    await expect(
      pg.query("update kriya.mcp_servers set status = 'active' where id = 'drafty'")
    ).rejects.toThrow(/can't go from retired to active/)
  })

  it("drift needs the hash the worker saw, and re-pinning must pin it", async () => {
    const where = "where kriya_name = 'mcp_tracker_create_item'"
    await expect(
      pg.query(`update kriya.mcp_tools set status = 'drifted' ${where}`)
    ).rejects.toThrow()
    await pg.query(
      `update kriya.mcp_tools set status = 'drifted', drifted_hash = $1 ${where}`,
      [HASH_B]
    )
    // Approving again without the new definition keeps nothing old
    await expect(
      pg.query(`update kriya.mcp_tools set status = 'pinned' ${where}`)
    ).rejects.toThrow(/pin the new definition/)
    // Nor does a detour through disabled
    await pg.query(`update kriya.mcp_tools set status = 'disabled' ${where}`)
    await expect(
      pg.query(`update kriya.mcp_tools set status = 'pinned' ${where}`)
    ).rejects.toThrow(/pin the new definition/)
    await pg.query(
      `update kriya.mcp_tools set status = 'pinned', definition_hash = $1, definition = '{"name":"y"}' ${where}`,
      [HASH_B]
    )
    const { rows } = await pg.query(
      `select status, definition_hash, drifted_hash from kriya.mcp_tools ${where}`
    )
    expect(rows).toEqual([
      { status: "pinned", definition_hash: HASH_B, drifted_hash: null },
    ])
  })
})

describe("NT-DB-06 tool names", () => {
  it("a Kriya name starts with mcp_<server>_ and is unique across servers", async () => {
    await expect(
      pg.query(
        `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk)
         values ('tracker', 'sneaky', 'mcp_public_sneaky', '{}', $1, 'x', 'R0')`,
        [HASH_A]
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk)
         values ('tracker', 'get_item2', 'mcp_tracker_get_item', '{}', $1, 'x', 'R0')`,
        [HASH_A]
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk)
         values ('tracker', 'Upper', 'mcp_tracker_Upper', '{}', $1, 'x', 'R0')`,
        [HASH_A]
      )
    ).rejects.toThrow()
  })
})
