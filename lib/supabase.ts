import "server-only"

import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"

// Supabase clients for the server. The browser never talks to Supabase
// directly: sign-in, sign-up and recovery go through server actions.

export function supabaseUrl() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set."
    )
  }
  return { url, key }
}

// The browser never reads the session, so its cookies are httpOnly
export const SESSION_COOKIE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
}

// Acts as the signed-in person, through their session cookies
export async function createSupabase() {
  const { url, key } = supabaseUrl()
  const store = await cookies()
  return createServerClient(url, key, {
    cookieOptions: SESSION_COOKIE,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options)
          }
        } catch {
          // Server components can't set cookies; proxy.ts refreshes them
        }
      },
    },
  })
}

// Admin API (account deletion, owner user search). Needs SUPABASE_SECRET_KEY,
// which must never reach the browser.
export function createSupabaseAdmin() {
  const { url } = supabaseUrl()
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set on the server.")
  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
