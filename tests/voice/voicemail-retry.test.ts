import { MockLanguageModelV4 } from "ai/test"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import type { CallNotes } from "@/lib/voice/dialogue"
import { clock } from "@/lib/voice/schedule"
import { finishOutcome } from "@/lib/voice/verify"
import { specFor } from "@/scripts/voice-eval"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, seed, transition, voiceCall, voiceTask } from "../db/voice-fixtures"

// D-22 (S29): an outreach call that only reached voicemail or a network
// message wasn't answered by anyone, so it's tried again within its caps;
// no model is asked to interpret a voicemail greeting.

const spec = specFor({ id: "voicemail", callee: [] })
// A Tuesday afternoon, inside calling hours
const T0 = new Date("2026-10-13T14:00:00+05:30")
const notes: CallNotes = {
  proposed: [],
  agreed: [],
  questions: [],
  wrongPerson: null,
  callback: null,
  optOut: null,
  flags: ["voicemail or network message"],
  rejected: [],
  end: "voicemail",
}
// A model that must never be called
const never = new MockLanguageModelV4({
  modelId: "m/never",
  doGenerate: async () => {
    throw new Error("a voicemail needs no model")
  },
})

let pg: TestDb
let user: string

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  clock.now = () => new Date(T0)
  user = await createUser(pg)
})
afterAll(() => {
  clock.now = () => new Date()
})

async function voicemailAttempt(attempts: number, maxAttempts: number) {
  const task = await voiceTask(pg, user, {
    spec,
    status: "in_progress",
    report_requested: false,
  })
  const call = await voiceCall(pg, user, task, {
    status: "in_call",
    attempts,
    max_attempts: maxAttempts,
    window_end: new Date(T0.getTime() + 6 * 3_600_000).toISOString(),
  })
  const attempt = await callAttempt(pg, user, call, {
    status: "ended",
    requested_at: T0.toISOString(),
    answered_at: T0.toISOString(),
    connected_at: T0.toISOString(),
    verified_at: T0.toISOString(),
    end_reason: "voicemail",
  })
  await seed(pg, "call_outcomes", {
    user_id: user,
    voice_task_id: task,
    call_attempt_id: attempt,
    observed: {},
    interpreted: { notes },
    verifier_status: "pending",
  })
  return { task, call, attempt }
}
const row = async (table: string, id: string) =>
  (
    await pg.query<Record<string, unknown>>(
      `select * from kriya.${table} where id = $1`,
      [id]
    )
  ).rows[0]

describe("a call that reached voicemail", () => {
  it("the rule is the database's: rolled back, the edge is refused again", async () => {
    const fs = await import("node:fs")
    const file = (dir: string, name: string) =>
      fs.readFileSync(`supabase/${dir}/${name}`, "utf8")
    const { call, attempt } = await voicemailAttempt(1, 2)
    await pg.query(
      "update kriya.call_attempts set end_reason = 'voicemail' where id = $1",
      [attempt]
    )
    await transition(pg, "call", call, "settled", "verifier")
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key)"
    )
    await pg.exec(file("rollback", "20270102000000_voice_voicemail_retry.down.sql"))
    await expect(transition(pg, "call", call, "retry_wait", "worker")).rejects.toThrow(
      /only an undelivered owner report goes round again/
    )
    await pg.exec(file("migrations", "20270102000000_voice_voicemail_retry.sql"))
    expect(await transition(pg, "call", call, "retry_wait", "worker")).toBe(true)
  })

  it("is accepted without a model, and tried again while attempts are left", async () => {
    const { task, call, attempt } = await voicemailAttempt(1, 2)
    await finishOutcome(attempt, { model: never })
    const [outcome] = (
      await pg.query<{ verifier_status: string }>(
        "select verifier_status from kriya.call_outcomes where call_attempt_id = $1",
        [attempt]
      )
    ).rows
    expect(outcome.verifier_status).toBe("accepted")
    const after = await row("voice_calls", call)
    expect(after.status).toBe("retry_wait")
    expect(new Date(after.available_at as string).getTime()).toBeGreaterThan(T0.getTime())
    expect((await row("voice_tasks", task)).status).toBe("in_progress")
  })

  it("ends as not reached once its attempts are used: result no_answer", async () => {
    const { task, call, attempt } = await voicemailAttempt(2, 2)
    await finishOutcome(attempt, { model: never })
    expect((await row("voice_calls", call)).status).toBe("exhausted")
    const after = await row("voice_tasks", task)
    expect(after.status).toBe("completed")
    expect(after.result).toBe("no_answer")
  })

  it("a call where someone spoke is still never redialled", async () => {
    const task = await voiceTask(pg, user, {
      spec,
      status: "in_progress",
      report_requested: false,
    })
    const call = await voiceCall(pg, user, task, {
      status: "in_call",
      attempts: 1,
      max_attempts: 2,
    })
    const attempt = await callAttempt(pg, user, call, {
      status: "ended",
      requested_at: T0.toISOString(),
      connected_at: T0.toISOString(),
      verified_at: T0.toISOString(),
      end_reason: "tavi_hangup",
    })
    await seed(pg, "call_outcomes", {
      user_id: user,
      voice_task_id: task,
      call_attempt_id: attempt,
      observed: {},
      interpreted: { notes: { ...notes, end: "done", flags: [] } },
      verifier_status: "needs_review",
    })
    const { settleCall } = await import("@/lib/voice/verify")
    await settleCall(call)
    expect((await row("voice_calls", call)).status).toBe("settled")
    await expect(transition(pg, "call", call, "retry_wait", "worker")).rejects.toThrow(
      /only an undelivered owner report, or an outreach call that reached voicemail/
    )
  })
})
