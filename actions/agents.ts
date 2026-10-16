"use server"

import { eq, notExists } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import {
  agentInputSchema,
  agents,
  squadMembers,
  squads,
  threads,
  type AgentInput,
} from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { checkAgentAllowed } from "@/lib/entitlements"

const id = z.string().min(1).max(32)

function normalize(values: AgentInput) {
  const data = agentInputSchema.parse(values)
  return {
    name: data.name,
    role: data.role,
    instructions: data.instructions?.trim() || null,
    model: data.model?.trim() || null,
    ...(data.glyph && { glyph: data.glyph }),
  }
}

// A new agent comes with an empty thread to talk to it in
export async function createAgent(values: AgentInput) {
  const user = await requireUser()
  const data = normalize(values)
  const allowed = await checkAgentAllowed(user.id)
  if (!allowed.ok) throw new Error(allowed.message)
  const result = await withUser(user.id, async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({ ...data, id: nanoid(12), userId: user.id })
      .returning()
    const [thread] = await tx
      .insert(threads)
      .values({ id: nanoid(12), userId: user.id, agentId: agent.id })
      .returning({ id: threads.id })
    return { agent, threadId: thread.id }
  })
  revalidatePath("/", "layout")
  return result
}

export async function updateAgent(agentId: string, values: AgentInput) {
  const user = await requireUser()
  const data = normalize(values)
  const [agent] = await withUser(user.id, (tx) =>
    tx
      .update(agents)
      .set(data)
      .where(eq(agents.id, id.parse(agentId)))
      .returning()
  )
  if (!agent) throw new Error("Agent not found")
  revalidatePath("/", "layout")
  return agent
}

// Deletes the agent with its threads, memory and tasks. A worker holding one
// of those tasks loses its lease at the next heartbeat and stops.
export async function deleteAgent(agentId: string) {
  const user = await requireUser()
  const target = id.parse(agentId)
  await withUser(user.id, async (tx) => {
    const removed = await tx
      .delete(agents)
      .where(eq(agents.id, target))
      .returning({ id: agents.id })
    if (removed.length === 0) throw new Error("Agent not found")
    // A squad left with nobody in it has nothing to show
    await tx
      .delete(squads)
      .where(
        notExists(
          tx.select().from(squadMembers).where(eq(squadMembers.squadId, squads.id))
        )
      )
  })
  revalidatePath("/", "layout")
}
