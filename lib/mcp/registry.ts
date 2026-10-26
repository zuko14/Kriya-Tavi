import { createMCPClient, UnauthorizedError, type MCPClient } from "@ai-sdk/mcp"
import type { Tool, ToolSet } from "ai"
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import {
  mcpConnections,
  mcpEnablements,
  mcpServers,
  mcpTools,
  type McpServer,
} from "@/db/schema"
import { classifyMcpTool, type McpPolicyInput, type RiskClass } from "@/lib/agent/policy"
import { log } from "@/lib/log"
import { guardedFetch, OPEN_TIMEOUT_MS } from "@/lib/mcp/fetch"
import { connectedAuth, markDrift, type AuthFor } from "@/lib/mcp/live"
import { definitionHash, mcpTool } from "@/lib/mcp/tools"
import { verifySpecSchema } from "@/lib/mcp/verify"
import { assertClosed, record } from "@/lib/reliability/breaker"

// One task's apps (MCP_CONNECTIVITY §4): the servers the person turned on
// for this agent, opened in the worker for this task only, with only the
// tools the owner pinned and whose definitions still match. A failure
// anywhere leaves that app out with a line in the prompt; the task never
// fails because of an app. Logs carry ids only (NT-SEC-03).

const MAX_SERVERS = 5

const reconnectNote = (server: McpServer) =>
  `${server.name} needs you to reconnect it in Account → Apps.`

export type McpTask = {
  // Keyed by kriya_name
  tools: ToolSet
  classes: Map<string, RiskClass>
  // R2–R4: the person approves the exact call, every time (ND-25)
  approvals: Record<string, "user-approval">
  sideEffects: Set<string>
  // Reads the owner marked safe to repeat (R0 by class too): N4 may retry them
  idempotent: Set<string>
  // The apps whose tools are on the belt, and what the prompt says about the rest
  apps: string[]
  notes: string[]
  close: () => Promise<void>
}

export async function loadMcp(
  task: { id: string; userId: string },
  agentId: string,
  options: { maxTools: number; disabled: Set<string>; authFor?: AuthFor }
): Promise<McpTask | null> {
  const authFor = options.authFor ?? connectedAuth(task.userId)
  const enabled = await withUser(task.userId, (tx) =>
    tx
      .select({ serverId: mcpEnablements.serverId })
      .from(mcpEnablements)
      .where(or(isNull(mcpEnablements.agentId), eq(mcpEnablements.agentId, agentId)))
  )
  const ids = [...new Set(enabled.map((row) => row.serverId))]
  if (ids.length === 0) return null
  // The registry is read with the server's rights, scoped to the person's own choices
  const servers = await privileged
    .select()
    .from(mcpServers)
    .where(and(inArray(mcpServers.id, ids), eq(mcpServers.status, "active")))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
  const pins = await privileged
    .select()
    .from(mcpTools)
    .where(and(inArray(mcpTools.serverId, ids), eq(mcpTools.status, "pinned")))
    .orderBy(asc(mcpTools.approvedAt), asc(mcpTools.name))

  const clients: MCPClient[] = []
  const close = async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})))
  }
  const mcp: McpTask = {
    tools: {},
    classes: new Map(),
    approvals: {},
    sideEffects: new Set(),
    idempotent: new Set(),
    apps: [],
    notes: [],
    close,
  }
  const trimmed = new Set<string>()
  try {
    for (const server of servers.slice(0, MAX_SERVERS)) {
      const authProvider = await authFor(server)
      if (authProvider === null) continue
      if (authProvider === "reconnect") {
        mcp.notes.push(reconnectNote(server))
        continue
      }
      const ref = { taskId: task.id, serverId: server.id }
      const kept: [string, Tool, RiskClass][] = []
      try {
        assertClosed(`mcp:${server.id}`)
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
        clients.push(client)
        const listed = await client.listTools({ options: { timeout: OPEN_TIMEOUT_MS } })
        const live = new Map(
          listed.tools.map((definition) => [definition.name, definition])
        )
        for (const pin of pins.filter((p) => p.serverId === server.id)) {
          const definition = live.get(pin.name)
          if (!definition) {
            log.warn("mcp tool missing", { ...ref, tool: pin.kriyaName })
            continue
          }
          const hash = definitionHash(definition)
          if (hash !== pin.definitionHash) {
            // Rug pull or update: off every belt until the owner re-approves (ND-07)
            await markDrift(server.id, pin.name, hash)
            log.warn("mcp tool drifted", { ...ref, tool: pin.kriyaName })
            continue
          }
          // The pinned annotations, never the live server's
          const pinned = pin.definition as Pick<McpPolicyInput, "annotations">
          const cls = classifyMcpTool({
            ownerRisk: pin.ownerRisk,
            annotations: pinned.annotations,
            category: pin.category,
          })
          if (cls === "R5" || options.disabled.has(pin.kriyaName)) continue
          // A read-back (ND-12) only for a side effect, and only through a
          // read tool that is itself pinned, unchanged, R0 and not switched off
          const spec = verifySpecSchema.safeParse(pin.verify)
          const reader = spec.success
            ? pins.find((p) => p.serverId === server.id && p.name === spec.data.tool)
            : undefined
          const readDefinition = reader && live.get(reader.name)
          const check =
            spec.success &&
            cls !== "R0" &&
            cls !== "R1" &&
            reader &&
            readDefinition &&
            definitionHash(readDefinition) === reader.definitionHash &&
            !options.disabled.has(reader.kriyaName) &&
            classifyMcpTool({
              ownerRisk: reader.ownerRisk,
              annotations: (reader.definition as Pick<McpPolicyInput, "annotations">)
                .annotations,
              category: reader.category,
            }) === "R0"
              ? spec.data
              : undefined
          kept.push([pin.kriyaName, mcpTool(client, pin, server.name, check), cls])
        }
      } catch (error) {
        // A refresh that failed: the person signs in again; not the app's fault
        if (error instanceof UnauthorizedError) {
          await privileged
            .update(mcpConnections)
            .set({ needsReconnect: true })
            .where(
              and(
                eq(mcpConnections.userId, task.userId),
                eq(mcpConnections.serverId, server.id)
              )
            )
          mcp.notes.push(reconnectNote(server))
          log.warn("mcp sign-in needs reconnecting", ref)
          continue
        }
        record(`mcp:${server.id}`)
        mcp.notes.push(`${server.name} isn't reachable right now.`)
        log.warn("mcp server unavailable", {
          ...ref,
          error: (error as Error)?.name ?? "error",
        })
        continue
      }
      for (const [name, built, cls] of kept) {
        if (mcp.classes.size >= options.maxTools) {
          trimmed.add(server.name)
          continue
        }
        mcp.tools[name] = built
        mcp.classes.set(name, cls)
        if (cls !== "R0" && cls !== "R1") {
          mcp.approvals[name] = "user-approval"
          mcp.sideEffects.add(name)
        } else if (cls === "R0" && pins.some((p) => p.kriyaName === name && p.idempotent))
          mcp.idempotent.add(name)
        if (!mcp.apps.includes(server.name)) mcp.apps.push(server.name)
      }
    }
  } catch (error) {
    await close()
    throw error
  }
  if (trimmed.size > 0)
    mcp.notes.push(
      `Some of ${[...trimmed].join(", ")}'s tools were left out to keep the list short.`
    )
  if (mcp.classes.size === 0) {
    await close()
    return null
  }
  return mcp
}
