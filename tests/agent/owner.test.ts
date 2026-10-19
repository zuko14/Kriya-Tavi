import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// AT-OWN-A1: the owner console counts goals, schedules, runs, approvals and
// records, and never selects what's in them (titles, prompts, previews,
// what an agent did) or any memory, file, ledger, screenshot or login data.

vi.mock("server-only", () => ({}))

let pg: TestDb

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  const user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1'), ('t2', $1, 'a1')",
      [user]
    )
    await tx.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, 'a1', 't2', 'SECRET goal')",
      [user]
    )
    await tx.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule, next_run_at, approved_at, status)
       values ('s1', $1, 'a1', 't1', 'recurring', 'SECRET prompt', '{}', now(), now(), 'active')`,
      [user]
    )
  })
  await pg.query(
    "insert into kriya.schedule_runs (schedule_id, user_id, due_at, outcome) values ('s1', $1, now() - interval '1 day', 'enqueued'), ('s1', $1, now(), 'skipped_active')",
    [user]
  )
  await pg.query(
    "insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title, preview) values ('ap', $1, 't1', 'gmail_draft', 'R3', 'SECRET title', '{\"input\":\"SECRET\"}')",
    [user]
  )
  await pg.query(
    "insert into kriya.episodes (user_id, thread_id, done, titles, seq, hash) values ($1, 't1', '[{\"title\":\"SECRET\"}]', 'SECRET', 1, 'h')",
    [user]
  )
})

describe("owner counts (AT-OWN-A1)", () => {
  it("returns numbers only, and none of the planted content", async () => {
    const { backgroundCounts } = await import("@/lib/owner")
    const counts = await backgroundCounts()
    expect(JSON.stringify(counts)).not.toContain("SECRET")
    expect(Object.values(counts).every((v) => typeof v === "number")).toBe(true)
    expect(counts).toMatchObject({
      openGoals: 1,
      activeSchedules: 1,
      runs7d: 2,
      enqueued7d: 1,
      skipped7d: 1,
      pendingApprovals: 1,
      episodes7d: 1,
    })
  })

  it("lib/owner.ts never names a content column", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib", "owner.ts"), "utf8")
    for (const column of [
      /goals\.title/,
      /success_criteria|successCriteria/,
      /schedules\.prompt|\bprompt\b/,
      /approvals\.(title|preview)|\bpreview\b/,
      /episodes\.(done|unconfirmed|checks|titles|summary)/,
      /\bmemories\b/,
      /login_profiles|state_sealed/,
      /ledger_entries|invoices/,
      /kriya\.files|screenshot/,
    ]) {
      expect(source, String(column)).not.toMatch(column)
    }
  })
})
