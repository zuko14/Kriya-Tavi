"use server"

import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { agents, squads, threads } from "@/db/schema"
import { loadMessages } from "@/lib/agent/messages"
import { cancelThreadTask } from "@/lib/agent/queue"
import { requireUser } from "@/lib/auth"
import { getActivity } from "@/queries/workspace"

const id = z.string().min(1).max(32)

export async function createThread(owner: { agentId?: string; squadId?: string }) {
  const user = await requireUser()
  const threadId = await withUser(user.id, async (tx) => {
    if (owner.agentId) {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, id.parse(owner.agentId)))
      if (!agent) throw new Error("Agent not found")
    } else if (owner.squadId) {
      const [squad] = await tx
        .select({ id: squads.id })
        .from(squads)
        .where(eq(squads.id, id.parse(owner.squadId)))
      if (!squad) throw new Error("Squad not found")
    } else {
      throw new Error("A thread belongs to an agent or a squad")
    }
    const [thread] = await tx
      .insert(threads)
      .values({
        id: nanoid(12),
        userId: user.id,
        agentId: owner.agentId ?? null,
        squadId: owner.agentId ? null : (owner.squadId ?? null),
      })
      .returning({ id: threads.id })
    return thread.id
  })
  revalidatePath("/", "layout")
  return threadId
}

// What's saved in a thread, for a page catching up with a task that started
// elsewhere (another tab or device)
export async function threadMessages(threadId: string) {
  const user = await requireUser()
  return withUser(user.id, (tx) => loadMessages(tx, id.parse(threadId)))
}

export async function threadActivity(threadId: string) {
  const user = await requireUser()
  return getActivity(user.id, id.parse(threadId))
}

export async function renameThread(threadId: string, title: string) {
  const user = await requireUser()
  const value = z.string().trim().min(1).max(80).parse(title)
  await withUser(user.id, (tx) =>
    tx
      .update(threads)
      .set({ title: value })
      .where(eq(threads.id, id.parse(threadId)))
  )
  revalidatePath("/", "layout")
}

export async function deleteThread(threadId: string) {
  const user = await requireUser()
  const target = id.parse(threadId)
  await cancelThreadTask(user.id, target)
  await withUser(user.id, (tx) => tx.delete(threads).where(eq(threads.id, target)))
  revalidatePath("/", "layout")
}

export async function stopThread(threadId: string) {
  const user = await requireUser()
  return cancelThreadTask(user.id, id.parse(threadId))
}
