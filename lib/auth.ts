import "server-only"

import { eq } from "drizzle-orm"
import { notFound, redirect } from "next/navigation"
import { cache } from "react"

import { privileged } from "@/db"
import { platformRoles, profiles } from "@/db/schema"
import { createSupabase } from "@/lib/supabase"

// Who is asking. Identity always comes from the verified session (getClaims
// checks the JWT's signature), never from anything the browser sends.

export type SessionUser = { id: string; email: string | null }

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabase()
  const { data, error } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (error || !claims?.sub) return null
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null }
})

const getProfile = cache(async (userId: string) => {
  const [profile] = await privileged
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
  return profile ?? null
})

// For pages and server actions: a signed-in, active person, or a redirect
export async function requireUser() {
  const user = await getSessionUser()
  if (!user) redirect("/login")
  const profile = await getProfile(user.id)
  // The profile trigger runs with sign-up; a missing row means a broken account
  if (!profile) redirect("/login?error=account")
  if (profile.status === "suspended") redirect("/suspended")
  return { ...user, profile }
}

// For route handlers: null instead of a redirect
export async function authenticate() {
  const user = await getSessionUser()
  if (!user) return null
  const profile = await getProfile(user.id)
  if (!profile || profile.status !== "active") return null
  return { ...user, profile }
}

export const isOwner = cache(async (userId: string) => {
  const [role] = await privileged
    .select({ role: platformRoles.role })
    .from(platformRoles)
    .where(eq(platformRoles.userId, userId))
  return role?.role === "owner"
})

// The owner console is invisible to everyone else: a 404, not a 403
export async function requireOwner() {
  const user = await requireUser()
  if (!(await isOwner(user.id))) notFound()
  return user
}

export { safeNext } from "@/lib/redirect"

export function appUrl() {
  const url = process.env.KRIYA_APP_URL?.replace(/\/+$/, "")
  if (url) return url
  if (process.env.NODE_ENV === "production") {
    throw new Error("KRIYA_APP_URL must be set in production.")
  }
  return "http://localhost:6796"
}
