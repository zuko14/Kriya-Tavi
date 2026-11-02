import { WorkspaceProviderError } from "@/lib/cloud/provider"
import { log } from "@/lib/log"

// HTTP for the vendor adapters (TOOLS_AND_CONTRACTS §1, rules 4 and 5):
// idempotent calls retry up to twice on transport errors, create never
// does; a refusal becomes a plain message; logs carry the operation and
// status code only, never a body, URL query or key.

export type Fetcher = typeof fetch

const RETRIES = 2

function plain(status: number) {
  if (status === 401 || status === 403)
    return "The cloud workspace provider refused Kriya's key."
  if (status === 404) return "The cloud workspace no longer exists at the provider."
  if (status === 409) return "The cloud workspace is busy at the provider; try again."
  if (status === 429)
    return "The cloud workspace provider is limiting requests; try again shortly."
  return "The cloud workspace provider had an error."
}

export class ProviderHttp {
  constructor(
    private readonly provider: "e2b" | "daytona",
    private readonly fetcher: Fetcher = fetch
  ) {}

  // The response when ok or its status is in `allow` (e.g. 404 for "gone")
  async request(
    op: string,
    url: string,
    init: RequestInit & { retry?: boolean; allow?: number[]; timeoutMs?: number }
  ) {
    const { retry = false, allow = [], timeoutMs = 30_000, ...rest } = init
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        const timeout = AbortSignal.timeout(timeoutMs)
        res = await this.fetcher(url, {
          ...rest,
          signal: rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout,
        })
      } catch {
        if (retry && attempt < RETRIES) continue
        log.warn("workspace provider unreachable", { provider: this.provider, op })
        throw new WorkspaceProviderError(
          "The cloud workspace provider couldn't be reached."
        )
      }
      if (res.ok || allow.includes(res.status)) return res
      // Not awaited: nothing in the body is needed
      void res.body?.cancel().catch(() => {})
      log.warn("workspace provider refused", {
        provider: this.provider,
        op,
        status: res.status,
      })
      throw new WorkspaceProviderError(plain(res.status))
    }
  }

  async json<T>(op: string, url: string, init: Parameters<ProviderHttp["request"]>[2]) {
    const res = await this.request(op, url, init)
    if (res.status === 404 && init.allow?.includes(404)) return null
    try {
      return (await res.json()) as T
    } catch {
      log.warn("workspace provider answer unreadable", { provider: this.provider, op })
      throw new WorkspaceProviderError(
        "The cloud workspace provider's answer was unreadable."
      )
    }
  }
}
