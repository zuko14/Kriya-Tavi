import { createHash, randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20271202000000_harness_own_usage.sql: own-key usage rows are the person's
// alone and read-only to them; only the device route (privileged) writes.

let pg: TestDb
let alice: string
let bob: string

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

async function row(user: string) {
  const token = createHash("sha256").update(randomUUID()).digest("hex")
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_devices (user_id, name, platform, token_hash) values ($1, 'laptop', 'darwin', $2) returning id`,
    [user, token]
  )
  await pg.query(
    `insert into kriya.harness_own_usage (user_id, device_id, provider, model, input_tokens) values ($1, $2, 'openrouter', 'm', 10)`,
    [user, rows[0].id]
  )
  return rows[0].id
}

describe("HT-OWN-DB-01: own usage rows", () => {
  it("are readable only by their person, and nobody inserts, updates or deletes them as a session", async () => {
    const device = await row(alice)
    const seen = (user: string) =>
      asUser(pg, user, (tx) =>
        tx.query("select provider from kriya.harness_own_usage")
      ).then((r) => r.rows.length)
    expect(await seen(alice)).toBe(1)
    expect(await seen(bob)).toBe(0)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          `insert into kriya.harness_own_usage (user_id, device_id, provider, model) values ($1, $2, 'openrouter', 'm')`,
          [alice, device]
        )
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.harness_own_usage set input_tokens = 0")
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) => tx.query("delete from kriya.harness_own_usage"))
    ).rejects.toThrow()
  })

  it("refuses bad values at the database", async () => {
    const device = await row(bob)
    for (const sql of [
      `insert into kriya.harness_own_usage (user_id, device_id, provider, model) values ($1, $2, 'BAD PROVIDER', 'm')`,
      `insert into kriya.harness_own_usage (user_id, device_id, provider, model, input_tokens) values ($1, $2, 'openrouter', 'm', -1)`,
      `insert into kriya.harness_own_usage (user_id, device_id, provider, model, reported_cost_micro_usd) values ($1, $2, 'openrouter', 'm', -5)`,
    ])
      await expect(pg.query(sql, [bob, device])).rejects.toThrow()
  })
})
