import { and, asc, eq, inArray, ne, or } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { agents, mcpConnections, mcpEnablements, mcpServers, mcpTools } from "@/db/schema"
import { approvalFor, classifyMcpTool, type McpPolicyInput } from "@/lib/agent/policy"
import { getSetting } from "@/lib/config"

// Account → Apps and the agent dialog (N6, TOOLS_AND_CONTRACTS §7). The
// person's own choices are read as the person (row security); the registry is
// read with the server's rights but only the parts a person may see: the
// app's name and address, and each pinned tool in words. Never a definition,
// a token or a secret's name.

export type AppView = {
  id: string
  name: string
  domain: string
  // The owner suspended it: connected people see "Paused by Kriya"
  paused: boolean
  connected: boolean
  needsReconnect: boolean
  // Tool words, "search items", split by whether Kriya asks first
  reads: string[]
  asks: string[]
  // "all" my agents, or these agents
  enabled: "all" | string[]
}

const words = (kriyaName: string) =>
  kriyaName.replace(/^mcp_[a-z]+_/, "").replaceAll("_", " ")

export async function appsForPerson(userId: string) {
  const { connected, chosen, mine } = await withUser(userId, async (tx) => ({
    connected: await tx
      .select({ serverId: mcpConnections.serverId, needs: mcpConnections.needsReconnect })
      .from(mcpConnections),
    chosen: await tx
      .select({ serverId: mcpEnablements.serverId, agentId: mcpEnablements.agentId })
      .from(mcpEnablements),
    mine: await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .orderBy(asc(agents.createdAt)),
  }))
  const ids = connected.map((row) => row.serverId)
  const servers = await privileged
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
      status: mcpServers.status,
    })
    .from(mcpServers)
    .where(
      or(
        // Apps to connect to: active, and ones that sign in
        and(eq(mcpServers.status, "active"), ne(mcpServers.auth, "none")),
        // Apps already connected, even if the owner has paused them
        ids.length > 0 ? inArray(mcpServers.id, ids) : undefined
      )
    )
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
  const pins =
    servers.length > 0
      ? await privileged
          .select({
            serverId: mcpTools.serverId,
            kriyaName: mcpTools.kriyaName,
            ownerRisk: mcpTools.ownerRisk,
            category: mcpTools.category,
            definition: mcpTools.definition,
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
      : []

  const apps: AppView[] = servers
    .filter((s) => s.status === "active" || s.status === "suspended")
    .map((server) => {
      const link = connected.find((row) => row.serverId === server.id)
      const mine_ = chosen.filter((row) => row.serverId === server.id)
      const classed = pins
        .filter((pin) => pin.serverId === server.id)
        .map((pin) => ({
          name: words(pin.kriyaName),
          cls: classifyMcpTool({
            ownerRisk: pin.ownerRisk,
            category: pin.category,
            annotations: (pin.definition as Pick<McpPolicyInput, "annotations">)
              .annotations,
          }),
        }))
        // A payments, identity, credentials or filing tool is never a tool (R5)
        .filter((tool) => tool.cls !== "R5")
      return {
        id: server.id,
        name: server.name,
        domain: new URL(server.url).hostname,
        paused: server.status === "suspended",
        connected: !!link,
        needsReconnect: link?.needs ?? false,
        reads: classed.filter((t) => approvalFor(t.cls) === "none").map((t) => t.name),
        asks: classed
          .filter((t) => approvalFor(t.cls) === "user-approval")
          .map((t) => t.name),
        enabled: mine_.some((row) => row.agentId === null)
          ? ("all" as const)
          : mine_.flatMap((row) => (row.agentId ? [row.agentId] : [])),
      }
    })
    // A paused app the person never connected isn't theirs to see
    .filter((app) => !app.paused || app.connected)
  return { apps, agents: mine }
}

// The agent dialog's Apps section (getSystemStatus.apps): the apps the person
// has connected and which agents may use each. null with the switches off or
// nothing connected, so the dialog is exactly as before (the `skills` pattern).
export async function appChoices(userId: string) {
  if (
    (await getSetting("next.mcp")) !== "on" ||
    (await getSetting("next.mcpConnect")) !== "on"
  )
    return null
  const { apps } = await appsForPerson(userId)
  const usable = apps.filter((app) => app.connected && !app.paused && !app.needsReconnect)
  return usable.length === 0
    ? null
    : usable.map((app) => ({
        id: app.id,
        name: app.name,
        all: app.enabled === "all",
        agents: app.enabled === "all" ? [] : app.enabled,
      }))
}

export type AppChoice = NonNullable<Awaited<ReturnType<typeof appChoices>>>[number]
