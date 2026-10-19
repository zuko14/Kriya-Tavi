import { createHash, timingSafeEqual } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { pathToFileURL } from "node:url"

import { chromium, type Browser } from "playwright-core"
import { WebSocketServer } from "ws"

import { startEgressProxy, type EgressOptions } from "./egress"
import { UsedTokens, verifyLiveToken } from "./live"
import type { BrowserAction, OpenSession, PdfOptions, StorageState } from "./protocol"
import { DEFAULT_LIMITS, Session, type Limits } from "./session"

// kriya-browser (AD-08, BROWSER_AND_LOGIN_PROFILES.md §2): a private service
// the worker drives with KRIYA_BROWSER_SECRET. No database, no other secret,
// and every page load goes through the egress guard.

const ACTIONS = new Set([
  "open",
  "snapshot",
  "click",
  "type",
  "select",
  "upload",
  "scroll",
  "screenshot",
  "handoff",
])
// An upload carries one file (≤ 10 MB on the default plan) as base64
const MAX_BODY = 16 * 1024 * 1024

type Options = {
  secret: string
  port?: number
  host?: string
  maxSessions?: number
  limits?: Partial<Limits>
  executablePath?: string
  // Tests only: fixture host names and a DNS table; never from the environment
} & EgressOptions

const digest = (value: string) => createHash("sha256").update(value).digest()

// Shape check only; the worker builds the state from a sealed profile
function isStorageState(value: unknown): value is StorageState {
  const state = value as StorageState
  return (
    Boolean(state) &&
    Array.isArray(state.cookies) &&
    Array.isArray(state.origins) &&
    state.cookies.length <= 500 &&
    state.origins.length <= 50 &&
    state.cookies.every(
      (c) => typeof c?.name === "string" && typeof c.domain === "string"
    )
  )
}

export async function createBrowserService(options: Options) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const maxSessions = options.maxSessions ?? 3
  const expected = digest(`Bearer ${options.secret}`)
  const proxy = await startEgressProxy({
    fixtures: options.fixtures,
    lookup: options.lookup,
  })
  const sessions = new Map<string, Session>()
  let pdfBrowser: Promise<Browser> | null = null
  const usedTokens = new UsedTokens()

  const end = async (id: string, capture = false) => {
    const session = sessions.get(id)
    sessions.delete(id)
    return session ? session.close(capture) : { seconds: 0 }
  }

  // Sessions without a heartbeat, or past their length, are closed
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (
        now - session.lastSeen > limits.idleSeconds * 1000 ||
        now - session.openedAt > limits.maxSeconds * 1000
      ) {
        void end(id)
      }
    }
  }, 500)
  sweeper.unref()

  async function renderPdf(html: string, pdf: PdfOptions = {}) {
    pdfBrowser ??= chromium.launch({
      headless: true,
      chromiumSandbox: true,
      executablePath: options.executablePath,
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>" },
    })
    // Fresh context, no JavaScript, no network at all (AD-18)
    const context = await (
      await pdfBrowser
    ).newContext({ javaScriptEnabled: false, offline: true })
    try {
      await context.route("**/*", (route) => route.abort())
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: "load", timeout: 15_000 })
      return await page.pdf({
        format: pdf.format ?? "A4",
        landscape: pdf.landscape ?? false,
        printBackground: true,
      })
    } finally {
      await context.close()
    }
  }

  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error("too large"))
          req.destroy()
        } else chunks.push(chunk)
      })
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
        } catch (error) {
          reject(error)
        }
      })
      req.on("error", reject)
    })

  async function route(req: http.IncomingMessage) {
    const { pathname } = new URL(req.url ?? "/", "http://browser")
    const [, first, id, verb] = pathname.split("/")
    if (req.method === "GET" && pathname === "/health") {
      return { status: 200, body: { ok: true, sessions: sessions.size } }
    }
    const auth = digest(String(req.headers.authorization ?? ""))
    if (!timingSafeEqual(auth, expected)) {
      return { status: 401, body: { error: "unauthorized" } }
    }

    if (req.method === "POST" && pathname === "/sessions") {
      const input = (await readBody(req)) as Partial<OpenSession>
      if (typeof input.taskId !== "string" || typeof input.userId !== "string") {
        return { status: 400, body: { error: "taskId and userId are required" } }
      }
      const domains = input.allowedDomains
      if (
        domains !== undefined &&
        (!Array.isArray(domains) ||
          domains.length > 10 ||
          !domains.every((d) => typeof d === "string" && /^[a-z0-9.-]{1,253}$/.test(d)))
      ) {
        return { status: 400, body: { error: "allowedDomains must be host names" } }
      }
      if (input.state !== undefined && !isStorageState(input.state)) {
        return { status: 400, body: { error: "state is not a storage state" } }
      }
      if (sessions.size >= maxSessions) return { status: 503, body: { error: "busy" } }
      const session = await Session.open({
        proxyPort: proxy.port,
        limits,
        userId: input.userId,
        viewport: input.viewport,
        executablePath: options.executablePath,
        state: input.state,
        allowedDomains: domains,
      })
      sessions.set(session.id, session)
      return { status: 200, body: { sessionId: session.id } }
    }
    if (req.method === "POST" && pathname === "/render/pdf") {
      const { html, options: pdf } = (await readBody(req)) as {
        html?: unknown
        options?: PdfOptions
      }
      if (typeof html !== "string")
        return { status: 400, body: { error: "html is required" } }
      return {
        status: 200,
        body: { pdf: (await renderPdf(html, pdf)).toString("base64") },
      }
    }
    if (first !== "sessions" || !id) return { status: 404, body: { error: "not found" } }

    const session = sessions.get(id)
    if (req.method === "POST" && verb === "actions") {
      const action = (await readBody(req)) as BrowserAction
      if (!ACTIONS.has(action?.action)) {
        return { status: 400, body: { error: "unknown action" } }
      }
      if (!session) {
        return {
          status: 200,
          body: {
            ok: false,
            error: "stopped",
            message: "This browser session has ended.",
          },
        }
      }
      return { status: 200, body: await session.act(action) }
    }
    if (req.method === "GET" && verb === "snapshot") {
      if (!session) return { status: 404, body: { error: "no such session" } }
      return { status: 200, body: await session.snapshot() }
    }
    if (req.method === "POST" && verb === "heartbeat") {
      if (session) session.lastSeen = Date.now()
      return { status: 200, body: { ok: Boolean(session && session.state !== "closed") } }
    }
    if (req.method === "POST" && verb === "close") {
      const { captureState } = (await readBody(req)) as { captureState?: unknown }
      return { status: 200, body: await end(id, captureState === true) }
    }
    return { status: 404, body: { error: "not found" } }
  }

  const server = http.createServer((req, res) => {
    route(req)
      .catch(() => ({ status: 500, body: { error: "failed" } }))
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      })
  })
  // The live view (take-over), the only route the person's browser reaches:
  // /live/<session id>?token=…, minted by kriya-web for that person. A bad,
  // reused or expired token, another person's session or a second viewer is
  // refused before the upgrade, so no frame is ever sent (AT-BRW-12).
  const live = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  server.on("upgrade", (req, socket, head) => {
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const url = new URL(req.url ?? "/", "http://browser")
    const [, first, id, extra] = url.pathname.split("/")
    if (first !== "live" || !id || extra !== undefined) return refuse("404 Not Found")
    const user = verifyLiveToken(
      url.searchParams.get("token") ?? "",
      id,
      options.secret,
      usedTokens
    )
    const session = sessions.get(id)
    if (!user || !session || session.userId !== user || session.state === "closed") {
      return refuse("401 Unauthorized")
    }
    if (session.live) return refuse("409 Conflict")
    live.handleUpgrade(req, socket, head, (ws) => void session.attachLive(ws))
  })

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve)
  )
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    // In-process only, for tests: each live session's temporary profile
    profileDirs: () => [...sessions.values()].map((session) => session.dir),
    close: async () => {
      clearInterval(sweeper)
      await Promise.all([...sessions.keys()].map((id) => end(id)))
      live.close()
      if (pdfBrowser) await (await pdfBrowser).close().catch(() => {})
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await proxy.close()
    },
  }
}

// `npm run browser`: configuration from the environment, names only in errors
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.KRIYA_BROWSER_SECRET ?? ""
  if (secret.length < 32) {
    console.error(
      "[kriya-browser] KRIYA_BROWSER_SECRET is missing or shorter than 32 characters"
    )
    process.exit(1)
  }
  const number = (value: string | undefined, fallback: number) => {
    const n = Number.parseInt(value ?? "", 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const port = number(process.env.PORT, 10000)
  const service = await createBrowserService({
    secret,
    port,
    host: "0.0.0.0",
    maxSessions: number(process.env.BROWSER_MAX_SESSIONS, 3),
    limits: { maxSeconds: number(process.env.BROWSER_SESSION_MAX_SECONDS, 900) },
    executablePath: process.env.BROWSER_CHROMIUM_PATH || undefined,
  })
  console.info(`[kriya-browser] listening on ${port}`)
  const stop = () => void service.close().then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
