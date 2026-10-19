"use server"

import { and, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { agents, MEMORY_KINDS, memories, memoryInputSchema } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import {
  addPersonNote,
  agentMemoryStates,
  confirmNote,
  exportNotes,
  notesByIds,
  notesToReview,
  PERSON_NOTE_MAX,
  pinNote,
  refuseSensitive,
  setMemoryPaused,
  sharedNotes,
} from "@/lib/memory/person"
import { eraseMemory } from "@/lib/memory/write"
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
  refuseSensitive(data.content, null, "user")
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
  refuseSensitive(data.content, null, "user")
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

// Erasure: the note and every older version it replaced (memory v2 keeps
// history; without it there is never more than the note itself)
export async function deleteMemory(agentId: string, memoryId: string) {
  const user = await requireUser()
  await withUser(user.id, async (tx) => {
    const [note] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(eq(memories.id, id.parse(memoryId)), eq(memories.agentId, id.parse(agentId)))
      )
    if (note) await eraseMemory(tx, note.id)
  })
  revalidatePath("/", "layout")
  return getMemories(user.id, agentId)
}

/* ─────────────── memory v2: about you, review, export ─────────────── */

const aboutYouInput = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(PERSON_NOTE_MAX),
  kind: z.enum(MEMORY_KINDS).optional(),
  slot: z.string().trim().max(64).optional(),
})

async function aboutYou(userId: string) {
  return withUser(userId, async (tx) => ({
    notes: await sharedNotes(tx),
    review: await notesToReview(tx),
    agents: await agentMemoryStates(tx),
  }))
}

// Pause or resume one agent's memory; while paused it saves nothing
export async function setAgentMemoryPaused(agentId: string, paused: boolean) {
  const user = await requireUser()
  await withUser(user.id, (tx) =>
    setMemoryPaused(tx, id.parse(agentId), z.boolean().parse(paused))
  )
  return aboutYou(user.id)
}

export type AboutYou = Awaited<ReturnType<typeof aboutYou>>

export async function listAboutYou() {
  const user = await requireUser()
  return aboutYou(user.id)
}

export async function addAboutYou(input: z.input<typeof aboutYouInput>) {
  const user = await requireUser()
  const data = aboutYouInput.parse(input)
  await withUser(user.id, (tx) => addPersonNote(tx, user.id, data))
  revalidatePath("/account")
  return aboutYou(user.id)
}

// The person vouches for a note an agent saved after reading outside content
export async function confirmMemory(memoryId: string) {
  const user = await requireUser()
  await withUser(user.id, (tx) => confirmNote(tx, id.parse(memoryId)))
  return aboutYou(user.id)
}

export async function pinMemory(memoryId: string, pinned: boolean) {
  const user = await requireUser()
  await withUser(user.id, (tx) =>
    pinNote(tx, id.parse(memoryId), z.boolean().parse(pinned))
  )
  return aboutYou(user.id)
}

export async function forgetForGood(memoryId: string) {
  const user = await requireUser()
  await withUser(user.id, (tx) => eraseMemory(tx, id.parse(memoryId)))
  revalidatePath("/", "layout")
  return aboutYou(user.id)
}

// Everything remembered about the person, as JSON for download (DPDP access)
export async function exportMemory() {
  const user = await requireUser()
  return withUser(user.id, (tx) => exportNotes(tx))
}

// "Used N memories" on a reply: the notes behind it, read as the person
export async function usedMemories(memoryIds: string[]) {
  const user = await requireUser()
  const ids = z.array(id).max(100).parse(memoryIds)
  if ((await getSetting("agents.memoryV2")) !== "on") return []
  return withUser(user.id, (tx) => notesByIds(tx, ids))
}

export type UsedMemory = Awaited<ReturnType<typeof usedMemories>>[number]

export async function clearMemories(agentId: string) {
  const user = await requireUser()
  await withUser(user.id, (tx) =>
    tx.delete(memories).where(eq(memories.agentId, id.parse(agentId)))
  )
  revalidatePath("/", "layout")
  return getMemories(user.id, agentId)
}
