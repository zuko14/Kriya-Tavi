import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { CHUNK_SAMPLES } from "@/lib/voice/audio"
import {
  mockRecognition,
  mockSynthesis,
  mockTelephony,
  type Scenario,
} from "@/lib/voice/mock"
import type { CallStatus, RecognitionEvent } from "@/lib/voice/providers"

const DIR = path.join(process.cwd(), "tests", "voice", "scenarios")
const scenario = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8")) as Scenario

const STATUSES: CallStatus[] = [
  "initiated",
  "ringing",
  "answered",
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
  "unknown",
]

const input = {
  attemptId: "attempt-1",
  to: "+919876543210",
  callerId: "+918000000000",
  streamUrl: "wss://voice.test/media/exotel?t=x",
  statusUrl: "https://web.test/api/voice/mock/status/y",
  ringTimeoutSeconds: 30,
  maxDurationSeconds: 300,
}

async function deliver(id: string) {
  const provider = mockTelephony(scenario(id))
  const { providerCallId } = await provider.placeCall(input)
  const events = provider
    .webhooks(providerCallId)
    .map((body) => provider.parseStatusEvent(body, new Headers()))
  return { provider, providerCallId, events }
}

describe("scenario files", () => {
  it.each(fs.readdirSync(DIR))("%s is well formed", (file) => {
    const s = scenario(file.replace(/\.json$/, ""))
    expect(s.id.startsWith(file.replace(/\.json$/, ""))).toBe(true)
    expect(s.provider_script.length).toBeGreaterThan(0)
    for (const step of s.provider_script) {
      expect(STATUSES).toContain(step.status)
      expect(step.atMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("mock telephony", () => {
  it("records each call and correlates its webhooks by attempt", async () => {
    const { provider, providerCallId, events } = await deliver("S02")
    expect(provider.placed).toEqual([
      expect.objectContaining({ ...input, providerCallId }),
    ])
    expect(events.map((e) => [e?.status, e?.attemptId])).toEqual([
      ["ringing", "attempt-1"],
      ["busy", "attempt-1"],
    ])
    expect(await provider.getCall(providerCallId)).toMatchObject({
      status: "busy",
      answeredAt: null,
      billableSeconds: null,
    })
    expect(await provider.getCall("mock-nope")).toBeNull()
  })

  it("S05 ends unanswered", async () => {
    const { provider, providerCallId } = await deliver("S05")
    expect((await provider.getCall(providerCallId))?.status).toBe("no_answer")
  })

  it("S15 delivers duplicates with the same key and late events out of order", async () => {
    const { provider, providerCallId, events } = await deliver("S15")
    expect(events.map((e) => e?.status)).toEqual([
      "ringing",
      "answered",
      "ringing",
      "answered",
      "completed",
      "completed",
    ])
    expect(new Set(events.map((e) => e?.dedupeKey)).size).toBe(3)
    expect(events[2]!.occurredAt!.getTime()).toBeLessThan(
      events[1]!.occurredAt!.getTime()
    )
    const call = await provider.getCall(providerCallId)
    expect(call).toMatchObject({ status: "completed", billableSeconds: 40 })
    expect(call!.endedAt!.getTime() - call!.answeredAt!.getTime()).toBe(40_000)
  })

  it("S01 is answered and completed", async () => {
    const { provider, providerCallId } = await deliver("S01")
    expect(await provider.getCall(providerCallId)).toMatchObject({ status: "completed" })
  })

  it("fails placeCall on demand, and reports a hangup before the end", async () => {
    const rejected = mockTelephony({ ...scenario("S02"), place_error: "rejected" })
    await expect(rejected.placeCall(input)).rejects.toMatchObject({ status: 400 })
    const timeout = mockTelephony({ ...scenario("S02"), place_error: "timeout" })
    await expect(timeout.placeCall(input)).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(rejected.placed).toEqual([])

    const ringing = mockTelephony({
      id: "ring",
      provider_script: [{ status: "ringing", atMs: 0 }],
    })
    const { providerCallId } = await ringing.placeCall(input)
    await ringing.hangup(providerCallId)
    expect(ringing.hangups).toEqual([providerCallId])
    expect((await ringing.getCall(providerCallId))?.status).toBe("canceled")
  })

  it("ignores webhook bodies that aren't its own", () => {
    const provider = mockTelephony(scenario("S02"))
    for (const body of ["", "{}", "[]", '{"CallSid":1}', "not json"]) {
      expect(provider.parseStatusEvent(body, new Headers())).toBeNull()
    }
  })
})

describe("mock speech", () => {
  it("recognition reports what the callee said, timed by the audio written", async () => {
    const stt = mockRecognition()
    const stream = stt.open({ language: "en-IN", sampleRate: 8000, hints: [] })
    stream.write(new Int16Array(8000))
    stream.say("Yes three works")
    const { billedSeconds } = await stream.close()
    const events: RecognitionEvent[] = []
    for await (const event of stream.events) events.push(event)
    expect(events.map((e) => e.type)).toEqual([
      "speech_started",
      "partial",
      "final",
      "endpoint",
    ])
    expect(events[2]).toMatchObject({
      text: "Yes three works",
      confidence: null,
      startMs: 1000,
    })
    expect(billedSeconds).toBe(1)
  })

  it("recognition can fail mid-stream", async () => {
    const stream = mockRecognition().open({
      language: "en-IN",
      sampleRate: 8000,
      hints: [],
    })
    stream.fail(new Error("vendor down"))
    const events: RecognitionEvent[] = []
    for await (const event of stream.events) events.push(event)
    expect(events).toEqual([{ type: "error", error: new Error("vendor down") }])
  })

  it("synthesis streams whole chunks, stops on abort and counts characters", async () => {
    const tts = mockSynthesis()
    const all = []
    for await (const chunk of tts.synthesize("one two three four five six", {
      voice: "mock",
      sampleRate: 8000,
      signal: new AbortController().signal,
    })) {
      all.push(chunk)
    }
    expect(all.length).toBe(Math.ceil((6 * 0.3 * 8000) / CHUNK_SAMPLES))
    expect(all.every((c) => c.length === CHUNK_SAMPLES)).toBe(true)

    const abort = new AbortController()
    const some = []
    for await (const chunk of tts.synthesize("one two three four five six", {
      voice: "mock",
      sampleRate: 8000,
      signal: abort.signal,
    })) {
      some.push(chunk)
      abort.abort()
    }
    expect(some.length).toBe(1)
    expect(tts.spoken).toHaveLength(2)
    expect(tts.billedUnits("Hello there")).toBe(11)
  })
})
