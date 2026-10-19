import type {
  ActionResult,
  BrowserAction,
  BrowserProvider,
  OpenSession,
  PdfOptions,
  Snapshot,
  StorageState,
} from "@/lib/browser/provider"
import { registrableDomain } from "@/lib/browser/sites"

// The worker's side of kriya-browser: HTTPS + KRIYA_BROWSER_SECRET to the
// private service (BROWSER_AND_LOGIN_PROFILES.md §2.2). The secret never
// appears in an error.

const withDomain = (snapshot: Snapshot): Snapshot => {
  let domain = snapshot.facts.domain
  try {
    domain = registrableDomain(new URL(snapshot.facts.url).hostname)
  } catch {}
  return { ...snapshot, facts: { ...snapshot.facts, domain } }
}

export class HttpBrowserProvider implements BrowserProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 30_000
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok)
      throw new Error(`kriya-browser ${path.split("/")[1]}: HTTP ${res.status}`)
    return (await res.json()) as T
  }

  open(input: OpenSession) {
    return this.call<{ sessionId: string }>("POST", "/sessions", input)
  }

  async act(sessionId: string, action: BrowserAction) {
    const result = await this.call<ActionResult>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/actions`,
      action
    )
    if (result.snapshot) result.snapshot = withDomain(result.snapshot)
    return result
  }

  async snapshot(sessionId: string) {
    return withDomain(
      await this.call<Snapshot>(
        "GET",
        `/sessions/${encodeURIComponent(sessionId)}/snapshot`
      )
    )
  }

  async heartbeat(sessionId: string) {
    const { ok } = await this.call<{ ok: boolean }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/heartbeat`
    )
    return ok
  }

  close(sessionId: string, captureState = false) {
    return this.call<{ seconds: number; state?: StorageState }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/close`,
      { captureState }
    )
  }

  async renderPdf(html: string, options?: PdfOptions) {
    const { pdf } = await this.call<{ pdf: string }>("POST", "/render/pdf", {
      html,
      options,
    })
    return Buffer.from(pdf, "base64")
  }
}
