import { spawn } from "node:child_process"
import { lookup as dnsLookup } from "node:dns/promises"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"

import { isBlockedAddress, isBlockedHost } from "../browser/egress"

// CD-12 inside the image: commands reach the network only through this
// proxy. A root-owned firewall lets the command user (`kriya`) talk to
// loopback and nothing else; the proxy runs in the root runner, resolves
// each name itself, checks every address with browser/egress.ts's
// predicates, and dials the checked address. `registries`: the package
// registries below, port 443 only. `offline`: nothing. Applied only when
// the runner runs as root (the image); the local provider has no isolation.

export const PROXY_PORT = 10001

// npm, PyPI and its file host, crates.io (sparse index and downloads), the
// Go module proxy and its checksum database
export const REGISTRIES = new Set([
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
])

export type Network = "registries" | "offline"

const METADATA_V4 = "169.254.0.0/16"
const METADATA_V6 = "fd00:ec2::254"
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]
const PRIVATE_V6 = ["fc00::/7", "fe80::/10"]
// Docker's embedded resolver sits on loopback; the proxy resolves instead
const LOOPBACK_RESOLVER = "127.0.0.11"
const CHAIN = "KRIYA_EGRESS"

// The rules for both families, as argument lists for iptables / ip6tables.
// The command user may reach loopback (the proxy, servers it starts
// itself) except a resolver there; everything else is rejected. The
// explicit metadata and private rejects come first so each shows in the
// counters; the last rule would refuse them anyway. Same for both
// profiles: the proxy is what differs. Idempotent: a runner restarted in
// the same VM flushes and rewrites its own chain and adds the jump once.
export function firewallRules(uid: number) {
  const reject = ["-j", "REJECT"]
  const family = (head: string[][], tail: string[][]) => ({
    rules: [
      ["-F", CHAIN],
      ...head,
      ["-A", CHAIN, "-o", "lo", "-j", "ACCEPT"],
      ...tail,
      ["-A", CHAIN, ...reject],
    ],
    jump: ["OUTPUT", "-m", "owner", "--uid-owner", String(uid), "-j", CHAIN],
  })
  return {
    v4: family(
      [["-A", CHAIN, "-d", LOOPBACK_RESOLVER, ...reject]],
      [METADATA_V4, ...PRIVATE_V4].map((range) => ["-A", CHAIN, "-d", range, ...reject])
    ),
    v6: family(
      [],
      [METADATA_V6, ...PRIVATE_V6].map((range) => ["-A", CHAIN, "-d", range, ...reject])
    ),
  }
}

type Run = (command: string, args: string[]) => Promise<{ code: number; stderr: string }>

const run: Run = (command, args) =>
  new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text))
    child.on("error", (error) => done({ code: 127, stderr: error.message }))
    child.on("close", (code) => done({ code: code ?? 1, stderr }))
  })

// A non-loopback IPv6 address on this machine (/proc/net/if_inet6)
function hasIpv6() {
  try {
    return fs
      .readFileSync("/proc/net/if_inet6", "utf8")
      .split("\n")
      .some((line) => line.trim() && !line.trim().endsWith(" lo"))
  } catch {
    return false
  }
}

async function applyFamily(
  exec: Run,
  command: string,
  { rules, jump }: ReturnType<typeof firewallRules>["v4"]
) {
  // The chain may exist from an earlier start; -F below must then succeed
  await exec(command, ["-N", CHAIN])
  for (const args of rules) {
    const result = await exec(command, args)
    if (result.code !== 0) return `${command} ${args.join(" ")}: ${result.stderr.trim()}`
  }
  if ((await exec(command, ["-C", ...jump])).code === 0) return null
  const result = await exec(command, ["-I", jump[0], "1", ...jump.slice(1)])
  return result.code === 0 ? null : `${command} -I ${jump[0]}: ${result.stderr.trim()}`
}

// Throws unless the rules are in place: the runner then doesn't start
// (fail closed). IPv6 rules may be missing only where no IPv6 exists
export async function applyFirewall(
  uid: number,
  deps: { run?: Run; ipv6?: () => boolean } = {}
) {
  const exec = deps.run ?? run
  const { v4, v6 } = firewallRules(uid)
  const failed = await applyFamily(exec, "iptables", v4)
  if (failed) throw new Error(failed)
  const failed6 = await applyFamily(exec, "ip6tables", v6)
  if (!failed6) return { ipv6: true }
  if ((deps.ipv6 ?? hasIpv6)()) throw new Error(`${failed6} (IPv6 is up)`)
  return { ipv6: false }
}

const REFUSED =
  "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nBlocked by Kriya's workspace egress policy (CD-12).\n"

type Lookup = (host: string) => Promise<string[]>
type Dial = (address: string, port: number) => net.Socket

// Why a CONNECT target is refused, or null when it may go
export function refusal(network: Network, host: string, port: number): string | null {
  if (network !== "registries") return "offline workspace"
  if (port !== 443) return "port"
  const name = host.toLowerCase().replace(/\.$/, "")
  if (net.isIP(name) || isBlockedHost(name) || !REGISTRIES.has(name)) return "host"
  return null
}

// The checked addresses for a host; empty when any answer is blocked
async function vetted(host: string, lookup: Lookup) {
  const addresses = await lookup(host).catch(() => [] as string[])
  return addresses.length && addresses.every((address) => !isBlockedAddress(address))
    ? addresses
    : []
}

export async function startRegistryProxy(options: {
  network: Network
  port?: number
  // Tests: resolve and dial without the internet; the checks are the same
  lookup?: Lookup
  dial?: Dial
}) {
  const lookup: Lookup =
    options.lookup ??
    (async (host) =>
      (await dnsLookup(host, { all: true })).map((answer) => answer.address))
  const dial: Dial =
    options.dial ?? ((address, port) => net.connect({ host: address, port }))

  const server = http.createServer((_req, res) => {
    // Only CONNECT tunnels: every registry is HTTPS
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end("Blocked by Kriya's workspace egress policy (CD-12).\n")
  })
  server.on("connect", async (req, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy())
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? "")
    const host = match?.[1] ?? ""
    const port = Number(match?.[2] ?? 0)
    const why = match ? refusal(options.network, host, port) : "target"
    const addresses = why ? [] : await vetted(host, lookup)
    if (!addresses.length) return socket.end(REFUSED)
    const upstream = dial(addresses[0], port)
    upstream.setTimeout(30_000, () => upstream.destroy())
    upstream.on("error", () => socket.end(REFUSED))
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    socket.on("close", () => upstream.destroy())
  })
  await new Promise<void>((done) =>
    server.listen(options.port ?? PROXY_PORT, "127.0.0.1", done)
  )
  const address = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}
