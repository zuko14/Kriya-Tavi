"use server"

import { and, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { agents, memories, memoryInputSchema } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getMemories } from "@/queries/workspace"

// The person inspects, edits and forgets what their agents remember

const id = z.string().min(1).max(32)

export async function listMemories(agentId: string) {
  const user = await requireUser()
  return getMemories(user.id, id.parse(agentId))
}

export async function addMemory(agentId: string, content: string) {
  const user = await requireUser()
  const data = memoryInputSchema.parse({ content })
  const agent = id.parse(agentId)
  await withUser(user.id, async (tx) => {
    const [owned] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agent))
    if (!owned) throw new Error("Agent not found")
    await tx.insert(memories).values({
      id: nanoid(12),
      userId: user.id,
      agentId: agent,
      content: data.content,
      source: "user",
    })
  })
  revalidatePath("/", "layout")
  return getMemories(user.id, agent)
}

export async function editMemory(agentId: string, memoryId: string, content: string) {
  const user = await requireUser()
  const data = memoryInputSchema.parse({ content })
  await withUser(user.id, (tx) =>
    tx
      .update(memories)
      .set({ content: data.content, source: "user" })
      .where(
        and(eq(memories.id, id.parse(memoryId)), eq(memories.agentId, id.parse(agentId)))
      )
  )
  return getMemories(user.id, agentId)
}

export async function deleteMemory(agentId: string, memoryId: string) {
  const user = await requireUser()
  await withUser(user.id, (tx) =>
    tx
      .delete(memories)
      .where(
        and(eq(memories.id, id.parse(memoryId)), eq(memories.agentId, id.parse(agentId)))
      )
  )
  revalidatePath("/", "layout")
  return getMemories(user.id, agentId)
}

export async function clearMemories(agentId: string) {
  const user = await requireUser()
  await withUser(user.id, (tx) =>
    tx.delete(memories).where(eq(memories.agentId, id.parse(agentId)))
  )
  revalidatePath("/", "layout")
  return getMemories(user.id, agentId)
}
