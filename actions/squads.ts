"use server"

import { and, eq, inArray, notInArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser, type Tx } from "@/db"
import {
  agents,
  squadInputSchema,
  squadMembers,
  squads,
  threads,
  type SquadInput,
} from "@/db/schema"
import { requireUser } from "@/lib/auth"

const id = z.string().min(1).max(32)

async function validate(tx: Tx, values: SquadInput) {
  const data = squadInputSchema.parse(values)
  const agentIds = [...new Set(data.agentIds)]
  // RLS: only the person's own agents are found
  const found = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.id, agentIds))
  if (agentIds.length < 2 || found.length !== agentIds.length) {
    throw new Error("A squad needs at least two of your agents.")
  }
  return { name: data.name, agentIds }
}

export async function createSquad(values: SquadInput) {
  const user = await requireUser()
  const result = await withUser(user.id, async (tx) => {
    const { name, agentIds } = await validate(tx, values)
    const [squad] = await tx
      .insert(squads)
      .values({ id: nanoid(12), userId: user.id, name })
      .returning()
    await tx.insert(squadMembers).values(
      agentIds.map((agentId, position) => ({
        squadId: squad.id,
        agentId,
        userId: user.id,
        position,
      }))
    )
    const [thread] = await tx
      .insert(threads)
      .values({ id: nanoid(12), userId: user.id, squadId: squad.id })
      .returning({ id: threads.id })
    return { squad, threadId: thread.id }
  })
  revalidatePath("/", "layout")
  return result
}

export async function updateSquad(squadId: string, values: SquadInput) {
  const user = await requireUser()
  const target = id.parse(squadId)
  const squad = await withUser(user.id, async (tx) => {
    const { name, agentIds } = await validate(tx, values)
    const [squad] = await tx
      .update(squads)
      .set({ name })
      .where(eq(squads.id, target))
      .returning()
    if (!squad) throw new Error("Squad not found")
    await tx
      .delete(squadMembers)
      .where(
        and(eq(squadMembers.squadId, target), notInArray(squadMembers.agentId, agentIds))
      )
    for (const [position, agentId] of agentIds.entries()) {
      await tx
        .insert(squadMembers)
        .values({ squadId: target, agentId, userId: user.id, position })
        .onConflictDoUpdate({
          target: [squadMembers.squadId, squadMembers.agentId],
          set: { position },
        })
    }
    return squad
  })
  revalidatePath("/", "layout")
  return squad
}

// The squad and its threads go; its agents stay
export async function deleteSquad(squadId: string) {
  const user = await requireUser()
  const [squad] = await withUser(user.id, (tx) =>
    tx
      .delete(squads)
      .where(eq(squads.id, id.parse(squadId)))
      .returning()
  )
  if (!squad) throw new Error("Squad not found")
  revalidatePath("/", "layout")
}
