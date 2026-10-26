import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import https from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"

import { describe, expect, it } from "vitest"

import { EgressError, guardedFetch, MAX_BODY_BYTES, pinnedLookup } from "@/lib/mcp/fetch"

// NT-MCP-10…14: the guarded fetch (ND-10). DNS and the HTTPS request are
// stand-ins, so nothing leaves the machine; what's checked is what the
// guard refuses and where it would connect.

const SERVER = {
  url: "https://mcp.tracker.example/mcp",
  allowedAuthOrigins: ["https://auth.tracker.example"],
}

type Options = {
  servername?: string
  headers: Record<string, string>
  lookup: (
    name: string,
    options: object,
    callback: (e: unknown, address: unknown) => void
  ) => void
}
type Sent = { url: URL; options: Options; body: unknown }

// An https.request stand-in that answers with `status`, `headers` and `body`
function fakeRequest(
  answer: {
    status?: number
    headers?: Record<string, string>
    body?: string | Buffer
  } = {}
) {
  const sent: Sent[] = []
  const request = ((
    url: URL,
    options: Options,
    onResponse: (res: PassThrough) => void
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (b?: unknown) => void
      destroy: () => void
    }
    req.destroy = () => {}
    req.end = (body?: unknown) => {
      sent.push({ url, options, body })
      const res = new PassThrough() as PassThrough & {
        statusCode: number
        headers: object
      }
      res.statusCode = answer.status ?? 200
      res.headers = answer.headers ?? { "content-type": "application/json" }
      onResponse(res)
      res.end(answer.body ?? "{}")
    }
    return req
  }) as never
  return { request, sent }
}

const publicDns = async () => ["93.184.216.34"]

describe("guardedFetch", () => {
  it("sends to the checked address, keeping the name for TLS, without cookies", async () => {
    const { request, sent } = fakeRequest({
      headers: { "content-type": "application/json", "set-cookie": "s=1" },
      body: '{"ok":true}',
    })
    const lookups: string[] = []
    const fetch = guardedFetch(SERVER, {
      lookup: async (host) => (lookups.push(host), ["93.184.216.34"]),
      request,
    })
    const res = await fetch(SERVER.url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "a=b" },
      body: '{"jsonrpc":"2.0"}',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(lookups).toEqual(["mcp.tracker.example"])
    const [{ options, body }] = sent
    expect(options.servername).toBe("mcp.tracker.example")
    expect(options.headers.cookie).toBeUndefined()
    expect(body).toBe('{"jsonrpc":"2.0"}')
    // The connection's own lookup answers with the address that was checked
    const resolved = await new Promise((resolve) =>
      options.lookup("mcp.tracker.example", {}, (_e: unknown, address: unknown) =>
        resolve(address)
      )
    )
    expect(resolved).toBe("93.184.216.34")
  })

  it("allows the server's OAuth origin", async () => {
    const { request, sent } = fakeRequest()
    await guardedFetch(SERVER, { lookup: publicDns, request })(
      "https://auth.tracker.example/.well-known/oauth-authorization-server"
    )
    expect(sent).toHaveLength(1)
  })

  it("NT-MCP-10: refuses http", async () => {
    const { request, sent } = fakeRequest()
    await expect(
      guardedFetch(SERVER, { lookup: publicDns, request })(
        "http://mcp.tracker.example/mcp"
      )
    ).rejects.toThrow(EgressError)
    expect(sent).toEqual([])
  })

  it("NT-MCP-11: refuses a host outside the server's allow-list (e.g. metadata it points to)", async () => {
    const { request, sent } = fakeRequest()
    const fetch = guardedFetch(SERVER, { lookup: publicDns, request })
    for (const url of [
      "https://evil.example/collect",
      "https://169.254.169.254/latest/meta-data/",
    ])
      await expect(fetch(url)).rejects.toThrow(EgressError)
    expect(sent).toEqual([])
  })

  it("NT-MCP-12: refuses a private host name even if the owner listed it", async () => {
    const { request, sent } = fakeRequest()
    const fetch = guardedFetch(
      { url: "https://mcp.svc.internal/mcp", allowedAuthOrigins: ["https://localhost"] },
      { lookup: publicDns, request }
    )
    await expect(fetch("https://mcp.svc.internal/mcp")).rejects.toThrow(/private name/)
    await expect(fetch("https://localhost/")).rejects.toThrow(/private name/)
    expect(sent).toEqual([])
  })

  it("NT-MCP-13: refuses private, link-local and metadata answers, and resolves once", async () => {
    for (const answer of [
      ["10.0.0.1"],
      ["169.254.169.254"],
      ["93.184.216.34", "127.0.0.1"],
      [],
    ]) {
      const { request, sent } = fakeRequest()
      await expect(
        guardedFetch(SERVER, { lookup: async () => answer, request })(SERVER.url)
      ).rejects.toThrow(EgressError)
      expect(sent).toEqual([])
    }
    // A DNS answer that changes after the check can't be used: the
    // connection never resolves the name again
    let calls = 0
    const { request, sent } = fakeRequest()
    await guardedFetch(SERVER, {
      lookup: async () => (calls++ === 0 ? ["93.184.216.34"] : ["10.0.0.1"]),
      request,
    })(SERVER.url)
    const address = await new Promise((resolve) =>
      sent[0].options.lookup(
        "mcp.tracker.example",
        { all: true },
        (_e: unknown, all: unknown) => resolve(all)
      )
    )
    expect(address).toEqual([{ address: "93.184.216.34", family: 4 }])
    expect(calls).toBe(1)
  })

  it("NT-MCP-14: refuses any redirect", async () => {
    const { request } = fakeRequest({
      status: 302,
      headers: { location: "https://10.0.0.1/" },
    })
    await expect(
      guardedFetch(SERVER, { lookup: publicDns, request })(SERVER.url)
    ).rejects.toThrow(/redirect/)
  })

  it("caps the answer at 2 MB", async () => {
    const { request } = fakeRequest({ body: Buffer.alloc(MAX_BODY_BYTES + 1, 97) })
    const res = await guardedFetch(SERVER, { lookup: publicDns, request })(SERVER.url)
    await expect(res.text()).rejects.toThrow()
  })
})

// The unknown in MCP_CONNECTIVITY §5, settled: node:https connects to the
// address the guard's own pinned lookup gives while TLS still checks the
// certificate against the name (servername), so no undici dependency. A real
// local TLS server with a throwaway certificate made for this test only.
describe("node:https with a pinned lookup", () => {
  const hasOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })()

  it.skipIf(!hasOpenssl)(
    "reaches the pinned address and validates TLS for the name",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-tls-"))
      const key = path.join(dir, "key.pem")
      const cert = path.join(dir, "cert.pem")
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=mcp.tracker.example",
          "-addext",
          "subjectAltName=DNS:mcp.tracker.example",
        ],
        { stdio: "ignore" }
      )
      const server = https.createServer(
        { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
        (req, res) => res.end(`host=${req.headers.host}`)
      )
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const { port } = server.address() as AddressInfo
      const get = (servername: string) =>
        new Promise<string>((resolve, reject) => {
          https
            .request(
              `https://mcp.tracker.example:${port}/`,
              {
                ca: fs.readFileSync(cert),
                servername,
                lookup: pinnedLookup("127.0.0.1"),
              },
              (res) => {
                let body = ""
                res.on("data", (c) => (body += c))
                res.on("end", () => resolve(body))
              }
            )
            .on("error", reject)
            .end()
        })
      try {
        expect(await get("mcp.tracker.example")).toBe(`host=mcp.tracker.example:${port}`)
        // The same address under another name fails the certificate check
        await expect(get("other.example")).rejects.toThrow()
      } finally {
        server.close()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
