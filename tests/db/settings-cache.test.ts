import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { sessionPooler, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { getSetting, setSetting } from "@/lib/config"

import { createTestDb } from "./harness"

// The settings cache (lib/config.ts): parallel reads share one query, a
// Save always wins, and a failed refresh serves the last copy for a while
// instead of failing every page (production: a busy connection pool).

let db: DB
let selects = 0
let failing = false

beforeAll(async () => {
  const pg = await createTestDb()
  db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  // Counts and optionally fails reads of the settings table
  const counted = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== "select")
        return typeof value === "function" ? value.bind(target) : value
      return (...args: unknown[]) => {
        const builder = (value as (...a: unknown[]) => unknown).apply(target, args)
        return new Proxy(builder as object, {
          get(b, p, r) {
            const v = Reflect.get(b, p, r)
            if (p !== "from") return typeof v === "function" ? v.bind(b) : v
            return (table: unknown) => {
              if (table === schema.platformSettings) {
                selects++
                if (failing) return Promise.reject(new Error("max clients reached"))
              }
              return (v as (t: unknown) => unknown).call(b, table)
            }
          },
        })
      }
    },
  })
  setDatabaseForTests(counted)
})

describe("settings cache", () => {
  it("a dozen parallel reads after a Save make one query", async () => {
    await setSetting("agents.inbox", "on", null)
    selects = 0
    const values = await Promise.all(
      Array.from({ length: 12 }, () => getSetting("agents.inbox"))
    )
    expect(values).toEqual(Array(12).fill("on"))
    expect(selects).toBe(1)
  })

  it("a Save during a load: the next read sees the saved value", async () => {
    await setSetting("agents.goals", "off", null)
    const before = getSetting("agents.goals")
    await setSetting("agents.goals", "on", null)
    await before
    expect(await getSetting("agents.goals")).toBe("on")
  })

  it("a failed refresh serves the last copy within the window, then fails", async () => {
    await setSetting("agents.ledger", "on", null)
    expect(await getSetting("agents.ledger")).toBe("on")
    const now = Date.now()
    const clock = vi.spyOn(Date, "now")
    failing = true
    try {
      clock.mockReturnValue(now + 60_000) // expired, within five minutes
      expect(await getSetting("agents.ledger")).toBe("on")
      clock.mockReturnValue(now + 10 * 60_000) // too old to trust
      await expect(getSetting("agents.ledger")).rejects.toThrow("max clients reached")
    } finally {
      failing = false
      clock.mockRestore()
    }
  })

  it("after a Save there's no copy to fall back on: the error shows", async () => {
    await setSetting("agents.radar", "on", null)
    failing = true
    try {
      await expect(getSetting("agents.radar")).rejects.toThrow("max clients reached")
    } finally {
      failing = false
    }
  })
})

describe("DATABASE_URL check", () => {
  it("flags Supabase's session pooler, not the transaction pooler or others", () => {
    expect(
      sessionPooler("postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres")
    ).toBe(true)
    expect(
      sessionPooler("postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres")
    ).toBe(false)
    expect(sessionPooler("postgresql://u:p@db.abc.supabase.co:5432/postgres")).toBe(false)
    expect(sessionPooler("postgresql://u:p@127.0.0.1:54322/postgres")).toBe(false)
    expect(sessionPooler("not a url")).toBe(false)
  })
})
