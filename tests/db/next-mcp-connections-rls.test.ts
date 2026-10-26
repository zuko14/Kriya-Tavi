import fs from "node:fs"
import path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// NT-DB-07 (20270101000300_mcp_connections.sql): the session sees that an
// app is connected and can disconnect it, never a token (not even the
// ciphertext), only the server writes, and kriya.connections is exactly
// what it was.

let pg: TestDb
let alice: string
let bob: string

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  for (const id of ["tracker", "notes"])
    await pg.query(
      `insert into kriya.mcp_servers (id, name, url, auth, client_id, status)
       values ($1, $1, 'https://' || $1 || '.example.com/mcp', 'oauth_public', 'kriya', 'active')`,
      [id]
    )
  // As the server writes them (privileged)
  await pg.query(
    `insert into kriya.mcp_connections (id, user_id, server_id, access_token, refresh_token, scopes, pin)
     values ('c-alice', $1, 'tracker', 'v2_aaaaaaaa.iv.tag.body', 'v2_aaaaaaaa.iv.tag.body2', '{read}',
             '{"issuer":"https://auth.example.com"}'),
            ('c-bob', $2, 'tracker', 'v2_aaaaaaaa.iv.tag.bob', null, '{}', '{}')`,
    [alice, bob]
  )
})

describe("mcp_connections", () => {
  it("the session reads the non-token columns of its own rows only", async () => {
    const own = await asUser(pg, alice, (tx) =>
      tx.query(
        "select id, server_id, scopes, needs_reconnect, expires_at from kriya.mcp_connections"
      )
    )
    expect(own.rows).toEqual([
      {
        id: "c-alice",
        server_id: "tracker",
        scopes: ["read"],
        needs_reconnect: false,
        expires_at: null,
      },
    ])
  })

  it("no token, ciphertext or pin can be selected, however it's asked", async () => {
    for (const sql of [
      "select access_token from kriya.mcp_connections",
      "select refresh_token from kriya.mcp_connections",
      "select pin from kriya.mcp_connections",
      "select * from kriya.mcp_connections",
      "select count(*) from kriya.mcp_connections where access_token like 'v2_%'",
    ])
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow(
        /permission denied/
      )
  })

  it("only the server writes: insert and update are refused", async () => {
    for (const sql of [
      `insert into kriya.mcp_connections (id, user_id, server_id, access_token)
       values ('c-new', '${alice}', 'notes', 'x')`,
      "update kriya.mcp_connections set needs_reconnect = true",
      "update kriya.mcp_connections set account = 'me'",
    ])
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow()
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.mcp_connections"
    )
    expect(rows[0].n).toBe(2)
  })

  it("a person removes their own connection and no one else's", async () => {
    await asUser(pg, bob, (tx) => tx.query("delete from kriya.mcp_connections"))
    const left = await pg.query<{ id: string }>(
      "select id from kriya.mcp_connections order by id"
    )
    expect(left.rows).toEqual([{ id: "c-alice" }])
    await asUser(pg, alice, (tx) => tx.query("delete from kriya.mcp_connections"))
    expect((await pg.query("select 1 from kriya.mcp_connections")).rows).toEqual([])
  })

  it("one connection per person per app, and only to an app in the registry", async () => {
    await pg.query(
      "insert into kriya.mcp_connections (id, user_id, server_id, access_token) values ('c1', $1, 'notes', 'x')",
      [alice]
    )
    await expect(
      pg.query(
        "insert into kriya.mcp_connections (id, user_id, server_id, access_token) values ('c2', $1, 'notes', 'y')",
        [alice]
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        "insert into kriya.mcp_connections (id, user_id, server_id, access_token) values ('c3', $1, 'nowhere', 'y')",
        [alice]
      )
    ).rejects.toThrow()
    // Retiring the app (deleting its registry row) takes the sign-ins with it
    await pg.query("delete from kriya.mcp_servers where id = 'notes'")
    expect((await pg.query("select 1 from kriya.mcp_connections")).rows).toEqual([])
  })
})

describe("kriya.connections is unchanged (ND-09)", () => {
  it("the migration never names it", () => {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase",
        "migrations",
        "20270101000300_mcp_connections.sql"
      ),
      "utf8"
    )
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/kriya\.connections\b/)
  })

  it("keeps its provider check, its grants and its policies", async () => {
    const { rows: check } = await pg.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'kriya.connections'::regclass and conname = 'connections_provider_check'`
    )
    expect(check[0].def).not.toMatch(/mcp/)
    const { rows: grants } = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where table_schema = 'kriya' and table_name = 'connections' and grantee = 'authenticated'
         and privilege_type = 'SELECT' order by column_name`
    )
    expect(grants.map((g) => g.column_name)).not.toContain("access_token")
    expect(grants.map((g) => g.column_name)).not.toContain("refresh_token")
    const { rows: policies } = await pg.query<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'kriya' and tablename = 'connections' order by 1"
    )
    expect(policies.map((p) => p.policyname)).toEqual(["delete_own", "read_own"])
  })
})
