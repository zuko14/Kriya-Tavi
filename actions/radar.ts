"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireOwner, requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { retractFact as retract } from "@/lib/facts"
import { audit } from "@/lib/owner"
import { addPersonObligation, markObligation as mark } from "@/lib/radar/obligations"
import { OBLIGATION_KINDS } from "@/lib/radar/templates"

// Radar (K4): the person marks a deadline done or dismissed, or adds their
// own. Neither is an agent tool (DATA_MODEL §3.9). The owner retracts a
// public fact (K6), audited.

const OFF = { error: "Radar isn't available yet." }

async function person() {
  const user = await requireUser()
  return (await getSetting("agents.radar")) === "on" ? user : null
}

export async function markObligation(id: string, status: "done" | "dismissed") {
  const user = await person()
  const parsed = z
    .object({ id: z.string().min(1).max(32), status: z.enum(["done", "dismissed"]) })
    .safeParse({ id, status })
  if (!user || !parsed.success) return OFF
  if (!(await mark(user.id, parsed.data.id, parsed.data.status))) {
    return { error: "That deadline was already closed." }
  }
  revalidatePath("/radar")
  return { ok: true as const }
}

const own = z.object({
  kind: z.enum(OBLIGATION_KINDS as [string, ...string[]]),
  title: z.string().trim().min(1).max(200),
  dueAt: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(1).max(500),
})

export async function addObligation(input: z.input<typeof own>) {
  const user = await person()
  const parsed = own.safeParse(input)
  if (!user || !parsed.success) return OFF
  await addPersonObligation(user.id, {
    ...parsed.data,
    dueAt: new Date(parsed.data.dueAt),
  })
  revalidatePath("/radar")
  return { ok: true as const }
}

export async function retractFact(key: string) {
  const owner = await requireOwner()
  const parsed = z
    .string()
    .regex(/^[a-z0-9_.-]{3,120}$/)
    .safeParse(key)
  if (!parsed.success) return { error: "That fact wasn't found." }
  if (!(await retract(owner.id, parsed.data))) return { error: "That fact wasn't found." }
  await audit(owner.id, "fact.retract", { type: "public_fact", id: parsed.data })
  revalidatePath("/owner/facts")
  return { ok: true as const }
}
