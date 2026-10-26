import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { voiceOperations } from "@/lib/owner"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { approval, callAttempt, voiceCall, voiceTask } from "../db/voice-fixtures"

vi.mock("server-only", () => ({}))

// D-24 L-setup: the person's confirmation to the first dial and first ring,
// from the recorded times only; calls scheduled for later don't count.

let pg: TestDb
let user: string

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

async function confirmedCall(dialAfter: number, ringAfter: number, notBeforeAfter = 0) {
  const task = await voiceTask(pg, user, { status: "in_progress" })
  await approval(pg, user, task, { decided_at: ago(600) })
  const call = await voiceCall(pg, user, task, { not_before: ago(600 - notBeforeAfter) })
  await callAttempt(pg, user, call, {
    status: "ringing",
    requested_at: ago(600 - dialAfter),
    ringing_at: ago(600 - ringAfter),
  })
}

describe("voice setup latency", () => {
  it("says so plainly when there's nothing to measure", async () => {
    expect((await voiceOperations()).setup).toEqual({
      calls: 0,
      dialP50: null,
      dialP95: null,
      ringP50: null,
      ringP95: null,
    })
  })

  it("p50 and p95 from confirmation, leaving out calls scheduled for later", async () => {
    await confirmedCall(1, 4)
    await confirmedCall(1, 6)
    await confirmedCall(3, 8)
    // Moved to the next calling window: not a setup delay
    await confirmedCall(300, 305, 300)
    const { setup } = await voiceOperations()
    expect(setup.calls).toBe(3)
    expect(setup.dialP50).toBeCloseTo(1, 0)
    expect(setup.ringP50).toBeCloseTo(6, 0)
    expect(setup.ringP95).toBeGreaterThan(7)
    expect(setup.ringP95).toBeLessThanOrEqual(8.1)
  })
})
