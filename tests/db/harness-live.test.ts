import { createHash, randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20271001000000_harness_live.sql: a live session and its events are the
// person's alone and read-only to them; only device routes write.

let pg: TestDb
let alice: string
let bob: string

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

async function liveRow(user: string) {
  const token = createHash("sha256").update(randomUUID()).digest("hex")
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_devices (user_id, name, platform, token_hash)
     values ($1, 'laptop', 'darwin', $2) returning id`,
    [user, token]
  )
  const made = await pg.query<{ id: string }>(
    `insert into kriya.harness_live_sessions (user_id, device_id, device_session_id)
     values ($1, $2, 's1') returning id`,
    [user, rows[0].id]
  )
  await pg.query(
    `insert into kriya.harness_live_events (session_id, seq, user_id, kind, at)
     values ($1, 0, $2, 'user', now())`,
    [made.rows[0].id, user]
  )
  return made.rows[0].id
}

describe("HT-RC-DB-01: live rows", () => {
  it("are readable only by their person", async () => {
    const id = await liveRow(alice)
    const count = (user: string, table: string) =>
      asUser(pg, user, (tx) =>
        tx.query(
          `select 1 from kriya.${table} where ${table.endsWith("events") ? "session_id" : "id"} = $1`,
          [id]
        )
      ).then((r) => r.rows.length)
    expect(await count(alice, "harness_live_sessions")).toBe(1)
    expect(await count(alice, "harness_live_events")).toBe(1)
    expect(await count(bob, "harness_live_sessions")).toBe(0)
    expect(await count(bob, "harness_live_events")).toBe(0)
  })

  it("can't be written by the person's session", async () => {
    const id = await liveRow(alice)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.harness_live_sessions set remote = false where id = $1", [
          id,
        ])
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.harness_live_events (session_id, seq, user_id, kind, at) values ($1, 9, $2, 'user', now())",
          [id, alice]
        )
      )
    ).rejects.toThrow()
  })
})
