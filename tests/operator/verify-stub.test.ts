import path from "node:path"

import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"
import { startStub } from "@/scripts/verify-model-stub"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// OT-UIV-02 (UI_VERIFICATION §4): the stub answers in the shape the real
// OpenAI-compatible client accepts. One task runs through the real runner
// and the real createGatewayModel, pointed at the stub: a scripted tool
// call, then text. No network beyond 127.0.0.1, no model cost.

let pg: TestDb
let user: string
let close: () => Promise<void>

beforeAll(async () => {
  const stub = await startStub(
    0,
    path.join(process.cwd(), "tests/operator/verify-scripts")
  )
  close = stub.close
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/v1`
  process.env.OPENROUTER_API_KEY = "stub"
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Lekha', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})

afterAll(async () => {
  await close()
  delete process.env.OPENROUTER_BASE_URL
  delete process.env.OPENROUTER_API_KEY
})

describe("the stub model (OT-UIV-02)", () => {
  it("drives a scripted tool call and reply through the real runner", async () => {
    await enqueueTurn({
      userId: user,
      threadId: "t1",
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "[verify:stub-test] Remember this" }],
      } as KriyaMessage,
    })
    const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    const id = rowsOf<{ id: string }>(
      await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
    )[0]!.id
    const { rows } = await pg.query<Record<string, unknown>>(
      "select * from kriya.tasks where id = $1",
      [id]
    )
    const task = Object.fromEntries(
      Object.entries(rows[0]).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        v,
      ])
    ) as unknown as schema.Task
    await runTask(task, {
      workerId: "w1",
      leaseSeconds: 30,
      shutdown: new AbortController().signal,
    })

    const done = await pg.query("select status from kriya.tasks where id = $1", [id])
    expect(done.rows).toEqual([{ status: "succeeded" }])
    const notes = await pg.query<{ content: string }>(
      "select content from kriya.memories"
    )
    expect(notes.rows.map((n) => n.content)).toEqual(["Prefers short answers"])
    const reply = await pg.query<{ parts: { type: string; text?: string }[] }>(
      "select parts from kriya.messages where role = 'assistant'"
    )
    expect(reply.rows[0].parts.findLast((p) => p.type === "text")?.text).toBe(
      "Saved that."
    )
    // No cost reported, so the charge can't be priced (shown honestly)
    const charge = await pg.query<{ status: string }>("select status from kriya.charges")
    expect(charge.rows.map((c) => c.status)).not.toContain("final")
  })
})
