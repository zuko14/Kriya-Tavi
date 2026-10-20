import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// The Supabase database advisors' security lints, kept at zero
// (migration 20261115000000_database_lint.sql): a function or a table added
// later without them fails here, not in the dashboard.

let pg: TestDb

beforeAll(async () => {
  pg = await createTestDb()
})

describe("database lints", () => {
  it("0011: every kriya function pins its search_path", async () => {
    const { rows } = await pg.query<{ fn: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'kriya'
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
       order by 1`
    )
    expect(rows).toEqual([])
  })

  it("0008: every kriya table with RLS has a policy", async () => {
    const { rows } = await pg.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kriya' and c.relkind = 'r' and c.relrowsecurity
         and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
       order by 1`
    )
    expect(rows).toEqual([])
  })

  it("the server-only policies still let no client role in", async () => {
    const user = await createUser(pg)
    await pg.query(
      "insert into kriya.platform_settings (key, value) values ('fx.source', 'test')"
    )
    const seen = await asUser(pg, user, async (tx) =>
      tx
        .query("select 1 from kriya.platform_settings")
        .then((r) => r.rows.length)
        .catch(() => "denied")
    )
    // No grant (denied) or no visible row: either way nothing leaks
    expect([0, "denied"]).toContain(seen)
  })

  it("the guarded functions still work with an empty search_path", async () => {
    const { rows } = await pg.query<{ fy: string }>(
      "select kriya.financial_year('2026-10-20') as fy"
    )
    expect(rows).toEqual([{ fy: "2026-27" }])
  })
})
