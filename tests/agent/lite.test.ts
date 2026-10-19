import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { streamTask } from "@/lib/agent/queue"
import { followWhileVisible, liteMode } from "@/lib/lite"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// AT-LITE-01 (K10): the person sets Lite mode for themselves only (unset
// until they choose); their choice beats the browser's save-data hint; a
// Lite stream checks for news every 1.5 s instead of 350 ms; and in Lite
// mode the notifications connection closes while the tab is hidden.

let pg: TestDb
let alice: string
let bob: string

const lite = async (user: string) =>
  (
    await pg.query<{ lite_mode: boolean | null }>(
      "select lite_mode from kriya.profiles where id = $1",
      [user]
    )
  ).rows[0].lite_mode

// What setLiteMode (actions/account.ts) runs, as the person
const set = (user: string, target: string, on: boolean) =>
  asUser(pg, user, (tx) =>
    tx.query("update kriya.profiles set lite_mode = $1 where id = $2", [on, target])
  )

beforeEach(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("the setting (AT-LITE-01)", () => {
  it("is unset until the person chooses, then keeps their choice", async () => {
    expect(await lite(alice)).toBeNull()
    await set(alice, alice, true)
    expect(await lite(alice)).toBe(true)
    expect(await lite(bob)).toBeNull()
    await set(alice, alice, false)
    expect(await lite(alice)).toBe(false)
  })

  it("can't be set on someone else's profile", async () => {
    await set(alice, bob, true)
    expect(await lite(bob)).toBeNull()
  })

  it("keeps the four profile columns editable and status not", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query(
        "update kriya.profiles set display_name = 'A', locale = 'hi-IN', use_case = 'student', onboarded_at = now(), lite_mode = true where id = $1",
        [alice]
      )
    )
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.profiles set status = 'active' where id = $1", [alice])
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("rolls back and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261101000004')"
    )
    const has = async () =>
      (
        await pg.query(
          "select 1 from information_schema.columns where table_schema = 'kriya' and table_name = 'profiles' and column_name = 'lite_mode'"
        )
      ).rows.length === 1
    await pg.exec(read("rollback", "20261101000004_profiles_lite.down.sql"))
    expect(await has()).toBe(false)
    expect(
      (await pg.query("select 1 from supabase_migrations.schema_migrations")).rows
    ).toEqual([])
    // The four original columns are still the person's to edit
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.profiles set display_name = 'B' where id = $1", [alice])
    )
    await pg.exec(read("migrations", "20261101000004_profiles_lite.sql"))
    expect(await has()).toBe(true)
  })
})

describe("in the browser", () => {
  it("follows the person's choice, else the browser's save-data hint", () => {
    expect(liteMode(null, undefined)).toBe(false)
    expect(liteMode(null, false)).toBe(false)
    expect(liteMode(null, true)).toBe(true)
    // An explicit choice wins either way
    expect(liteMode(false, true)).toBe(false)
    expect(liteMode(true, false)).toBe(true)
  })
})

describe("thread stream polling", () => {
  afterEach(() => vi.restoreAllMocks())

  // The delay of the first wait streamTask takes between empty reads
  async function firstWait(lite: boolean) {
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    await asUser(pg, alice, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
        [alice]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
        [alice]
      )
    })
    const [task] = (
      await pg.query<{ id: string }>(
        `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
         values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'running') returning id`,
        [alice]
      )
    ).rows
    const waits: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      waits.push(ms ?? 0)
      return real(fn, 0)
    }) as typeof setTimeout)
    const stop = new AbortController()
    const reader = streamTask(alice, task.id, stop.signal, { lite }).getReader()
    void reader.read()
    while (waits.length === 0) await new Promise((resolve) => real(resolve, 5))
    stop.abort()
    return waits[0]
  }

  it("checks every 350 ms normally", async () => {
    expect(await firstWait(false)).toBe(350)
  })

  it("checks every 1.5 s in Lite mode", async () => {
    expect(await firstWait(true)).toBe(1_500)
  })
})

describe("notifications connection", () => {
  // A stand-in for document and EventSource
  function page(visible: boolean) {
    const listeners = new Set<() => void>()
    const doc = {
      visibilityState: visible ? "visible" : "hidden",
      addEventListener: (_: "visibilitychange", fn: () => void) => listeners.add(fn),
      removeEventListener: (_: "visibilitychange", fn: () => void) =>
        listeners.delete(fn),
    }
    const sources: { closed: boolean }[] = []
    const open = () => {
      const source = { closed: false, close: () => (source.closed = true) }
      sources.push(source)
      return source
    }
    const show = (v: boolean) => {
      doc.visibilityState = v ? "visible" : "hidden"
      for (const fn of listeners) fn()
    }
    return { doc, open, sources, show, listeners }
  }

  it("in Lite mode closes while the tab is hidden and reconnects when it's back", () => {
    const p = page(true)
    const stop = followWhileVisible(p.open, true, p.doc)
    expect(p.sources).toHaveLength(1)
    p.show(false)
    expect(p.sources[0].closed).toBe(true)
    p.show(true)
    expect(p.sources).toHaveLength(2)
    expect(p.sources[1].closed).toBe(false)
    stop()
    expect(p.sources[1].closed).toBe(true)
    expect(p.listeners.size).toBe(0)
  })

  it("in Lite mode doesn't connect from a hidden tab until it's shown", () => {
    const p = page(false)
    followWhileVisible(p.open, true, p.doc)
    expect(p.sources).toHaveLength(0)
    p.show(true)
    expect(p.sources).toHaveLength(1)
  })

  it("normally stays connected whatever the tab does", () => {
    const p = page(true)
    const stop = followWhileVisible(p.open, false, p.doc)
    p.show(false)
    expect(p.sources).toHaveLength(1)
    expect(p.sources[0].closed).toBe(false)
    expect(p.listeners.size).toBe(0)
    stop()
    expect(p.sources[0].closed).toBe(true)
  })
})
