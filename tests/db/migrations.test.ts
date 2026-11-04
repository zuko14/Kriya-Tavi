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

    // Newest first: N9's vector columns sit on memories (track N)
    await pg.exec(read("rollback", "20270101000200_memory_embeddings.down.sql"))
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
    // Rollbacks run newest first: track R (R9, R7, R1), track H (H10, H1), track C (C1) and track N
    // (N1) use check_transition(); crews (O11) reference jobs; operator jobs
    // (O2) reference goals and use check_transition(), as do policy versions
    // (A12), radar (A13), ledger (A7), files (A5), skills (A9) and login
    // profiles (A6); obligations reference goals
    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    await pg.exec(read("rollback", "20270401000100_room_goals_notes.down.sql"))
    await pg.exec(read("rollback", "20270401000000_rooms.down.sql"))
    // The Control Center's tables reference harness_devices: rolled back first
    await pg.exec(read("rollback", "20270801000000_harness_control.down.sql"))
    await pg.exec(read("rollback", "20270301000200_harness_open_cap.down.sql"))
    await pg.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    await pg.exec(read("rollback", "20270301000000_harness.down.sql"))
    await pg.exec(read("rollback", "20270201000000_cloud_workspaces.down.sql"))
    await pg.exec(read("rollback", "20270101000300_mcp_connections.down.sql"))
    await pg.exec(read("rollback", "20270101000000_next_platform.down.sql"))
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
    await pg.exec(read("migrations", "20270101000000_next_platform.sql"))
    await pg.exec(read("migrations", "20270101000300_mcp_connections.sql"))
    await pg.exec(read("migrations", "20270201000000_cloud_workspaces.sql"))
    await pg.exec(read("migrations", "20270301000000_harness.sql"))
    await pg.exec(read("migrations", "20270301000100_harness_device_provider.sql"))
    await pg.exec(read("migrations", "20270301000200_harness_open_cap.sql"))
    await pg.exec(read("migrations", "20270801000000_harness_control.sql"))
    await pg.exec(read("migrations", "20270401000000_rooms.sql"))
    await pg.exec(read("migrations", "20270401000100_room_goals_notes.sql"))
    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
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

  it("NT-MIG-01 rolls the track N data model back with data in it and applies it again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270101000000')"
    )
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in
             ('mcp_servers', 'mcp_tools', 'mcp_enablements', 'delivery_checks')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'tool_executions' and column_name = 'risk'
           union all select proname from pg_proc where proname in
             ('mcp_tools_unauthenticated', 'mcp_servers_unauthenticated', 'mcp_tools_repin',
              'delivery_checks_owner', 'delivery_checks_frozen')
           union all select entity from kriya.allowed_transitions
             where entity in ('mcp_server', 'mcp_tool')`
        )
      ).rows.length
    // 4 tables, 1 column, 5 functions, 11 transitions
    expect(await added()).toBe(21)

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
    const { rows: tasks } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [user]
    )
    const { rows: runs } = await pg.query<{ id: string }>(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, risk)
       values ($1, $2, 1, 'c1', 'mcp_tracker_create_item', 'R2') returning id`,
      [tasks[0].id, user]
    )
    await pg.query(
      `insert into kriya.mcp_servers (id, name, url, auth, client_id, status)
       values ('tracker', 'Tracker', 'https://mcp.example.com/mcp', 'oauth_public', 'kriya', 'active')`
    )
    await pg.query(
      `insert into kriya.mcp_tools (server_id, name, kriya_name, definition, definition_hash, description, owner_risk)
       values ('tracker', 'create_item', 'mcp_tracker_create_item', '{}', repeat('a', 64), 'Create an item', 'R2')`
    )
    await pg.query(
      "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
      [user]
    )
    await pg.query(
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ($1, $2, $3, 'recheck', 'verified')`,
      [user, tasks[0].id, runs[0].id]
    )

    // Newest first: N6's sign-ins point at the registry
    await pg.exec(read("rollback", "20270101000300_mcp_connections.down.sql"))
    await pg.exec(read("rollback", "20270101000000_next_platform.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270101000000'"
    )
    expect(version).toEqual([])
    // The run itself stays; only its risk class goes
    const { rows: kept } = await pg.query("select tool_name from kriya.tool_executions")
    expect(kept).toEqual([{ tool_name: "mcp_tracker_create_item" }])

    await pg.exec(read("migrations", "20270101000000_next_platform.sql"))
    await pg.exec(read("migrations", "20270101000300_mcp_connections.sql"))
    expect(await added()).toBe(21)
    const { rows: rls } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rls).toEqual([])
  })

  it("NT-MIG-01 rolls memory embeddings back with vectors in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270101000200')"
    )
    const added = async () =>
      (
        await pg.query(
          `select column_name from information_schema.columns
           where table_schema = 'kriya' and table_name = 'memories'
             and column_name in ('embedding', 'embedding_model', 'embedded_at')`
        )
      ).rows.length
    expect(await added()).toBe(3)
    const guard = async () =>
      (await pg.query("select 1 from pg_proc where proname = 'memories_vector_guard'"))
        .rows.length
    expect(await guard()).toBe(1)
    const user = "00000000-0000-0000-0000-0000000000ac"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a', $1, 'A', 'r', 'g')",
      [user]
    )
    await pg.query(
      `insert into kriya.memories (id, user_id, agent_id, content, embedding, embedding_model, embedded_at)
       values ('n1', $1, 'a', 'likes tea', array_fill(0.5::real, array[64]), 'test/embed', now())`,
      [user]
    )
    await pg.query(
      "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1::uuid, 'embed_notes', $1::text)",
      [user]
    )
    // Too short a vector, or a kind that doesn't exist, is refused
    await expect(
      pg.query(
        "update kriya.memories set embedding = array[1, 2]::real[] where id = 'n1'"
      )
    ).rejects.toThrow()

    await pg.exec(read("rollback", "20270101000200_memory_embeddings.down.sql"))
    expect(await added()).toBe(0)
    expect(await guard()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270101000200'"
    )
    expect(version).toEqual([])
    // The note stays; only its vector and the embedding jobs go
    const { rows: notes } = await pg.query("select id, content from kriya.memories")
    expect(notes).toEqual([{ id: "n1", content: "likes tea" }])
    const { rows: jobs } = await pg.query("select 1 from kriya.maintenance_jobs")
    expect(jobs).toEqual([])
    await expect(
      pg.query(
        "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1, 'embed_notes', 'x')",
        [user]
      )
    ).rejects.toThrow()

    await pg.exec(read("migrations", "20270101000200_memory_embeddings.sql"))
    expect(await added()).toBe(3)
    await pg.query(
      "insert into kriya.maintenance_jobs (user_id, kind, ref) values ($1::uuid, 'embed_notes', $1::text)",
      [user]
    )
  })

  it("NT-MIG-01 rolls MCP sign-ins back with tokens in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270101000300')"
    )
    const exists = async () =>
      (
        await pg.query(
          "select 1 from pg_tables where schemaname = 'kriya' and tablename = 'mcp_connections'"
        )
      ).rows.length
    expect(await exists()).toBe(1)
    const user = "00000000-0000-0000-0000-0000000000ad"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      `insert into kriya.mcp_servers (id, name, url, auth, client_id, status)
       values ('tracker', 'Tracker', 'https://tracker.example.com/mcp', 'oauth_public', 'kriya', 'active')`
    )
    await pg.query(
      "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
      [user]
    )
    await pg.query(
      `insert into kriya.mcp_connections (id, user_id, server_id, access_token, refresh_token)
       values ('c1', $1, 'tracker', 'v2_deadbeef.x.y.z', 'v2_deadbeef.x.y.z')`,
      [user]
    )

    await pg.exec(read("rollback", "20270101000300_mcp_connections.down.sql"))
    expect(await exists()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270101000300'"
    )
    expect(version).toEqual([])
    // The person's app choice and the registry stay; only the tokens go
    const { rows: kept } = await pg.query("select server_id from kriya.mcp_enablements")
    expect(kept).toEqual([{ server_id: "tracker" }])

    await pg.exec(read("migrations", "20270101000300_mcp_connections.sql"))
    expect(await exists()).toBe(1)
    const { rows: rls } = await pg.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
    )
    expect(rls).toEqual([])
  })

  it("CT-DB-06 rolls cloud workspaces back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270201000000')"
    )
    // Everything about kriya's shape that the migration touches, in text
    const shape = async () =>
      (
        await pg.query<{ line: string }>(
          `select concat_ws(' ', table_name, column_name, data_type, column_default, is_nullable) as line
             from information_schema.columns where table_schema = 'kriya'
           union all select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
             from pg_constraint where connamespace = 'kriya'::regnamespace
           union all select indexdef from pg_indexes where schemaname = 'kriya'
           union all select polrelid::regclass || ' ' || polname from pg_policy
           union all select tgrelid::regclass || ' ' || tgname from pg_trigger
             where not tgisinternal and tgrelid::regclass::text like 'kriya.%'
           union all select p.oid::regprocedure::text from pg_proc p
             where p.pronamespace = 'kriya'::regnamespace
           union all select entity || ' ' || from_status || ' ' || to_status
             from kriya.allowed_transitions
           order by 1`
        )
      ).rows.map((r) => r.line)
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('workspaces', 'workspace_sessions')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'plans' and column_name = 'workspace_minutes'
           union all select proname from pg_proc where proname = 'open_workspace_session'
           union all select entity from kriya.allowed_transitions where entity = 'workspace'`
        )
      ).rows.length
    // 2 tables, 1 column, 1 function, 12 transitions
    expect(await added()).toBe(16)
    const before = await shape()

    const user = "00000000-0000-0000-0000-0000000000ae"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    const { rows: tasks } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [user]
    )
    await pg.query("update kriya.plans set workspace_minutes = 60 where id = 'free'")
    const { rows: ws } = await pg.query<{ id: string }>(
      `insert into kriya.workspaces (user_id, thread_id, provider, image, size)
       values ($1, 't1', 'local', 'kriya-runner', '2c-4g') returning id`,
      [user]
    )
    await pg.query(
      "select kriya.open_workspace_session(gen_random_uuid(), $1, $2, 'local', 3)",
      [tasks[0].id, ws[0].id]
    )
    await pg.query(
      `insert into kriya.resource_usage (request_key, user_id, task_id, kind, quantity) values
        ('ws:1', $1, $2, 'workspace_seconds', 60),
        ('ws-ckpt:1', $1, $2, 'workspace_storage_bytes', 1024),
        ('br:1', $1, $2, 'browser_seconds', 30)`,
      [user, tasks[0].id]
    )

    // Tracks R (R1) and H (H1) sort after it and are rolled back first, newest first
    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    await pg.exec(read("rollback", "20270401000100_room_goals_notes.down.sql"))
    await pg.exec(read("rollback", "20270401000000_rooms.down.sql"))
    // The Control Center's tables reference harness_devices: rolled back first
    await pg.exec(read("rollback", "20270801000000_harness_control.down.sql"))
    await pg.exec(read("rollback", "20270301000200_harness_open_cap.down.sql"))
    await pg.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    await pg.exec(read("rollback", "20270301000000_harness.down.sql"))
    await pg.exec(read("rollback", "20270201000000_cloud_workspaces.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270201000000'"
    )
    expect(version).toEqual([])
    // Other usage stays; the old kind check is back
    const { rows: usage } = await pg.query("select request_key from kriya.resource_usage")
    expect(usage).toEqual([{ request_key: "br:1" }])
    await expect(
      pg.query(
        "insert into kriya.resource_usage (request_key, kind, quantity) values ('ws:2', 'workspace_seconds', 1)"
      )
    ).rejects.toThrow(/resource_usage_kind_check/)

    await pg.exec(read("migrations", "20270201000000_cloud_workspaces.sql"))
    await pg.exec(read("migrations", "20270301000000_harness.sql"))
    await pg.exec(read("migrations", "20270301000100_harness_device_provider.sql"))
    await pg.exec(read("migrations", "20270301000200_harness_open_cap.sql"))
    await pg.exec(read("migrations", "20270801000000_harness_control.sql"))
    await pg.exec(read("migrations", "20270401000000_rooms.sql"))
    await pg.exec(read("migrations", "20270401000100_room_goals_notes.sql"))
    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await added()).toBe(16)
    expect(await shape()).toEqual(before)
  })

  it("HT-DB-06 rolls the harness tables back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270301000000')"
    )
    const shape = async () =>
      (
        await pg.query<{ line: string }>(
          `select concat_ws(' ', table_name, column_name, data_type, column_default, is_nullable) as line
             from information_schema.columns where table_schema = 'kriya'
           union all select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
             from pg_constraint where connamespace = 'kriya'::regnamespace
           union all select indexdef from pg_indexes where schemaname = 'kriya'
           union all select polrelid::regclass || ' ' || polname from pg_policy
           union all select tgrelid::regclass || ' ' || tgname from pg_trigger
             where not tgisinternal and tgrelid::regclass::text like 'kriya.%'
           union all select p.oid::regprocedure::text from pg_proc p
             where p.pronamespace = 'kriya'::regnamespace
           union all select entity || ' ' || from_status || ' ' || to_status
             from kriya.allowed_transitions
           order by 1`
        )
      ).rows.map((r) => r.line)
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('harness_devices', 'harness_device_codes',
             'harness_usage', 'harness_approval_requests', 'harness_sessions')
           union all select column_name from information_schema.columns
             where table_schema = 'kriya' and table_name = 'plans' and column_name = 'harness_monthly_micro_inr'
           union all select proname from pg_proc where proname = 'reserve_harness_spend'
           union all select entity from kriya.allowed_transitions where entity = 'harness_approval'`
        )
      ).rows.length
    // 5 tables, 1 column, 1 function, 4 transitions
    expect(await added()).toBe(11)
    const before = await shape()

    const user = "00000000-0000-0000-0000-0000000000af"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    const { rows: devices } = await pg.query<{ id: string }>(
      `insert into kriya.harness_devices (user_id, agent_id, name, platform, token_hash)
       values ($1, 'a1', 'laptop', 'linux', repeat('a', 64)) returning id`,
      [user]
    )
    const d = devices[0].id
    await pg.query(
      `insert into kriya.harness_device_codes (device_code_hash, user_code, device_name, platform, expires_at, device_id)
       values (repeat('b', 64), 'ABCD2345', 'laptop', 'linux', now(), $1)`,
      [d]
    )
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 1000 where id = 'free'"
    )
    await pg.query(
      "select kriya.reserve_harness_spend($1, $2, 'r1', 'budget', 'm', 10)",
      [user, d]
    )
    await pg.query(
      `insert into kriya.harness_approval_requests (user_id, device_id, tool, summary, expires_at)
       values ($1, $2, 'shell', 'Run tests', now())`,
      [user, d]
    )
    await pg.query(
      "insert into kriya.harness_sessions (user_id, device_id, thread_id, device_session_id) values ($1, $2, 't1', 's1')",
      [user, d]
    )

    // Track R (R1) sorts after it and is rolled back first
    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    await pg.exec(read("rollback", "20270401000100_room_goals_notes.down.sql"))
    await pg.exec(read("rollback", "20270401000000_rooms.down.sql"))
    // The Control Center's tables reference harness_devices: rolled back first
    await pg.exec(read("rollback", "20270801000000_harness_control.down.sql"))
    await pg.exec(read("rollback", "20270301000200_harness_open_cap.down.sql"))
    await pg.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    await pg.exec(read("rollback", "20270301000000_harness.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270301000000'"
    )
    expect(version).toEqual([])
    // Everything else stays
    const { rows: threads } = await pg.query(
      "select id from kriya.threads where user_id = $1",
      [user]
    )
    expect(threads).toEqual([{ id: "t1" }])

    await pg.exec(read("migrations", "20270301000000_harness.sql"))
    await pg.exec(read("migrations", "20270301000100_harness_device_provider.sql"))
    await pg.exec(read("migrations", "20270301000200_harness_open_cap.sql"))
    await pg.exec(read("migrations", "20270801000000_harness_control.sql"))
    await pg.exec(read("migrations", "20270401000000_rooms.sql"))
    await pg.exec(read("migrations", "20270401000100_room_goals_notes.sql"))
    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await added()).toBe(11)
    expect(await shape()).toEqual(before)
  })

  it("RT-DB-08 rolls the rooms back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270401000000')"
    )
    const shape = async () =>
      (
        await pg.query<{ line: string }>(
          `select concat_ws(' ', table_name, column_name, data_type, column_default, is_nullable) as line
             from information_schema.columns where table_schema = 'kriya'
           union all select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
             from pg_constraint where connamespace = 'kriya'::regnamespace
           union all select indexdef from pg_indexes where schemaname = 'kriya'
           union all select polrelid::regclass || ' ' || polname from pg_policy
           union all select tgrelid::regclass || ' ' || tgname from pg_trigger
             where not tgisinternal and tgrelid::regclass::text like 'kriya.%'
           union all select p.oid::regprocedure::text from pg_proc p
             where p.pronamespace = 'kriya'::regnamespace
           union all select entity || ' ' || from_status || ' ' || to_status
             from kriya.allowed_transitions
           order by 1`
        )
      ).rows.map((r) => r.line)
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('rooms', 'room_members', 'room_invites',
             'room_agents', 'room_messages', 'room_invocations', 'room_disclosures')
           union all select proname from pg_proc where proname in ('room_role', 'is_room_member',
             'rooms_owner_member', 'room_messages_seq', 'room_members_guard', 'join_room',
             'check_room_invocation')
           union all select entity from kriya.allowed_transitions where entity = 'room_disclosure'`
        )
      ).rows.length
    // 7 tables, 7 functions, 2 transitions
    expect(await added()).toBe(16)
    const before = await shape()

    const user = "00000000-0000-0000-0000-0000000000b0"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'L', 'r', 'g')",
      [user]
    )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    const { rows: rooms } = await pg.query<{ id: string }>(
      "insert into kriya.rooms (created_by, title) values ($1, 'Plan') returning id",
      [user]
    )
    const r = rooms[0].id
    await pg.query(
      "insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at) values ($1, $2, repeat('c', 64), 2, now() + interval '1 day')",
      [r, user]
    )
    await pg.query(
      "insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ($1, 'a1', $2, 't1')",
      [r, user]
    )
    await pg.query(
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'hi')",
      [r, user]
    )
    await pg.query(
      "insert into kriya.room_invocations (room_id, agent_id, owner_id, requested_by) values ($1, 'a1', $2, $2)",
      [r, user]
    )
    await pg.query(
      "insert into kriya.room_disclosures (room_id, owner_id, agent_id, body) values ($1, $2, 'a1', 'x')",
      [r, user]
    )

    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    await pg.exec(read("rollback", "20270401000100_room_goals_notes.down.sql"))
    await pg.exec(read("rollback", "20270401000000_rooms.down.sql"))
    expect(await added()).toBe(0)
    const { rows: version } = await pg.query(
      "select 1 from supabase_migrations.schema_migrations where version = '20270401000000'"
    )
    expect(version).toEqual([])
    // The bridge thread and the agent stay
    const { rows: threads } = await pg.query(
      "select id from kriya.threads where user_id = $1",
      [user]
    )
    expect(threads).toEqual([{ id: "t1" }])

    await pg.exec(read("migrations", "20270401000000_rooms.sql"))
    await pg.exec(read("migrations", "20270401000100_room_goals_notes.sql"))
    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await added()).toBe(16)
    expect(await shape()).toEqual(before)
  })
})

describe("20270401000100_room_goals_notes (track R, R7)", () => {
  it("rolls goals and notes back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270401000100')"
    )
    const shape = async () =>
      (
        await pg.query<{ line: string }>(
          `select concat_ws(' ', table_name, column_name, data_type, column_default, is_nullable) as line
             from information_schema.columns where table_schema = 'kriya'
           union all select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
             from pg_constraint where connamespace = 'kriya'::regnamespace
           union all select indexdef from pg_indexes where schemaname = 'kriya'
           union all select polrelid::regclass || ' ' || polname from pg_policy
           union all select tgrelid::regclass || ' ' || tgname from pg_trigger
             where not tgisinternal and tgrelid::regclass::text like 'kriya.%'
           union all select p.oid::regprocedure::text from pg_proc p
             where p.pronamespace = 'kriya'::regnamespace
           union all select entity || ' ' || from_status || ' ' || to_status
             from kriya.allowed_transitions
           order by 1`
        )
      ).rows.map((r) => r.line)
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('room_goals', 'room_goal_items', 'room_notes')
           union all select proname from pg_proc where proname = 'room_goal_items_guard'
           union all select entity from kriya.allowed_transitions where entity = 'room_goal'`
        )
      ).rows.length
    // 3 tables, 1 function, 4 transitions
    expect(await added()).toBe(8)
    const before = await shape()

    const user = "00000000-0000-0000-0000-0000000000c0"
    await pg.query("insert into auth.users (id) values ($1)", [user])
    const { rows: rooms } = await pg.query<{ id: string }>(
      "insert into kriya.rooms (created_by, title) values ($1, 'Launch') returning id",
      [user]
    )
    const r = rooms[0].id
    await pg.query(
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'hi')",
      [r, user]
    )
    const { rows: goals } = await pg.query<{ id: string }>(
      "insert into kriya.room_goals (room_id, title, created_by) values ($1, 'Launch ready', $2) returning id",
      [r, user]
    )
    await pg.query(
      "insert into kriya.room_goal_items (goal_id, room_id, text, created_by, confirmed_by) values ($1, $2, 'Price sheet', $3, $3)",
      [goals[0].id, r, user]
    )
    await pg.query(
      "insert into kriya.room_notes (room_id, body, author_kind, user_id) values ($1, 'Venue: Hall B', 'human', $2)",
      [r, user]
    )

    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    await pg.exec(read("rollback", "20270401000100_room_goals_notes.down.sql"))
    expect(await added()).toBe(0)
    expect(
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = '20270401000100'"
        )
      ).rows
    ).toEqual([])
    // The room and its messages stay
    expect(
      (await pg.query("select body from kriya.room_messages where room_id = $1", [r]))
        .rows
    ).toEqual([{ body: "hi" }])

    await pg.exec(read("migrations", "20270401000100_room_goals_notes.sql"))
    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await added()).toBe(8)
    expect(await shape()).toEqual(before)
  })
})

describe("20270401000200_room_moderation (track R, R9)", () => {
  it("rolls blocks and reports back with data in them and applies them again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270401000200')"
    )
    const shape = async () =>
      (
        await pg.query<{ line: string }>(
          `select concat_ws(' ', table_name, column_name, data_type, column_default, is_nullable) as line
             from information_schema.columns where table_schema = 'kriya'
           union all select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
             from pg_constraint where connamespace = 'kriya'::regnamespace
           union all select indexdef from pg_indexes where schemaname = 'kriya'
           union all select polrelid::regclass || ' ' || polname from pg_policy
           union all select tgrelid::regclass || ' ' || tgname from pg_trigger
             where not tgisinternal and tgrelid::regclass::text like 'kriya.%'
           union all select p.oid::regprocedure::text from pg_proc p
             where p.pronamespace = 'kriya'::regnamespace
           union all select entity || ' ' || from_status || ' ' || to_status
             from kriya.allowed_transitions
           order by 1`
        )
      ).rows.map((r) => r.line)
    const added = async () =>
      (
        await pg.query(
          `select relname from pg_class where relname in ('person_blocks', 'room_reports')
           union all select proname from pg_proc where proname in ('room_reports_fill', 'invite_blocked')
           union all select entity from kriya.allowed_transitions where entity = 'room_report'`
        )
      ).rows.length
    // 2 tables, 2 functions, 2 transitions
    expect(await added()).toBe(6)
    const before = await shape()

    const user = "00000000-0000-0000-0000-0000000000d0"
    const other = "00000000-0000-0000-0000-0000000000d1"
    await pg.query("insert into auth.users (id) values ($1), ($2)", [user, other])
    const { rows: rooms } = await pg.query<{ id: string }>(
      "insert into kriya.rooms (created_by, title) values ($1, 'Launch') returning id",
      [user]
    )
    const r = rooms[0].id
    const { rows: messages } = await pg.query<{ id: string }>(
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'hi') returning id",
      [r, user]
    )
    await pg.query(
      "insert into kriya.person_blocks (blocker_id, blocked_id) values ($1, $2)",
      [user, other]
    )
    await pg.query(
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason) values ($1, $2, $3, 'spam')",
      [r, messages[0].id, user]
    )

    // The self-hosted fabric (SH1) widens the provider checks and references workspaces
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270401000200_room_moderation.down.sql"))
    expect(await added()).toBe(0)
    expect(
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = '20270401000200'"
        )
      ).rows
    ).toEqual([])
    // The room and its messages stay
    expect(
      (await pg.query("select body from kriya.room_messages where room_id = $1", [r]))
        .rows
    ).toEqual([{ body: "hi" }])

    await pg.exec(read("migrations", "20270401000200_room_moderation.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await added()).toBe(6)
    expect(await shape()).toEqual(before)
  })
})

describe("20270301000100_harness_device_provider (track H, H10, PX-06)", () => {
  it("widens the provider checks to 'device', rolls back and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270301000100')"
    )
    const checks = async () =>
      (
        await pg.query<{ line: string }>(
          `select conrelid::regclass || ' ' || pg_get_constraintdef(oid) as line
             from pg_constraint
            where conname in ('workspaces_provider_check', 'workspace_sessions_provider_check')
            order by 1`
        )
      ).rows.map((r) => r.line)
    const after = await checks()
    expect(after).toHaveLength(2)
    for (const line of after) expect(line).toContain("'device'")

    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    await pg.exec(read("rollback", "20270301000200_harness_open_cap.down.sql"))
    await pg.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    const before = await checks()
    expect(before).toHaveLength(2)
    for (const line of before) expect(line).not.toContain("'device'")
    expect(
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = '20270301000100'"
        )
      ).rows
    ).toEqual([])

    await pg.exec(read("migrations", "20270301000100_harness_device_provider.sql"))
    await pg.exec(read("migrations", "20270301000200_harness_open_cap.sql"))
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await checks()).toEqual(after)
  })
})

describe("20270301000200_harness_open_cap (track H, re-audit 2026-11-02)", () => {
  it("adds the open-answers limit to reserve_harness_spend, rolls back and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270301000200')"
    )
    const body = async () =>
      (
        await pg.query<{ src: string }>(
          "select prosrc as src from pg_proc where proname = 'reserve_harness_spend'"
        )
      ).rows.map((r) => r.src)
    const after = await body()
    expect(after).toHaveLength(1)
    expect(after[0]).toContain("harness too many open")

    await pg.exec(read("rollback", "20270301000200_harness_open_cap.down.sql"))
    const before = await body()
    expect(before).toHaveLength(1)
    expect(before[0]).not.toContain("harness too many open")
    expect(before[0]).toContain("harness cap reached")
    expect(
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = '20270301000200'"
        )
      ).rows
    ).toEqual([])

    await pg.exec(read("migrations", "20270301000200_harness_open_cap.sql"))
    expect(await body()).toEqual(after)
  })
})

describe("20270501000000_cloud_fabric (track C extension, SH1)", () => {
  it("CT-SH-DB-15 refuses to roll back over self-hosted workspaces, rolls back empty and applies again", async () => {
    const read = (dir: string, file: string) =>
      fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")
    const pg = await createTestDb()
    await pg.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key); insert into supabase_migrations.schema_migrations values ('20270501000000')"
    )
    const present = async () =>
      (
        await pg.query(
          `select relname as name from pg_class where relname in ('exec_nodes', 'exec_leases')
           union all select proname from pg_proc where proname in ('exec_request', 'exec_admit', 'exec_metrics')`
        )
      ).rows.length
    expect(await present()).toBe(5)
    const { rows } = await pg.query<{ id: string }>(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'f@test.local') returning id"
    )
    await pg.query(
      "insert into kriya.workspaces (user_id, provider, image, size) values ($1, 'selfhosted', 'i', '2c-4g')",
      [rows[0].id]
    )
    await expect(
      pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    ).rejects.toThrow(/selfhosted workspaces/)
    expect(await present()).toBe(5)
    await pg.query("delete from kriya.workspaces")
    await pg.exec(read("rollback", "20270501000000_cloud_fabric.down.sql"))
    expect(await present()).toBe(0)
    expect(
      (
        await pg.query(
          "select 1 from supabase_migrations.schema_migrations where version = '20270501000000'"
        )
      ).rows
    ).toEqual([])
    await pg.exec(read("migrations", "20270501000000_cloud_fabric.sql"))
    expect(await present()).toBe(5)
  })
})
