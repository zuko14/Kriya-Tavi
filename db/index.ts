import { sql } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

// Supabase Postgres. Two ways in:
//
// - withUser(userId, fn) runs fn in a transaction as the `authenticated`
//   role with the user's id as the JWT subject, so every query is bound by
//   Row Level Security. Use it for anything done on a person's behalf.
// - privileged bypasses RLS. Only the worker's bookkeeping, metering, billing
//   webhooks and owner tools use it, each behind its own authorization check.

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0]
// Either a connection or a transaction
export type Q = DB | Tx

function open(): DB {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is not set. See docs/kriya/deployment.md.")
  const client = postgres(url, {
    // Supabase's transaction pooler (port 6543) doesn't keep prepared statements
    prepare: false,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
  })
  return drizzle({ client, schema, casing: "snake_case" }) as unknown as DB
}

// One pool per process, kept across dev-server hot reloads. Opened on first
// use: `next build` imports every route and must not need a database.
const globalForDb = globalThis as unknown as { __kriyaDb?: DB }

function connection() {
  return (globalForDb.__kriyaDb ??= open())
}

// Tests swap in an in-process Postgres (PGlite)
export function setDatabaseForTests(db: DB) {
  globalForDb.__kriyaDb = db
}

function lazy<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_, property) {
      const target = get()
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export const privileged: DB = lazy(connection)

// Rows of a raw `execute`: postgres-js returns an array, PGlite { rows }
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}

export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>) {
  return privileged.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" })
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`)
    await tx.execute(sql`set local role authenticated`)
    return fn(tx)
  })
}
