import { NextRequest } from "next/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { proxy } from "@/proxy"

// proxy.ts (A3): signed-out visitors of /inbox and /goals go to /login like
// every other app page, and other paths behave as before. Supabase is
// stubbed as "no session" unless a test signs in.

const session = vi.hoisted(() => ({ sub: null as string | null }))

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: async () => ({
        data: session.sub ? { claims: { sub: session.sub } } : null,
      }),
    },
  }),
}))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-key"
})

const visit = async (path: string) => {
  const response = await proxy(new NextRequest(`https://kriya.test${path}`))
  return response.headers.get("location")
}

describe("signed-out routing", () => {
  it.each(["/inbox", "/inbox?show=approve", "/goals", "/goals/g1"])(
    "%s goes to /login",
    async (path) => {
      const location = await visit(path)
      expect(location).toContain("/login?next=")
      expect(decodeURIComponent(location!)).toContain(path)
    }
  )

  it.each(["/home", "/s/squad1/t1", "/account"])(
    "%s still goes to /login",
    async (path) => {
      expect(await visit(path)).toContain("/login?next=")
    }
  )

  it.each(["/", "/login", "/share/abc", "/pricing"])("%s is left alone", async (path) => {
    expect(await visit(path)).toBeNull()
  })

  // AT-SHR-05 (A5): shares are public, /s/ squads still need a session
  it.each([`/share/${"a".repeat(43)}`, `/share/${"a".repeat(43)}/pdf`, "/share"])(
    "%s isn't sent to login",
    async (path) => {
      const response = await proxy(new NextRequest(`https://kriya.test${path}`))
      expect(response.headers.get("location")).toBeNull()
      expect(response.status).toBe(200)
    }
  )

  it("/accounts (A7) goes to /login", async () => {
    expect(await visit("/accounts")).toContain("/login?next=")
  })

  it("/s/<squad> still goes to /login", async () => {
    expect(await visit("/s/squad1")).toContain("/login?next=")
  })

  it("/api/files/<id> needs a session", async () => {
    const response = await proxy(new NextRequest("https://kriya.test/api/files/abc"))
    expect(response.status).toBe(401)
  })

  it("/api/browser/live/<id>/token needs a session (A6)", async () => {
    const response = await proxy(
      new NextRequest("https://kriya.test/api/browser/live/abc/token", {
        method: "POST",
        headers: { origin: "https://kriya.test" },
      })
    )
    expect(response.status).toBe(401)
    // From another site, refused before that (CSRF)
    const cross = await proxy(
      new NextRequest("https://kriya.test/api/browser/live/abc/token", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      })
    )
    expect(cross.status).toBe(403)
  })
})

describe("signed-in routing", () => {
  it("a signed-in visit to /login or /signup goes home", async () => {
    session.sub = "user-1"
    try {
      expect(await visit("/login")).toContain("/home")
      expect(await visit("/signup")).toContain("/home")
    } finally {
      session.sub = null
    }
  })

  // requireUser sends a session whose account row is gone to
  // /login?error=account; sending that back to /home looped forever
  it("a sign-in page with a notice stays, so a broken account can't loop", async () => {
    session.sub = "user-without-profile"
    try {
      expect(await visit("/login?error=account")).toBeNull()
      expect(await visit("/login?error=signup-link")).toBeNull()
    } finally {
      session.sub = null
    }
  })
})
