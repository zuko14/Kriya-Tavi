import "server-only"

import { createHash } from "node:crypto"

import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { notFound, redirect } from "next/navigation"
import { cache } from "react"

import { privileged } from "@/db"
import { harnessDevices, platformRoles, profiles } from "@/db/schema"
import { getSetting } from "@/lib/config"
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

// Kriya Harness (HD-05, invariant 3): the one other source of identity, for
// /api/harness/v1 only. A bearer token → its sha256 → a device that isn't
// revoked or idle past harness.deviceIdleDays → an active profile. Nothing
// else accepts device tokens; this never reads a cookie. "suspended" lets
// the route answer 403 instead of 401.
export type DeviceUser = { id: string; deviceId: string; agentId: string | null }

const DEVICE_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/

export async function authenticateDevice(
  request: Request
): Promise<DeviceUser | "suspended" | null> {
  const match = DEVICE_TOKEN.exec(request.headers.get("authorization") ?? "")
  if (!match) return null
  const idleDays =
    Number.parseInt((await getSetting("harness.deviceIdleDays")) ?? "", 10) || 90
  const hash = createHash("sha256").update(match[1]).digest("hex")
  const [device] = await privileged
    .select({
      id: harnessDevices.id,
      userId: harnessDevices.userId,
      agentId: harnessDevices.agentId,
    })
    .from(harnessDevices)
    .where(
      and(
        eq(harnessDevices.tokenHash, hash),
        isNull(harnessDevices.revokedAt),
        gt(harnessDevices.lastUsedAt, sql`now() - make_interval(days => ${idleDays})`)
      )
    )
  if (!device) return null
  const profile = await getProfile(device.userId)
  if (!profile) return null
  if (profile.status === "suspended") return "suspended"
  if (profile.status !== "active") return null
  await privileged
    .update(harnessDevices)
    .set({ lastUsedAt: new Date() })
    .where(
      and(eq(harnessDevices.id, device.id), eq(harnessDevices.userId, device.userId))
    )
  return { id: device.userId, deviceId: device.id, agentId: device.agentId }
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
