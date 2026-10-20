import { drizzle } from "drizzle-orm/pglite"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { POST } from "@/app/api/voice/exotel/status/[token]/route"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { mockTelephony } from "@/lib/voice/mock"
import { hashToken } from "@/lib/voice/streams"
import { registerTelephony } from "@/lib/voice/verify"
import { proxy } from "@/proxy"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, voiceCall, voiceTask } from "../db/voice-fixtures"

// The status webhook route and its proxy exemption (voice phase 3)

let pg: TestDb
let attemptId: string

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  registerTelephony(mockTelephony({ id: "route", provider_script: [] }))
  const user = await createUser(pg)
  const task = await voiceTask(pg, user, { status: "in_progress" })
  const call = await voiceCall(pg, user, task, { status: "dialing" })
  attemptId = await callAttempt(pg, user, call, {
    status: "initiated",
    telephony_provider: "mock",
    provider_call_id: "mock-route-1",
    callback_token_hash: hashToken("the-token"),
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
})

const post = (token: string, body: string) =>
  POST(
    new Request(`https://kriya.test/api/voice/exotel/status/${token}`, {
      method: "POST",
      body,
    }),
    { params: Promise.resolve({ token }) }
  )

describe("POST /api/voice/exotel/status/[token]", () => {
  const ringing = JSON.stringify({
    CallSid: "mock-route-1",
    Status: "ringing",
    EventId: "route-ringing",
  })

  it("answers 404 for an unknown token and stores nothing", async () => {
    expect((await post("nope", ringing)).status).toBe(404)
    expect((await pg.query("select 1 from kriya.call_events")).rows).toEqual([])
  })

  it("refuses a body over 64 KB", async () => {
    expect((await post("the-token", "x".repeat(64_001))).status).toBe(413)
  })

  it("refuses an event for another call", async () => {
    const other = JSON.stringify({
      CallSid: "mock-other",
      Status: "ringing",
      EventId: "x",
    })
    expect((await post("the-token", other)).status).toBe(400)
  })

  it("stores the event and moves the attempt", async () => {
    expect((await post("the-token", ringing)).status).toBe(200)
    const { rows } = await pg.query(
      "select status from kriya.call_attempts where id = $1",
      [attemptId]
    )
    expect(rows).toEqual([{ status: "ringing" }])
  })
})

describe("T-WH-04 proxy exempts exactly the webhook prefix from the Origin check", () => {
  const request = (path: string, origin?: string) =>
    proxy(
      new NextRequest(`https://kriya.test${path}`, {
        method: "POST",
        headers: origin ? { origin } : {},
      })
    )

  beforeAll(() => {
    // Without Supabase config the proxy stops after the Origin check
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
  })

  it("lets the provider post status webhooks without an Origin", async () => {
    expect((await request("/api/voice/exotel/status/abc")).status).toBe(200)
    expect((await request("/api/billing/webhook")).status).toBe(200)
  })

  it("still refuses other cross-site posts, including look-alike paths", async () => {
    for (const path of [
      "/api/voice/exotel/statusx",
      "/api/voice/exotel/other",
      "/api/voice/tasks",
      "/api/threads/t1/turn",
    ]) {
      expect((await request(path)).status, path).toBe(403)
      expect((await request(path, "https://evil.test")).status, path).toBe(403)
    }
    expect((await request("/api/threads/t1/turn", "https://kriya.test")).status).toBe(200)
  })
})
