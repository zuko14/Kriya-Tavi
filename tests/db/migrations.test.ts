import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createTestDb } from "./harness"

const down = fs.readFileSync(
  path.join(process.cwd(), "supabase", "rollback", "20261016000000_kriya_core.down.sql"),
  "utf8"
)
const up = fs.readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261016000000_kriya_core.sql"),
  "utf8"
)

describe("migrations", () => {
  it("turns on row level security for every kriya table", async () => {
    const pg = await createTestDb()
    const { rows } = await pg.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rows).toEqual([])
  })

  it("rolls back cleanly and can be applied again", async () => {
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key)"
    )
    await pg.exec(down)
    const { rows } = await pg.query("select 1 from pg_namespace where nspname = 'kriya'")
    expect(rows).toHaveLength(0)
    await pg.exec(up)
    const { rows: plans } = await pg.query("select id from kriya.plans order by sort")
    expect(plans).toHaveLength(3)
  })

  it("rolls memory v2 back to the old memories table and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const memoryDown = read("rollback", "20261101000000_memory_v2.down.sql")
    const memoryUp = read("migrations", "20261101000000_memory_v2.sql")
    const columns = async () =>
      (
        await pg.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = 'kriya' and table_name = 'memories' order by column_name"
        )
      ).rows.map((r) => r.column_name)

    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261101000000')"
    )
    const user = "00000000-0000-0000-0000-0000000000aa"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a', $1, 'A', 'r', 'g')",
      [user]
    )
    await pg.query(
      `insert into kriya.memories (id, user_id, agent_id, content, source, invalid_at) values
        ('kept', $1, 'a', 'likes tea', 'agent', null),
        ('shared', $1, null, 'lives in Pune', 'user', null),
        ('old', $1, 'a', 'likes coffee', 'agent', now()),
        ('merged', $1, 'a', 'tea, no sugar', 'derived', null)`,
      [user]
    )

    await pg.exec(memoryDown)
    expect(await columns()).toEqual([
      "agent_id",
      "content",
      "created_at",
      "id",
      "source",
      "updated_at",
      "user_id",
    ])
    const { rows: notes } = await pg.query(
      "select id, source from kriya.memories order by id"
    )
    expect(notes).toEqual([
      { id: "kept", source: "agent" },
      { id: "merged", source: "agent" },
    ])
    const { rows: tables } = await pg.query(
      "select 1 from pg_tables where schemaname = 'kriya' and tablename in ('thread_summaries', 'maintenance_jobs', 'resource_usage')"
    )
    expect(tables).toEqual([])
    const { rows: versions } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261101000000'"
    )
    expect(versions).toEqual([])
    await expect(
      pg.query(
        "insert into kriya.memories (id, user_id, content) values ('x', $1, 'y')",
        [user]
      )
    ).rejects.toThrow(/null value/)

    await pg.exec(memoryUp)
    expect(await columns()).toContain("search")
    const { rows: rls } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rls).toEqual([])
  })

  it("rolls the memory pause column back and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261101000001')"
    )
    const hasColumn = async () =>
      (
        await pg.query(
          "select 1 from information_schema.columns where table_schema = 'kriya' and table_name = 'agents' and column_name = 'memory_paused'"
        )
      ).rows.length === 1
    expect(await hasColumn()).toBe(true)
    await pg.exec(read("rollback", "20261101000001_memory_pause.down.sql"))
    expect(await hasColumn()).toBe(false)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261101000001'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261101000001_memory_pause.sql"))
    expect(await hasColumn()).toBe(true)
  })

  it("rolls the browser tables back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261101000002')"
    )
    const exists = async () =>
      (
        await pg.query(
          "select 1 from pg_proc where proname = 'open_browser_session' union all select 1 from pg_class where relname = 'browser_sessions'"
        )
      ).rows.length
    expect(await exists()).toBe(2)
    await pg.exec(read("rollback", "20261101000002_browser.down.sql"))
    expect(await exists()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261101000002'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261101000002_browser.sql"))
    expect(await exists()).toBe(2)
  })

  it("rolls goals, schedules, approvals and episodes back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261101000003')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname as name from pg_class where relname in
             ('goals', 'schedules', 'schedule_runs', 'approvals', 'episodes', 'allowed_transitions')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and column_name in
               ('verification', 'max_goals', 'max_schedules', 'min_schedule_interval_minutes')
           union all select proname from pg_proc where proname in ('check_transition', 'episodes_guard')`
        )
      ).rows.length
    expect(await added()).toBe(12)
    // Rollbacks run newest first: policy versions (A12), radar (A13),
    // ledger (A7), files (A5), skills (A9) and login profiles (A6) use
    // check_transition(); obligations reference goals
    await pg.exec(read("rollback", "20261114000000_policy_versions.down.sql"))
    await pg.exec(read("rollback", "20261113000000_radar_watch.down.sql"))
    await pg.exec(read("rollback", "20261111000000_ledger.down.sql"))
    await pg.exec(read("rollback", "20261110000000_files.down.sql"))
    await pg.exec(read("rollback", "20261109000000_skills.down.sql"))
    await pg.exec(read("rollback", "20261106000000_login_profiles.down.sql"))
    await pg.exec(read("rollback", "20261101000003_goals_schedules.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261101000003'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261101000003_goals_schedules.sql"))
    expect(await added()).toBe(12)
    await pg.exec(read("migrations", "20261106000000_login_profiles.sql"))
    await pg.exec(read("migrations", "20261109000000_skills.sql"))
    await pg.exec(read("migrations", "20261110000000_files.sql"))
    await pg.exec(read("migrations", "20261111000000_ledger.sql"))
    await pg.exec(read("migrations", "20261113000000_radar_watch.sql"))
    await pg.exec(read("migrations", "20261114000000_policy_versions.sql"))
  })

  it("rolls the A8 providers and undo columns back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261108000000')"
    )
    const check = async () =>
      (
        await pg.query<{ def: string }>(
          "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'connections_provider_check'"
        )
      ).rows[0].def
    const undoColumns = async () =>
      (
        await pg.query(
          `select 1 from information_schema.columns where table_schema = 'kriya'
             and table_name = 'tool_executions' and column_name in ('undo', 'undo_until', 'undone_at')`
        )
      ).rows.length
    expect(await check()).toContain("github")
    expect(await undoColumns()).toBe(3)
    await pg.exec(read("rollback", "20261108000000_connectors_v2.down.sql"))
    expect(await check()).not.toContain("github")
    expect(await undoColumns()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261108000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261108000000_connectors_v2.sql"))
    expect(await check()).toContain("meta")
    expect(await undoColumns()).toBe(3)
  })

  it("rolls the skills table back and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261109000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname = 'skills'
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and column_name = 'max_skills'
           union all select entity from kriya.allowed_transitions where entity = 'skill'`
        )
      ).rows.length
    expect(await added()).toBe(5)
    await pg.exec(read("rollback", "20261109000000_skills.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261109000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261109000000_skills.sql"))
    expect(await added()).toBe(5)
  })

  it("rolls files and shares back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261110000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('files', 'share_links', 'share_views')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and column_name in ('max_file_mb', 'storage_mb', 'max_shares')
           union all select proname from pg_proc
             where proname in ('files_within_plan', 'shares_within_plan', 'share_links_guard')
           union all select entity from kriya.allowed_transitions where entity = 'file'`
        )
      ).rows.length
    expect(await added()).toBe(13)
    // Newest first: the ledger (A7) references files
    await pg.exec(read("rollback", "20261111000000_ledger.down.sql"))
    await pg.exec(read("rollback", "20261110000000_files.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261110000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261110000000_files.sql"))
    expect(await added()).toBe(13)
    await pg.exec(read("migrations", "20261111000000_ledger.sql"))
  })

  it("rolls the ledger back and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261111000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class
             where relname in ('ledger_entries', 'invoice_series', 'invoices', 'claim_checks')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and column_name = 'ledger_enabled'
           union all select proname from pg_proc where proname in
             ('issue_invoice', 'financial_year', 'ledger_within_plan', 'invoices_guard', 'ledger_entries_guard')
           union all select entity from kriya.allowed_transitions
             where entity in ('ledger_entry', 'invoice')`
        )
      ).rows.length
    expect(await added()).toBe(19)
    await pg.exec(read("rollback", "20261111000000_ledger.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261111000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261111000000_ledger.sql"))
    expect(await added()).toBe(19)
  })

  it("rolls watchers, Radar and the facts commons back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261113000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class
             where relname in ('watch_state', 'obligations', 'fact_sources', 'public_facts')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'schedules' and column_name = 'watch'
           union all select proname from pg_proc where proname = 'public_facts_guard'
           union all select entity from kriya.allowed_transitions where entity = 'obligation'
           union all select conname from pg_constraint
             where conname = 'schedule_runs_outcome_check' and pg_get_constraintdef(oid) like '%unchanged%'`
        )
      ).rows.length
    expect(await added()).toBe(11)
    await pg.exec(read("rollback", "20261113000000_radar_watch.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261113000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261113000000_radar_watch.sql"))
    expect(await added()).toBe(11)
  })

  it("rolls policy versions back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261114000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('policy_versions', 'policy_task_versions')
           union all select proname from pg_proc where proname = 'policy_versions_frozen'
           union all select entity from kriya.allowed_transitions where entity = 'policy_version'`
        )
      ).rows.length
    expect(await added()).toBe(12)
    await pg.exec(read("rollback", "20261114000000_policy_versions.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261114000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261114000000_policy_versions.sql"))
    expect(await added()).toBe(12)
  })

  it("rolls login profiles and kits back and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261106000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('login_profiles', 'kits')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'plans' and column_name = 'max_login_profiles'
           union all select proname from pg_proc
             where proname in ('open_login_session', 'login_profiles_within_plan')
           union all select conname from pg_constraint where conname = 'browser_sessions_login_profile_fk'
           union all select entity from kriya.allowed_transitions where entity = 'login_profile'`
        )
      ).rows.length
    expect(await added()).toBe(9)
    await pg.exec(read("rollback", "20261106000000_login_profiles.down.sql"))
    expect(await added()).toBe(0)
    const { rows } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261106000000'"
    )
    expect(rows).toEqual([])
    await pg.exec(read("migrations", "20261106000000_login_profiles.sql"))
    expect(await added()).toBe(9)
  })

  it("T-MIG-01 rolls the voice core back and applies it again, before the core rollback", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261016000000'), ('20261020000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'kriya' and c.relkind = 'r'
               and (relname like 'voice\\_%' or relname like 'call\\_%'
                    or relname in ('phone_verifications', 'conversation_turns'))
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'plans'
               and column_name in ('voice_enabled', 'max_outreach_calls_per_day',
                 'max_call_seconds', 'max_attempts_per_call', 'max_voice_task_cost_micro_inr')
           union all select proname from pg_proc
             where proname in ('voice_transition', 'voice_status_guard', 'voice_transitions_frozen')`
        )
      ).rows.length
    const version = async (v: string) =>
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = $1",
          [v]
        )
      ).rows.length
    expect(await added()).toBe(24)

    await pg.exec(read("rollback", "20261020000000_voice_core.down.sql"))
    expect(await added()).toBe(0)
    expect(await version("20261020000000")).toBe(0)
    await pg.exec(read("migrations", "20261020000000_voice_core.sql"))
    expect(await added()).toBe(24)
    const { rows } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rows).toEqual([])

    // F2: voice first, then the core; neither version stays recorded
    await pg.exec(read("rollback", "20261020000000_voice_core.down.sql"))
    await pg.exec(read("rollback", "20261016000000_kriya_core.down.sql"))
    expect(await version("20261020000000")).toBe(0)
    expect(await version("20261016000000")).toBe(0)
    await pg.exec(read("migrations", "20261016000000_kriya_core.sql"))
    await pg.exec(read("migrations", "20261020000000_voice_core.sql"))
    expect(await added()).toBe(24)
  })
})
