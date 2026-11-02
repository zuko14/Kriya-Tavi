import { drizzle } from "drizzle-orm/pglite"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// R2: the room actions against PGlite. Each test file mocks the session
// and the client address; rooms are switched on through the environment
// (platform_settings stays empty).

export function roomsEnv(over: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { KRIYA_ROOMS_ENABLED: "on", ...over }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

export async function roomsDb() {
  const pg: TestDb = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  return { pg, createUser: () => createUser(pg) }
}

// The token from an invite link
export const tokenOf = (url: string) => url.split("/rooms/join/")[1]
