import fs from "node:fs"
import path from "node:path"

import { beforeEach, describe, expect, it } from "vitest"

import { createTestDb, createUser, type TestDb } from "./harness"
import { approval, voiceCall, voiceTask } from "./voice-fixtures"

// The voice call queue (voice phase 3, DATA_MODEL §4): claim, heartbeat and
// recovery in SQL. PGlite has one connection, so "two workers at once" is
// two claims in a row; skip locked is exercised on Supabase only.

let pg: TestDb
let alice: string
let bob: string

beforeEach(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

const claim = async (worker = "w1", maxLive = 10) =>
  (
    await pg.query<{ id: string }>("select id from kriya.claim_voice_call($1, 30, $2)", [
      worker,
      maxLive,
    ])
  ).rows.map((r) => r.id)

const later = () => new Date(Date.now() + 60 * 60_000).toISOString()
const call = async (user: string, row: Record<string, unknown> = {}) => {
  const task = await voiceTask(pg, user, { status: "authorized" })
  return voiceCall(pg, user, task, row)
}

const row = async (id: string) =>
  (
    await pg.query<{ status: string; lease_owner: string | null; leased: boolean }>(
      "select status, lease_owner, lease_expires_at > now() as leased from kriya.voice_calls where id = $1",
      [id]
    )
  ).rows[0]

describe("T-Q-01 claim_voice_call", () => {
  it("claims a due call with a lease and records the transition", async () => {
    const id = await call(alice)
    expect(await claim()).toEqual([id])
    expect(await row(id)).toEqual({ status: "dialing", lease_owner: "w1", leased: true })
    const { rows } = await pg.query(
      "select from_status, to_status, actor from kriya.voice_transitions where entity_id = $1",
      [id]
    )
    expect(rows).toEqual([
      { from_status: "scheduled", to_status: "dialing", actor: "worker" },
    ])
    expect(await claim()).toEqual([])
  })

  it("waits for available_at and not_before, and skips cancelled calls", async () => {
    await call(alice, { available_at: later() })
    await call(alice, { not_before: later() })
    await call(alice, { cancel_requested_at: new Date().toISOString() })
    expect(await claim()).toEqual([])
  })

  it("claims retries in retry_wait", async () => {
    const id = await call(alice, { status: "retry_wait" })
    expect(await claim()).toEqual([id])
  })

  it("allows one live outreach call per person, not counting their report calls", async () => {
    const first = await call(alice)
    const second = await call(alice)
    const report = await call(alice, { kind: "owner_report" })
    const other = await call(bob)
    const claimed = [
      ...(await claim()),
      ...(await claim()),
      ...(await claim()),
      ...(await claim()),
    ]
    expect(claimed).toContain(first)
    expect(claimed).toContain(report)
    expect(claimed).toContain(other)
    expect(claimed).not.toContain(second)
    expect((await row(second)).status).toBe("scheduled")
  })

  it("respects the global cap on live calls", async () => {
    await call(alice)
    await call(bob)
    expect(await claim("w1", 1)).toHaveLength(1)
    expect(await claim("w2", 1)).toEqual([])
  })

  it("two claims never get the same call", async () => {
    await call(alice)
    await call(bob)
    const [a] = await claim("w1")
    const [b] = await claim("w2")
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it("isn't callable from a person's session", async () => {
    await expect(
      pg.transaction(async (tx) => {
        await tx.exec("set local role authenticated")
        await tx.query("select kriya.claim_voice_call('w', 30, 10)")
      })
    ).rejects.toThrow(/permission denied/)
  })
})

describe("heartbeat_voice_call", () => {
  it("extends only its own lease and reports a cancel request", async () => {
    const id = await call(alice)
    await claim("w1")
    const beat = (worker: string) =>
      pg
        .query<{ cancel_requested: boolean }>(
          "select * from kriya.heartbeat_voice_call($1, $2, 30)",
          [id, worker]
        )
        .then((r) => r.rows)
    expect(await beat("w1")).toEqual([{ cancel_requested: false }])
    expect(await beat("w2")).toEqual([])
    await pg.query(
      "update kriya.voice_calls set cancel_requested_at = now() where id = $1",
      [id]
    )
    expect(await beat("w1")).toEqual([{ cancel_requested: true }])
  })
})

describe("recover_voice_calls", () => {
  it("takes over calls whose lease expired, and only those", async () => {
    const lost = await call(alice)
    const held = await call(bob)
    await claim("w1")
    await claim("w2")
    await pg.query(
      "update kriya.voice_calls set lease_expires_at = now() - interval '1 second' where id = $1",
      [lost]
    )
    const { rows } = await pg.query<{ id: string }>(
      "select id from kriya.recover_voice_calls('w3', 30)"
    )
    expect(rows.map((r) => r.id)).toEqual([lost])
    expect(await row(lost)).toMatchObject({
      status: "dialing",
      lease_owner: "w3",
      leased: true,
    })
    expect((await row(held)).lease_owner).toBe("w2")
  })

  it("expires approvals nobody answered and the tasks waiting on them", async () => {
    const task = await voiceTask(pg, alice, { status: "awaiting_confirmation" })
    const id = await approval(pg, alice, task, {
      status: "pending",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    const waiting = await voiceTask(pg, alice, { status: "awaiting_confirmation" })
    await approval(pg, alice, waiting, { status: "pending", expires_at: later() })
    await pg.query("select kriya.recover_voice_calls('w', 30)")
    const status = async (sql: string, v: string) =>
      (await pg.query<{ status: string }>(sql, [v])).rows[0].status
    expect(
      await status("select status from kriya.voice_approvals where id = $1", id)
    ).toBe("expired")
    expect(await status("select status from kriya.voice_tasks where id = $1", task)).toBe(
      "expired"
    )
    expect(
      await status("select status from kriya.voice_tasks where id = $1", waiting)
    ).toBe("awaiting_confirmation")
  })
})

describe("voice queue migration", () => {
  it("rolls back and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261021000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select proname from pg_proc where proname in
             ('claim_voice_call', 'heartbeat_voice_call', 'recover_voice_calls')
           union all select indexname from pg_indexes
             where indexname in ('call_attempts_stream_token_idx', 'call_attempts_callback_token_idx')
           union all select to_status from kriya.voice_allowed_transitions
             where (entity, from_status, to_status) in
               (('task', 'authorized', 'failed'), ('call', 'scheduled', 'exhausted'),
                ('call', 'dialing', 'blocked'))`
        )
      ).rows.length
    expect(await added()).toBe(8)
    await pg.exec(read("rollback", "20261021000000_voice_queue.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261021000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261021000000_voice_queue.sql"))
    expect(await added()).toBe(8)
  })
})
