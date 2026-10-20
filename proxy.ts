import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

// Runs before every request:
// 1. Refuses cross-site writes (CSRF): a non-GET request must come from the
//    app's own origin. Payment webhooks are exempt; they're verified by
//    signature instead.
// 2. Refreshes the Supabase session cookie.
// 3. Sends signed-out visitors of app pages to /login. This is a convenience:
//    every page, action and route handler checks the session again itself.

const PROTECTED = [
  "/home",
  "/agents",
  "/tasks",
  "/a/",
  "/s/",
  "/usage",
  "/account",
  "/onboarding",
  "/owner",
  "/billing",
  // A3: the Inbox and goal pages
  "/inbox",
  "/goals",
  // A7: Accounts
  "/accounts",
  // A13: Radar and watchers
  "/radar",
  // Voice phase 7: phone calls (with the slash, /calls itself but not /callsx)
  "/calls/",
]
// A5: file downloads. /share/ stays public on purpose (K8, AT-SHR-05)
const PROTECTED_API = [
  "/api/threads",
  "/api/events",
  "/api/files/",
  "/api/browser/live/",
  // Voice phase 7: a task's live status
  "/api/voice/tasks/",
]
const AUTH_PAGES = ["/login", "/signup"]
// Voice status webhooks carry a per-attempt token instead (voice phase 3)
const WEBHOOKS = ["/api/billing/webhook", "/api/voice/exotel/status/"]

function allowedOrigins(request: NextRequest) {
  const origins = new Set([request.nextUrl.origin])
  const app = process.env.KRIYA_APP_URL
  if (app) {
    try {
      origins.add(new URL(app).origin)
    } catch {}
  }
  return origins
}

const startsWithAny = (path: string, prefixes: string[]) =>
  prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  const method = request.method

  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !startsWithAny(path, WEBHOOKS)) {
    const origin = request.headers.get("origin")
    if (!origin || !allowedOrigins(request).has(origin)) {
      return new NextResponse("Cross-site request refused.", { status: 403 })
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) return NextResponse.next()

  let response = NextResponse.next({ request })
  const supabase = createServerClient(url, key, {
    // Same as lib/supabase.ts (which can't be imported here: server-only)
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
        for (const [name, value] of Object.entries(headers))
          response.headers.set(name, value)
      },
    },
  })

  // Verifies the token and refreshes it when it's about to expire
  const { data } = await supabase.auth.getClaims()
  const signedIn = !!data?.claims?.sub

  if (!signedIn && startsWithAny(path, PROTECTED_API)) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 })
  }
  if (!signedIn && startsWithAny(path, PROTECTED)) {
    const login = request.nextUrl.clone()
    login.pathname = "/login"
    login.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`
    return NextResponse.redirect(login)
  }
  // A sign-in page with a notice stays: requireUser sends a valid session
  // whose account row is gone to /login?error=account, and bouncing that back
  // to /home would loop forever
  if (
    signedIn &&
    startsWithAny(path, AUTH_PAGES) &&
    !request.nextUrl.searchParams.has("error")
  ) {
    const home = request.nextUrl.clone()
    home.pathname = "/home"
    home.search = ""
    return NextResponse.redirect(home)
  }

  return response
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|brand/).*)",
  ],
}
