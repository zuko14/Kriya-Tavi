import { createHash } from "node:crypto"

import { createClient } from "@supabase/supabase-js"
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"

import { privileged, rowsOf, withUser } from "@/db"
import { editDeliverables, editJobs, resourceUsage } from "@/db/schema"
import { log } from "@/lib/log"

// Previews (EDD-46): small files of a finished edit, in their own private bucket
// (kriya-files refuses video, EH-24). A device uploads straight to Storage by a
// signed link, so bytes never pass through the web service (EH-23). Nobody can
// watch one until the worker has checked its size, hash and container here.

export const PREVIEW_BUCKET = "kriya-edit-previews"
// A <video> keeps seeking for an hour (EH-25)
export const LINK_SECONDS = 3600
// A device that reserved and never finished: the reservation goes after this
const ABANDONED_MS = 60 * 60_000
// A read may fail for a moment: an object is called missing only after this
const MISSING_GRACE_MS = 10 * 60_000
const BATCH = 10

export interface PreviewStore {
  uploadUrl(path: string): Promise<string>
  // null when the object isn't there (or can't be read right now)
  read(path: string): Promise<Buffer | null>
  // Without a download name the browser plays it; with one it saves it
  signedUrl(path: string, seconds: number, downloadName?: string): Promise<string>
  remove(paths: string[]): Promise<void>
}

let testStore: PreviewStore | null | undefined
export function setPreviewStoreForTests(store: PreviewStore | null | undefined) {
  testStore = store
}

// The service key never leaves the server (invariant 4); null when unset
export function previewStore(): PreviewStore | null {
  if (testStore !== undefined) return testStore
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !key) return null
  const bucket = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage.from(PREVIEW_BUCKET)
  return {
    async uploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: true })
      if (error) throw new Error("storage: couldn't create an upload link")
      return data.signedUrl
    },
    async read(path) {
      const { data, error } = await bucket.download(path)
      return error || !data ? null : Buffer.from(await data.arrayBuffer())
    },
    async signedUrl(path, seconds, downloadName) {
      const { data, error } = await bucket.createSignedUrl(
        path,
        seconds,
        downloadName ? { download: downloadName } : undefined
      )
      if (error) throw new Error("storage: couldn't sign a link")
      return data.signedUrl
    },
    async remove(paths) {
      if (paths.length === 0) return
      const { error } = await bucket.remove(paths)
      if (error) throw new Error("storage: delete failed")
    },
  }
}

// What each kind must be, from its bytes. The device's word isn't enough (ES-16)
export function containerOk(kind: string, bytes: Buffer) {
  if (kind === "preview" || kind === "clip")
    return bytes.subarray(4, 8).toString("latin1") === "ftyp"
  if (kind === "poster")
    return (
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
    )
  if (kind === "report")
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"))
      return typeof value === "object" && value !== null && !Array.isArray(value)
    } catch {
      return false
    }
  return false
}

type Row = typeof editDeliverables.$inferSelect

async function reject(store: PreviewStore, row: Row, reason: string) {
  await store.remove([row.storagePath]).catch(() => {})
  await privileged
    .update(editDeliverables)
    .set({ status: "rejected", deletedAt: new Date() })
    .where(and(eq(editDeliverables.id, row.id), eq(editDeliverables.userId, row.userId)))
  log.info("edit preview rejected", { reason })
}

/** Checks finished uploads and clears reservations nobody finished. */
export async function verifyPreviews() {
  const store = previewStore()
  if (!store) return 0
  const rows = await privileged
    .select()
    .from(editDeliverables)
    .where(
      and(
        eq(editDeliverables.status, "pending"),
        isNull(editDeliverables.deletedAt),
        or(
          isNotNull(editDeliverables.uploadedAt),
          lt(editDeliverables.createdAt, new Date(Date.now() - ABANDONED_MS))
        )
      )
    )
    .limit(BATCH)
  let done = 0
  for (const row of rows) {
    try {
      if (!row.uploadedAt) {
        await reject(store, row, "abandoned")
        continue
      }
      const bytes = await store.read(row.storagePath)
      if (!bytes) {
        if (Date.now() - row.uploadedAt.getTime() > MISSING_GRACE_MS)
          await reject(store, row, "missing")
        continue
      }
      if (bytes.length !== row.bytes) await reject(store, row, "size")
      else if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
        await reject(store, row, "hash")
      else if (!containerOk(row.kind, bytes)) await reject(store, row, "container")
      else {
        await privileged.transaction(async (tx) => {
          await tx
            .update(editDeliverables)
            .set({ status: "ready" })
            .where(
              and(
                eq(editDeliverables.id, row.id),
                eq(editDeliverables.userId, row.userId)
              )
            )
          await tx
            .insert(resourceUsage)
            .values({
              requestKey: `edit_preview:${row.id}`,
              userId: row.userId,
              kind: "edit_preview_bytes",
              quantity: row.bytes,
              costMicroUsd: null,
            })
            .onConflictDoNothing()
        })
        done++
      }
    } catch (error) {
      log.error("edit preview check failed", { error })
    }
  }
  return done
}

/** The person's own, checked file: a link for the player, or null. */
export async function previewLink(userId: string, id: string) {
  const store = previewStore()
  if (!store) return null
  const [row] = await withUser(userId, (tx) =>
    tx
      .select({ kind: editDeliverables.kind, path: editDeliverables.storagePath })
      .from(editDeliverables)
      .where(
        and(
          eq(editDeliverables.id, id),
          eq(editDeliverables.status, "ready"),
          isNull(editDeliverables.deletedAt),
          gt(editDeliverables.expiresAt, new Date())
        )
      )
  )
  if (!row) return null
  // A video plays from Storage's own origin; anything else only downloads. Open to the
  // person's own checked file; the card that names a clip is theirs too
  const playable = row.kind === "preview" || row.kind === "clip"
  return store.signedUrl(
    row.path,
    LINK_SECONDS,
    playable ? undefined : `kriya-edit-${row.kind}`
  )
}

const OBJECT = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/

/**
 * Retention: expired previews go, and so does any object with no live row, as
 * after an account's deletion (rows cascade, objects don't; EH-26). Runs
 * whatever the switches say, as profileJanitor does.
 */
export async function previewJanitor() {
  const store = previewStore()
  if (!store) return { expired: 0, swept: 0 }
  const due = await privileged
    .select({
      id: editDeliverables.id,
      userId: editDeliverables.userId,
      path: editDeliverables.storagePath,
    })
    .from(editDeliverables)
    .where(
      and(isNull(editDeliverables.deletedAt), lt(editDeliverables.expiresAt, new Date()))
    )
    .limit(200)
  for (const row of due) {
    await store.remove([row.path])
    await privileged
      .update(editDeliverables)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(editDeliverables.id, row.id), eq(editDeliverables.userId, row.userId))
      )
  }
  // Names come from Supabase's storage.objects; deletes through the storage API
  const names = rowsOf<{ name: string }>(
    await privileged.execute(
      sql`select name from storage.objects where bucket_id = ${PREVIEW_BUCKET} limit 1000`
    )
  ).map((r) => r.name)
  const ids = names.flatMap((name) => OBJECT.exec(name)?.[3] ?? [])
  const live = ids.length
    ? await privileged
        .select({ path: editDeliverables.storagePath })
        .from(editDeliverables)
        .where(and(inArray(editDeliverables.id, ids), isNull(editDeliverables.deletedAt)))
    : []
  const kept = new Set(live.map((row) => row.path))
  const orphans = names.filter((name) => !kept.has(name))
  await store.remove(orphans)
  return { expired: due.length, swept: orphans.length }
}

/** The device says its upload finished; false when it isn't this computer's. */
export async function markUploaded(
  device: { id: string; deviceId: string },
  jobId: string,
  id: string
) {
  const own = privileged
    .select({ id: editJobs.id })
    .from(editJobs)
    .where(
      and(
        eq(editJobs.id, jobId),
        eq(editJobs.userId, device.id),
        eq(editJobs.deviceId, device.deviceId)
      )
    )
  const marked = await privileged
    .update(editDeliverables)
    .set({ uploadedAt: new Date() })
    .where(
      and(
        eq(editDeliverables.id, id),
        eq(editDeliverables.userId, device.id),
        eq(editDeliverables.jobId, jobId),
        eq(editDeliverables.status, "pending"),
        isNull(editDeliverables.deletedAt),
        inArray(editDeliverables.jobId, own)
      )
    )
    .returning({ id: editDeliverables.id })
  return marked.length > 0
}
