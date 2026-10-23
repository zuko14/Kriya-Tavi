import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn, TurnError } from "@/lib/agent/queue"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// A turn sent while no worker is alive used to sit "queued" with "booting
// turn…" until its deadline (production, 2026-10-23). Now it's refused at
// once with a clear message, and nothing is queued.

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

let pg: TestDb
let user: string

const send = () =>
  enqueueTurn({
    userId: user,
    threadId: "t1",
    message: {
      id: `m${Math.random()}`,
      role: "user",
      parts: [{ type: "text", text: "Summarise my mail" }],
    } as KriyaMessage,
  })
const queued = async () =>
  (await pg.query<{ n: number }>("select count(*)::int as n from kriya.tasks")).rows[0].n

beforeEach(async () => {
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Vector', 'Google manager', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

describe("sending a turn with no live worker", () => {
  it("is refused with a clear message when the workers have stopped", async () => {
    await pg.query(
      "insert into kriya.workers (id, concurrency, heartbeat_at) values ('w-old', 4, now() - interval '11 hours')"
    )
    const error = await send().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TurnError)
    expect(error).toMatchObject({ status: 503, code: "unavailable" })
    expect((error as Error).message).toMatch(/task runner is offline/)
    expect(await queued()).toBe(0)
  })

  it("is refused when the last worker shut down cleanly", async () => {
    await pg.query(
      "insert into kriya.workers (id, concurrency, heartbeat_at, stopped_at) values ('w-stop', 4, now(), now())"
    )
    await expect(send()).rejects.toMatchObject({ code: "unavailable" })
  })

  it("is queued as before while a worker is alive", async () => {
    await pg.query(
      "insert into kriya.workers (id, concurrency, heartbeat_at, stopped_at) values ('w-old', 4, now() - interval '1 day', now() - interval '1 day'), ('w-live', 4, now(), null)"
    )
    await send()
    expect(await queued()).toBe(1)
  })
})
