import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createTestDb, createUser } from "./harness"
import { PHONE, statusOf, transition, voiceCall, voiceTask } from "./voice-fixtures"

// Verification calls have no task (voice phase 6, D-13; owner decision
// 2026-10-20): migration 20261022000000_voice_verification and its rollback

const read = (dir: string, file: string) =>
  fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
const VERSION = "20261022000000"

const verificationCall = (pg: Awaited<ReturnType<typeof createTestDb>>, user: string) =>
  voiceCall(pg, user, null as unknown as string, { kind: "verification", seq: 1 })

describe("voice verification calls", () => {
  it("a verification call has no task and moves through voice_transition()", async () => {
    const pg = await createTestDb()
    const user = await createUser(pg)
    const call = await verificationCall(pg, user)
    expect(await transition(pg, "call", call, "dialing", "worker")).toBe(true)
    expect(await statusOf(pg, "call", call)).toBe("dialing")
    const { rows } = await pg.query<{ task: string | null }>(
      "select voice_task_id as task from kriya.voice_transitions where entity_id = $1",
      [call]
    )
    expect(rows).toEqual([{ task: null }])
  })

  it("every other call still needs its task, and a verification call has none", async () => {
    const pg = await createTestDb()
    const user = await createUser(pg)
    const task = await voiceTask(pg, user)
    await expect(
      voiceCall(pg, user, null as unknown as string, { kind: "owner_report" })
    ).rejects.toThrow(/voice_calls_task_unless_verification/)
    await expect(
      voiceCall(pg, user, task, { kind: "verification", to_phone_e164: PHONE })
    ).rejects.toThrow(/voice_calls_task_unless_verification/)
  })

  it("rolls back (dropping verification calls) and applies again", async () => {
    const pg = await createTestDb()
    await pg.exec(
      `create schema if not exists supabase_migrations;
       create table if not exists supabase_migrations.schema_migrations (version text primary key);
       insert into supabase_migrations.schema_migrations values ('${VERSION}')`
    )
    const user = await createUser(pg)
    const call = await verificationCall(pg, user)
    await transition(pg, "call", call, "dialing", "worker")
    const nullable = async () =>
      (
        await pg.query<{ t: string; n: string }>(
          `select table_name as t, is_nullable as n from information_schema.columns
           where table_schema = 'kriya' and column_name = 'voice_task_id'
             and table_name in ('voice_calls', 'voice_transitions') order by 1`
        )
      ).rows.map((r) => `${r.t}:${r.n}`)
    expect(await nullable()).toEqual(["voice_calls:YES", "voice_transitions:YES"])

    await pg.exec(read("rollback", `${VERSION}_voice_verification.down.sql`))
    expect(await nullable()).toEqual(["voice_calls:NO", "voice_transitions:NO"])
    expect(await statusOf(pg, "call", call)).toBeUndefined()
    const version = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = $1",
      [VERSION]
    )
    expect(version.rows).toEqual([])

    await pg.exec(read("migrations", `${VERSION}_voice_verification.sql`))
    expect(await nullable()).toEqual(["voice_calls:YES", "voice_transitions:YES"])
  })
})
