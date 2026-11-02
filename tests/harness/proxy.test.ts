import { NextRequest } from "next/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

// HT-API-10 (HF-07, HF-08): the browser origin check stays on every cookie
// route and server action, but a command-line client's POST to the harness
// API (no Origin, no cookie) reaches its route, which judges the bearer
// token itself; a signed-out visitor of /connect/device returns there after
// signing in.

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: null }) } }),
}))

import { proxy } from "@/proxy"

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test"
  process.env.KRIYA_APP_URL = "https://kriya.example"
})

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://kriya.example${path}`, { method, headers })

describe("HT-API-10: proxy.ts and the harness API", () => {
  it("a POST without Origin to /api/harness/v1 passes the proxy", async () => {
    for (const path of ["/api/harness/v1/device/code", "/api/harness/v1/device/token"]) {
      const res = await proxy(request("POST", path))
      expect(res.status, path).toBe(200)
      expect(res.headers.get("x-middleware-next")).toBe("1")
    }
    // Signed out isn't the proxy's business here: the route answers 401 itself
    const res = await proxy(request("GET", "/api/harness/v1/me"))
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("cookie routes and server actions still need Kriya's Origin", async () => {
    for (const path of ["/api/threads/t1/turn", "/home", "/account", "/api/harnessx"]) {
      const res = await proxy(request("POST", path))
      expect(res.status, path).toBe(403)
      expect(await res.text()).toBe("Cross-site request refused.")
    }
    const evil = await proxy(
      request("POST", "/api/threads/t1/turn", { origin: "https://evil.example" })
    )
    expect(evil.status).toBe(403)
  })

  it("signed out, /harness goes to sign-in and comes back", async () => {
    const res = await proxy(request("GET", "/harness"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).search).toBe("?next=%2Fharness")
    // The API isn't the page: /api/harness/ keeps its own bearer check
    const api = await proxy(request("GET", "/api/harness/v1/me"))
    expect(api.headers.get("x-middleware-next")).toBe("1")
  })

  it("signed out, /connect/device?code=X goes to sign-in and comes back", async () => {
    const res = await proxy(request("GET", "/connect/device?code=ABCD2345"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
    expect(new URL(res.headers.get("location")!).search).toBe(
      "?next=%2Fconnect%2Fdevice%3Fcode%3DABCD2345"
    )
  })
})
