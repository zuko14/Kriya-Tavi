import { createHash, createHmac, randomBytes } from "node:crypto"

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import {
  charges,
  episodes,
  files,
  mandates,
  profiles,
  shareLinks,
  shareViews,
  type FileRow,
} from "@/db/schema"
import { renderReceipt, renderTemplate } from "@/lib/documents/templates"
import { savePdf } from "@/lib/documents/render"
import { DOWNLOAD_SECONDS, fileStore, objectPath } from "@/lib/files"
import { loadEvidence, reportData, verdict } from "@/lib/operator/verdict"

// Kriya Share (K8, AD-34): the person shares a snapshot (a PDF made at that
// moment) for 1–30 days. The link's token is 32 random bytes shown once;
// only its sha256 is stored. Opening a link reads that one row and its
// file, nothing live. No agent tool reaches this module (AT-SHR-04).

export const SHARE_DAYS = { min: 1, max: 30, default: 7 }
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex")

const TOKEN = /^[A-Za-z0-9_-]{43}$/

const LISTED = {
  id: shareLinks.id,
  kind: shareLinks.kind,
  title: shareLinks.title,
  expiresAt: shareLinks.expiresAt,
  revokedAt: shareLinks.revokedAt,
  views: shareLinks.views,
  createdAt: shareLinks.createdAt,
}

// The receipt PDF (K1) of one of the person's records, saved as their
// generated file; null when the record isn't theirs or was deleted
export async function receiptPdf(userId: string, episodeId: string) {
  const [episode] = await withUser(userId, (tx) =>
    tx
      .select({
        id: episodes.id,
        seq: episodes.seq,
        hash: episodes.hash,
        createdAt: episodes.createdAt,
        done: episodes.done,
        unconfirmed: episodes.unconfirmed,
        chargeMicroInr: charges.chargeMicroInr,
        chargeStatus: charges.status,
      })
      .from(episodes)
      .leftJoin(charges, eq(charges.taskId, episodes.taskId))
      .where(and(eq(episodes.id, episodeId), isNull(episodes.deletedAt)))
  )
  if (!episode?.hash) return null
  const { title, html } = renderReceipt({
    ...episode,
    hash: episode.hash,
    done: episode.done.map((d) => ({
      title: d.title,
      evidence: d.verification.evidence,
    })),
  })
  const file = await savePdf(userId, { html, name: `kriya-receipt-${episode.seq}` })
  return { file, title, episodeId: episode.id }
}

// A job's handover report (track O, O5) as the person's PDF, with the
// verdict as of now, read as the person. Null for another person's job, a
// proposal, a declined one, or (completedOnly, for sharing) one not done.
export async function jobReportPdf(
  userId: string,
  mandateId: string,
  { completedOnly = false } = {}
) {
  const made = await withUser(userId, async (tx) => {
    const [job] = await tx.select().from(mandates).where(eq(mandates.id, mandateId))
    if (!job || job.status === "proposed" || job.status === "declined") return null
    if (completedOnly && job.status !== "completed") return null
    const results = verdict(
      job.criteria,
      job.subjects,
      await loadEvidence(tx, userId, job)
    )
    return { job, data: reportData(job, results) }
  })
  if (!made) return null
  const { title, html } = renderTemplate("report", made.data)
  const file = await savePdf(userId, { html, name: `kriya-job-${made.job.id}` })
  return { file, title, mandateId: made.job.id }
}

// Receipts and completed jobs' reports; goal snapshots and ledger exports
// come with their templates
export async function createShare(
  userId: string,
  input: { kind: "receipt" | "report"; ref: string; days: number }
) {
  const made =
    input.kind === "report"
      ? await jobReportPdf(userId, input.ref, { completedOnly: true })
      : await receiptPdf(userId, input.ref)
  if (!made)
    return {
      error:
        input.kind === "report"
          ? "Only a finished job's report can be shared."
          : "That record wasn't found.",
    }
  const { file: snapshot, title } = made
  const ref = "episodeId" in made ? made.episodeId : made.mandateId
  const token = randomBytes(32).toString("base64url")
  try {
    const [row] = await withUser(userId, (tx) =>
      tx
        .insert(shareLinks)
        .values({
          userId,
          tokenHash: tokenHash(token),
          kind: input.kind,
          ref,
          title,
          snapshotFileId: snapshot.id,
          expiresAt: new Date(Date.now() + input.days * 86_400_000),
        })
        .returning(LISTED)
    )
    return { share: row, path: `/share/${token}` }
  } catch (error) {
    await removeFiles([snapshot])
    if (/share limit/.test(`${error} ${(error as { cause?: unknown })?.cause}`)) {
      return {
        error: "You have as many live links as your plan allows. Revoke one first.",
      }
    }
    throw error
  }
}

export async function revokeShare(userId: string, id: string) {
  const rows = await withUser(userId, (tx) =>
    tx
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id })
  )
  return rows.length > 0
}

export async function listShares(userId: string) {
  return withUser(userId, (tx) =>
    tx.select(LISTED).from(shareLinks).orderBy(desc(shareLinks.createdAt)).limit(50)
  )
}

/* ───────────────────────── the public side ──────────────────────── */

// A live link by its token, else null: expired, revoked and unknown links
// look the same (AT-SHR-01). Privileged, scoped to that one row.
export async function openShare(token: string) {
  if (!TOKEN.test(token)) return null
  const [row] = await privileged
    .select({
      id: shareLinks.id,
      userId: shareLinks.userId,
      title: shareLinks.title,
      kind: shareLinks.kind,
      createdAt: shareLinks.createdAt,
      expiresAt: shareLinks.expiresAt,
      snapshotFileId: shareLinks.snapshotFileId,
      sharedBy: profiles.displayName,
    })
    .from(shareLinks)
    .leftJoin(profiles, eq(profiles.id, shareLinks.userId))
    .where(
      and(
        eq(shareLinks.tokenHash, tokenHash(token)),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, new Date())
      )
    )
  return row ?? null
}

export type OpenShare = NonNullable<Awaited<ReturnType<typeof openShare>>>

// The address is kept only as an HMAC under a server key; without the key,
// not at all
export function ipHash(ip: string) {
  const key = process.env.KRIYA_TOKEN_KEY?.trim()
  if (!key || !ip) return null
  return createHmac("sha256", `share-views:${key}`).update(ip).digest("hex").slice(0, 32)
}

export async function recordView(share: OpenShare, ip: string) {
  await privileged.transaction(async (tx) => {
    await tx
      .insert(shareViews)
      .values({ shareId: share.id, userId: share.userId, ipHash: ipHash(ip) })
    await tx
      .update(shareLinks)
      .set({ views: sql`${shareLinks.views} + 1` })
      .where(and(eq(shareLinks.id, share.id), eq(shareLinks.userId, share.userId)))
  })
}

// A fresh 60 s link to the snapshot, for a live share only
export async function snapshotUrl(share: OpenShare) {
  const store = fileStore()
  if (!store) return null
  const [file] = await privileged
    .select()
    .from(files)
    .where(and(eq(files.id, share.snapshotFileId), eq(files.userId, share.userId)))
  return file ? store.signedUrl(objectPath(file), DOWNLOAD_SECONDS, file.name) : null
}

/* ──────────────────────────── retention ─────────────────────────── */

async function removeFiles(rows: Pick<FileRow, "id" | "userId">[]) {
  if (rows.length === 0) return 0
  await fileStore()?.remove(rows.map(objectPath))
  await privileged.delete(files).where(
    inArray(
      files.id,
      rows.map((r) => r.id)
    )
  )
  return rows.length
}

// Janitor (DATA_MODEL §5): snapshots 7 days after their share ended (the
// share and its views go with them), and screenshots past their retention.
// Storage objects first, then rows; in batches.
export async function purgeExpired(batch = 100) {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000)
  const ended = await privileged
    .select({ id: files.id, userId: files.userId })
    .from(files)
    .innerJoin(shareLinks, eq(shareLinks.snapshotFileId, files.id))
    .where(or(lt(shareLinks.revokedAt, weekAgo), lt(shareLinks.expiresAt, weekAgo)))
    .limit(batch)
  const screenshots = await privileged
    .select({ id: files.id, userId: files.userId })
    .from(files)
    .where(and(eq(files.origin, "screenshot"), lt(files.retentionUntil, new Date())))
    .limit(batch)
  return (await removeFiles(ended)) + (await removeFiles(screenshots))
}
