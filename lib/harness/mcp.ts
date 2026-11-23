import { and, asc, eq, inArray } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { mcpEnablements, mcpServers, mcpTools } from "@/db/schema"
import { classifyMcpTool, type McpPolicyInput } from "@/lib/agent/policy"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"

// Harness 2.0 W16, MCP P3a (upgrade_2.0/GROUNDING_AND_CONNECTORS.md §4,
// WORKSPACE_PANEL_SKILLS_PLUGINS.md §5): the owner's registry servers a
// device may use. Only active servers the person enabled whose auth is
// "none": DeepSeek Harness's MCP client signs in with static headers only
// (spike S2, 2026-11-23), and a server whose token is sealed on Kriya's
// server never reaches a device (invariant 4, track H rule 6). Each pinned
// tool carries its definition hash and the class classifyMcpTool gives it;
// R5 tools are left out. Nothing here holds a token, a client id or the
// name of a secret.

export type DeviceMcpServer = {
  id: string
  name: string
  url: string
  tools: { name: string; definitionHash: string; risk: string; readOnly: boolean }[]
}

export async function deviceMcpServers(
  device: DeviceUser
): Promise<DeviceMcpServer[] | null> {
  const [own, registry] = await Promise.all([
    getSetting("harness.mcp"),
    getSetting("next.mcp"),
  ])
  if (own !== "on" || registry !== "on") return null
  const enabled = await withUser(device.id, (tx) =>
    tx.select({ serverId: mcpEnablements.serverId }).from(mcpEnablements)
  )
  const ids = [...new Set(enabled.map((r) => r.serverId))]
  if (!ids.length) return []
  const servers = await privileged
    .select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url })
    .from(mcpServers)
    .where(
      and(
        inArray(mcpServers.id, ids),
        eq(mcpServers.status, "active"),
        eq(mcpServers.auth, "none")
      )
    )
    .orderBy(asc(mcpServers.id))
  if (!servers.length) return []
  const pins = await privileged
    .select({
      serverId: mcpTools.serverId,
      name: mcpTools.name,
      definition: mcpTools.definition,
      definitionHash: mcpTools.definitionHash,
      ownerRisk: mcpTools.ownerRisk,
      category: mcpTools.category,
    })
    .from(mcpTools)
    .where(
      and(
        inArray(
          mcpTools.serverId,
          servers.map((s) => s.id)
        ),
        eq(mcpTools.status, "pinned")
      )
    )
    .orderBy(asc(mcpTools.name))
  return servers
    .map((s) => ({
      ...s,
      tools: pins
        .filter((p) => p.serverId === s.id)
        .map((p) => {
          const risk = classifyMcpTool({
            ownerRisk: p.ownerRisk,
            annotations: (p.definition as Pick<McpPolicyInput, "annotations">)
              ?.annotations,
            category: p.category,
          })
          return {
            name: p.name,
            definitionHash: p.definitionHash,
            risk,
            readOnly: risk === "R0" || risk === "R1",
          }
        })
        .filter((t) => t.risk !== "R5"),
    }))
    .filter((s) => s.tools.length > 0)
}
