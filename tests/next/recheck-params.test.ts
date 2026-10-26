import { drizzle } from "drizzle-orm/pglite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { recheckDeliveries } from "@/lib/delivery/recheck"

import { createTestDb } from "../db/harness"

vi.mock("server-only", () => ({}))

// The late re-check against the real driver. PGlite accepts a Date inside a
// raw query and the production driver (postgres) does not, so the first live
// run of the worker step failed on every tick while every test passed. The
// window is sent as ISO text now; this test fails if a Date goes in again.

const hasDate = (value: unknown): boolean =>
  value instanceof Date ||
  (Array.isArray(value) && value.some(hasDate)) ||
  (!!value &&
    typeof value === "object" &&
    "queryChunks" in value &&
    hasDate((value as { queryChunks: unknown[] }).queryChunks))

afterEach(() => vi.restoreAllMocks())

describe("recheckDeliveries query parameters", () => {
  it("sends the window as text, never a Date object", async () => {
    const pg = await createTestDb()
    const db = drizzle({ client: pg, schema, casing: "snake_case" })
    setDatabaseForTests(db as unknown as DB)
    const execute = vi.spyOn(db, "execute")
    await recheckDeliveries(new Date("2026-10-25T10:00:00Z"))
    expect(execute).toHaveBeenCalled()
    for (const [query] of execute.mock.calls) expect(hasDate(query)).toBe(false)
  })
})
