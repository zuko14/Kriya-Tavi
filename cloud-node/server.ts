import http from "node:http"

import { FenceStore } from "./fences"
import {
  destroySchema,
  fencedSchema,
  HEADERS,
  NODE_AGENT_VERSION,
  NODE_PROTOCOL,
  openSchema,
  parseRef,
  proxyToken,
  safeEqual,
  signature,
  SKEW_MS,
  type ListedSandbox,
  type NodeStats,
} from "./protocol"
import type { Probe, SandboxRuntime } from "./runtime"
import { measure } from "./stats"

// The node agent (CD-28, CD-31, CD-33, CD-36; SELF_HOSTED_ARCHITECTURE §4):
// one small HTTP service per machine, listening on loopback behind a TLS
// proxy. It has no database, no Kriya secret and no provider key: only its
// own node key. Lifecycle calls are signed by the worker; runner traffic
// passes through /v1/runner/<ref>/… with a proxy token bound to the
// sandbox's current fence, so a worker that lost its lease is locked out the
// moment a newer one opens the sandbox. A sandbox with no traffic for its
// idle time is stopped here even if the control plane is gone (CD-33).

export type NodeOptions = {
  nodeId: string
  key: string
  runtime: SandboxRuntime
  stateDir: string
  // The disk sandboxes use (Docker's data root), for statfs
  dataDir: string
  reserve: { cpuMillis: number; memMb: number; diskMb: number }
  // For sandboxes found running after a restart (their open's values are gone)
  defaults: { idleSeconds: number; diskMb: number }
  log?: (message: string, fields?: Record<string, unknown>) => void
  now?: () => number
}

const CONTROL_BODY = 64 * 1024
const NONCES = 100_000

type Json = Record<string, unknown> | unknown[]

function send(res: http.ServerResponse, status: number, body: Json) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

function readBody(req: http.IncomingMessage, limit: number) {
  return new Promise<Buffer>((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error("too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => done(Buffer.concat(chunks)))
    req.on("error", fail)
  })
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
  HEADERS.proxy,
  HEADERS.fence,
  HEADERS.ts,
  HEADERS.nonce,
  HEADERS.sig,
])

export function createNodeServer(options: NodeOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const fences = new FenceStore(options.stateDir)
  const nonces = new Map<string, number>()
  const lastSeen = new Map<string, number>()
  const inflight = new Map<string, number>()
  const limits = new Map<string, { idleSeconds: number; diskMb: number }>()
  // The runner's address per sandbox, so a proxied call doesn't spawn the
  // docker CLI; dropped on every lifecycle change and on upstream errors
  const addresses = new Map<string, string>()
  // Lifecycle calls on one sandbox run one at a time: an older holder's open
  // can't interleave with a newer one's and restart it under its feet
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(ref: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(ref) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    queues.set(ref, tail)
    void tail.then(() => {
      if (queues.get(ref) === tail) queues.delete(ref)
    })
    return run
  }
  let probe: Probe = {
    ready: false,
    reasons: ["not probed yet"],
    isolation: null,
    imageDigest: null,
  }

  const reprobe = async () => {
    probe = await options.runtime.probe().catch((error: unknown) => ({
      ready: false,
      reasons: [`probe failed: ${String(error).slice(0, 120)}`],
      isolation: null,
      imageDigest: null,
    }))
    return probe
  }

  function verify(req: http.IncomingMessage, path: string, body: Buffer) {
    const ts = String(req.headers[HEADERS.ts] ?? "")
    const nonce = String(req.headers[HEADERS.nonce] ?? "")
    const sig = String(req.headers[HEADERS.sig] ?? "")
    if (!/^\d{13}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig)
      return false
    if (Math.abs(now() - Number(ts)) > SKEW_MS) return false
    const expected = signature(options.key, req.method ?? "GET", path, ts, nonce, body)
    if (!safeEqual(sig, expected)) return false
    // A signed request is accepted once (replay within the skew window)
    if (nonces.has(nonce)) return false
    if (nonces.size >= NONCES) nonces.delete(nonces.keys().next().value!)
    nonces.set(nonce, now() + 2 * SKEW_MS)
    return true
  }

  async function stats(): Promise<NodeStats> {
    const measured = await measure(options.dataDir)
    const listed = await options.runtime.list().catch(() => [])
    return {
      protocol: NODE_PROTOCOL,
      agentVersion: NODE_AGENT_VERSION,
      nodeId: options.nodeId,
      ready: probe.ready,
      reasons: probe.reasons,
      isolation: probe.isolation,
      imageDigest: probe.imageDigest,
      cpuMillis: Math.max(0, measured.cpus * 1000 - options.reserve.cpuMillis),
      memMb: Math.max(0, measured.memTotalMb - options.reserve.memMb),
      diskMb: Math.max(0, (measured.diskTotalMb ?? 0) - options.reserve.diskMb),
      memAvailableMb: measured.memAvailableMb,
      diskFreeMb:
        measured.diskFreeMb === null
          ? null
          : Math.max(0, measured.diskFreeMb - options.reserve.diskMb),
      inodesFree: measured.inodesFree,
      psi: measured.psi,
      load1: measured.load1,
      containers: listed.length,
      running: listed.filter((s) => s.running).length,
    }
  }

  async function open(body: unknown) {
    const parsed = openSchema.safeParse(body)
    if (!parsed.success) return { status: 400, body: { error: "bad open request" } }
    const o = parsed.data
    if (parseRef(o.ref)?.nodeId !== options.nodeId)
      return { status: 400, body: { error: "that sandbox isn't on this node" } }
    if (!probe.ready)
      return {
        status: 503,
        body: { error: "this node isn't ready", reasons: probe.reasons },
      }
    const current = fences.get(o.ref)
    if (o.fence < current) return { status: 409, body: { error: "fenced" } }
    const found = await options.runtime.inspect(o.ref)
    // The same open again (a retried request): nothing to do
    if (found?.running && o.fence === current)
      return { status: 200, body: { ref: o.ref, fence: o.fence } }
    if (o.fresh) {
      if (found) return { status: 409, body: { error: "that sandbox already exists" } }
      // A second line behind the control plane's admission: a host already
      // short of memory takes nothing new
      const m = await measure(options.dataDir)
      if (
        (m.memAvailableMb !== null && m.memAvailableMb < options.reserve.memMb) ||
        (m.psi.memory ?? 0) > 25
      )
        return { status: 507, body: { error: "this node is short of memory" } }
      // Recorded before the container exists, so a crash can't forget it
      if (!fences.advance(o.ref, o.fence))
        return { status: 409, body: { error: "fenced" } }
      try {
        await options.runtime.create({
          ref: o.ref,
          workspaceId: o.workspaceId,
          cpuMillis: o.cpuMillis,
          memMb: o.memMb,
          diskMb: o.diskMb,
          pids: o.pids,
          env: o.env,
        })
      } catch (error) {
        await options.runtime.remove(o.ref).catch(() => {})
        fences.delete(o.ref)
        log("sandbox create failed", { ref: o.ref, error: String(error).slice(0, 200) })
        return { status: 502, body: { error: "the sandbox couldn't be started" } }
      }
    } else {
      if (!found) return { status: 404, body: { error: "no such sandbox" } }
      if (!fences.advance(o.ref, o.fence))
        return { status: 409, body: { error: "fenced" } }
      try {
        // A newer holder takes over: every process of the older one ends
        if (found.running) await options.runtime.restart(o.ref)
        else await options.runtime.start(o.ref)
      } catch (error) {
        log("sandbox start failed", { ref: o.ref, error: String(error).slice(0, 200) })
        return { status: 502, body: { error: "the sandbox couldn't be started" } }
      }
    }
    limits.set(o.ref, { idleSeconds: o.idleSeconds, diskMb: o.diskMb })
    lastSeen.set(o.ref, now())
    log("sandbox open", { ref: o.ref, fence: o.fence, fresh: o.fresh })
    return { status: 200, body: { ref: o.ref, fence: o.fence } }
  }

  async function control(method: string, path: string, body: unknown) {
    if (method === "GET" && path === "/v1/node")
      return { status: 200, body: await stats() }
    if (method === "GET" && path === "/v1/sandboxes") {
      const listed: ListedSandbox[] = (await options.runtime.list()).map((s) => ({
        ...s,
        fence: fences.get(s.ref) || null,
      }))
      return { status: 200, body: { sandboxes: listed } }
    }
    if (method !== "POST") return { status: 404, body: { error: "not found" } }
    if (path === "/v1/sandboxes/open") {
      const ref = (body as { ref?: unknown } | null)?.ref
      if (typeof ref !== "string") return open(body)
      return serial(ref, () => {
        addresses.delete(ref)
        return open(body)
      })
    }
    if (path === "/v1/sandboxes/destroy") {
      const parsed = destroySchema.safeParse(body)
      if (!parsed.success) return { status: 400, body: { error: "bad request" } }
      const { ref, fence } = parsed.data
      return serial(ref, async () => {
        if (fence !== undefined && fence < fences.get(ref))
          return { status: 409, body: { error: "fenced" } }
        await options.runtime.remove(ref)
        fences.delete(ref)
        limits.delete(ref)
        lastSeen.delete(ref)
        addresses.delete(ref)
        log("sandbox destroyed", { ref })
        return { status: 200, body: { ref } }
      })
    }
    const parsed = fencedSchema.safeParse(body)
    if (!parsed.success) return { status: 400, body: { error: "bad request" } }
    const { ref, fence } = parsed.data
    if (path === "/v1/sandboxes/stop") {
      return serial(ref, async () => {
        if (fence < fences.get(ref)) return { status: 409, body: { error: "fenced" } }
        await options.runtime.stop(ref)
        addresses.delete(ref)
        log("sandbox stopped", { ref, reason: "asked" })
        return { status: 200, body: { ref } }
      })
    }
    if (fence < fences.get(ref)) return { status: 409, body: { error: "fenced" } }
    if (path === "/v1/sandboxes/touch") {
      const found = await options.runtime.inspect(ref)
      if (!found) return { status: 404, body: { error: "no such sandbox" } }
      lastSeen.set(ref, now())
      return { status: 200, body: { ref, running: found.running } }
    }
    return { status: 404, body: { error: "not found" } }
  }

  // /v1/runner/<ref>/<runner path>: the runner in that sandbox
  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const rest = url.pathname.slice("/v1/runner/".length)
    const slash = rest.indexOf("/")
    const ref = slash > 0 ? rest.slice(0, slash) : ""
    const target = slash > 0 ? rest.slice(slash) : ""
    const fence = Number(req.headers[HEADERS.fence] ?? "")
    const token = String(req.headers[HEADERS.proxy] ?? "")
    if (!parseRef(ref) || !target.startsWith("/v1/") || !Number.isSafeInteger(fence))
      return send(res, 404, { error: "not found" })
    if (!token || !safeEqual(token, proxyToken(options.key, ref, fence)))
      return send(res, 401, { error: "unauthorized" })
    const current = fences.get(ref)
    if (!current || fence !== current) return send(res, 409, { error: "fenced" })
    const base = addresses.get(ref) ?? (await options.runtime.address(ref))
    if (!base) return send(res, 404, { error: "no such sandbox" })
    addresses.set(ref, base)

    lastSeen.set(ref, now())
    inflight.set(ref, (inflight.get(ref) ?? 0) + 1)
    let ended = false
    const done = () => {
      if (ended) return
      ended = true
      inflight.set(ref, Math.max(0, (inflight.get(ref) ?? 1) - 1))
      lastSeen.set(ref, now())
    }
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers))
      if (!HOP.has(name) && value !== undefined) headers[name] = value
    const upstream = http.request(
      `${base}${target}${url.search}`,
      { method: req.method, headers },
      (answer) => {
        const out: http.OutgoingHttpHeaders = {}
        for (const [name, value] of Object.entries(answer.headers))
          if (!HOP.has(name) && value !== undefined) out[name] = value
        res.writeHead(answer.statusCode ?? 502, out)
        answer.pipe(res)
        answer.on("end", done)
        answer.on("error", done)
      }
    )
    upstream.on("error", () => {
      addresses.delete(ref)
      done()
      if (!res.headersSent)
        send(res, 502, { error: "the workspace runner didn't answer" })
      else res.destroy()
    })
    // The caller went away (a canceled task): the runner sees its request
    // end and stops the command's process group (CD-16 cancellation path)
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy()
      done()
    })
    req.pipe(upstream)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://node")
      if (req.method === "GET" && url.pathname === "/v1/health")
        return send(res, 200, { ok: true, protocol: NODE_PROTOCOL })
      if (url.pathname.startsWith("/v1/runner/")) return await proxy(req, res, url)
      const body = await readBody(req, CONTROL_BODY).catch(() => null)
      if (!body) return send(res, 413, { error: "too large" })
      const path = url.pathname + url.search
      if (!verify(req, path, body)) return send(res, 401, { error: "unauthorized" })
      let json: unknown = null
      if (body.length) {
        try {
          json = JSON.parse(body.toString("utf8"))
        } catch {
          return send(res, 400, { error: "bad json" })
        }
      }
      const answer = await control(req.method ?? "GET", url.pathname, json)
      send(res, answer.status, answer.body as Json)
    } catch (error) {
      log("node request failed", { error: String(error).slice(0, 200) })
      if (!res.headersSent) send(res, 500, { error: "the node had an error" })
      else res.destroy()
    }
  })

  // Idle stop, disk quota and housekeeping; the caller runs it on a timer
  async function sweep(options2: { usage?: boolean } = {}) {
    const t = now()
    for (const [nonce, until] of nonces) if (until < t) nonces.delete(nonce)
    const listed = await options.runtime.list().catch(() => [])
    const sizes = options2.usage
      ? await options.runtime.usage().catch(() => new Map<string, number>())
      : new Map<string, number>()
    for (const { ref, running } of listed) {
      if (!running) continue
      if (!lastSeen.has(ref)) lastSeen.set(ref, t)
      const limit = limits.get(ref) ?? options.defaults
      const idle =
        (inflight.get(ref) ?? 0) === 0 &&
        t - lastSeen.get(ref)! > limit.idleSeconds * 1000
      const over = (sizes.get(ref) ?? 0) > limit.diskMb * 1024 * 1024
      if (idle || over) {
        addresses.delete(ref)
        await options.runtime.stop(ref).catch(() => {})
        log("sandbox stopped", { ref, reason: over ? "disk_quota" : "idle" })
      }
    }
  }

  return {
    server,
    sweep,
    reprobe,
    fences,
    get probe() {
      return probe
    },
  }
}
