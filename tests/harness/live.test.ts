import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Remote Control (REMOTE_CONTROL.md), HT-RC-*: POST /live on the real route
// over PGlite, and the person's reads.

vi.mock("server-only", () => ({}))

import { POST as liveRoute } from "@/app/api/harness/v1/live/route"
import { LIVE_KEEP, liveFeed, liveSessions } from "@/lib/harness/live"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let bob: string
let mine: { token: string; deviceId: string }

const report = (over: Record<string, unknown> = {}) => ({
  deviceSessionId: "session-1",
  title: "Fix the login page",
  project: "app",
  remote: true,
  state: "running",
  events: [
    { seq: 0, at: Date.now(), kind: "user", text: "Fix it" },
    {
      seq: 1,
      at: Date.now(),
      kind: "tool_start",
      callId: "c1",
      tool: "edit",
      target: "src/a.ts",
    },
  ],
  ...over,
})
const send = (body: unknown, token = mine.token) =>
  liveRoute(call("POST", "/live", { token, body }))

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  bob = await db.createUser()
  mine = await deviceFor(pg, alice)
})

beforeEach(() => {
  harnessEnv({ KRIYA_HARNESS_REMOTE_CONTROL: "on" })
})

describe("HT-RC-01: POST /live", () => {
  it("answers 404 with the switch off", async () => {
    harnessEnv({ KRIYA_HARNESS_REMOTE_CONTROL: "off" })
    expect((await send(report())).status).toBe(404)
  })

  it("stores a session once and each event once", async () => {
    expect((await send(report())).status).toBe(204)
    expect((await send(report({ state: "waiting" }))).status).toBe(204)
    const [row] = await liveSessions(alice)
    expect(row).toMatchObject({
      title: "Fix the login page",
      state: "waiting",
      remote: true,
    })
    const feed = await liveFeed(alice, row.id, -1)
    expect(feed?.events.map((e) => e.seq)).toEqual([0, 1])
    expect((await liveFeed(alice, row.id, 0))?.events.map((e) => e.seq)).toEqual([1])
  })

  it("never shows one person's session to another", async () => {
    await send(report())
    const [row] = await liveSessions(alice)
    expect(await liveSessions(bob)).toEqual([])
    expect(await liveFeed(bob, row.id, -1)).toBeNull()
  })

  it("reflects the switch going off", async () => {
    await send(report({ remote: false, state: "ended", events: [] }))
    expect((await liveSessions(alice))[0]).toMatchObject({
      remote: false,
      state: "ended",
    })
  })

  it("refuses a body outside the contract", async () => {
    expect((await send({ ...report(), userId: bob })).status).toBe(400)
    expect(
      (await send(report({ events: [{ seq: 0, at: 1, kind: "shell" }] }))).status
    ).toBe(400)
  })

  it("keeps only the newest events", async () => {
    const seq = LIVE_KEEP + 5
    await send(
      report({
        deviceSessionId: "long",
        events: [{ seq, at: Date.now(), kind: "assistant", text: "done" }],
      })
    )
    await send(report({ deviceSessionId: "long", events: [] }))
    const row = (await liveSessions(alice)).find((r) => r.remote)!
    const feed = await liveFeed(alice, row.id, -1)
    expect(feed?.events.length).toBeGreaterThan(0)
    expect(feed?.events.every((e) => e.seq > seq - LIVE_KEEP)).toBe(true)
  })
})
