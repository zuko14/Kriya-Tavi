import { createHash } from "node:crypto"

import { and, eq, isNull, or, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { rowsOf, type Q } from "@/db"
import { memories, type MemoryKind } from "@/db/schema"
import { similarNotes } from "@/lib/memory/retrieve"
import { SENSITIVE_REFUSAL, sensitiveKind } from "@/lib/memory/sensitive"

// The agent's write path for memory v2 (MEMORY_AND_CONTEXT.md §4). History is
// kept: a changed fact supersedes the old note (invalid_at, superseded_by)
// instead of overwriting it, and an agent's "forget" only invalidates. Only
// the person erases (eraseMemory). Callers pass a withUser transaction.

export type WriteEnv = {
  userId: string
  // The agent holding the turn
  agentId: string
  taskId: string | null
  // The turn has read web, mail, document or browser content (AD-11)
  untrusted: boolean
}

export type WriteInput = {
  note: string
  kind?: MemoryKind
  slot?: string | null
  shared?: boolean
  importance?: number
}

export type WriteResult = {
  id: string
  saved: string
  trust: "trusted" | "unconfirmed"
  duplicate?: true
  superseded?: string
  similar: { id: string; content: string }[]
}

// Longer text is a document, not a note; the database allows 2000 for the
// person's own notes
export const AGENT_NOTE_MAX = 1000
export const SLOT_PATTERN = /^[a-z][a-z0-9_.[\]-]{0,63}$/

export const normalise = (text: string) =>
  text.normalize("NFC").replace(/\s+/g, " ").trim()

export const contentHash = (text: string) =>
  createHash("sha256").update(normalise(text).toLowerCase()).digest("hex")

const now = sql`now()`

export async function writeMemory(
  tx: Q,
  env: WriteEnv,
  input: WriteInput,
  // The note this one replaces (memory_update)
  supersedes?: string
): Promise<WriteResult> {
  const content = normalise(input.note)
  if (!content) throw new Error("The note is empty.")
  if (content.length > AGENT_NOTE_MAX) {
    throw new Error(
      `Keep a note under ${AGENT_NOTE_MAX} characters: one fact, preference or decision. Longer text belongs in a file.`
    )
  }
  const slot = input.slot ?? null
  if (slot !== null && !SLOT_PATTERN.test(slot)) {
    throw new Error("A slot looks like profile.course or profile.skills[] (lowercase).")
  }
  const sensitive = sensitiveKind(content, { slot, source: "agent" })
  if (sensitive) {
    throw new Error(
      `Not saved: this looks like ${SENSITIVE_REFUSAL[sensitive]}. Never keep such values in memory. If the rest of the note matters, save it without the value.`
    )
  }

  const agentId = input.shared ? null : env.agentId
  const hash = contentHash(content)
  const trust = env.untrusted ? ("unconfirmed" as const) : ("trusted" as const)
  const invalidate = (id: string, by: string | null) =>
    tx
      .update(memories)
      .set({ invalidAt: now, ...(by && { supersededBy: by }) })
      .where(and(eq(memories.id, id), eq(memories.userId, env.userId)))

  const [same] = await tx
    .select({ id: memories.id, trust: memories.trust })
    .from(memories)
    .where(
      and(
        eq(memories.userId, env.userId),
        agentId ? eq(memories.agentId, agentId) : isNull(memories.agentId),
        eq(memories.contentHash, hash),
        isNull(memories.invalidAt)
      )
    )
    .limit(1)
  if (same) {
    await tx.update(memories).set({ lastUsedAt: now }).where(eq(memories.id, same.id))
    if (supersedes && supersedes !== same.id) await invalidate(supersedes, same.id)
    return {
      id: same.id,
      saved: content,
      trust: same.trust,
      duplicate: true,
      ...(supersedes && supersedes !== same.id && { superseded: supersedes }),
      similar: [],
    }
  }

  // A single-valued slot holds one current value: the old one becomes history
  let replaced = supersedes
  if (!replaced && slot && !slot.endsWith("[]")) {
    const [current] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, env.userId),
          eq(memories.slot, slot),
          isNull(memories.invalidAt)
        )
      )
    replaced = current?.id
  }
  // Freed first: the slot's unique index allows one current value
  if (replaced) await invalidate(replaced, null)

  const id = nanoid(12)
  await tx.insert(memories).values({
    id,
    userId: env.userId,
    agentId,
    content,
    source: "agent",
    kind: input.kind ?? "fact",
    slot,
    trust,
    importance: input.importance ?? 2,
    taskId: env.taskId,
    contentHash: hash,
  })
  if (replaced) {
    await tx.update(memories).set({ supersededBy: id }).where(eq(memories.id, replaced))
  }

  const similar = await similarNotes(tx, {
    userId: env.userId,
    agentId: env.agentId,
    content,
    exclude: replaced ? [id, replaced] : [id],
  })
  return { id, saved: content, trust, ...(replaced && { superseded: replaced }), similar }
}

// A current note the agent can see: shared, or its own
async function visibleNote(tx: Q, env: WriteEnv, id: string) {
  const [note] = await tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.id, id),
        eq(memories.userId, env.userId),
        isNull(memories.invalidAt),
        or(isNull(memories.agentId), eq(memories.agentId, env.agentId))
      )
    )
  if (!note) throw new Error(`No note with id ${id} in your memory.`)
  return note
}

// memory_update: a new note replaces `id`, in the same kind, slot and scope
export async function updateMemory(tx: Q, env: WriteEnv, id: string, note: string) {
  const old = await visibleNote(tx, env, id)
  return writeMemory(
    tx,
    env,
    {
      note,
      kind: old.kind,
      slot: old.slot,
      shared: old.agentId === null,
      importance: old.importance,
    },
    old.id
  )
}

// memory_forget from an agent: the note stops being used and stays as history
export async function forgetMemory(tx: Q, env: WriteEnv, id: string) {
  await visibleNote(tx, env, id)
  await tx.update(memories).set({ invalidAt: now }).where(eq(memories.id, id))
  return { forgotten: id }
}

// The person's "Forget": deletes the note and every older version it
// replaced (erasure). Returns how many notes were deleted.
export async function eraseMemory(tx: Q, id: string) {
  const result = await tx.execute(sql`
    with recursive chain(id) as (
      select id from kriya.memories where id = ${id}
      union
      select m.id from kriya.memories m join chain c on m.superseded_by = c.id
    )
    delete from kriya.memories where id in (select id from chain) returning id`)
  return rowsOf<{ id: string }>(result).length
}
