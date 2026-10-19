import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import type { Q } from "@/db"
import { agents, memories, type MemoryKind } from "@/db/schema"
import { SENSITIVE_REFUSAL, sensitiveKind } from "@/lib/memory/sensitive"
import { contentHash, normalise, SLOT_PATTERN } from "@/lib/memory/write"

// What the person does with memory v2 (MEMORY_AND_CONTEXT.md §11). Called
// from actions/memory.ts inside withUser, so Row Level Security limits every
// statement to the person's own notes. Trust and pins are the person's to
// set; no agent tool calls these (DATA_MODEL §4).

export const PERSON_NOTE_MAX = 2_000

// "About you": notes shared by all of the person's agents, profile first
export function sharedNotes(tx: Q) {
  return tx
    .select()
    .from(memories)
    .where(and(isNull(memories.agentId), isNull(memories.invalidAt)))
    .orderBy(
      sql`${memories.kind} <> 'profile'`,
      asc(memories.slot),
      desc(memories.updatedAt)
    )
}

// Sensitive values never become memory, whoever writes them (AGENTS.md track
// A rule 8). Used by every note the person writes, old actions included.
export function refuseSensitive(content: string, slot: string | null, source: "user") {
  const sensitive = sensitiveKind(content, { slot, source })
  if (sensitive) {
    throw new Error(
      `Not saved: this looks like ${SENSITIVE_REFUSAL[sensitive]}. Kriya never keeps such values in memory.`
    )
  }
}

// A note the person writes for all their agents. Trusted by definition. A
// one-value slot keeps its old value as history.
export async function addPersonNote(
  tx: Q,
  userId: string,
  input: { content: string; kind?: MemoryKind; slot?: string | null }
) {
  const content = normalise(input.content)
  if (!content || content.length > PERSON_NOTE_MAX) {
    throw new Error(`Write a note of 1 to ${PERSON_NOTE_MAX} characters.`)
  }
  const slot = input.slot || null
  if (slot !== null && !SLOT_PATTERN.test(slot)) {
    throw new Error("A slot looks like profile.course or profile.skills[] (lowercase).")
  }
  refuseSensitive(content, slot, "user")
  const hash = contentHash(content)
  const [same] = await tx
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        isNull(memories.agentId),
        isNull(memories.invalidAt),
        eq(memories.contentHash, hash)
      )
    )
  if (same) return same.id

  const [current] =
    slot && !slot.endsWith("[]")
      ? await tx
          .select({ id: memories.id })
          .from(memories)
          .where(and(eq(memories.slot, slot), isNull(memories.invalidAt)))
      : []
  if (current) {
    await tx
      .update(memories)
      .set({ invalidAt: sql`now()` })
      .where(eq(memories.id, current.id))
  }
  const id = nanoid(12)
  await tx.insert(memories).values({
    id,
    userId,
    agentId: null,
    content,
    source: "user",
    kind: input.kind ?? "fact",
    slot,
    trust: "trusted",
    contentHash: hash,
  })
  if (current) {
    await tx.update(memories).set({ supersededBy: id }).where(eq(memories.id, current.id))
  }
  return id
}

// "New memories to review": notes saved after an agent read outside content
export function notesToReview(tx: Q) {
  return tx
    .select({
      id: memories.id,
      content: memories.content,
      kind: memories.kind,
      agentName: agents.name,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(and(eq(memories.trust, "unconfirmed"), isNull(memories.invalidAt)))
    .orderBy(desc(memories.createdAt))
}

export async function confirmNote(tx: Q, id: string) {
  const rows = await tx
    .update(memories)
    .set({ trust: "trusted" })
    .where(and(eq(memories.id, id), isNull(memories.invalidAt)))
    .returning({ id: memories.id })
  return rows.length > 0
}

export async function pinNote(tx: Q, id: string, pinned: boolean) {
  const rows = await tx
    .update(memories)
    .set({ pinned })
    .where(eq(memories.id, id))
    .returning({ id: memories.id })
  return rows.length > 0
}

// The notes one reply used ("Used N memories" chip), in the reply's order.
// Erased notes and other people's are simply missing.
export async function notesByIds(tx: Q, ids: string[]) {
  if (ids.length === 0) return []
  const rows = await tx
    .select({
      id: memories.id,
      content: memories.content,
      kind: memories.kind,
      trust: memories.trust,
      agentName: agents.name,
      current: sql<boolean>`${memories.invalidAt} is null`,
    })
    .from(memories)
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .where(inArray(memories.id, ids))
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

// The person's agents and whether each one's memory is paused
export function agentMemoryStates(tx: Q) {
  return tx
    .select({ id: agents.id, name: agents.name, memoryPaused: agents.memoryPaused })
    .from(agents)
    .orderBy(asc(agents.createdAt))
}

export async function setMemoryPaused(tx: Q, agentId: string, paused: boolean) {
  const rows = await tx
    .update(agents)
    .set({ memoryPaused: paused })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id })
  return rows.length > 0
}

// Everything Kriya remembers about the person, history included (DPDP
// access). Ids and content only; no internal hashes or provenance ids.
export function exportNotes(tx: Q) {
  return tx
    .select({
      id: memories.id,
      agent: agents.name,
      content: memories.content,
      kind: memories.kind,
      slot: memories.slot,
      source: memories.source,
      trust: memories.trust,
      importance: memories.importance,
      pinned: memories.pinned,
      current: sql<boolean>`${memories.invalidAt} is null`,
      supersededBy: memories.supersededBy,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .leftJoin(agents, eq(agents.id, memories.agentId))
    .orderBy(asc(memories.createdAt))
}
