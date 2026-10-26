import { NextResponse, type NextRequest } from "next/server"

import { appUrl, authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import {
  appsUrl,
  McpConnectError,
  mcpCallbackUrl,
  MCP_FLOW_COOKIE,
  mcpConnectStart,
} from "@/lib/connectors"
import { log } from "@/lib/log"

// Starts signing in to an app (N6, MCP_CONNECTIVITY §3): the person must be
// signed in, the switches on and the app active; then off to the app's own
// authorization server. What comes back needs this browser's sealed cookie.
// Only the OAuth hand-off runs here; no app tool ever does (ND-10).
const SERVER_ID = /^[a-z]{2,12}$/

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ serverId: string }> }
) {
  const origin = appUrl()
  const user = await authenticate()
  if (!user) return NextResponse.redirect(new URL("/login?next=/account", origin))

  const { serverId } = await ctx.params
  if (
    !SERVER_ID.test(serverId) ||
    (await getSetting("next.mcp")) !== "on" ||
    (await getSetting("next.mcpConnect")) !== "on"
  ) {
    return NextResponse.redirect(appsUrl(origin, { app_error: "unavailable" }))
  }
  try {
    const { url, cookie } = await mcpConnectStart(user.id, serverId, {
      redirectUri: mcpCallbackUrl(serverId, origin),
    })
    const response = NextResponse.redirect(url)
    response.cookies.set(MCP_FLOW_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/connect/mcp",
      maxAge: 600,
    })
    return response
  } catch (error) {
    // Ids only: never a token, a code or the app's own words
    log.warn("mcp connect start failed", {
      serverId,
      error: (error as Error)?.name ?? "error",
    })
    return NextResponse.redirect(
      appsUrl(origin, {
        app_error: error instanceof McpConnectError ? error.code : "failed",
      })
    )
  }
}
