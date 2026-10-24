import { createHash } from "node:crypto"

import { createClient } from "@supabase/supabase-js"
import { and, desc, eq, ilike, inArray } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { files, FILE_MIMES, type FileMime, type FileRow } from "@/db/schema"

// Files (A5, AD-19): bytes in the private bucket `kriya-files` at
// <user id>/<file id>, metadata in kriya.files. An upload is untrusted:
// its declared type must match its bytes, and nothing in it ever runs.
// No next/* imports, so the worker uses this too.

export const BUCKET = "kriya-files"
export const DOWNLOAD_SECONDS = 60
export const objectPath = (file: { userId: string; id: string }) =>
  `${file.userId}/${file.id}`

// Where the bytes live. Supabase Storage in production; tests pass their own.
export interface FileStore {
  uploadUrl(path: string): Promise<string>
  // null when the object isn't there (or can't be read right now)
  read(path: string): Promise<Buffer | null>
  // The stored object's size without downloading it; null when unknown
  size?(path: string): Promise<number | null>
  write(path: string, bytes: Buffer, mime: string): Promise<void>
  signedUrl(path: string, seconds: number, downloadName: string): Promise<string>
  remove(paths: string[]): Promise<void>
}

let testStore: FileStore | null | undefined
export function setFileStoreForTests(store: FileStore | null | undefined) {
  testStore = store
}

// The service key never leaves the server (invariant 4); null when unset
export function fileStore(): FileStore | null {
  if (testStore !== undefined) return testStore
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !key) return null
  const bucket = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage.from(BUCKET)
  return {
    async uploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path)
      if (error) throw new Error("storage: couldn't create an upload link")
      return data.signedUrl
    },
    async read(path) {
      const { data, error } = await bucket.download(path)
      return error || !data ? null : Buffer.from(await data.arrayBuffer())
    },
    async size(path) {
      const { data, error } = await bucket.info(path)
      return error || typeof data?.size !== "number" ? null : data.size
    },
    async write(path, bytes, mime) {
      const { error } = await bucket.upload(path, bytes, {
        contentType: mime,
        upsert: false,
      })
      if (error) throw new Error("storage: upload failed")
    },
    async signedUrl(path, seconds, downloadName) {
      const { data, error } = await bucket.createSignedUrl(path, seconds, {
        download: downloadName,
      })
      if (error) throw new Error("storage: couldn't sign a download")
      return data.signedUrl
    },
    async remove(paths) {
      if (paths.length === 0) return
      const { error } = await bucket.remove(paths)
      if (error) throw new Error("storage: delete failed")
    },
  }
}

/* ───────────────────────────── checks ───────────────────────────── */

export const isFileMime = (mime: string): mime is FileMime =>
  (FILE_MIMES as readonly string[]).includes(mime)

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Path parts, control characters and leading dots go; 255 at most
export function safeName(name: string) {
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 255)
  return cleaned || "file"
}

const has = (bytes: Buffer, signature: number[], at = 0) =>
  signature.every((value, i) => bytes[at + i] === value)

const EXECUTABLES: number[][] = [
  [0x4d, 0x5a], // MZ: Windows
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat, Java class
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32
  [0x23, 0x21], // #! script
]

// Markup or a second file hidden in a binary format, and active PDF
// content: the classic polyglot tricks (SECURITY S9). Each pattern ends in
// a delimiter, so compressed image or font bytes almost never match by
// chance. ponytail: keys inside compressed PDF object streams aren't seen;
// inflate and scan them if PDFs ever open anywhere but as data.
const HIDDEN = /<(script|html|svg|iframe)[\s>/]|<\?php|<!doctype html/i
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)[\s(<[/]/

function detect(bytes: Buffer): FileMime | "text" | null {
  if (has(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (has(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (has(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (has(bytes, [0x52, 0x49, 0x46, 0x46]) && has(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp"
  if (has(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const head = bytes.toString("latin1")
    return head.includes("[Content_Types].xml") && head.includes("word/document.xml")
      ? DOCX
      : null
  }
  // Text: valid UTF-8, no NUL or other control bytes than tab, newlines, form feed
  if (bytes.includes(0)) return null
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (text.includes("�") || /[\u0001-\u0008\u000b\u000e-\u001f\u007f]/.test(text))
    return null
  return "text"
}

export function sniff(
  bytes: Buffer,
  declared: string
): { ok: true; mime: FileMime } | { ok: false; reason: string } {
  if (!isFileMime(declared))
    return { ok: false, reason: "That type of file isn't accepted." }
  if (EXECUTABLES.some((signature) => has(bytes, signature))) {
    return { ok: false, reason: "Programs and scripts can't be uploaded." }
  }
  const found = detect(bytes)
  const text = declared === "text/plain" || declared === "text/csv"
  if (text ? found !== "text" : found !== declared) {
    return { ok: false, reason: "The file's contents don't match its type." }
  }
  if (!text) {
    const body = bytes.toString("latin1")
    if (
      HIDDEN.test(body) ||
      (declared !== "application/pdf" && body.includes("%PDF-")) ||
      (declared !== DOCX && body.includes("PK\u0003\u0004"))
    ) {
      return { ok: false, reason: "The file hides other content inside it." }
    }
    if (declared === "application/pdf" && PDF_ACTIVE.test(body)) {
      return { ok: false, reason: "PDFs with scripts or attachments aren't accepted." }
    }
  }
  return { ok: true, mime: declared }
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/* ───────────────────────────── uploads ──────────────────────────── */

const LIMIT_ERRORS: [RegExp, string][] = [
  [/larger than the plan/, "That file is larger than your plan allows."],
  [/storage used up/, "Your file storage is full. Delete something first."],
]

// Drizzle wraps the database error in `cause`
export const limitMessage = (error: unknown) => {
  const text = `${String(error)} ${String((error as { cause?: unknown })?.cause ?? "")}`
  return LIMIT_ERRORS.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

// Step 1: a pending row (plan limits checked in SQL) and a signed upload link
export async function createUpload(
  userId: string,
  input: { name: string; mime: string; size: number }
) {
  const store = fileStore()
  if (!store) return { error: "File storage isn't set up yet." }
  if (!isFileMime(input.mime)) return { error: "That type of file isn't accepted." }
  let row: FileRow
  try {
    ;[row] = await withUser(userId, (tx) =>
      tx
        .insert(files)
        .values({
          userId,
          name: safeName(input.name),
          mime: input.mime as FileMime,
          sizeBytes: input.size,
          origin: "upload",
        })
        .returning()
    )
  } catch (error) {
    const message = limitMessage(error)
    if (message) return { error: message }
    throw error
  }
  return { fileId: row.id, uploadUrl: await store.uploadUrl(objectPath(row)) }
}

// Step 2: the object must exist with the announced size and its bytes must
// be what the type says. Idempotent: a checked file answers with its status.
export async function confirmUpload(userId: string, fileId: string) {
  const store = fileStore()
  if (!store) return { error: "File storage isn't set up yet." }
  const [row] = await withUser(userId, (tx) =>
    tx.select().from(files).where(eq(files.id, fileId))
  )
  if (!row) return { error: "That file wasn't found." }
  if (row.status !== "pending") return { status: row.status }

  // The signed link has no size cap: a larger object is refused before it is
  // downloaded into the server's memory
  const stored = await store.size?.(objectPath(row))
  const wrongSize = stored != null && stored !== row.sizeBytes
  const bytes = wrongSize ? null : await store.read(objectPath(row))
  if (!wrongSize && !bytes) {
    return { error: "The upload hasn't arrived yet. Try again in a moment." }
  }
  const check =
    wrongSize || bytes!.length !== row.sizeBytes
      ? { ok: false as const, reason: "The upload's size doesn't match." }
      : sniff(bytes!, row.mime)
  const own = and(
    eq(files.id, row.id),
    eq(files.userId, userId),
    eq(files.status, "pending")
  )
  if (!check.ok) {
    await store.remove([objectPath(row)]).catch(() => {})
    await privileged
      .update(files)
      .set({ status: "rejected", extraction: { reason: check.reason } })
      .where(own)
    return { status: "rejected" as const, reason: check.reason }
  }
  await privileged
    .update(files)
    .set({ status: "ready", sha256: sha256(bytes!) })
    .where(own)
  return { status: "ready" as const }
}

// A PDF Kriya made, a screenshot or an attachment: written by the server
// and checked like an upload, then ready at once
export async function saveGenerated(
  userId: string,
  input: {
    name: string
    mime: FileMime
    bytes: Buffer
    origin: "generated" | "screenshot" | "email_attachment" | "drive"
    taskId?: string | null
    retentionUntil?: Date | null
  }
) {
  const store = fileStore()
  if (!store) throw new Error("File storage isn't set up yet.")
  const check = sniff(input.bytes, input.mime)
  if (!check.ok) throw new Error(check.reason)
  const [row] = await privileged
    .insert(files)
    .values({
      userId,
      name: safeName(input.name),
      mime: input.mime,
      sizeBytes: input.bytes.length,
      origin: input.origin,
      taskId: input.taskId ?? null,
      retentionUntil: input.retentionUntil ?? null,
    })
    .returning()
  try {
    await store.write(objectPath(row), input.bytes, input.mime)
  } catch (error) {
    await privileged.delete(files).where(eq(files.id, row.id))
    throw error
  }
  const [ready] = await privileged
    .update(files)
    .set({ status: "ready", sha256: sha256(input.bytes) })
    .where(and(eq(files.id, row.id), eq(files.userId, userId)))
    .returning()
  return ready
}

const LISTED = ["upload", "generated", "email_attachment", "drive"] as const

// Account → Files and file_list: what each file is and where it stands;
// never its text
export async function listFiles(
  userId: string,
  filter: { query?: string; origin?: (typeof LISTED)[number]; limit?: number } = {}
) {
  const name = filter.query && `%${filter.query.replace(/[\\%_]/g, "\\$&")}%`
  return withUser(userId, (tx) =>
    tx
      .select({
        id: files.id,
        name: files.name,
        mime: files.mime,
        sizeBytes: files.sizeBytes,
        origin: files.origin,
        status: files.status,
        createdAt: files.createdAt,
      })
      .from(files)
      .where(
        and(
          inArray(files.origin, filter.origin ? [filter.origin] : [...LISTED]),
          name ? ilike(files.name, name) : undefined
        )
      )
      .orderBy(desc(files.createdAt))
      .limit(filter.limit ?? 200)
  )
}

export type FileListItem = Awaited<ReturnType<typeof listFiles>>[number]

// file_read (TOOLS_AND_CONTRACTS §2.3): a window of a file's extracted text,
// read as the person, so another person's file simply isn't there. Only a
// page count is stored, not page breaks, so it pages by character offset.
export const READ_CHARS = 20_000

export async function readExtracted(userId: string, fileId: string, start = 0) {
  const [row] = await withUser(userId, (tx) =>
    tx
      .select({
        id: files.id,
        name: files.name,
        mime: files.mime,
        status: files.status,
        text: files.text,
        extraction: files.extraction,
      })
      .from(files)
      .where(eq(files.id, fileId))
  )
  if (!row) return { error: "No file of the person's has that id." }
  if (row.status !== "extracted")
    return {
      error:
        row.status === "failed" || row.status === "rejected"
          ? `Kriya couldn't read this file. ${row.extraction?.reason ?? ""}`.trim()
          : "Kriya hasn't read this file yet. Try again in a minute.",
    }
  const text = row.text ?? ""
  const end = start + READ_CHARS
  return {
    fileId: row.id,
    name: row.name,
    mime: row.mime,
    pages: row.extraction?.pages ?? null,
    start,
    total: text.length,
    text: text.slice(start, end),
    ...(end < text.length && { nextStart: end }),
  }
}

const READABLE = ["ready", "extracted", "failed"] as const

// A 60 s link for the person's own checked file
export async function downloadUrl(userId: string, fileId: string) {
  const store = fileStore()
  if (!store) return null
  const [row] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), inArray(files.status, [...READABLE])))
  )
  return row ? store.signedUrl(objectPath(row), DOWNLOAD_SECONDS, row.name) : null
}

// The object first, then the row; a share whose snapshot this was goes too
export async function deleteFile(userId: string, fileId: string) {
  const [row] = await withUser(userId, (tx) =>
    tx.select().from(files).where(eq(files.id, fileId))
  )
  if (!row) return false
  await fileStore()?.remove([objectPath(row)])
  await withUser(userId, (tx) => tx.delete(files).where(eq(files.id, row.id)))
  return true
}

// AT-BRW-10: the only bytes a browser upload can carry are the person's
// own checked file from kriya.files, read here by id, never from the model
export async function fileForBrowserUpload(userId: string, fileId: string) {
  const store = fileStore()
  if (!store) return null
  const [row] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), inArray(files.status, ["ready", "extracted"])))
  )
  if (!row) return null
  const bytes = await store.read(objectPath(row))
  if (!bytes || sha256(bytes) !== row.sha256) return null
  return { name: row.name, mime: row.mime, data: bytes.toString("base64") }
}
