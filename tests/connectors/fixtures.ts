import { randomBytes } from "node:crypto"

import { drizzle } from "drizzle-orm/pglite"
import { vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { saveConnection } from "@/lib/connectors"

import { createTestDb, createUser } from "../db/harness"

// Connector tests answer every HTTP request from fixtures; nothing leaves
// the machine (TEST_AND_EVALUATION §1). The bodies are hand-written from the
// providers' documented response shapes with synthetic ids and names: no
// live call was made (the OAuth apps don't exist yet, AB-06). Re-record
// redacted live responses here before live use.

export type Fixture = { method?: string; url: RegExp; status?: number; body?: unknown }
export type Call = {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

const parse = (body: unknown) => {
  if (typeof body !== "string") return body ?? null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

// Each fixture answers one matching request, first match first; an
// unmatched request fails the test
export function serve(fixtures: Fixture[]) {
  const calls: Call[] = []
  const queue = [...fixtures]
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = init?.method ?? "GET"
      calls.push({
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: parse(init?.body),
      })
      const i = queue.findIndex((f) => (f.method ?? "GET") === method && f.url.test(url))
      if (i < 0) throw new Error(`No fixture for ${method} ${url}`)
      const [f] = queue.splice(i, 1)
      return new Response(f.body === undefined ? null : JSON.stringify(f.body), {
        status: f.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    })
  )
  return calls
}

export const TOKEN = (provider: string) => `test-token-${provider}`

// A throwaway database with one person whose accounts are connected
export async function connectedUser(providers: schema.ConnectionProvider[]) {
  process.env.KRIYA_TOKEN_KEY ??= randomBytes(32).toString("base64")
  const pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  const userId = await createUser(pg)
  for (const provider of providers) {
    await saveConnection(userId, provider, {
      accessToken: TOKEN(provider),
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      account: "test-account",
    })
  }
  return { pg, userId }
}

export const REPO = "octo-org/kriya-demo"
