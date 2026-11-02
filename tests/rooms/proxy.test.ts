import { NextRequest } from "next/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

// RT-ACT-02 (CHANGE_IMPACT §3, proxy.ts): signed-out visitors of /rooms and
// /rooms/join/<token> go to sign-in and come back; /api/rooms/ answers the
// JSON 401; room writes still need Kriya's Origin; /roomsx is untouched.

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

describe("proxy.ts and rooms", () => {
  it("signed out, room pages go to sign-in with ?next= and come back", async () => {
    for (const path of ["/rooms", "/rooms/abc", "/rooms/join/tok_EN-123"]) {
      const res = await proxy(request("GET", path))
      expect(res.status, path).toBe(307)
      const location = new URL(res.headers.get("location")!)
      expect(location.pathname).toBe("/login")
      expect(location.searchParams.get("next")).toBe(path)
    }
    const other = await proxy(request("GET", "/roomsx"))
    expect(other.headers.get("x-middleware-next")).toBe("1")
  })

  it("signed out, /api/rooms/ gets the JSON 401", async () => {
    const res = await proxy(request("GET", "/api/rooms/abc/messages"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Sign in to continue." })
  })

  it("room writes need Kriya's Origin", async () => {
    for (const path of ["/rooms/abc", "/api/rooms/abc/messages", "/rooms/join/x"]) {
      expect((await proxy(request("POST", path))).status, path).toBe(403)
      expect(
        (await proxy(request("POST", path, { origin: "https://evil.example" }))).status,
        path
      ).toBe(403)
    }
  })
})
