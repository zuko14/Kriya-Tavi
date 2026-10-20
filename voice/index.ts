import { createHash, timingSafeEqual } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { hostname } from "node:os"
import { pathToFileURL } from "node:url"

import WebSocket, { WebSocketServer } from "ws"

import { checkEnvironment } from "@/lib/env"
import { log } from "@/lib/log"
import { chunks, exotelCodec } from "@/lib/voice/audio"
import type { MediaCodec, MediaEvent } from "@/lib/voice/providers"
import { claimStream, type ClaimedStream } from "@/lib/voice/streams"

// kriya-voice (D-03, VOICE_ARCHITECTURE.md §1): a plain Node service that
// accepts the provider's media WebSocket for a connected call. It never
// places calls and reads nothing but the stream's own attempt. The dialogue
// loop (voice phase 4) plugs in through onCall.
//
// A stream is accepted only with the static Basic-auth secret
// (KRIYA_VOICE_STREAM_SECRET), checked before the upgrade, and a one-time token
// that matches an attempt dialing this call_sid (lib/voice/streams.ts),
// checked on `start` (TELEPHONY_PROVIDER_ASSESSMENT.md §2.3).

// Chunks sent ahead of what the provider says it has played. Exotel's clear
// drops only audio that hasn't started, so this bounds how much plays on
// after a barge-in (VOICE_ARCHITECTURE.md §3)
const LEAD = 2

const digest = (value: string) => createHash("sha256").update(value).digest()

// One connected call. events carries the callee's audio, keys, the marks
// asked for with mark(), and stop; it ends when the stream closes.
export class Call {
  readonly events: ReadableStream<MediaEvent>
  private push!: ReadableStreamDefaultController<MediaEvent>
  private queue: ({ audio: Int16Array } | { mark: string })[] = []
  private inFlight = 0
  // Marks of audio dropped by clear() carry an older generation
  private generation = 0
  private sent = 0
  // Chunks the provider says it played (the session's played_ms)
  playedChunks = 0
  private ended = false

  constructor(
    private socket: WebSocket,
    private codec: MediaCodec,
    readonly streamId: string,
    readonly providerCallId: string,
    readonly attemptId: string,
    readonly userId: string
  ) {
    this.events = new ReadableStream({ start: (c) => void (this.push = c) })
  }

  // Audio chunks waiting to be sent
  get queued() {
    return this.queue.filter((item) => "audio" in item).length
  }

  play(pcm: Int16Array) {
    for (const chunk of chunks(pcm)) this.queue.push({ audio: chunk })
    this.pump()
  }

  // Reported back as an event once everything queued before it has played
  mark(name: string) {
    this.queue.push({ mark: name })
    this.pump()
  }

  // Barge-in: drop what's queued here and what the provider hasn't started
  clear() {
    this.queue = []
    this.generation += 1
    this.inFlight = 0
    this.send(this.codec.clear(this.streamId))
  }

  close(code = 1000) {
    this.socket.close(code)
  }

  private send(message: string) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message)
  }

  private pump() {
    while (this.queue.length && !this.ended) {
      const item = this.queue[0]
      if ("audio" in item) {
        if (this.inFlight >= LEAD) return
        this.send(this.codec.audio(this.streamId, item.audio))
        this.send(this.codec.mark(this.streamId, `~${this.generation}.${++this.sent}`))
        this.inFlight += 1
      } else {
        this.send(this.codec.mark(this.streamId, item.mark))
      }
      this.queue.shift()
    }
  }

  // From the provider
  receive(event: MediaEvent) {
    if (this.ended) return
    if (event.type === "mark" && event.name.startsWith("~")) {
      if (event.name.startsWith(`~${this.generation}.`)) {
        this.playedChunks += 1
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.pump()
      }
      return
    }
    this.push.enqueue(event)
  }

  end() {
    if (this.ended) return
    this.ended = true
    this.push.close()
  }
}

type Options = {
  // At least 32 characters; the password of the stream's Basic auth
  streamSecret: string
  port?: number
  host?: string
  sampleRate?: 8000 | 16000
  // Written to call_attempts.stream_owner
  instance?: string
  onCall?: (call: Call) => void
  // A stream must send start within this long
  startTimeoutMs?: number
  // How long a drain waits for live calls (max call length) before ending them
  drainSeconds?: number
  // Tests only: replaces the database check
  claim?: (token: string, callSid: string, owner: string) => Promise<ClaimedStream | null>
}

export async function createVoiceService(options: Options) {
  if (options.streamSecret.length < 32) {
    throw new Error("The stream secret must be at least 32 characters.")
  }
  const expected = digest(options.streamSecret)
  const codec = exotelCodec(options.sampleRate ?? 8000)
  const instance = options.instance ?? `${hostname()}:${process.pid}`
  const claim = options.claim ?? claimStream
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const drainSeconds = options.drainSeconds ?? 300
  const calls = new Set<Call>()
  const sockets = new Set<WebSocket>()
  let accepting = true
  let idle: (() => void)[] = []

  // Basic auth; the user name isn't checked
  const authorized = (header: string | undefined) => {
    const [scheme, value] = (header ?? "").split(" ")
    if (scheme !== "Basic" || !value) return false
    const decoded = Buffer.from(value, "base64").toString("utf8")
    return timingSafeEqual(digest(decoded.slice(decoded.indexOf(":") + 1)), expected)
  }

  function accept(socket: WebSocket, url: URL) {
    sockets.add(socket)
    let call: Call | null = null
    let claiming = false
    const timer = setTimeout(() => socket.close(1008), startTimeoutMs)

    socket.on("message", async (data) => {
      const event = codec.parse(String(data))
      if (!event) return
      if (call) {
        call.receive(event)
        if (event.type === "stop") socket.close(1000)
        return
      }
      // Until start is authorized nothing else is read
      if (event.type !== "start" || claiming) return
      claiming = true
      clearTimeout(timer)
      const token = event.params.t ?? url.searchParams.get("t") ?? ""
      let claimed: ClaimedStream | null = null
      try {
        claimed = await claim(token, event.providerCallId, instance)
      } catch (error) {
        log.error("voice stream check failed", { error })
        return socket.close(1011)
      }
      if (!claimed) {
        log.warn("voice stream refused")
        return socket.close(1008)
      }
      if (socket.readyState !== WebSocket.OPEN) return
      call = new Call(
        socket,
        codec,
        event.streamId,
        event.providerCallId,
        claimed.attemptId,
        claimed.userId
      )
      calls.add(call)
      log.info("voice stream connected", { attemptId: claimed.attemptId })
      options.onCall?.(call)
    })

    socket.on("close", () => {
      clearTimeout(timer)
      sockets.delete(socket)
      if (call) {
        call.end()
        calls.delete(call)
        log.info("voice stream closed", { attemptId: call.attemptId })
      }
      if (calls.size === 0) {
        for (const resolve of idle) resolve()
        idle = []
      }
    })
  }

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://voice")
    const found = req.method === "GET" && pathname === "/health"
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" })
    res.end(
      JSON.stringify(
        found ? { ok: true, accepting, calls: calls.size } : { error: "not found" }
      )
    )
  })

  // Exotel media chunks are at most 100 KB, base64 in JSON
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  server.on("upgrade", (req, socket, head) => {
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    const url = new URL(req.url ?? "/", "http://voice")
    if (url.pathname !== "/media/exotel") return refuse("404 Not Found")
    if (!accepting) return refuse("503 Service Unavailable")
    if (!authorized(req.headers.authorization)) return refuse("401 Unauthorized")
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, url))
  })

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve)
  )
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`

  // Stop taking streams; wait for live calls up to drainSeconds, then end
  // them (D-03: a deploy shouldn't cut a call short)
  async function drain() {
    accepting = false
    if (calls.size > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        new Promise<void>((resolve) => idle.push(resolve)),
        new Promise<void>(
          (resolve) => (timer = setTimeout(resolve, drainSeconds * 1000))
        ),
      ])
      clearTimeout(timer)
    }
    for (const socket of sockets) socket.close(1001)
  }

  return {
    url,
    mediaUrl: `ws://127.0.0.1:${port}/media/exotel`,
    calls: () => calls.size,
    drain,
    close: async () => {
      accepting = false
      for (const socket of sockets) socket.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// `npm run voice`: configuration from the environment, names only in errors
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.KRIYA_SERVICE = "voice"
  checkEnvironment("voice")
  const secret = process.env.KRIYA_VOICE_STREAM_SECRET ?? ""
  if (secret.length < 32) {
    console.error(
      `[kriya-voice] KRIYA_VOICE_STREAM_SECRET is ${
        "KRIYA_VOICE_STREAM_SECRET" in process.env
          ? `${secret.length} characters; it needs at least 32`
          : "not set"
      }`
    )
    process.exit(1)
  }
  const port = Number.parseInt(process.env.PORT ?? "", 10) || 10000
  const service = await createVoiceService({
    streamSecret: secret,
    port,
    host: "0.0.0.0",
    // No STT/TTS vendor is chosen yet (the voice phase 4 benchmark, B6):
    // a stream is refused rather than answered by a mock (D-12). The
    // session (lib/voice/session.ts) is wired here once vendors exist
    onCall: (call) => {
      log.warn("voice stream refused: no speech providers configured", {
        attemptId: call.attemptId,
      })
      call.close(1011)
    },
  })
  log.info("kriya-voice listening", { port })
  const stop = () =>
    void service
      .drain()
      .then(service.close)
      .then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
