"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { FILE_MIMES } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import * as files from "@/lib/files"
import { allow } from "@/lib/rate-limit"

// The person's files (A5, AD-19): a signed upload link, then a check of
// what arrived; delete; a 60 s download link. Behind agents.files.

const OFF = { error: "Files aren't available yet." }
const fileId = z.uuid()
const uploadInput = z.object({
  name: z.string().trim().min(1).max(255),
  mime: z.enum(FILE_MIMES),
  size: z
    .number()
    .int()
    .min(1)
    .max(100 * 1048576),
})

async function person() {
  const user = await requireUser()
  return (await getSetting("agents.files")) === "on" ? user : null
}

export async function createUploadUrl(name: string, mime: string, size: number) {
  const user = await person()
  if (!user) return OFF
  const input = uploadInput.safeParse({ name, mime, size })
  if (!input.success) return { error: "That type of file isn't accepted." }
  if (!(await allow(`upload:${user.id}`, 30, 3600))) {
    return { error: "Too many uploads this hour. Try again later." }
  }
  return files.createUpload(user.id, input.data)
}

export async function confirmUpload(id: string) {
  const user = await person()
  const parsed = fileId.safeParse(id)
  if (!user || !parsed.success) return OFF
  const result = await files.confirmUpload(user.id, parsed.data)
  revalidatePath("/account")
  return result
}

export async function deleteFile(id: string) {
  const user = await person()
  const parsed = fileId.safeParse(id)
  if (!user || !parsed.success) return OFF
  if (!(await files.deleteFile(user.id, parsed.data)))
    return { error: "That file wasn't found." }
  revalidatePath("/account")
  return { ok: true as const }
}

export async function downloadUrl(id: string) {
  const user = await person()
  const parsed = fileId.safeParse(id)
  if (!user || !parsed.success) return OFF
  const url = await files.downloadUrl(user.id, parsed.data)
  return url ? { url } : { error: "That file wasn't found." }
}
