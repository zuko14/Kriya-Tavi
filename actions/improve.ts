"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireOwner } from "@/lib/auth"
import { advance, rollback } from "@/lib/improve"
import { log } from "@/lib/log"

// The owner promotes or rolls back a policy version (A12, AD-25). Each step
// is audited by lib/improve.ts with the owner's id.

const versionId = z.string().regex(/^[A-Za-z0-9_-]{12}$/)

async function step(id: string, run: (id: string, ownerId: string) => Promise<unknown>) {
  const owner = await requireOwner()
  const parsed = versionId.safeParse(id)
  if (!parsed.success) return { error: "That version wasn't found." }
  try {
    await run(parsed.data, owner.id)
  } catch (error) {
    log.warn("policy step refused", { id: parsed.data, error })
    return { error: error instanceof Error ? error.message : "That step isn't allowed." }
  }
  revalidatePath("/owner/improve")
  return { ok: true as const }
}

export async function advanceVersion(id: string) {
  return step(id, advance)
}

export async function rollbackVersion(id: string) {
  return step(id, (version, ownerId) => rollback(version, "owner", ownerId))
}
