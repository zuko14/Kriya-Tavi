import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp"
import { and, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { mcpConnections, mcpTools, type McpServer } from "@/db/schema"
import { mcpAuthProvider } from "@/lib/connectors"
import { guardedFetch, OPEN_TIMEOUT_MS } from "@/lib/mcp/fetch"

// What a server says its tools are right now, and who is signed in to ask.
// Shared by the task runner's registry, the owner's pinning and the daily
// drift check. Only `tools/list` runs here: no tool ever executes (ND-10).

// How this person signs in to a server: undefined = no sign-in needed, null =
// not connected (the app is left out), "reconnect" = connected but the sign-in
// stopped working (left out, and the person is told)
export type AuthFor = (
  server: McpServer
) =>
  | OAuthClientProvider
  | undefined
  | null
  | "reconnect"
  | Promise<OAuthClientProvider | undefined | null | "reconnect">

// The person's own sign-in, from kriya.mcp_connections (N6)
export const connectedAuth =
  (userId: string): AuthFor =>
  async (server) => {
    if (server.auth === "none") return undefined
    const [row] = await privileged
      .select({ needs: mcpConnections.needsReconnect })
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.userId, userId), eq(mcpConnections.serverId, server.id))
      )
    if (!row) return null
    return row.needs ? "reconnect" : mcpAuthProvider(userId, server.id)
  }

export async function listLive(
  server: McpServer,
  authProvider?: OAuthClientProvider
): Promise<Map<string, Record<string, unknown>>> {
  const client = await createMCPClient({
    transport: {
      type: server.transport,
      url: server.url,
      fetch: guardedFetch(server),
      redirect: "error",
      ...(authProvider && { authProvider }),
    },
    clientName: "kriya",
    initializationOptions: { timeout: OPEN_TIMEOUT_MS },
  })
  try {
    const listed = await client.listTools({ options: { timeout: OPEN_TIMEOUT_MS } })
    return new Map(
      listed.tools.map((tool) => [tool.name, tool as unknown as Record<string, unknown>])
    )
  } finally {
    await client.close().catch(() => {})
  }
}

// pinned → drifted, with the hash the worker saw (the owner pins exactly that
// one again); a no-op for a tool that is already drifted or disabled
export const markDrift = (serverId: string, name: string, hash: string) =>
  privileged
    .update(mcpTools)
    .set({ status: "drifted", driftedHash: hash })
    .where(
      and(
        eq(mcpTools.serverId, serverId),
        eq(mcpTools.name, name),
        eq(mcpTools.status, "pinned")
      )
    )

// The app's tool list as the owner, for pinning and drift review. null = it
// can't be read: say why in `error` (the owner isn't signed in, or the app
// didn't answer). No details of the failure are kept: they came from outside.
export async function liveAsOwner(
  server: McpServer,
  ownerId: string
): Promise<
  | { live: Map<string, Record<string, unknown>> }
  | { error: "connect" | "reconnect" | "unreachable" }
> {
  const auth = await connectedAuth(ownerId)(server)
  if (auth === null) return { error: "connect" }
  if (auth === "reconnect") return { error: "reconnect" }
  try {
    return { live: await listLive(server, auth) }
  } catch {
    return { error: "unreachable" }
  }
}
