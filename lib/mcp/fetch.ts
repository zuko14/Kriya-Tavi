import { lookup as dnsLookup } from "node:dns/promises"
import https from "node:https"
import type { LookupFunction } from "node:net"
import { Readable, Transform } from "node:stream"

import { isBlockedAddress, isBlockedHost } from "@/browser/egress"

// The only way Kriya reaches an MCP server (ND-10, MCP_CONNECTIVITY §5).
// HTTPS to the server's own host or one of its OAuth origins; the name is
// resolved here, every address checked with the egress guard's own rules
// (imported, never copied), and the connection goes to the checked address
// with the original name for TLS, so a DNS answer that changes between
// check and use can't reach a private range. No redirects, no cookies.
// Node's fetch takes no lookup hook without adding undici, hence node:https.

export const OPEN_TIMEOUT_MS = 10_000
export const MAX_BODY_BYTES = 2 * 1024 * 1024

export class EgressError extends Error {
  name = "EgressError"
}

type Lookup = (host: string) => Promise<string[]>
// Tests only: a stand-in for https.request
type HttpsRequest = typeof https.request

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

// The connection resolves the name to the checked address only. Node asks
// with { all: true } (address family selection) and expects a list then.
export function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(":") ? 6 : 4
  return (_name, options, callback) => {
    if ((options as { all?: boolean }).all)
      (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ])
    else callback(null, address, family)
  }
}

export function guardedFetch(
  server: { url: string; allowedAuthOrigins: string[] },
  deps: { lookup?: Lookup; request?: HttpsRequest } = {}
): typeof fetch {
  const lookup = deps.lookup ?? defaultLookup
  const request = deps.request ?? https.request
  const hosts = new Set(
    [server.url, ...server.allowedAuthOrigins].map((url) => new URL(url).hostname)
  )

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== "https:") throw new EgressError("Only https is allowed.")
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (!hosts.has(host)) throw new EgressError(`${host} isn't this app's server.`)
    if (isBlockedHost(host)) throw new EgressError(`${host} is a private name.`)
    // One private answer is enough to refuse: no round-robin rebinding
    const addresses = await lookup(host)
    if (addresses.length === 0 || addresses.some(isBlockedAddress))
      throw new EgressError(`${host} resolves to a private address.`)
    const pinned = pinnedLookup(addresses[0])

    const headers = new Headers(init.headers)
    headers.delete("cookie")
    const body =
      init.body == null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : Buffer.from(await new Response(init.body).arrayBuffer())

    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(headers),
          lookup: pinned,
          servername: host,
          signal: init.signal ?? undefined,
        },
        (res) => {
          clearTimeout(timer)
          const status = res.statusCode ?? 502
          if (status >= 300 && status < 400) {
            res.destroy()
            reject(
              new EgressError("The app's server tried to redirect; Kriya doesn't follow.")
            )
            return
          }
          let seen = 0
          const capped = res.pipe(
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                seen += chunk.length
                if (seen > MAX_BODY_BYTES)
                  done(new EgressError("The app's answer is too large."))
                else done(null, chunk)
              },
            })
          )
          const out = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (name === "set-cookie" || value == null) continue
            out.set(name, Array.isArray(value) ? value.join(", ") : value)
          }
          resolve(
            new Response(
              status === 204 || status === 304
                ? null
                : (Readable.toWeb(capped) as ReadableStream<Uint8Array>),
              { status, headers: out }
            )
          )
        }
      )
      const timer = setTimeout(
        () => req.destroy(new EgressError("The app's server didn't answer in time.")),
        OPEN_TIMEOUT_MS
      )
      req.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      req.end(body)
    })
  }) as typeof fetch
}
