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
})
