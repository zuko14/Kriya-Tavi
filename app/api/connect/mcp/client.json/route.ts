import { NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { mcpServers } from "@/db/schema"
import { appUrl } from "@/lib/auth"
import { mcpCallbackUrl, mcpClientIdUrl } from "@/lib/connectors"

// Kriya's Client ID Metadata Document (MCP authorization, N6): the URL of this
// document is Kriya's client id for apps that use it (auth = oauth_cimd).
// Public by design; it holds no secret, only where the person comes back to.
export async function GET() {
  const origin = appUrl()
  const servers = await privileged
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.auth, "oauth_cimd"), eq(mcpServers.status, "active")))
  return NextResponse.json(
    {
      client_id: mcpClientIdUrl(origin),
      client_name: "Kriya Tavi",
      client_uri: origin,
      redirect_uris: servers.map((server) => mcpCallbackUrl(server.id, origin)),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { headers: { "cache-control": "public, max-age=300" } }
  )
}
