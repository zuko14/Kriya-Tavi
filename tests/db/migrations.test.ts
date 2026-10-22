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
    // Rollbacks run newest first: crews (O11) reference jobs; operator jobs
    // (O2) reference goals and use check_transition(), as do policy versions
    // (A12), radar (A13), ledger (A7), files (A5), skills (A9) and login
    // profiles (A6); obligations reference goals
    await pg.exec(read("rollback", "20261201000100_operator_crews.down.sql"))
    await pg.exec(read("rollback", "20261201000000_operator_mandates.down.sql"))
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
    await pg.exec(read("migrations", "20261201000000_operator_mandates.sql"))
    await pg.exec(read("migrations", "20261201000100_operator_crews.sql"))
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

  it("OT-DB-06 rolls operator jobs and grants back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261201000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('mandates', 'grants', 'grant_uses')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'tool_executions' and column_name = 'grant_id'
           union all select proname from pg_proc
             where proname in ('consume_grant', 'grants_guard', 'mandates_guard')
           union all select entity from kriya.allowed_transitions where entity in ('mandate', 'grant')`
        )
      ).rows.length
    // 3 tables, 1 column, 3 functions, 20 transitions
    expect(await added()).toBe(27)

    const user = "00000000-0000-0000-0000-0000000000ab"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    await pg.query(
      `insert into kriya.mandates (id, user_id, origin_thread_id, title, objective, criteria,
         due_at, proposed_by, status)
       values ('m1', $1, 't1', 'Collect', 'Get paid',
         '[{"id":"c1","text":"x","evidence":{"kind":"file_created"}}]',
         now() + interval '5 days', 'agent', 'active')`,
      [user]
    )
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
       values ($1, 'm1', 'gmail_draft', '{"to":["a@example.com"]}', 2, now() + interval '5 days')
       returning id`,
      [user]
    )
    await pg.query("select kriya.consume_grant($1, $2, gen_random_uuid(), 'call-1')", [
      user,
      rows[0].id,
    ])

    // Crews (O11) reference jobs: newest first
    await pg.exec(read("rollback", "20261201000100_operator_crews.down.sql"))
    await pg.exec(read("rollback", "20261201000000_operator_mandates.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261201000000'"
    )
    expect(version).toEqual([])
    // The rest of the person's data is untouched
    const { rows: threads } = await pg.query("select id from kriya.threads")
    expect(threads).toEqual([{ id: "t1" }])

    await pg.exec(read("migrations", "20261201000000_operator_mandates.sql"))
    await pg.exec(read("migrations", "20261201000100_operator_crews.sql"))
    expect(await added()).toBe(27)
    const { rows: rls } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rls).toEqual([])
  })

  it("G2 rolls the drive file origin back and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261201000200')"
    )
    const user = "00000000-0000-0000-0000-0000000000ad"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    const add = (origin: string) =>
      pg.query(
        `insert into kriya.files (user_id, name, mime, size_bytes, origin)
         values ($1, 'a.pdf', 'application/pdf', 10, $2)`,
        [user, origin]
      )
    await add("drive")
    await add("upload")
    await pg.exec(read("rollback", "20261201000200_drive_files.down.sql"))
    // Drive copies go; everything else stays; the old origins only
    const { rows } = await pg.query("select origin from kriya.files")
    expect(rows).toEqual([{ origin: "upload" }])
    await expect(add("drive")).rejects.toThrow(/files_origin_check/)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261201000200'"
    )
    expect(version).toEqual([])
    await pg.exec(read("migrations", "20261201000200_drive_files.sql"))
    await add("drive")
  })

  it("O11 rolls crews back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261201000100')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('crew_runs', 'crew_parts', 'crew_runs_one_open')
           union all select entity from kriya.allowed_transitions where entity in ('crew_run', 'crew_part')`
        )
      ).rows.length
    // 2 tables, 1 index, 20 transitions
    expect(await added()).toBe(23)

    const user = "00000000-0000-0000-0000-0000000000ac"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('lead', $1, 'a1'), ('part', $1, 'a1')",
      [user]
    )
    await pg.query(
      `insert into kriya.mandates (id, user_id, title, objective, criteria, due_at, proposed_by, status)
       values ('m1', $1, 'Collect', 'Get paid', '[{"id":"c1","text":"x","evidence":{"kind":"person_confirmed"}}]',
         now() + interval '5 days', 'agent', 'active')`,
      [user]
    )
    await pg.query(
      `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, deadline_at)
       values ('r1', $1, 'lead', 'a1', 's1', 'm1', now() + interval '1 day')`,
      [user]
    )
    await pg.query(
      `insert into kriya.crew_parts (id, user_id, run_id, key, agent_id, thread_id, brief)
       values ('p1', $1, 'r1', 'drafts', 'a1', 'part', 'Draft')`,
      [user]
    )

    await pg.exec(read("rollback", "20261201000100_operator_crews.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20261201000100'"
    )
    expect(version).toEqual([])
    // The part thread and the job stay with the person
    const { rows: kept } = await pg.query(
      "select (select count(*)::int from kriya.threads) as threads, (select count(*)::int from kriya.mandates) as jobs"
    )
    expect(kept).toEqual([{ threads: 2, jobs: 1 }])

    await pg.exec(read("migrations", "20261201000100_operator_crews.sql"))
    expect(await added()).toBe(23)
  })

  it("T-MIG-01 rolls the voice core back and applies it again, before the core rollback", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    // 24 from the voice core, 3 voice_* tables from phase 10
    const VOICE_TABLES = 27
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20261016000000'), ('20261020000000'), ('20261023000000')"
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
    expect(await added()).toBe(VOICE_TABLES)

    // Newest first (voice phase 10): its tables outlive attempts, without
    // keys to them, so they're removed by their own rollback
    await pg.exec(read("rollback", "20261023000000_voice_improvement.down.sql"))
    expect(await version("20261023000000")).toBe(0)
    await pg.exec(read("rollback", "20261020000000_voice_core.down.sql"))
    expect(await added()).toBe(0)
    expect(await version("20261020000000")).toBe(0)
    await pg.exec(read("migrations", "20261020000000_voice_core.sql"))
    await pg.exec(read("migrations", "20261023000000_voice_improvement.sql"))
    expect(await added()).toBe(VOICE_TABLES)
    const { rows } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rows).toEqual([])

    // F2: voice first, then the core; neither version stays recorded
    await pg.exec(read("rollback", "20261023000000_voice_improvement.down.sql"))
    await pg.exec(read("rollback", "20261020000000_voice_core.down.sql"))
    await pg.exec(read("rollback", "20261016000000_kriya_core.down.sql"))
    expect(await version("20261020000000")).toBe(0)
    expect(await version("20261016000000")).toBe(0)
    await pg.exec(read("migrations", "20261016000000_kriya_core.sql"))
    await pg.exec(read("migrations", "20261020000000_voice_core.sql"))
    await pg.exec(read("migrations", "20261023000000_voice_improvement.sql"))
    expect(await added()).toBe(VOICE_TABLES)
  })
})
