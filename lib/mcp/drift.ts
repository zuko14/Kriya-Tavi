import { and, asc, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { mcpServers, mcpTools } from "@/db/schema"
import { log } from "@/lib/log"
import { connectedAuth, listLive, markDrift } from "@/lib/mcp/live"
import { definitionHash } from "@/lib/mcp/tools"
import { assertClosed, record } from "@/lib/reliability/breaker"

// The daily drift check (ND-07, TOOLS_AND_CONTRACTS §8): so a changed tool
// shows on /owner/apps even when nobody has used the app (tasks check on
// every run too). It looks as the owner who added the server, never as a
// person using it; a server the owner isn't signed in to is left to the
// tasks. Reads `tools/list` only. Logs carry ids only.

const DAY_MS = 24 * 60 * 60 * 1000

// shortcut: kept in memory per worker, so a restart checks again (it only
// reads; a repeat is harmless). Upgrade to a column if checks become costly.
const lastChecked = new Map<string, number>()

export function resetDriftClock() {
  lastChecked.clear()
}

export async function checkDrift(now = new Date(), { limit = 5 } = {}) {
  const result = { servers: 0, drifted: 0, skipped: 0, errors: 0 }
  const servers = await privileged
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.status, "active"))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
  for (const server of servers) {
    if (result.servers + result.skipped >= limit) break
    if (now.getTime() - (lastChecked.get(server.id) ?? 0) < DAY_MS) continue
    const pins = await privileged
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, server.id), eq(mcpTools.status, "pinned")))
    if (pins.length === 0) continue
    lastChecked.set(server.id, now.getTime())
    try {
      const auth =
        server.auth === "none"
          ? undefined
          : server.createdBy
            ? await connectedAuth(server.createdBy)(server)
            : null
      if (auth === null || auth === "reconnect") {
        result.skipped++
        continue
      }
      assertClosed(`mcp:${server.id}`)
      const live = await listLive(server, auth)
      result.servers++
      for (const pin of pins) {
        const definition = live.get(pin.name)
        if (!definition) {
          log.warn("mcp tool missing", { serverId: server.id, tool: pin.kriyaName })
          continue
        }
        const hash = definitionHash(definition)
        if (hash === pin.definitionHash) continue
        await markDrift(server.id, pin.name, hash)
        result.drifted++
        log.warn("mcp tool drifted", { serverId: server.id, tool: pin.kriyaName })
      }
    } catch (error) {
      record(`mcp:${server.id}`)
      result.errors++
      log.warn("mcp drift check failed", {
        serverId: server.id,
        error: (error as Error)?.name ?? "error",
      })
    }
  }
  return result
}
