import { NextResponse, type NextRequest } from "next/server"

import { appUrl, authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import {
  appsUrl,
  McpConnectError,
  mcpCallbackUrl,
  MCP_FLOW_COOKIE,
  mcpConnectFinish,
} from "@/lib/connectors"
import { log } from "@/lib/log"

// The app's authorization server sends the person back here. Tokens are
// stored only for the signed-in person who started this attempt in this
// browser (the sealed cookie), when the state and issuer match and the code
// exchange works (N6, MCP_CONNECTIVITY §3).
const SERVER_ID = /^[a-z]{2,12}$/

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ serverId: string }> }
) {
  const origin = appUrl()
  const done = (params: Record<string, string>) => {
    const response = NextResponse.redirect(appsUrl(origin, params))
    response.cookies.delete({ name: MCP_FLOW_COOKIE, path: "/api/connect/mcp" })
    return response
  }

  const user = await authenticate()
  if (!user) return NextResponse.redirect(new URL("/login?next=/account", origin))
  const { serverId } = await ctx.params
  if (
    !SERVER_ID.test(serverId) ||
    (await getSetting("next.mcp")) !== "on" ||
    (await getSetting("next.mcpConnect")) !== "on"
  )
    return done({ app_error: "unavailable" })

  const params = request.nextUrl.searchParams
  // The person said no on the app's consent screen
  if (params.get("error")) return done({ app_error: "denied" })
  const code = params.get("code")
  const state = params.get("state")
  const cookie = request.cookies.get(MCP_FLOW_COOKIE)?.value
  if (!code || !state || !cookie) return done({ app_error: "expired" })

  try {
    await mcpConnectFinish(user.id, serverId, {
      redirectUri: mcpCallbackUrl(serverId, origin),
      cookie,
      code,
      state,
      issuer: params.get("iss") ?? undefined,
    })
  } catch (error) {
    log.warn("mcp connect failed", { serverId, error: (error as Error)?.name ?? "error" })
    return done({
      app_error: error instanceof McpConnectError ? error.code : "failed",
    })
  }
  return done({ connected_app: serverId })
}
