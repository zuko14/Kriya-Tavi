import { withUser } from "@/db"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { recallNotes } from "@/lib/memory/retrieve"
import { SENSITIVE_REFUSAL, sensitiveKind } from "@/lib/memory/sensitive"
import { AGENT_NOTE_MAX, normalise, writeMemory } from "@/lib/memory/write"

// The device agent's memory (H7, HD-10): the notes it can see (its own and
// the person's shared ones) through recallNotes, and saves through
// writeMemory, both as the person (withUser). Content from a device is
// untrusted to Kriya, so a save is always unconfirmed until the person
// confirms it in the Inbox (memory quarantine). Only with memory v2 on.

export const memoryOn = async () => (await getSetting("agents.memoryV2")) === "on"

export async function searchNotes(
  device: DeviceUser & { agentId: string },
  query: string,
  limit = 8
) {
  const notes = await withUser(device.id, (tx) =>
    recallNotes(tx, { userId: device.id, agentId: device.agentId, query, limit })
  )
  // Confirmed notes first, each group in recall's order
  return notes
    .map((note) => ({
      id: note.id,
      content: note.content,
      kind: note.kind,
      confirmed: note.trust === "trusted",
      shared: note.agentId === null,
    }))
    .sort((a, b) => Number(b.confirmed) - Number(a.confirmed))
}

// A refusal sentence, or the saved note
export async function saveNote(
  device: DeviceUser & { agentId: string },
  content: string
) {
  const note = normalise(content)
  if (!note || note.length > AGENT_NOTE_MAX)
    return { refused: `Keep a note between 1 and ${AGENT_NOTE_MAX} characters.` }
  const sensitive = sensitiveKind(note, { slot: null, source: "agent" })
  if (sensitive)
    return {
      refused: `Not saved: this looks like ${SENSITIVE_REFUSAL[sensitive]}. Never keep such values in memory.`,
    }
  const saved = await withUser(device.id, (tx) =>
    writeMemory(
      tx,
      { userId: device.id, agentId: device.agentId, taskId: null, untrusted: true },
      { note }
    )
  )
  return { id: saved.id, confirmed: saved.trust === "trusted" }
}
