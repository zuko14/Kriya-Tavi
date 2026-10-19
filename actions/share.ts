"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { PdfUnavailableError } from "@/lib/documents/render"
import { allow } from "@/lib/rate-limit"
import * as share from "@/lib/share"

// Kriya Share (K8) and the receipt PDF (K1): the person's actions only,
// never agent tools (AT-SHR-04). Behind agents.files (and agents.receipts
// for receipts).

const OFF = { error: "Sharing isn't available yet." }

async function person() {
  const user = await requireUser()
  const on =
    (await getSetting("agents.files")) === "on" &&
    (await getSetting("agents.receipts")) === "on"
  return on ? user : null
}

const unavailable = (error: unknown) => {
  if (error instanceof PdfUnavailableError) return { error: error.message }
  throw error
}

// The receipt as a PDF in the person's files; the page then opens
// /api/files/<id>, which redirects to a 60 s link
export async function receiptPdf(episodeId: string) {
  const user = await person()
  const id = z.uuid().safeParse(episodeId)
  if (!user || !id.success) return OFF
  if (!(await allow(`pdf:${user.id}`, 20, 3600))) {
    return { error: "Too many PDFs this hour. Try again later." }
  }
  try {
    const made = await share.receiptPdf(user.id, id.data)
    if (!made) return { error: "That record wasn't found." }
    revalidatePath("/account")
    return { href: `/api/files/${made.file.id}` }
  } catch (error) {
    return unavailable(error)
  }
}

const shareInput = z.object({
  kind: z.literal("receipt"),
  ref: z.uuid(),
  days: z.number().int().min(share.SHARE_DAYS.min).max(share.SHARE_DAYS.max),
})

// The link is in this answer only: Kriya keeps just its hash
export async function createShare(kind: string, ref: string, days: number) {
  const user = await person()
  const input = shareInput.safeParse({ kind, ref, days })
  if (!user || !input.success) return OFF
  if (!(await allow(`share:${user.id}`, 20, 3600))) {
    return { error: "Too many links this hour. Try again later." }
  }
  try {
    const result = await share.createShare(user.id, input.data)
    revalidatePath("/account")
    return result
  } catch (error) {
    return unavailable(error)
  }
}

export async function revokeShare(id: string) {
  const user = await person()
  const parsed = z.string().min(1).max(32).safeParse(id)
  if (!user || !parsed.success) return OFF
  if (!(await share.revokeShare(user.id, parsed.data))) {
    return { error: "That link was already revoked." }
  }
  revalidatePath("/account")
  return { ok: true as const }
}

export async function listShares() {
  const user = await person()
  return user ? share.listShares(user.id) : []
}
