import { randomBytes, randomUUID } from "node:crypto"

import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { chunks } from "@/lib/voice/audio"
import { connectMockStream } from "@/lib/voice/mock"
import { hashToken } from "@/lib/voice/streams"
import { createVoiceService, type Call } from "@/voice/index"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, voiceCall, voiceTask } from "../db/voice-fixtures"

// kriya-voice on an ephemeral port, with the provider played by the mock
// stream client and the attempts in PGlite (TEST_STRATEGY.md §1). No
// network beyond localhost, no real seconds of waiting.

const SECRET = "stream-secret-".padEnd(48, "s")
let pg: TestDb
let user: string
let service: Awaited<ReturnType<typeof createVoiceService>>
const calls: Call[] = []

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  service = await createVoiceService({
    streamSecret: SECRET,
    instance: "voice-test",
    startTimeoutMs: 300,
    drainSeconds: 5,
    onCall: (call) => void calls.push(call),
  })
})

afterAll(async () => {
  await service?.close()
})

async function attempt(status = "ringing") {
  const token = randomBytes(32).toString("hex")
  const callSid = `CA-${randomUUID()}`
  const task = await voiceTask(pg, user, { status: "in_progress" })
  const call = await voiceCall(pg, user, task, { status: "dialing" })
  const id = await callAttempt(pg, user, call, {
    status,
    provider_call_id: callSid,
    stream_token_hash: hashToken(token),
  })
  return { id, token, callSid }
}

const stream = (id: string) =>
  pg
    .query<{ used: boolean; owner: string | null; status: string }>(
      "select stream_token_used_at is not null as used, stream_owner as owner, status from kriya.call_attempts where id = $1",
      [id]
    )
    .then((r) => r.rows[0])

const callFor = (attemptId: string) =>
  vi.waitFor(() => {
    const call = calls.find((c) => c.attemptId === attemptId)
    if (!call) throw new Error("not connected yet")
    return call
  })

async function connect(status = "ringing") {
  const a = await attempt(status)
  const client = await connectMockStream({
    url: service.mediaUrl,
    secret: SECRET,
    token: a.token,
    callSid: a.callSid,
  })
  return { ...a, client, call: await callFor(a.id) }
}

const sine = (samples: number) =>
  Int16Array.from({ length: samples }, (_, i) => Math.round(3000 * Math.sin(i / 3)))

const basic = (secret: string) =>
  `Basic ${Buffer.from(`kriya:${secret}`).toString("base64")}`

describe("kriya-voice", () => {
  it("reports health", async () => {
    const res = await fetch(`${service.url}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, accepting: true })
  })

  describe("T-SEC-01 stream authorization", () => {
    it("refuses a stream without Basic auth, or with the wrong secret", async () => {
      const a = await attempt()
      for (const secret of [undefined, "wrong-".padEnd(48, "w"), ""]) {
        await expect(
          connectMockStream({
            url: service.mediaUrl,
            secret,
            token: a.token,
            callSid: a.callSid,
          })
        ).rejects.toMatchObject({ status: 401 })
      }
      expect(await stream(a.id)).toEqual({ used: false, owner: null, status: "ringing" })
    })

    it("refuses other paths", async () => {
      const a = await attempt()
      await expect(
        connectMockStream({
          url: `${service.url.replace("http", "ws")}/media/plivo`,
          secret: SECRET,
          token: a.token,
          callSid: a.callSid,
        })
      ).rejects.toMatchObject({ status: 404 })
    })

    it("closes the stream for a wrong call_sid, an unknown token or an attempt not dialed", async () => {
      const a = await attempt()
      const b = await attempt("created")
      for (const [token, callSid] of [
        [a.token, "CA-someone-else"],
        [randomBytes(32).toString("hex"), a.callSid],
        [b.token, b.callSid],
      ]) {
        const client = await connectMockStream({
          url: service.mediaUrl,
          secret: SECRET,
          token,
          callSid,
        })
        expect((await client.closed).code).toBe(1008)
      }
      expect(await stream(a.id)).toMatchObject({ used: false, owner: null })
      expect(await stream(b.id)).toMatchObject({ used: false, status: "created" })
      expect(calls.some((c) => c.attemptId === a.id || c.attemptId === b.id)).toBe(false)
    })

    it("accepts a token once", async () => {
      const first = await connect()
      expect(await stream(first.id)).toEqual({
        used: true,
        owner: "voice-test",
        status: "ringing",
      })
      const again = await connectMockStream({
        url: service.mediaUrl,
        secret: SECRET,
        token: first.token,
        callSid: first.callSid,
      })
      expect((await again.closed).code).toBe(1008)
      expect(calls.filter((c) => c.attemptId === first.id)).toHaveLength(1)
      first.client.stop()
      await first.client.closed
    })

    it("closes a stream that never sends start", async () => {
      const socket = new WebSocket(service.mediaUrl, {
        headers: { authorization: basic(SECRET) },
      })
      const code = await new Promise((resolve) => socket.on("close", resolve))
      expect(code).toBe(1008)
    })
  })

  describe("a connected stream", () => {
    it("passes the callee's audio and keys through", async () => {
      const { client, call } = await connect()
      const reader = call.events.getReader()
      const pcm = sine(1600)
      client.sendAudio(pcm)
      client.dtmf("7")
      expect(await reader.read()).toEqual({
        done: false,
        value: { type: "audio", pcm: chunks(pcm)[0], timestampMs: 0 },
      })
      expect((await reader.read()).value).toEqual({ type: "dtmf", digit: "7" })
      client.stop()
      expect((await reader.read()).value).toEqual({ type: "stop", reason: "callended" })
      expect((await reader.read()).done).toBe(true)
      expect((await client.closed).code).toBe(1000)
    })

    it("keeps at most two chunks ahead of playback, then reports its own marks", async () => {
      const { client, call } = await connect()
      const reader = call.events.getReader()
      call.play(sine(5 * 1600))
      call.mark("sentence-1")
      await vi.waitFor(() => expect(client.audio()).toBe(2))
      expect(call.queued).toBe(3)
      for (let round = 0; client.audio() < 5 && round < 10; round++) {
        const before = client.audio()
        client.play()
        await vi.waitFor(() => expect(client.audio()).toBeGreaterThan(before))
      }
      expect(client.audio()).toBe(5)
      expect(call.queued).toBe(0)
      await vi.waitFor(() =>
        expect(client.received.at(-1)).toMatchObject({ mark: { name: "sentence-1" } })
      )
      client.play()
      // Only the caller's own mark comes back as an event
      expect((await reader.read()).value).toEqual({ type: "mark", name: "sentence-1" })
      client.stop()
      await client.closed
    })

    it("clear empties the queue and the provider's buffer", async () => {
      const { client, call } = await connect()
      call.play(sine(10 * 1600))
      await vi.waitFor(() => expect(client.audio()).toBe(2))
      call.clear()
      expect(call.queued).toBe(0)
      await vi.waitFor(() =>
        expect(client.received.at(-1)).toEqual({
          event: "clear",
          stream_sid: client.streamId,
        })
      )
      // Marks for cleared audio release nothing; new audio flows again
      client.play()
      call.play(sine(1600))
      await vi.waitFor(() => expect(client.audio()).toBe(3))
      client.stop()
      await client.closed
    })
  })

  describe("drain", () => {
    it("stops taking streams, lets live calls finish, then resolves", async () => {
      const drainable = await createVoiceService({
        streamSecret: SECRET,
        startTimeoutMs: 300,
        drainSeconds: 5,
      })
      const live = await attempt()
      const client = await connectMockStream({
        url: drainable.mediaUrl,
        secret: SECRET,
        token: live.token,
        callSid: live.callSid,
      })
      await vi.waitFor(() => expect(drainable.calls()).toBe(1))
      let drained = false
      const done = drainable.drain().then(() => (drained = true))
      expect(await (await fetch(`${drainable.url}/health`)).json()).toMatchObject({
        accepting: false,
        calls: 1,
      })
      const late = await attempt()
      await expect(
        connectMockStream({
          url: drainable.mediaUrl,
          secret: SECRET,
          token: late.token,
          callSid: late.callSid,
        })
      ).rejects.toMatchObject({ status: 503 })
      expect(drained).toBe(false)
      client.stop()
      await done
      expect(drainable.calls()).toBe(0)
      await drainable.close()
    })

    it("ends calls still running when the drain window closes", async () => {
      const drainable = await createVoiceService({
        streamSecret: SECRET,
        startTimeoutMs: 300,
        drainSeconds: 0.2,
      })
      const live = await attempt()
      const client = await connectMockStream({
        url: drainable.mediaUrl,
        secret: SECRET,
        token: live.token,
        callSid: live.callSid,
      })
      await vi.waitFor(() => expect(drainable.calls()).toBe(1))
      await drainable.drain()
      expect((await client.closed).code).toBe(1001)
      await drainable.close()
    })
  })

  it("refuses a weak stream secret", async () => {
    await expect(createVoiceService({ streamSecret: "short" })).rejects.toThrow(/32/)
  })
})
