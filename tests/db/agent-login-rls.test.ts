import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261106000000_login_profiles.sql (AT-RLS-A for login_profiles and kits,
// AT-SEC-01): each person sees only their own rows; no session can select
// sealed state or connection tokens; status and state are the server's; the
// plan limit and the browser minutes hold in SQL (invariant 7).

let pg: TestDb
let alice: string
let bob: string

const SEALED = "v1.aXY.dGFn.Ym9keQ"

// The server's side (privileged): a pending profile, then saved
async function profile(user: string, domain = "fixture.test", label = "Work") {
  const { rows } = await pg.query<{ id: string }>(
    "insert into kriya.login_profiles (user_id, domain, label) values ($1, $2, $3) returning id",
    [user, domain, label]
  )
  return rows[0].id
}
const activate = (id: string) =>
  pg.query(
    "update kriya.login_profiles set status = 'active', state_sealed = $2, confirmed_at = now(), expires_at = now() + interval '90 days' where id = $1",
    [id, SEALED]
  )

beforeAll(async () => {
  pg = await createTestDb()
  await pg.query(
    "update kriya.plans set max_login_profiles = 2, browser_minutes = 1 where id = 'free'"
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("login profiles", () => {
  it("AT-SEC-01 the person's session can't select sealed state or tokens", async () => {
    await activate(await profile(alice))
    await expect(
      asUser(pg, alice, (tx) => tx.query("select state_sealed from kriya.login_profiles"))
    ).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, alice, (tx) => tx.query("select * from kriya.login_profiles"))
    ).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select access_token, refresh_token from kriya.connections")
      )
    ).rejects.toThrow(/permission denied/)
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query<{ status: string }>(
        "select id, domain, label, status, background_allowed, expires_at from kriya.login_profiles"
      )
    )
    expect(rows).toEqual([expect.objectContaining({ status: "active" })])
  })

  it("AT-RLS-A another person finds, changes and deletes nothing", async () => {
    const { rows } = await asUser(pg, bob, (tx) =>
      tx.query("select id from kriya.login_profiles")
    )
    expect(rows).toEqual([])
    const updated = await asUser(pg, bob, (tx) =>
      tx.query(
        "update kriya.login_profiles set label = 'mine', background_allowed = true"
      )
    )
    expect(updated.affectedRows).toBe(0)
    const deleted = await asUser(pg, bob, (tx) =>
      tx.query("delete from kriya.login_profiles")
    )
    expect(deleted.affectedRows).toBe(0)
  })

  it("the person renames and allows background use, and nothing else", async () => {
    const changed = await asUser(pg, alice, (tx) =>
      tx.query(
        "update kriya.login_profiles set label = 'Personal', background_allowed = true"
      )
    )
    expect(changed.affectedRows).toBe(1)
    for (const set of [
      "status = 'expired'",
      "state_sealed = null",
      "expires_at = now() + interval '10 years'",
      "domain = 'evil.test'",
      `user_id = '${bob}'`,
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(`update kriya.login_profiles set ${set}`))
      ).rejects.toThrow(/permission denied/)
    }
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.login_profiles (user_id, domain, label) values ($1, 'fixture.test', 'x')",
          [alice]
        )
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("only an active profile holds state, and status follows the state machine", async () => {
    const id = await profile(bob)
    await expect(
      pg.query("update kriya.login_profiles set state_sealed = $2 where id = $1", [
        id,
        SEALED,
      ])
    ).rejects.toThrow(/check constraint/)
    await expect(
      pg.query("update kriya.login_profiles set status = 'expired' where id = $1", [id])
    ).rejects.toThrow(/can.t go from/)
    await activate(id)
    await pg.query(
      "update kriya.login_profiles set status = 'expired', state_sealed = null where id = $1",
      [id]
    )
    await activate(id)
    await expect(
      pg.query(
        "update kriya.login_profiles set status = 'pending', state_sealed = null where id = $1",
        [id]
      )
    ).rejects.toThrow(/can.t go from/)
  })

  it("enforces max_login_profiles, pending ones included (invariant 7)", async () => {
    await profile(alice, "fixture.test", "Second")
    await expect(profile(alice, "example.com", "Third")).rejects.toThrow(
      /login profiles limit/
    )
    // Removing one frees a place
    await asUser(pg, alice, (tx) =>
      tx.query("delete from kriya.login_profiles where label = 'Second'")
    )
    await profile(alice, "example.com", "Third")
  })

  it("removal deletes the state; the session record keeps no link", async () => {
    const id = await profile(bob, "example.com", "Temp")
    const session = randomUUID()
    await pg.query("select kriya.open_login_session($1, $2, $3, 'kriya-browser')", [
      session,
      bob,
      id,
    ])
    await asUser(pg, bob, (tx) =>
      tx.query("delete from kriya.login_profiles where id = $1", [id])
    )
    const { rows } = await pg.query<{ login_profile_id: string | null }>(
      "select login_profile_id from kriya.browser_sessions where id = $1",
      [session]
    )
    expect(rows).toEqual([{ login_profile_id: null }])
  })

  it("login sessions: server only, own profiles only, within the browser minutes", async () => {
    const id = await profile(bob, "fixture.test", "Minutes")
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query("select kriya.open_login_session($1, $2, $3, 'x')", [
          randomUUID(),
          bob,
          id,
        ])
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      pg.query("select kriya.open_login_session($1, $2, $3, 'x')", [
        randomUUID(),
        alice,
        id,
      ])
    ).rejects.toThrow(/unknown profile/)
    await pg.query(
      "insert into kriya.resource_usage (request_key, user_id, kind, quantity) values ('browser:m1', $1, 'browser_seconds', 60)",
      [bob]
    )
    await expect(
      pg.query("select kriya.open_login_session($1, $2, $3, 'x')", [
        randomUUID(),
        bob,
        id,
      ])
    ).rejects.toThrow(/browser minutes/)
  })
})

describe("kits", () => {
  const insert = (user: string, status = "ready") =>
    asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.kits (user_id, domain, title, deep_link, fields, status)
         values ($1, 'fixture.test', 'Profile intro', 'http://profile-editor.fixture.test/', '[{"label":"Headline","text":"Hi"}]', $2)`,
        [user, status]
      )
    )

  it("agents prepare ready kits; only the server records the check", async () => {
    await insert(alice)
    await expect(insert(alice, "verified")).rejects.toThrow(/row-level security/)
    await expect(
      asUser(pg, alice, (tx) => tx.query("update kriya.kits set status = 'verified'"))
    ).rejects.toThrow(/permission denied/)
  })

  it("AT-RLS-A another person finds and deletes nothing, and can't write for them", async () => {
    const { rows } = await asUser(pg, bob, (tx) => tx.query("select id from kriya.kits"))
    expect(rows).toEqual([])
    const deleted = await asUser(pg, bob, (tx) => tx.query("delete from kriya.kits"))
    expect(deleted.affectedRows).toBe(0)
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query(
          `insert into kriya.kits (user_id, domain, title, deep_link, fields) values ($1, 'x', 't', 'http://x.test/', '[{"label":"a","text":"b"}]')`,
          [alice]
        )
      )
    ).rejects.toThrow(/row-level security/)
  })
})
