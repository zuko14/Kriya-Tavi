"use server"

import { and, eq, isNull, ne } from "drizzle-orm"
import { z } from "zod"

import { withUser } from "@/db"
import { workspaces } from "@/db/schema"
import { requireUser } from "@/lib/auth"

// The person's one write on a cloud workspace (UX_SPEC §2): asking to close
// it. RLS and the column grant allow exactly close_requested_at on their own
// rows; the worker's janitor destroys the sandbox and deletes the saved
// changes. Tools never write this (PERSON_ONLY_WRITES).
export async function closeWorkspace(workspaceId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(workspaceId)
  if (!id.success) return { error: "Workspace not found." }
  const closed = await withUser(user.id, (tx) =>
    tx
      .update(workspaces)
      .set({ closeRequestedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, id.data),
          ne(workspaces.status, "closed"),
          isNull(workspaces.closeRequestedAt)
        )
      )
      .returning({ id: workspaces.id })
  )
  return closed.length ? { ok: true as const } : { error: "Workspace not found." }
}
