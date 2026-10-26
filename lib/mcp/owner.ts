import { and, asc, count, gte, like } from "drizzle-orm"

import { privileged } from "@/db"
import { mcpConnections, mcpServers, mcpTools, toolExecutions } from "@/db/schema"

// Read by /owner/apps only; kept apart from registry.ts, which builds app
// tools and may be imported by the worker's runner alone (NT-IMP-03).
// The owner's view (/owner/apps, NT-OWN-03): servers, pinned tools, which have
// drifted, and counts. Never a token, an input or an output; a definition only
// for a drifted tool, where the owner compares it with what the app says now.
export async function registry(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const [servers, tools, connections, calls] = await Promise.all([
    privileged
      .select()
      .from(mcpServers)
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id)),
    privileged
      .select()
      .from(mcpTools)
      .orderBy(asc(mcpTools.serverId), asc(mcpTools.name)),
    privileged
      .select({ serverId: mcpConnections.serverId, n: count() })
      .from(mcpConnections)
      .groupBy(mcpConnections.serverId),
    privileged
      .select({ name: toolExecutions.toolName, n: count() })
      .from(toolExecutions)
      .where(
        and(
          like(toolExecutions.toolName, "mcp\\_%"),
          gte(toolExecutions.startedAt, since)
        )
      )
      .groupBy(toolExecutions.toolName),
  ])
  const callsOf = new Map<string, number>()
  for (const row of calls) {
    // mcp_<server>_<tool>: server ids have no underscore
    const id = row.name.split("_")[1]
    callsOf.set(id, (callsOf.get(id) ?? 0) + row.n)
  }
  return servers.map((server) => ({
    ...server,
    connections: connections.find((c) => c.serverId === server.id)?.n ?? 0,
    calls: callsOf.get(server.id) ?? 0,
    tools: tools
      .filter((tool) => tool.serverId === server.id)
      .map(({ definition, verify, ...tool }) => ({
        ...tool,
        readBack: verify !== null,
        definition:
          tool.status === "drifted" ? (definition as Record<string, unknown>) : null,
      })),
  }))
}
