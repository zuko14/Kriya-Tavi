import { drizzle } from "drizzle-orm/pglite"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// A PGlite database for the harness API tests, with the harness switched on
// through the environment (the platform_settings table stays empty) and
// requests built the way the command-line client sends them.

export const VERSION = "0.1.0"

export function harnessEnv(over: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    KRIYA_HARNESS_API: "on",
    KRIYA_HARNESS_MIN_CLIENT_VERSION: "0.0.0",
    KRIYA_APP_URL: "https://kriya.example",
    ...over,
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

export async function harnessDb() {
  const pg: TestDb = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  return { pg, createUser: () => createUser(pg) }
}

let ip = 0
// A request as the client sends it: JSON, the version header, no Origin
export function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; version?: string | null; ip?: string } = {}
) {
  const headers: Record<string, string> = {
    "x-forwarded-for": options.ip ?? `10.0.0.${++ip % 250}`,
  }
  if (options.version !== null) headers["x-kriya-harness"] = options.version ?? VERSION
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers["content-type"] = "application/json"
  return new Request(`https://kriya.example/api/harness/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

// A signed-in device straight in the table (the sign-in flow is H2's tests)
export async function deviceFor(pg: TestDb, userId: string) {
  const { randomBytes, createHash } = await import("node:crypto")
  const token = randomBytes(32).toString("base64url")
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_devices (user_id, name, platform, token_hash)
     values ($1, 'laptop', 'darwin', $2) returning id`,
    [userId, createHash("sha256").update(token).digest("hex")]
  )
  return { token, deviceId: rows[0].id }
}
