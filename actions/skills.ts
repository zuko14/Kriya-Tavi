"use server"

import { and, eq, ne } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { skills } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"

// The person's side of skills (A9, AD-21): approving a draft, retiring a
// skill, and letting one that stopped matching try again. Never agent tools
// (DATA_MODEL §4, AT-POL-07).

const ref = z.object({ id: z.string().min(1).max(32), version: z.number().int().min(1) })

async function person() {
  const user = await requireUser()
  if ((await getSetting("agents.skills")) !== "on") return null
  return user
}

// Approving a version retires the person's older approved versions of it
export async function approveSkill(id: string, version: number) {
  const user = await person()
  const input = ref.safeParse({ id, version })
  if (!user || !input.success) return { error: "That skill wasn't found." }
  const approved = await withUser(user.id, async (tx) => {
    const rows = await tx
      .update(skills)
      .set({ status: "approved", approvedAt: new Date() })
      .where(
        and(
          eq(skills.id, input.data.id),
          eq(skills.version, input.data.version),
          eq(skills.status, "draft")
        )
      )
      .returning({ id: skills.id })
    if (rows.length === 0) return false
    await tx
      .update(skills)
      .set({ status: "retired" })
      .where(
        and(
          eq(skills.id, input.data.id),
          eq(skills.status, "approved"),
          ne(skills.version, input.data.version)
        )
      )
    return true
  })
  if (!approved) return { error: "That draft was already handled." }
  revalidatePath("/inbox")
  return { ok: true as const }
}

// Every version, so a retired skill can't run and its drafts go too
export async function retireSkill(id: string) {
  const user = await person()
  const input = ref.shape.id.safeParse(id)
  if (!user || !input.success) return { error: "That skill wasn't found." }
  await withUser(user.id, (tx) =>
    tx
      .update(skills)
      .set({ status: "retired" })
      .where(and(eq(skills.id, input.data), ne(skills.status, "retired")))
  )
  revalidatePath("/inbox")
  return { ok: true as const }
}

// "Try again": a skill that stopped matching runs again from the start
export async function resetSkill(id: string) {
  const user = await person()
  const input = ref.shape.id.safeParse(id)
  if (!user || !input.success) return { error: "That skill wasn't found." }
  await withUser(user.id, (tx) =>
    tx
      .update(skills)
      .set({ failures: 0 })
      .where(and(eq(skills.id, input.data), eq(skills.status, "approved")))
  )
  revalidatePath("/inbox")
  return { ok: true as const }
}
