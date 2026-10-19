import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core"
import type { WebSocket } from "ws"

import {
  LIVE_KEYS,
  type ActionResult,
  type BrowserAction,
  type BrowserErrorCode,
  type LiveInput,
  type LiveOutput,
  type Snapshot,
  type StorageState,
} from "./protocol"
import { collect, toSnapshot, type Collected } from "./snapshot"

// One person's browser for one task: its own Chromium process and its own
// temporary profile, deleted on close (AD-08, AT-BRW-07). The sandbox is
// always on; there is no switch to turn it off.

export type Limits = {
  perMinute: number
  perSession: number
  maxSeconds: number
  idleSeconds: number // without a worker heartbeat or action
  failures: number // the same step failing this often stops the session
}

export const DEFAULT_LIMITS: Limits = {
  perMinute: 30,
  perSession: 200,
  maxSeconds: 900,
  idleSeconds: 60,
  failures: 3,
}

// The egress guard's refusal page; see egress.ts
const REFUSED = "Blocked by Kriya's egress guard."

const fail = (
  error: BrowserErrorCode,
  message: string,
  snapshot?: Snapshot
): ActionResult => ({ ok: false, error, message, ...(snapshot && { snapshot }) })

export class Session {
  readonly id = randomUUID()
  readonly openedAt = Date.now()
  lastSeen = Date.now()
  state: "open" | "paused" | "closed" = "open"
  // Refs live under a random attribute so a page can't guess or plant them
  private readonly attr = `data-k${randomBytes(6).toString("hex")}`
  private recent: number[] = []
  private total = 0
  private readonly failures = new Map<string, number>()
  private last: Collected | null = null
  private downloads = 0
  // The person's live view during take-over: one socket at a time
  live: WebSocket | null = null

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    readonly dir: string,
    private readonly limits: Limits,
    readonly userId: string
  ) {}

  static async open(options: {
    proxyPort: number
    limits: Limits
    userId: string
    viewport?: { width: number; height: number }
    executablePath?: string
    state?: StorageState
    allowedDomains?: string[]
  }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kriya-browser-"))
    const context = await chromium.launchPersistentContext(dir, {
      headless: true,
      chromiumSandbox: true,
      executablePath: options.executablePath,
      // Everything through the egress guard, loopback included
      proxy: { server: `http://127.0.0.1:${options.proxyPort}`, bypass: "<-loopback>" },
      args: [
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
      ],
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      viewport: options.viewport ?? { width: 1280, height: 800 },
    })
    const page = context.pages()[0] ?? (await context.newPage())
    const session = new Session(context, page, dir, options.limits, options.userId)
    try {
      if (options.state) await context.setStorageState(options.state)
      const allowed = options.allowedDomains
      if (allowed?.length) {
        // With a login profile loaded, the main frame stays on its site; the
        // policy asks first (AT-BRW-08), and this holds even if it didn't
        const inside = (url: string) => {
          try {
            const { protocol, hostname } = new URL(url)
            if (protocol === "about:" || protocol === "data:") return true
            const host = hostname.toLowerCase()
            return allowed.some((d) => host === d || host.endsWith(`.${d}`))
          } catch {
            return false
          }
        }
        await context.route("**/*", (route, request) =>
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame() &&
          !inside(request.url())
            ? route.abort("blockedbyclient")
            : route.fallback()
        )
      }
    } catch (error) {
      await session.close()
      throw error
    }
    // One tab: pop-ups are closed; downloads are counted and refused
    context.on("page", (other) => {
      if (other !== page) other.close().catch(() => {})
    })
    page.on("download", (download) => {
      session.downloads++
      download.cancel().catch(() => {})
    })
    return session
  }

  private remember(current: Collected) {
    const snapshot = toSnapshot(current, this.last)
    this.last = current
    return snapshot
  }

  async snapshot(): Promise<Snapshot> {
    return this.remember(await collect(this.page, this.attr))
  }

  // Take-over (BROWSER §5): the person sees the page and types into it;
  // the agent's actions are refused until they hand it back. Frames go
  // only to this socket and are never stored; input is never logged.
  async attachLive(ws: WebSocket) {
    this.live = ws
    this.state = "paused"
    const send = (message: LiveOutput) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
    }
    let cdp: CDPSession | null = null
    const onNavigate = (frame: { parentFrame(): unknown }) => {
      if (!frame.parentFrame()) send({ t: "page", url: this.page.url() })
    }
    const detach = () => {
      if (this.live === ws) this.live = null
      this.page.off("framenavigated", onNavigate)
      cdp?.detach().catch(() => {})
      cdp = null
    }
    ws.on("close", detach)
    ws.on("message", (raw) => {
      this.lastSeen = Date.now()
      let input: LiveInput
      try {
        input = JSON.parse(String(raw)) as LiveInput
      } catch {
        return
      }
      void this.input(input, ws).catch(() => {})
    })
    try {
      cdp = await this.context.newCDPSession(this.page)
      const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 }
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        this.lastSeen = Date.now()
        send({
          t: "frame",
          data,
          width: Math.round(metadata.deviceWidth),
          height: Math.round(metadata.deviceHeight),
        })
        cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
      })
      this.page.on("framenavigated", onNavigate)
      send({ t: "page", url: this.page.url() })
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
      })
    } catch {
      send({ t: "ended", reason: "The live view couldn't start." })
      ws.close(1011)
    }
  }

  private async input(input: LiveInput, ws: WebSocket) {
    if (this.live !== ws || this.state === "closed") return
    const page = this.page
    const point = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0)
    switch (input.t) {
      case "move":
        return page.mouse.move(point(input.x), point(input.y))
      case "down":
        await page.mouse.move(point(input.x), point(input.y))
        return page.mouse.down()
      case "up":
        await page.mouse.move(point(input.x), point(input.y))
        return page.mouse.up()
      case "wheel":
        await page.mouse.move(point(input.x), point(input.y))
        return page.mouse.wheel(0, Math.max(-2000, Math.min(2000, point(input.dy))))
      case "text":
        if (typeof input.text === "string") {
          return page.keyboard.insertText(input.text.slice(0, 1_000))
        }
        return
      case "key":
        if ((LIVE_KEYS as readonly string[]).includes(input.key)) {
          return page.keyboard.press(input.key)
        }
        return
      case "done":
        // Control goes back to the agent, which looks at the page afresh
        this.state = "open"
        this.last = null
        ws.send(JSON.stringify({ t: "ended", reason: "done" } satisfies LiveOutput))
        ws.close(1000)
        return
    }
  }

  async act(action: BrowserAction): Promise<ActionResult> {
    if (this.state === "closed") return fail("stopped", "This browser session has ended.")
    this.lastSeen = Date.now()
    if (action.action === "handoff") {
      this.state = "paused"
      return { ok: true, snapshot: await this.snapshot() }
    }
    if (this.state === "paused") {
      return fail("paused", "The person has this page now; wait until they hand it back.")
    }
    const now = Date.now()
    this.recent = this.recent.filter((t) => now - t < 60_000)
    if (this.total >= this.limits.perSession) {
      await this.close()
      return fail("stopped", "This session reached its limit of browser actions.")
    }
    if (this.recent.length >= this.limits.perMinute) {
      return fail("rate_limited", "Too many browser actions in a minute; wait a moment.")
    }
    this.recent.push(now)
    this.total++

    let result: ActionResult
    try {
      result = await this.run(action)
    } catch (error) {
      result = fail(
        "failed",
        error instanceof Error ? error.message.split("\n")[0] : "failed"
      )
    }
    if (result.ok) return result
    const key = JSON.stringify(action)
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    if (count >= this.limits.failures) {
      await this.close()
      return fail("stopped", "The same step failed three times, so this session stopped.")
    }
    return result
  }

  private async run(action: BrowserAction): Promise<ActionResult> {
    const page = this.page
    switch (action.action) {
      case "snapshot":
        return { ok: true, snapshot: await this.snapshot() }
      case "open": {
        let url: URL
        try {
          url = new URL(action.url)
        } catch {
          return fail("failed", "That isn't a web address.")
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return fail("blocked", "Only http and https pages can be opened.")
        }
        try {
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15_000 })
        } catch (error) {
          return navigationFailure(error)
        }
        return this.afterNavigation()
      }
      case "scroll":
        await page.mouse.wheel(0, (action.direction === "down" ? 1 : -1) * 600)
        await page.waitForTimeout(300)
        return { ok: true, snapshot: await this.snapshot() }
      case "screenshot": {
        const current = await collect(page, this.attr)
        if (current.facts.focusedSensitive) {
          return fail("sensitive", "No screenshots while a sensitive field is focused.")
        }
        const png = await page.screenshot({ type: "png" })
        return {
          ok: true,
          snapshot: this.remember(current),
          screenshot: {
            sha256: createHash("sha256").update(png).digest("hex"),
            bytes: png.length,
            png: png.toString("base64"),
          },
        }
      }
      case "click":
      case "type":
      case "select":
      case "upload": {
        // The element must still be what the agent saw: a page that swapped
        // it since the snapshot is refused, never clicked
        const seen = this.last?.elements.find((e) => e.ref === action.ref)
        const current = await collect(page, this.attr)
        const now = current.elements.find((e) => e.ref === action.ref)
        const same =
          seen &&
          now &&
          seen.role === now.role &&
          seen.name === now.name &&
          seen.sensitive === now.sensitive
        if (!same) {
          return fail(
            "not_found",
            "The page changed since the last snapshot; look again.",
            this.remember(current)
          )
        }
        if (now.sensitive || current.facts.focusedSensitive || current.facts.captcha) {
          return fail(
            "sensitive",
            "The person has to do this step themselves (browser_handoff)."
          )
        }
        const target = page.locator(`[${this.attr}="${action.ref}"]`).first()
        const downloads = this.downloads
        if (action.action === "upload") {
          // Only into a file field, and only bytes the worker took from kriya.files
          if (now.type !== "file" || !action.file?.data) {
            return fail(
              "blocked",
              "Uploads go only into a file field, from your Kriya files."
            )
          }
          const buffer = Buffer.from(action.file.data, "base64")
          if (buffer.length > 10 * 1024 * 1024)
            return fail("blocked", "That file is too large.")
          await target.setInputFiles(
            { name: action.file.name, mimeType: action.file.mime, buffer },
            { timeout: 5_000 }
          )
        } else if (action.action === "click") await target.click({ timeout: 5_000 })
        else if (action.action === "type") {
          await target.fill(action.text.slice(0, 5_000), { timeout: 5_000 })
        } else await target.selectOption(action.value, { timeout: 5_000 })
        await this.settle()
        if (this.downloads > downloads) {
          return fail("blocked", "Downloads are off in Kriya's browser.")
        }
        return this.afterNavigation()
      }
      default:
        return fail("failed", "Unknown action.")
    }
  }

  private async settle() {
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => {})
    await this.page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {})
  }

  // A page the guard refused, or Chromium's own error page, is a failure
  private async afterNavigation(): Promise<ActionResult> {
    if (this.page.url().startsWith("chrome-error:")) {
      return fail("blocked", "That page couldn't be reached from Kriya's browser.")
    }
    const snapshot = await this.snapshot()
    if (snapshot.text === REFUSED) {
      return fail(
        "blocked",
        "Kriya's browser doesn't visit private or internal addresses."
      )
    }
    return { ok: true, snapshot }
  }

  // `capture`: the storage state as it is now, for saving or refreshing a
  // login profile; read before the browser goes away
  async close(capture = false): Promise<{ seconds: number; state?: StorageState }> {
    let state: StorageState | undefined
    if (this.state !== "closed") {
      if (capture) state = await this.context.storageState().catch(() => undefined)
      this.state = "closed"
      this.live?.close(1000)
      await this.context.close().catch(() => {})
      await fs.rm(this.dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      })
    }
    return { seconds: Math.round((Date.now() - this.openedAt) / 1000), state }
  }
}

function navigationFailure(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_BLOCKED|ERR_ACCESS_DENIED/.test(message)
  ) {
    return fail("blocked", "Kriya's browser doesn't visit private or internal addresses.")
  }
  return fail("failed", message.split("\n")[0])
}
