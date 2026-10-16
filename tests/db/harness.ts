import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { PGlite } from "@electric-sql/pglite"

// A throwaway Postgres (PGlite, in-process) with the parts of Supabase the
// migrations depend on: the auth schema, auth.uid() and the API roles.
const SUPABASE_SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;
grant usage on schema auth to anon, authenticated;
`

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations")

export async function createTestDb() {
  const pg = new PGlite()
  await pg.exec(SUPABASE_SHIM)
  for (const file of fs.readdirSync(MIGRATIONS).sort()) {
    await pg.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"))
  }
  return pg
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>

export async function createUser(pg: TestDb, email = `${randomUUID()}@test.local`) {
  const id = randomUUID()
  await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, email])
  return id
}

// Runs `fn` as an authenticated user, exactly as db/index.ts withUser does
export async function asUser<T>(
  pg: TestDb,
  userId: string,
  fn: (tx: Pick<TestDb, "query" | "exec">) => Promise<T>
) {
  return pg.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
    await tx.exec("set local role authenticated")
    return fn(tx)
  })
}
