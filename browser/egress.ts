import { lookup as dnsLookup } from "node:dns/promises"
import http from "node:http"
import net from "node:net"

// The egress guard (BROWSER_AND_LOGIN_PROFILES.md §4): Chromium reaches the
// internet only through this local proxy. Each request's host is resolved
// here, every address is checked, and the connection goes to the checked
// address, so a redirect or a DNS answer that changes can't reach Render's
// private network, metadata endpoints or this machine. Only ports 80 and
// 443. Never relaxed; tests map fixture host names in code (never from env).

const blocked = new net.BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(address, prefix, "ipv4")
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 can map to private IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, "ipv6")
}

export function isBlockedAddress(address: string) {
  const family = net.isIP(address)
  if (family === 0) return true
  // IPv4-mapped IPv6 is never needed by a public site. (Not a BlockList
  // rule: BlockList applies ::ffff:0:0/96 to plain IPv4 addresses too.)
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return true
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6")
}

// Names that only ever mean something inside a network
export function isBlockedHost(host: string) {
  const name = host.toLowerCase().replace(/\.$/, "")
  return (
    !name.includes(".") ||
    name === "localhost" ||
    /\.(localhost|internal|local)$/.test(name) ||
    name === "onrender.com" ||
    name.endsWith(".onrender.com")
  )
}

const PORTS = new Set([80, 443])
const REFUSED = "Blocked by Kriya's egress guard."

type Target = { host: string; port: number }
type Lookup = (host: string) => Promise<string[]>
export type EgressOptions = { fixtures?: Record<string, Target>; lookup?: Lookup }

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

export async function startEgressProxy(options: EgressOptions = {}) {
  const fixtures = new Map(Object.entries(options.fixtures ?? {}))
  const lookup = options.lookup ?? defaultLookup

  // Where to connect for host:port, or the status that refuses it
  async function route(rawHost: string, port: number): Promise<Target | 403 | 502> {
    const host = rawHost
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
    if (!PORTS.has(port)) return 403
    const fixture = fixtures.get(host)
    if (fixture) return fixture
    if (net.isIP(host)) return isBlockedAddress(host) ? 403 : { host, port }
    if (isBlockedHost(host)) return 403
    let addresses: string[]
    try {
      addresses = await lookup(host)
    } catch {
      return 502
    }
    // One private answer is enough to refuse: no round-robin rebinding
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) return 403
    return { host: addresses[0], port }
  }

  const server = http.createServer(async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? "")
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end()
      return
    }
    const target = await route(url.hostname, Number(url.port || 80))
    if (typeof target === "number") {
      res.writeHead(target, { "content-type": "text/plain" }).end(REFUSED)
      return
    }
    const headers = { ...req.headers }
    delete headers["proxy-connection"]
    delete headers["proxy-authorization"]
    const upstream = http.request(
      { ...target, method: req.method, path: url.pathname + url.search, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      }
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })

  // HTTPS (and WSS) tunnels
  server.on("connect", async (req, socket, head) => {
    socket.on("error", () => socket.destroy())
    let host = ""
    let port = 0
    try {
      const url = new URL(`http://${req.url}`)
      host = url.hostname
      port = Number(url.port || 80)
    } catch {}
    const target = host ? await route(host, port) : 403
    if (typeof target === "number") {
      socket.end(
        `HTTP/1.1 ${target} ${target === 403 ? "Forbidden" : "Bad Gateway"}\r\n\r\n`
      )
      return
    }
    const upstream = net.connect(target.port, target.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => upstream.destroy())
  })

  // Plain ws:// isn't proxied; wss:// goes through the tunnel check above
  server.on("upgrade", (_req, socket) => socket.destroy())

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
