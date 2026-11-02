import { createHash, timingSafeEqual } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { pathToFileURL } from "node:url"

import { WebSocketServer, type WebSocket } from "ws"

// kriya-relay (track H, H10, HD-12): a person's machine running `kriya serve`
// keeps one outbound WebSocket here; the worker's runner requests come in
// over HTTP and go down that socket as frames, the answer streams back. No
// database and no secret but its own: device tokens are checked by the web
// app's /api/harness/v1/world (authenticateDevice), at connect and again every
// few minutes, so a revoked device drops off. Nothing is stored; a restart
// drops every connection and the devices reconnect.
//
// Frames (JSON text, protocol kriya-relay/1), `id` per request:
//   relay → device  {t:"req", id, method, path, headers} {t:"body", id, data}
//                   {t:"end", id} {t:"abort", id}
//   device → relay  {t:"res", id, status, headers} {t:"body", id, data}
//                   {t:"end", id} {t:"error", id, message}
// `data` is base64, at most CHUNK bytes before encoding.

export const RELAY_PROTOCOL = "kriya-relay/1"

// The token's device id, or null when the web app refuses the token; throws
// when the web app can't say (unreachable, 429, 5xx)
export type Verify = (token: string, version: string | null) => Promise<string | null>

export type RelayOptions = {
  secret: string
  verify: Verify
  port?: number
  host?: string
  // How often a connected device's token is checked again
  reverifyMs?: number
  // A request with no frame from the device this long answers 504
  idleMs?: number
  pingMs?: number
}

const CHUNK = 256 * 1024
// Token checks (calls to kriya-web) in flight at once; more are refused 503
const MAX_CHECKING = 200
// The runner's largest body (an import, limitsSchema.importBytes max)
const MAX_BODY = 1024 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEVICE_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/
// What crosses the relay in each direction; nothing else (no cookies, no
// relay secret, no hop-by-hop headers)
const REQUEST_HEADERS = ["authorization", "content-type", "accept"]
const RESPONSE_HEADERS = ["content-type"]
const keep = (headers: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        typeof value === "string" &&
        (names.includes(name.toLowerCase()) ||
          (name.toLowerCase().startsWith("x-kriya-") &&
            name.toLowerCase() !== "x-kriya-relay-secret"))
    )
  ) as Record<string, string>

type Pending = {
  res: http.ServerResponse
  started: boolean
  timer: NodeJS.Timeout
}

type Device = { socket: WebSocket; token: string; version: string | null; alive: boolean }

const digest = (value: string) => createHash("sha256").update(value).digest()

// Device tokens are checked by the web app: kriya-web's own route, with the
// device's token and client version (the harness API's rules apply)
export function webVerifier(appUrl: string): Verify {
  const url = `${appUrl.replace(/\/+$/, "")}/api/harness/v1/world`
  return async (token, version) => {
    // Unreachable, rate limited or failing is not a verdict: it throws, so a
    // re-check keeps the connection and a new one is refused (re-audit
    // 2026-11-02: a kriya-web deploy must not drop every machine)
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(version && { "x-kriya-harness": version }),
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 429 || res.status >= 500) {
      void res.body?.cancel().catch(() => {})
      throw new Error(`kriya-web answered ${res.status}`)
    }
    // Signed out, revoked, suspended, too old or switched off
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return null
    }
    const body = (await res.json()) as { deviceId?: unknown }
    return typeof body.deviceId === "string" ? body.deviceId : null
  }
}

export async function createRelay(options: RelayOptions) {
  if (options.secret.length < 32)
    throw new Error("KRIYA_RELAY_SECRET needs at least 32 characters")
  const expected = digest(options.secret)
  const authorized = (req: http.IncomingMessage) =>
    timingSafeEqual(digest(String(req.headers["x-kriya-relay-secret"] ?? "")), expected)
  const idleMs = options.idleMs ?? 35 * 60_000
  const devices = new Map<string, Device>()
  const pending = new Map<WebSocket, Map<number, Pending>>()
  let nextId = 0

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    res.end(JSON.stringify(body))
  }

  // Every request still waiting on this socket answers 502 (or ends early)
  function failAll(socket: WebSocket) {
    for (const entry of pending.get(socket)?.values() ?? []) finish(entry, 502)
    pending.delete(socket)
  }

  function finish(entry: Pending, status: number) {
    clearTimeout(entry.timer)
    if (entry.res.writableEnded) return
    if (entry.started) return void entry.res.destroy()
    json(entry.res, status, {
      error:
        status === 504
          ? "the machine didn't answer in time"
          : "the machine isn't connected",
    })
  }

  function onFrame(socket: WebSocket, raw: string) {
    let frame: { t?: unknown; id?: unknown; [key: string]: unknown }
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    const waiting = pending.get(socket)
    const entry = typeof frame.id === "number" ? waiting?.get(frame.id) : undefined
    if (!entry || !waiting) return
    entry.timer.refresh()
    if (frame.t === "res" && !entry.started) {
      entry.started = true
      const status = Number(frame.status)
      entry.res.writeHead(status >= 100 && status < 600 ? status : 502, {
        ...keep((frame.headers ?? {}) as Record<string, unknown>, RESPONSE_HEADERS),
        "cache-control": "no-store",
      })
      // Streamed answers (exec's NDJSON) reach the worker as they come
      entry.res.flushHeaders()
    } else if (frame.t === "body" && entry.started && typeof frame.data === "string") {
      entry.res.write(Buffer.from(frame.data, "base64"))
    } else if (frame.t === "end") {
      waiting.delete(frame.id as number)
      clearTimeout(entry.timer)
      if (entry.started) entry.res.end()
      else finish(entry, 502)
    } else if (frame.t === "error") {
      waiting.delete(frame.id as number)
      finish(entry, 502)
    }
  }

  async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deviceId: string,
    rest: string
  ) {
    const device = devices.get(deviceId)
    if (!device) {
      req.resume()
      return json(res, 502, { error: "the machine isn't connected" })
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
      req.resume()
      return json(res, 413, { error: "the request body is too large" })
    }
    const { socket } = device
    const id = ++nextId
    const entry: Pending = {
      res,
      started: false,
      timer: setTimeout(() => {
        pending.get(socket)?.delete(id)
        send(socket, { t: "abort", id })
        finish(entry, 504)
      }, idleMs),
    }
    if (!pending.has(socket)) pending.set(socket, new Map())
    pending.get(socket)!.set(id, entry)
    // The worker gave up (timeout, abort): the device stops too
    res.on("close", () => {
      if (pending.get(socket)?.delete(id)) {
        clearTimeout(entry.timer)
        send(socket, { t: "abort", id })
      }
    })
    send(socket, {
      t: "req",
      id,
      method: req.method ?? "GET",
      path: rest,
      headers: keep(req.headers as Record<string, unknown>, REQUEST_HEADERS),
    })
    let size = 0
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_BODY) throw new Error("too large")
        for (let at = 0; at < chunk.length; at += CHUNK) {
          send(socket, {
            t: "body",
            id,
            data: chunk.subarray(at, at + CHUNK).toString("base64"),
          })
        }
        // Back-pressure: let the socket drain before reading more
        while (socket.bufferedAmount > 8 * CHUNK && socket.readyState === socket.OPEN) {
          await new Promise((done) => setTimeout(done, 10))
        }
      }
      send(socket, { t: "end", id })
    } catch {
      if (pending.get(socket)?.delete(id)) {
        send(socket, { t: "abort", id })
        clearTimeout(entry.timer)
        if (!res.headersSent)
          json(res, size > MAX_BODY ? 413 : 400, {
            error: "the request body didn't arrive",
          })
      }
    }
  }

  const send = (socket: WebSocket, frame: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay")
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, version: RELAY_PROTOCOL })
    }
    if (!authorized(req)) {
      req.resume()
      return json(res, 401, { error: "unauthorized" })
    }
    if (req.method === "GET" && url.pathname === "/v1/devices") {
      return json(res, 200, { devices: [...devices.keys()] })
    }
    const status = /^\/v1\/devices\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && status) {
      return json(res, 200, { connected: devices.has(status[1]) })
    }
    const route = /^\/v1\/forward\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (route && UUID.test(route[1])) {
      return void forward(req, res, route[1], route[2] + url.search)
    }
    req.resume()
    json(res, 404, { error: "not found" })
  })

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * CHUNK })
  let checking = 0
  server.on("upgrade", (req, raw, head) => {
    // The token check below is asynchronous: a client that resets meanwhile
    // must not raise an unhandled error (it would end every connection)
    const onRawError = () => raw.destroy()
    raw.on("error", onRawError)
    const refuse = (status: number) => {
      if (raw.destroyed) return
      raw.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`
      )
    }
    const deviceId = /^\/v1\/device\/([^/?]+)$/.exec(
      new URL(req.url ?? "/", "http://relay").pathname
    )?.[1]
    if (!deviceId || !UUID.test(deviceId)) return refuse(404)
    const token = DEVICE_TOKEN.exec(String(req.headers.authorization ?? ""))?.[1]
    if (!token) return refuse(401)
    const version =
      typeof req.headers["x-kriya-harness"] === "string"
        ? req.headers["x-kriya-harness"]
        : null
    // Each check is a call to kriya-web: a bounded number at once
    if (checking >= MAX_CHECKING) return refuse(503)
    checking++
    void options
      .verify(token, version)
      .catch(() => null)
      .then((verified) => {
        checking--
        // Only its own device: a token can't serve another device's id
        if (verified !== deviceId || raw.destroyed) return refuse(401)
        raw.removeListener("error", onRawError)
        accept(req, raw, head, deviceId, token, version)
      })
  })

  function accept(
    req: http.IncomingMessage,
    raw: Duplex,
    head: Buffer,
    deviceId: string,
    token: string,
    version: string | null
  ) {
    sockets.handleUpgrade(req, raw, head, (socket) => {
      // One connection per device: the newer one wins
      const earlier = devices.get(deviceId)
      if (earlier) earlier.socket.close(4000, "replaced")
      const device: Device = { socket, token, version, alive: true }
      devices.set(deviceId, device)
      socket.on("pong", () => (device.alive = true))
      socket.on("message", (data, binary) => {
        if (!binary) onFrame(socket, data.toString())
      })
      socket.on("close", () => {
        if (devices.get(deviceId)?.socket === socket) devices.delete(deviceId)
        failAll(socket)
      })
      socket.on("error", () => socket.terminate())
    })
  }

  // Liveness and revocation: a device that stops answering pings, or whose
  // token the web app no longer accepts, is dropped
  const ping = setInterval(() => {
    for (const device of devices.values()) {
      if (!device.alive) {
        device.socket.terminate()
        continue
      }
      device.alive = false
      device.socket.ping()
    }
  }, options.pingMs ?? 30_000)
  const reverify = setInterval(
    () => {
      for (const [deviceId, device] of devices) {
        void options
          .verify(device.token, device.version)
          .catch(() => deviceId)
          .then((verified) => {
            if (verified !== deviceId && devices.get(deviceId) === device)
              device.socket.close(4001, "signed out")
          })
      }
    },
    options.reverifyMs ?? 5 * 60_000
  )

  await new Promise<void>((listening) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", listening)
  )
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : (options.host ?? "127.0.0.1")}:${port}`,
    connected: () => [...devices.keys()],
    close: async () => {
      clearInterval(ping)
      clearInterval(reverify)
      for (const device of devices.values()) device.socket.terminate()
      sockets.close()
      server.closeAllConnections()
      await new Promise<void>((closed) => server.close(() => closed()))
    },
  }
}

// On Render: PORT, KRIYA_RELAY_SECRET and KRIYA_APP_URL; a deploy drops the
// connections and the devices reconnect
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.KRIYA_RELAY_SECRET ?? ""
  const appUrl = process.env.KRIYA_APP_URL ?? ""
  if (secret.length < 32 || !appUrl) {
    // Lengths and presence only, never a value
    console.error(
      `[kriya-relay] KRIYA_RELAY_SECRET is ${secret.length} characters (needs 32+); KRIYA_APP_URL ${appUrl ? "set" : "missing"}`
    )
    process.exit(1)
  }
  const relay = await createRelay({
    secret,
    verify: webVerifier(appUrl),
    port: Number.parseInt(process.env.PORT ?? "10002", 10),
    host: "0.0.0.0",
  })
  console.info(`[kriya-relay] listening on ${new URL(relay.url).port}`)
  const stop = () => void relay.close().then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
