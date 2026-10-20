import WebSocket from "ws"

import { chunks, CHUNK_SAMPLES, exotelCodec, pcmToBase64 } from "./audio"
import type {
  CallStatus,
  PlaceCallInput,
  ProviderCall,
  RecognitionEvent,
  RecognitionStream,
  SpeechRecognitionProvider,
  SpeechSynthesisProvider,
  StatusEvent,
  TelephonyProvider,
} from "./providers"

// The mock providers (TEST_STRATEGY.md §3): telephony driven by a scenario
// file (tests/voice/scenarios, EVALUATION_PLAN.md §1), scripted speech
// recognition and synthesis, and a client that plays the provider's side of
// the media stream. No network except the local stream; no account.

export type Scenario = {
  id: string
  // Delivered in this order; atMs is when each happened after placeCall.
  // Repeat an entry for a duplicate webhook, list it late for out-of-order
  provider_script: { status: CallStatus; atMs: number; eventId?: string }[]
  // placeCall failing: "rejected" (the provider refused it, like a 4xx) or
  // "timeout" (it may have reached the provider)
  place_error?: "rejected" | "timeout"
  // What the provider reports as billed; absent = not reported
  billable_seconds?: number
  [key: string]: unknown
}

const TERMINAL = new Set<CallStatus>([
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
])

// An async event stream with a push side
function channel<T>() {
  let controller!: ReadableStreamDefaultController<T>
  const reader = new ReadableStream<T>({
    start: (c) => void (controller = c),
  }).getReader()
  let open = true
  return {
    stream: (async function* () {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    })(),
    push: (value: T) => {
      if (open) controller.enqueue(value)
    },
    end: () => {
      if (open) controller.close()
      open = false
    },
  }
}

export function mockTelephony(scenario: Scenario, sampleRate: 8000 | 16000 = 8000) {
  const placed: (PlaceCallInput & { providerCallId: string; at: number })[] = []
  const hangups: string[] = []

  const callOf = (providerCallId: string) =>
    placed.find((call) => call.providerCallId === providerCallId)

  const provider: TelephonyProvider & {
    placed: typeof placed
    hangups: string[]
    webhooks(providerCallId: string): string[]
  } = {
    name: "mock",
    placed,
    hangups,
    media: exotelCodec(sampleRate),

    async placeCall(input) {
      if (scenario.place_error === "rejected") {
        throw Object.assign(new Error("mock provider rejected the call"), { status: 400 })
      }
      if (scenario.place_error === "timeout") {
        throw Object.assign(new Error("mock provider timed out"), { code: "ETIMEDOUT" })
      }
      const providerCallId = `mock-${scenario.id}-${placed.length + 1}`
      placed.push({ ...input, providerCallId, at: Date.now() })
      return { providerCallId }
    },

    async getCall(providerCallId): Promise<ProviderCall | null> {
      const call = callOf(providerCallId)
      if (!call) return null
      const byTime = [...scenario.provider_script].sort((a, b) => a.atMs - b.atMs)
      const answered = byTime.find((e) => e.status === "answered")
      const ended = byTime.findLast((e) => TERMINAL.has(e.status))
      const hungUp = hangups.includes(providerCallId) && !ended
      return {
        providerCallId,
        status: hungUp ? "canceled" : ((ended ?? byTime.at(-1))?.status ?? "initiated"),
        answeredAt: answered ? new Date(call.at + answered.atMs) : null,
        endedAt: ended ? new Date(call.at + ended.atMs) : null,
        billableSeconds: scenario.billable_seconds ?? null,
        reportedCost: null,
        raw: { scenario: scenario.id },
      }
    },

    async findByAttempt(attemptId) {
      const call = placed.find((c) => c.attemptId === attemptId)
      return call ? provider.getCall(call.providerCallId) : null
    },

    async hangup(providerCallId) {
      hangups.push(providerCallId)
    },

    // The bodies the provider would POST to the status URL, in delivery order
    webhooks(providerCallId) {
      const call = callOf(providerCallId)
      if (!call) return []
      return scenario.provider_script.map((e) =>
        JSON.stringify({
          CallSid: providerCallId,
          CustomField: call.attemptId,
          Status: e.status,
          EventId: e.eventId ?? `${providerCallId}:${e.status}:${e.atMs}`,
          At: new Date(call.at + e.atMs).toISOString(),
        })
      )
    },

    parseStatusEvent(body): StatusEvent | null {
      try {
        const data = JSON.parse(body)
        if (typeof data?.CallSid !== "string" || typeof data.Status !== "string") {
          return null
        }
        return {
          providerCallId: data.CallSid,
          attemptId: typeof data.CustomField === "string" ? data.CustomField : null,
          status: data.Status as CallStatus,
          occurredAt: data.At ? new Date(data.At) : null,
          dedupeKey: String(data.EventId),
          raw: data,
        }
      } catch {
        return null
      }
    },
  }
  return provider
}

// Speech recognition the test drives: say() is what the callee said
export type MockRecognitionStream = RecognitionStream & {
  say(text: string, confidence?: number): void
  fail(error: Error): void
  samples: number
}

export function mockRecognition() {
  const streams: MockRecognitionStream[] = []
  const provider: Omit<SpeechRecognitionProvider, "open"> & {
    streams: MockRecognitionStream[]
    open: (
      opts: Parameters<SpeechRecognitionProvider["open"]>[0]
    ) => MockRecognitionStream
  } = {
    name: "mock",
    streams,
    open({ sampleRate }) {
      const events = channel<RecognitionEvent>()
      const stream: MockRecognitionStream = {
        samples: 0,
        events: events.stream,
        write(pcm) {
          stream.samples += pcm.length
        },
        say(text, confidence) {
          const atMs = Math.round((stream.samples * 1000) / sampleRate)
          events.push({ type: "speech_started" })
          events.push({ type: "partial", text })
          events.push({
            type: "final",
            text,
            // Not given unless the script says, like vendors that omit it
            confidence: confidence ?? null,
            startMs: atMs,
            endMs: atMs + 400 * text.split(/\s+/).length,
          })
          events.push({ type: "endpoint" })
        },
        fail(error) {
          events.push({ type: "error", error })
          events.end()
        },
        async close() {
          events.end()
          return { billedSeconds: stream.samples / sampleRate }
        },
      }
      streams.push(stream)
      return stream
    },
  }
  return provider
}

// Speech synthesis: a quiet tone, 300 ms per word, in whole chunks
export function mockSynthesis() {
  const spoken: string[] = []
  const provider: SpeechSynthesisProvider & { spoken: string[] } = {
    name: "mock",
    spoken,
    async *synthesize(text, { sampleRate, signal }) {
      spoken.push(text)
      const samples = Math.round(text.split(/\s+/).length * 0.3 * sampleRate)
      const tone = Int16Array.from({ length: samples }, (_, i) =>
        Math.round(1000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate))
      )
      for (const chunk of chunks(tone)) {
        if (signal.aborted) return
        yield chunk
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
    billedUnits: (text) => text.length,
  }
  return provider
}

// The provider's side of a media stream (Exotel framing): connects with
// Basic auth, sends start with the one-time token, sends callee audio, and
// acknowledges each mark when it "plays" it. play() acknowledges what has
// arrived so far; autoPlay acknowledges at once.
export type OutboundMessage =
  | { event: "media"; stream_sid: string; media: { payload: string } }
  | { event: "mark"; stream_sid: string; mark: { name: string } }
  | { event: "clear"; stream_sid: string }

export async function connectMockStream(options: {
  url: string
  secret?: string
  token: string
  callSid: string
  streamId?: string
  autoPlay?: boolean
}) {
  const streamId = options.streamId ?? `stream-${options.callSid}`
  const headers: Record<string, string> = {}
  if (options.secret !== undefined) {
    const credentials = Buffer.from(`kriya:${options.secret}`).toString("base64")
    headers.authorization = `Basic ${credentials}`
  }
  const socket = new WebSocket(options.url, { headers })
  const received: OutboundMessage[] = []
  let unplayed: string[] = []
  const send = (data: unknown) => socket.send(JSON.stringify(data))
  const acknowledge = (names: string[]) => {
    for (const name of names)
      send({ event: "mark", stream_sid: streamId, mark: { name } })
  }

  const closed = new Promise<{ code: number }>((resolve) =>
    socket.on("close", (code) => resolve({ code }))
  )
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as OutboundMessage
    received.push(message)
    if (message.event === "clear") unplayed = []
    if (message.event === "mark") {
      if (options.autoPlay) acknowledge([message.mark.name])
      else unplayed.push(message.mark.name)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("unexpected-response", (_req, res) =>
      reject(
        Object.assign(new Error(`refused: ${res.statusCode}`), { status: res.statusCode })
      )
    )
    socket.once("error", reject)
  })
  send({ event: "connected" })
  send({
    event: "start",
    stream_sid: streamId,
    start: {
      stream_sid: streamId,
      call_sid: options.callSid,
      custom_parameters: { t: options.token },
      media_format: { encoding: "raw/slin", sample_rate: "8000" },
    },
  })

  let chunk = 0
  return {
    socket,
    received,
    closed,
    streamId,
    audio: () => received.filter((m) => m.event === "media").length,
    sendAudio(pcm: Int16Array) {
      for (const part of chunks(pcm)) {
        chunk += 1
        send({
          event: "media",
          stream_sid: streamId,
          media: {
            chunk,
            timestamp: String((chunk - 1) * (CHUNK_SAMPLES / 8)),
            payload: pcmToBase64(part),
          },
        })
      }
    },
    dtmf: (digit: string) =>
      send({ event: "dtmf", stream_sid: streamId, dtmf: { digit } }),
    // Everything sent so far has been heard
    play() {
      const names = unplayed
      unplayed = []
      acknowledge(names)
    },
    stop(reason = "callended") {
      send({ event: "stop", stream_sid: streamId, stop: { reason } })
    },
  }
}
