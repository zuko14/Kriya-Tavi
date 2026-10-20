import { is } from "drizzle-orm"
import { toSnakeCase } from "drizzle-orm/casing"
import { getTableConfig, PgTable } from "drizzle-orm/pg-core"
import { beforeAll, describe, expect, it } from "vitest"

import * as schema from "@/db/schema"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"
import {
  approval,
  callAttempt,
  callOutcome,
  HASH,
  now,
  seed,
  voiceCall,
  voiceTask,
} from "./voice-fixtures"

let pg: TestDb
let alice: string
let bob: string

// One row of everything for a user
async function world(user: string) {
  await seed(pg, "voice_profiles", { user_id: user })
  await seed(pg, "voice_access", { user_id: user })
  const task = await voiceTask(pg, user, { status: "awaiting_report" })
  await approval(pg, user, task)
  const call = await voiceCall(pg, user, task, { status: "settled" })
  const attempt = await callAttempt(pg, user, call, { status: "ended" })
  await seed(pg, "call_events", {
    user_id: user,
    call_attempt_id: attempt,
    provider: "mock",
    source: "status_webhook",
    dedupe_key: `${attempt}:completed`,
    status: "completed",
  })
  await seed(pg, "conversation_turns", {
    user_id: user,
    call_attempt_id: attempt,
    seq: 0,
    speaker: "tavi",
    text: "Hello",
  })
  await callOutcome(pg, user, task, attempt)
  await seed(pg, "voice_transitions", {
    user_id: user,
    voice_task_id: task,
    entity: "task",
    entity_id: task,
    from_status: "in_progress",
    to_status: "awaiting_report",
    actor: "verifier",
  })
  await seed(pg, "voice_usage", {
    request_key: `${attempt}:telephony`,
    user_id: user,
    voice_task_id: task,
    call_attempt_id: attempt,
    component: "telephony",
    provider: "mock",
    product: "outbound",
    usage_status: "missing",
  })
  await seed(pg, "voice_charges", {
    user_id: user,
    voice_task_id: task,
    cost_basis: "none",
    markup_bps: 10000,
    status: "unpriced",
  })
  await seed(pg, "phone_verifications", {
    user_id: user,
    phone_e164: "+919876543210",
    code_hash: HASH,
    expires_at: now(),
  })
  return { task, call, attempt }
}

let bobs: Awaited<ReturnType<typeof world>>

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await world(alice)
  bobs = await world(bob)
  await seed(pg, "call_suppressions", { phone_hash: HASH, reason: "owner_block" })
  await seed(pg, "voice_prices", {
    id: "mock:attempt",
    provider: "mock",
    product: "outbound",
    unit: "attempt",
    price_micro: 0,
    currency: "INR",
    effective_from: now(),
    source: "test fixture",
    checked_at: now(),
  })
})

// Readable by their owner. call_attempts is read by named columns (its
// token hashes aren't granted), so it's covered separately below.
const READABLE = [
  "voice_profiles",
  "voice_tasks",
  "voice_approvals",
  "voice_calls",
  "call_events",
  "conversation_turns",
  "call_outcomes",
  "voice_transitions",
  "voice_usage",
  "voice_charges",
]
const HIDDEN = [
  "voice_access",
  "phone_verifications",
  "call_suppressions",
  "voice_prices",
  "voice_allowed_transitions",
]

const asAlice = <T>(fn: (tx: Pick<TestDb, "query" | "exec">) => Promise<T>) =>
  asUser(pg, alice, fn)

describe("voice row level security", () => {
  it.each(READABLE)("T-RLS %s: a user sees only their own rows", async (table) => {
    const { rows } = await asAlice((tx) =>
      tx.query<{ user_id: string }>(`select user_id from kriya.${table}`)
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.user_id === alice)).toBe(true)
  })

  it("T-RLS call_attempts: own rows only, and the token hashes aren't selectable", async () => {
    const { rows } = await asAlice((tx) =>
      tx.query<{ user_id: string }>(
        "select id, user_id, status, policy_version from kriya.call_attempts"
      )
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.user_id === alice)).toBe(true)
    for (const column of ["callback_token_hash", "stream_token_hash", "stream_owner"]) {
      await expect(
        asAlice((tx) => tx.query(`select ${column} from kriya.call_attempts`))
      ).rejects.toThrow(/permission denied/)
    }
  })

  it.each(HIDDEN)("T-RLS %s: unreadable from a person's session", async (table) => {
    await expect(
      asAlice((tx) => tx.query(`select 1 from kriya.${table}`))
    ).rejects.toThrow(/permission denied/)
  })

  it.each([...READABLE, "call_attempts"])(
    "T-RLS %s: no inserts, even in the person's own name",
    async (table) => {
      await expect(
        asAlice((tx) =>
          tx.query(`insert into kriya.${table} (user_id) values ($1)`, [alice])
        )
      ).rejects.toThrow(/permission denied/)
    }
  )

  it.each(
    [...READABLE, "call_attempts"].filter(
      (t) => t !== "voice_profiles" && t !== "conversation_turns"
    )
  )("T-RLS %s: no updates or deletes", async (table) => {
    await expect(
      asAlice((tx) => tx.query(`update kriya.${table} set user_id = user_id`))
    ).rejects.toThrow(/permission denied/)
    await expect(asAlice((tx) => tx.query(`delete from kriya.${table}`))).rejects.toThrow(
      /permission denied/
    )
  })

  it("T-RLS voice_profiles: preferences are editable, the verified number isn't", async () => {
    const updated = await asAlice((tx) =>
      tx.query("update kriya.voice_profiles set timezone = 'Asia/Dubai'")
    )
    expect(updated.affectedRows).toBe(1)
    const { rows } = await pg.query(
      "select user_id, timezone from kriya.voice_profiles order by timezone"
    )
    expect(rows).toEqual([
      { user_id: alice, timezone: "Asia/Dubai" },
      { user_id: bob, timezone: "Asia/Kolkata" },
    ])
    for (const set of [
      "owner_phone_e164 = '+919999999999'",
      "owner_phone_verified_at = now()",
      "user_id = user_id",
    ]) {
      await expect(
        asAlice((tx) => tx.query(`update kriya.voice_profiles set ${set}`))
      ).rejects.toThrow(/permission denied/)
    }
    await expect(
      asAlice((tx) => tx.query("delete from kriya.voice_profiles"))
    ).rejects.toThrow(/permission denied/)
  })

  it("T-RLS conversation_turns: a user deletes their own turns, never another's", async () => {
    const theirs = await asAlice((tx) =>
      tx.query("delete from kriya.conversation_turns where user_id = $1", [bob])
    )
    expect(theirs.affectedRows).toBe(0)
    const own = await asAlice((tx) => tx.query("delete from kriya.conversation_turns"))
    expect(own.affectedRows).toBe(1)
    const { rows } = await pg.query<{ user_id: string }>(
      "select user_id from kriya.conversation_turns"
    )
    expect(rows).toEqual([{ user_id: bob }])
  })

  it("T-DB-01 child rows can't point at another user's parent", async () => {
    await expect(approval(pg, alice, bobs.task)).rejects.toThrow(/foreign key/)
    await expect(voiceCall(pg, alice, bobs.task)).rejects.toThrow(/foreign key/)
    await expect(callAttempt(pg, alice, bobs.call)).rejects.toThrow(/foreign key/)
    // An attempt with no outcome yet, so only the foreign key can refuse it
    const spare = await callAttempt(pg, bob, bobs.call)
    await expect(callOutcome(pg, alice, bobs.task, spare)).rejects.toThrow(/foreign key/)
    await expect(
      seed(pg, "conversation_turns", {
        user_id: alice,
        call_attempt_id: bobs.attempt,
        seq: 9,
        speaker: "callee",
        text: "x",
      })
    ).rejects.toThrow(/foreign key/)
    await expect(voiceTask(pg, alice, { parent_task_id: bobs.task })).rejects.toThrow(
      /foreign key/
    )
  })

  it("T-FK-01 deleting a thread or a parent task nulls only the link", async () => {
    const user = await createUser(pg)
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('fk-agent', $1, 'A', 'r', 'g')",
        [user]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ('fk-thread', $1, 'fk-agent')",
        [user]
      )
    })
    const parent = await voiceTask(pg, user, { thread_id: "fk-thread" })
    const child = await voiceTask(pg, user, {
      thread_id: "fk-thread",
      parent_task_id: parent,
    })

    // What actions/threads.ts deleteThread does, in the person's session
    await asUser(pg, user, (tx) =>
      tx.query("delete from kriya.threads where id = 'fk-thread'")
    )
    const links = async () =>
      (
        await pg.query(
          "select id, user_id, thread_id, parent_task_id from kriya.voice_tasks where user_id = $1 order by created_at, id",
          [user]
        )
      ).rows
    expect(await links()).toEqual(
      expect.arrayContaining([
        { id: parent, user_id: user, thread_id: null, parent_task_id: null },
        { id: child, user_id: user, thread_id: null, parent_task_id: parent },
      ])
    )

    await pg.query("delete from kriya.voice_tasks where id = $1", [parent])
    expect(await links()).toEqual([
      { id: child, user_id: user, thread_id: null, parent_task_id: null },
    ])
  })

  it("T-FK-01 deleting the account removes everything but de-identified cost", async () => {
    const user = await createUser(pg)
    const { task } = await world(user)
    await pg.query("delete from auth.users where id = $1", [user])
    const left: string[] = []
    for (const table of [
      ...READABLE,
      "call_attempts",
      "voice_access",
      "phone_verifications",
    ]) {
      const { rows } = await pg.query<{ n: number }>(
        `select count(*)::int as n from kriya.${table} where user_id = $1`,
        [user]
      )
      if (rows[0].n > 0) left.push(table)
    }
    expect(left).toEqual([])
    const { rows } = await pg.query(
      `select (select count(*)::int from kriya.voice_usage where request_key like '%:telephony' and user_id is null) as usage,
              (select count(*)::int from kriya.voice_charges where user_id is null and voice_task_id is null) as charges,
              (select count(*)::int from kriya.voice_transitions where voice_task_id = $1) as audit`,
      [task]
    )
    expect(rows).toEqual([{ usage: 1, charges: 1, audit: 0 }])
  })

  it("T-DB-02 db/schema.ts has every voice column with the same nullability", async () => {
    const tables = Object.values(schema).flatMap((value) =>
      is(value, PgTable) ? [value] : []
    )
    // The name Drizzle will actually query (db/index.ts uses snake_case casing)
    const columnName = (c: { name: string; keyAsName: boolean }) =>
      c.keyAsName ? toSnakeCase(c.name) : c.name
    const drizzle = new Map<string, Map<string, boolean>>()
    for (const table of tables) {
      const config = getTableConfig(table)
      if (config.schema !== "kriya") continue
      drizzle.set(
        config.name,
        new Map(config.columns.map((c) => [columnName(c), c.notNull]))
      )
    }
    const { rows } = await pg.query<{
      table_name: string
      column_name: string
      is_nullable: "YES" | "NO"
    }>(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'kriya'
         and (table_name in (${[...READABLE, ...HIDDEN, "call_attempts"].map((t) => `'${t}'`).join(", ")})
              or (table_name = 'plans' and column_name in ('voice_enabled',
                'max_outreach_calls_per_day', 'max_call_seconds', 'max_attempts_per_call',
                'max_voice_task_cost_micro_inr')))
       order by table_name, column_name`
    )
    expect(rows.length).toBeGreaterThan(150)
    const mismatches = rows.flatMap((row) => {
      const notNull = drizzle.get(row.table_name)?.get(row.column_name)
      if (notNull === undefined) return [`${row.table_name}.${row.column_name}: missing`]
      if (notNull !== (row.is_nullable === "NO"))
        return [`${row.table_name}.${row.column_name}: nullability`]
      return []
    })
    expect(mismatches).toEqual([])
  })
})
