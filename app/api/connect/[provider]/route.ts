import { randomBytes } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/db/schema"
import { appUrl, authenticate } from "@/lib/auth"
import {
  accountUrl,
  authorizeUrl,
  GOOGLE_SERVICES,
  isGoogleService,
  isProviderConfigured,
  OAUTH_STATE_COOKIE,
} from "@/lib/connectors"

// Starts connecting an account: a one-time state in an httpOnly cookie, then
// off to Google or Notion to ask the person. The callback checks the state.
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ provider: string }> }
) {
  // The public address, not the one the request arrived on: behind a proxy
  // that can be an internal host, and session cookies belong to this one
  const origin = appUrl()
  const user = await authenticate()
  if (!user) return NextResponse.redirect(new URL("/login?next=/account", origin))

  const { provider } = await ctx.params
  if (!CONNECTION_PROVIDERS.includes(provider as ConnectionProvider)) {
    return NextResponse.redirect(accountUrl(origin, { connect_error: "unknown" }))
  }
  const p = provider as ConnectionProvider
  if (!isProviderConfigured(p)) {
    return NextResponse.redirect(accountUrl(origin, { connect_error: "unavailable" }))
  }

  const picked = request.nextUrl.searchParams.getAll("service").filter(isGoogleService)
  const services =
    picked.length > 0 ? picked : Object.keys(GOOGLE_SERVICES).filter(isGoogleService)
  const state = randomBytes(24).toString("base64url")
  const response = NextResponse.redirect(
    authorizeUrl(p, {
      state,
      redirectUri: `${appUrl()}/api/connect/${p}/callback`,
      services,
    })
  )
  response.cookies.set(OAUTH_STATE_COOKIE, `${p}.${user.id}.${state}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/connect",
    maxAge: 600,
  })
  return response
}
