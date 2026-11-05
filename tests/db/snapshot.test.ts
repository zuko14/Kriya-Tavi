import { describe, expect, it } from "vitest"

import { createTestDb, migratedTestDb, type TestDb } from "./harness"

// The restored test database must be the migrated one, or every database test
// would be checking the wrong thing. Compares what RLS and the tests rely on.

const shape = async (pg: TestDb) => {
  const rows = async (query: string) => (await pg.query(query)).rows
  return {
    columns: await rows(
      `select table_schema, table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema in ('kriya', 'auth')
       order by 1, 2, 3`
    ),
    policies: await rows(
      `select tablename, policyname, cmd, roles::text, qual, with_check
       from pg_policies order by 1, 2`
    ),
    rls: await rows(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' order by 1`
    ),
    triggers: await rows(
      `select tgname, tgrelid::regclass::text as on_table from pg_trigger
       where not tgisinternal order by 1, 2`
    ),
    functions: await rows(
      `select p.proname, md5(p.prosrc) as body from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'kriya' order by 1, 2`
    ),
    grants: await rows(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'kriya' order by 1, 2, 3`
    ),
    seeds: await rows(
      `select (select count(*)::int from kriya.plans) as plans,
        (select count(*)::int from kriya.allowed_transitions) as transitions`
    ),
  }
}

describe("the test database snapshot", () => {
  it("is in use, and matches a database built by migrating", async () => {
    expect(process.env.KRIYA_TEST_DB_SNAPSHOT).toBeTruthy()
    const [restored, migrated] = await Promise.all([createTestDb(), migratedTestDb()])
    expect(await shape(restored)).toEqual(await shape(migrated))
  })

  it("gives each test its own database", async () => {
    const [a, b] = await Promise.all([createTestDb(), createTestDb()])
    await a.query("delete from kriya.allowed_transitions")
    const { rows } = await b.query<{ n: number }>(
      "select count(*)::int as n from kriya.allowed_transitions"
    )
    expect(rows[0].n).toBeGreaterThan(0)
  })
})
