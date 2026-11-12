import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270801000000_harness_control.sql (Control Center, CONTROL_CENTER.md):
// device state, dispatches and runs are the person's alone; the person may
// queue for their own signed-in computer and cancel, never claim, run,
// finish or write a result; dispatches move only along allowed_transitions.

let pg: TestDb
let alice: string
let bob: string
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

async function device(user: string, revoked = false) {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_devices (user_id, name, platform, token_hash, revoked_at)
     values ($1, 'laptop', 'darwin', $2, $3) returning id`,
    [user, sha(randomUUID()), revoked ? new Date().toISOString() : null]
  )
  return rows[0].id
}

const queueAs = (user: string, deviceId: string, kind = "doctor") =>
  asUser(pg, user, (tx) =>
    tx.query<{ id: string }>(
      "insert into kriya.harness_dispatches (user_id, device_id, kind, payload) values ($1, $2, $3, '{}') returning id",
      [user, deviceId, kind]
    )
  ).then((r) => r.rows[0].id)

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("HT-CC-DB-01: Control Center rows are the person's alone", () => {
  it("each sees only their own state, dispatches and runs", async () => {
    const d = await device(alice)
    await pg.query(
      "insert into kriya.harness_device_state (device_id, user_id, projects) values ($1, $2, '[]')",
      [d, alice]
    )
    await queueAs(alice, d)
    await pg.query(
      "insert into kriya.harness_runs (user_id, device_id, local_id, source, kind, mode) values ($1, $2, 'r1', 'terminal', 'run', 'auto')",
      [alice, d]
    )
    const tables = ["harness_device_state", "harness_dispatches", "harness_runs"]
    const count = (user: string) =>
      asUser(pg, user, (tx) =>
        Promise.all(
          tables.map((t) =>
            tx.query(`select 1 from kriya.${t}`).then((r) => r.rows.length)
          )
        )
      )
    expect(await count(bob)).toEqual([0, 0, 0])
    expect(await count(alice)).toEqual([1, 1, 1])
  })
})

describe("HT-CC-DB-02: the person queues and cancels; only the server runs", () => {
  it("queues only for their own signed-in computer, always 'queued'", async () => {
    const mine = await device(alice)
    const revoked = await device(alice, true)
    const bobs = await device(bob)
    expect(await queueAs(alice, mine)).toBeTruthy()
    await expect(queueAs(alice, revoked)).rejects.toThrow()
    await expect(queueAs(alice, bobs)).rejects.toThrow()
    // Not as someone else, and never pre-claimed or with a result
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.harness_dispatches (user_id, device_id, kind) values ($1, $2, 'doctor')",
          [bob, bobs]
        )
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.harness_dispatches (user_id, device_id, kind, status) values ($1, $2, 'doctor', 'done')",
          [alice, mine]
        )
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.harness_dispatches (user_id, device_id, kind, result) values ($1, $2, 'doctor', '{}')",
          [alice, mine]
        )
      )
    ).rejects.toThrow()
  })

  it("cancels a queued one; can't claim, finish or rewrite a result; transitions are enforced", async () => {
    const d = await device(alice)
    const id = await queueAs(alice, d)
    for (const sql of [
      "update kriya.harness_dispatches set status = 'claimed' where id = $1",
      "update kriya.harness_dispatches set status = 'done' where id = $1",
      "update kriya.harness_dispatches set result = '{}' where id = $1",
      "update kriya.harness_dispatches set payload = '{}' where id = $1",
    ])
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql, [id])),
        sql
      ).rejects.toThrow()
    // Bob can't touch it
    const bobUpdate = await asUser(pg, bob, (tx) =>
      tx.query("update kriya.harness_dispatches set status = 'canceled' where id = $1", [
        id,
      ])
    )
    expect(bobUpdate.affectedRows ?? 0).toBe(0)
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.harness_dispatches set status = 'canceled' where id = $1", [
        id,
      ])
    )
    const { rows } = await pg.query<{ status: string }>(
      "select status from kriya.harness_dispatches where id = $1",
      [id]
    )
    expect(rows[0].status).toBe("canceled")
    // A canceled one stays canceled, even for the server
    await expect(
      pg.query("update kriya.harness_dispatches set status = 'claimed' where id = $1", [
        id,
      ])
    ).rejects.toThrow()
    // queued → canceling isn't a transition (a queued one is simply canceled)
    const other = await queueAs(alice, d)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "update kriya.harness_dispatches set status = 'canceling' where id = $1",
          [other]
        )
      )
    ).rejects.toThrow()
  })

  it("the person can't write device state or runs", async () => {
    const d = await device(alice)
    for (const sql of [
      `insert into kriya.harness_device_state (device_id, user_id) values ('${d}', '${alice}')`,
      `insert into kriya.harness_runs (user_id, device_id, local_id, source, kind) values ('${alice}', '${d}', 'x', 'terminal', 'run')`,
    ])
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow()
  })
})

describe("HT-CC-DB-03: the migration rolls back and forward", () => {
  it("down then up", async () => {
    const read = (dir: string, file: string) =>
      readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const db = await createTestDb()
    await db.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key)"
    )
    // Track E references the Control Center: first out, last in
    await db.exec(read("rollback", "20271104000000_editing_order.down.sql"))
    await db.exec(read("rollback", "20271103000000_editing_review.down.sql"))
    await db.exec(read("rollback", "20271102000000_editing_tables.down.sql"))
    await db.exec(read("rollback", "20271101000000_harness_dispatch_edit.down.sql"))
    await db.exec(read("rollback", "20270801000000_harness_control.down.sql"))
    await expect(db.query("select 1 from kriya.harness_dispatches")).rejects.toThrow()
    await db.exec(read("migrations", "20270801000000_harness_control.sql"))
    expect((await db.query("select 1 from kriya.harness_dispatches")).rows).toEqual([])
    await db.exec(read("migrations", "20271101000000_harness_dispatch_edit.sql"))
    await db.exec(read("migrations", "20271102000000_editing_tables.sql"))
    await db.exec(read("migrations", "20271103000000_editing_review.sql"))
    await db.exec(read("migrations", "20271104000000_editing_order.sql"))
  })
})
