import http from "node:http"
import net from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { isBlockedAddress, isBlockedHost, startEgressProxy } from "@/browser/egress"

// AT-BRW-06: the egress guard refuses private, loopback, link-local,
// metadata and CGNAT addresses and every port but 80/443, at connect time,
// after resolving the name, so redirects and DNS tricks can't get past it.
// Plain Node: runs without Chromium and without any real network.

describe("blocked addresses", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
  ])("%s is blocked", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"])(
    "%s is allowed",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  )

  it("anything that isn't an IP address is blocked", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true)
  })

  it.each([
    "localhost",
    "foo.localhost",
    "metadata.google.internal",
    "printer.local",
    "kriya-worker",
    "kriya-web.onrender.com",
  ])("host %s is blocked by name", (host) => {
    expect(isBlockedHost(host)).toBe(true)
  })

  it("ordinary names are left to the address check", () => {
    expect(isBlockedHost("www.example.com")).toBe(false)
  })
})

describe("proxy", () => {
  let fixture: http.Server
  let fixturePort: number
  let proxy: Awaited<ReturnType<typeof startEgressProxy>>

  // Names resolve only through this table: no real DNS in tests
  const dns: Record<string, string[]> = {
    "public.test": ["93.184.216.34"],
    "rebind.test": ["93.184.216.34", "127.0.0.1"],
    "inside.test": ["10.1.2.3"],
  }

  beforeAll(async () => {
    fixture = http.createServer((req, res) => {
      if (req.url === "/to-loopback") {
        res.writeHead(302, { location: `http://127.0.0.1:${fixturePort}/secret` })
        return res.end()
      }
      res.end(`fixture ${req.headers.host} ${req.url}`)
    })
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve))
    fixturePort = (fixture.address() as net.AddressInfo).port
    proxy = await startEgressProxy({
      fixtures: { "site.fixture.test": { host: "127.0.0.1", port: fixturePort } },
      lookup: async (host) => {
        const addresses = dns[host]
        if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
        return addresses
      },
    })
  })

  afterAll(async () => {
    await proxy.close()
    await new Promise((resolve) => fixture.close(resolve))
  })

  const viaProxy = (url: string) =>
    new Promise<{ status: number; body: string; location?: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: url,
            headers: { host: new URL(url).host },
          },
          (res) => {
            let body = ""
            res.on("data", (chunk) => (body += chunk))
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                location: res.headers.location,
              })
            )
          }
        )
        req.on("error", reject)
        req.end()
      }
    )

  const connectVia = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      )
      socket.once("data", (chunk) => {
        resolve(chunk.toString().split("\r\n")[0])
        socket.destroy()
      })
      socket.on("error", reject)
    })

  it("serves a mapped fixture site", async () => {
    const res = await viaProxy("http://site.fixture.test/page")
    expect(res).toMatchObject({ status: 200, body: "fixture site.fixture.test /page" })
  })

  it("refuses loopback, metadata and private targets, by address or by name", async () => {
    for (const url of [
      `http://127.0.0.1:${fixturePort}/secret`,
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost/",
      "http://inside.test/",
      "http://rebind.test/",
    ]) {
      const res = await viaProxy(url)
      expect(res.status, url).toBe(403)
      expect(res.body).not.toContain("fixture")
    }
  })

  it("refuses ports other than 80 and 443", async () => {
    expect((await viaProxy("http://public.test:8080/")).status).toBe(403)
    expect(await connectVia("public.test:22")).toMatch(/403/)
  })

  it("refuses HTTPS tunnels to private addresses", async () => {
    expect(await connectVia("169.254.169.254:443")).toMatch(/403/)
    expect(await connectVia("10.0.0.1:443")).toMatch(/403/)
    expect(await connectVia("rebind.test:443")).toMatch(/403/)
  })

  it("a redirect to loopback is refused when it is followed", async () => {
    const first = await viaProxy("http://site.fixture.test/to-loopback")
    expect(first.status).toBe(302)
    expect(first.location).toBe(`http://127.0.0.1:${fixturePort}/secret`)
    const next = await viaProxy(first.location!)
    expect(next.status).toBe(403)
    expect(next.body).not.toContain("fixture")
  })

  it("names that don't resolve fail without reaching anything", async () => {
    expect((await viaProxy("http://evil.test/")).status).toBe(502)
  })
})
