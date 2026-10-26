"use server"

import { revalidatePath } from "next/cache"
import { and, eq, inArray, isNull, ne } from "drizzle-orm"
import { z } from "zod"

import { withUser } from "@/db"
import { agents, mcpConnections, mcpEnablements, mcpServers } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { mcpDisconnect } from "@/lib/connectors"

// The person's side of apps (N6, TOOLS_AND_CONTRACTS §6): which agents may use
// an app they connected, and disconnecting it. Only the person does these;
// no agent tool writes mcp_enablements (PERSON_ONLY_WRITES). Everything goes
// through withUser, so row security keeps it to their own rows.

const serverId = z.string().regex(/^[a-z]{2,12}$/)
const agentIds = z.union([z.literal("all"), z.array(z.string().max(32)).min(1).max(50)])

type Answer = { ok: true } | { error: string }
const NOT_READY: Answer = { error: "Apps aren't switched on yet." }

async function ready() {
  return (
    (await getSetting("next.mcp")) === "on" &&
    (await getSetting("next.mcpConnect")) === "on"
  )
}

// Replaces which agents may use an app: all of them, or the ones named
export async function enableApp(app: string, chosen: "all" | string[]): Promise<Answer> {
  const user = await requireUser()
  const id = serverId.safeParse(app)
  const which = agentIds.safeParse(chosen)
  if (!id.success || !which.success) return { error: "That isn't an app Kriya knows." }
  if (!(await ready())) return NOT_READY
  const result = await withUser(user.id, async (tx): Promise<Answer> => {
    const [link] = await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(eq(mcpConnections.serverId, id.data))
    if (!link) return { error: "Connect the app first." }
    // Row security shows only apps that are active now
    const [server] = await tx
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, id.data))
    if (!server) return { error: "That app is paused right now." }
    if (which.data !== "all") {
      const own = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, which.data))
      if (own.length !== new Set(which.data).size)
        return { error: "Choose your own agents." }
    }
    await tx.delete(mcpEnablements).where(eq(mcpEnablements.serverId, id.data))
    await tx.insert(mcpEnablements).values(
      which.data === "all"
        ? [{ userId: user.id, serverId: id.data, agentId: null }]
        : [...new Set(which.data)].map((agentId) => ({
            userId: user.id,
            serverId: id.data,
            agentId,
          }))
    )
    return { ok: true }
  })
  revalidatePath("/account")
  return result
}

// Turns an app off for every agent, or for one
export async function disableApp(app: string, agentId?: string): Promise<Answer> {
  // One agent: the same as unticking it, which also handles "all my agents"
  if (agentId !== undefined) return setAppForAgent(app, agentId, false)
  const user = await requireUser()
  const id = serverId.safeParse(app)
  if (!id.success) return { error: "That isn't an app Kriya knows." }
  if (!(await ready())) return NOT_READY
  await withUser(user.id, (tx) =>
    tx.delete(mcpEnablements).where(eq(mcpEnablements.serverId, id.data))
  )
  revalidatePath("/account")
  return { ok: true }
}

// The agent dialog's checkbox: may this agent use the app?
export async function setAppForAgent(
  app: string,
  agentId: string,
  on: boolean
): Promise<Answer> {
  const user = await requireUser()
  const id = serverId.safeParse(app)
  const agent = z.string().max(32).safeParse(agentId)
  if (!id.success || !agent.success) return { error: "That isn't an app Kriya knows." }
  if (!(await ready())) return NOT_READY
  const result = await withUser(user.id, async (tx): Promise<Answer> => {
    const rows = await tx
      .select({ agentId: mcpEnablements.agentId })
      .from(mcpEnablements)
      .where(eq(mcpEnablements.serverId, id.data))
    const forAll = rows.some((row) => row.agentId === null)
    if (on) {
      if (forAll || rows.some((row) => row.agentId === agent.data)) return { ok: true }
      const [link] = await tx
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(eq(mcpConnections.serverId, id.data))
      if (!link) return { error: "Connect the app first." }
      const [own] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agent.data))
      if (!own) return { error: "Choose your own agent." }
      await tx
        .insert(mcpEnablements)
        .values({ userId: user.id, serverId: id.data, agentId: agent.data })
        .onConflictDoNothing()
      return { ok: true }
    }
    if (forAll) {
      // "All my agents" becomes every other agent by name
      const others = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(ne(agents.id, agent.data))
      await tx
        .delete(mcpEnablements)
        .where(and(eq(mcpEnablements.serverId, id.data), isNull(mcpEnablements.agentId)))
      if (others.length > 0)
        await tx
          .insert(mcpEnablements)
          .values(
            others.map((o) => ({ userId: user.id, serverId: id.data, agentId: o.id }))
          )
    } else {
      await tx
        .delete(mcpEnablements)
        .where(
          and(
            eq(mcpEnablements.serverId, id.data),
            eq(mcpEnablements.agentId, agent.data)
          )
        )
    }
    return { ok: true }
  })
  revalidatePath("/account")
  return result
}

// Revokes the grant where the app allows it and forgets the tokens and the
// agent choices, in one transaction (lib/connectors.ts mcpDisconnect)
export async function disconnectApp(app: string): Promise<Answer> {
  const user = await requireUser()
  const id = serverId.safeParse(app)
  if (!id.success) return { error: "That isn't an app Kriya knows." }
  await mcpDisconnect(user.id, id.data)
  revalidatePath("/account")
  return { ok: true }
}
