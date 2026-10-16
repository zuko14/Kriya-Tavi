import { timingSafeEqual } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/db/schema"
import { appUrl, authenticate } from "@/lib/auth"
import {
  accountUrl,
  exchangeCode,
  OAUTH_STATE_COOKIE,
  saveConnection,
} from "@/lib/connectors"
import { log } from "@/lib/log"

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Google or Notion sends the person back here. The account is saved only for
// the signed-in person who started this attempt in this browser, proven by
// the one-time state cookie.
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ provider: string }> }
) {
  // The public address, not the one the request arrived on: behind a proxy
  // that can be an internal host, and session cookies belong to this one
  const origin = appUrl()
  const done = (params: Record<string, string>) => {
    const response = NextResponse.redirect(accountUrl(origin, params))
    response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/connect" })
    return response
  }

  const user = await authenticate()
  if (!user) return NextResponse.redirect(new URL("/login?next=/account", origin))
  const { provider } = await ctx.params
  if (!CONNECTION_PROVIDERS.includes(provider as ConnectionProvider)) {
    return done({ connect_error: "unknown" })
  }
  const p = provider as ConnectionProvider

  const params = request.nextUrl.searchParams
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? ""
  const state = params.get("state") ?? ""
  if (!state || !same(expected, `${p}.${user.id}.${state}`)) {
    return done({ connect_error: "expired" })
  }
  // The person said no on the consent screen
  if (params.get("error")) return done({ connect_error: "denied" })
  const code = params.get("code")
  if (!code) return done({ connect_error: "failed" })

  try {
    const tokens = await exchangeCode(p, code, `${appUrl()}/api/connect/${p}/callback`)
    await saveConnection(user.id, p, tokens)
  } catch (error) {
    log.error("connect failed", { provider: p, error })
    return done({ connect_error: "failed" })
  }
  return done({ connected: p })
}
