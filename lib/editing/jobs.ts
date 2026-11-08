import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm"
import { z } from "zod"

import { privileged } from "@/db"
import {
  editDeliverables,
  editJobs,
  harnessDispatches as dispatches,
  messages,
  threads,
  type EditJob,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { verifyPreviews } from "@/lib/editing/previews"
import { settleReview } from "@/lib/editing/review"
import { log } from "@/lib/log"

// One pass of the worker's editLoop (TAVI_INTEGRATION §4). A job's status moves
// only here, from the dispatch its computer reported on: no session and no model
// can set one. A finished job leaves one assistant message in its thread, by a
// stable id, as lib/voice/thread-summary.ts does: no model call, no fake user
// message, no daily-limit hit (EH-16). What the computer reports is untrusted
// (TAVI §10), so only fields of a fixed shape are kept, and no words from it reach
// the thread or the agent.

const BATCH = 200
// Past this a lost job isn't looked at again; its row and report stay as they are
const LOST_FOR_GOOD_MS = 30 * 24 * 60 * 60_000
const TERMINAL = [
  "delivered",
  "delivered_with_notes",
  "blocked",
  "failed",
  "canceled",
  "expired",
] as const

const Progress = z.object({
  stage: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .optional(),
  percent: z.number().int().min(0).max(100).optional(),
  beat: z.number().int().min(0).max(2_000_000_000).optional(),
})
const Finished = z.object({
  outcome: z.enum(["delivered", "delivered_with_notes", "blocked"]),
  gates: z
    .array(
      z.strictObject({
        gate: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
        level: z.enum(["pass", "note", "fail", "skipped", "unchecked"]),
      })
    )
    .max(60)
    .default([]),
  notes: z.number().int().min(0).max(1000).default(0),
  // ED15: the person's notes this cut took and couldn't, and choices left to their default
  applied: z.number().int().min(0).max(100).optional(),
  skipped: z.number().int().min(0).max(100).optional(),
  defaulted: z.number().int().min(0).max(100).optional(),
})
const Failed = z.object({ code: z.string().regex(/^[a-z_]{1,32}$/) })

const WHY: Record<string, string> = {
  runtime_missing:
    "The Editing Studio isn't set up on that computer. Open it there once.",
  disk_low: "That computer is low on disk space.",
  source_offline: "The footage has moved or isn't reachable.",
  no_media: "There's no video in that folder.",
  model_unavailable: "Kriya's models weren't reachable from that computer.",
  cap_reached: "The Kriya Harness limit on your plan was reached.",
  not_allowed: "Editing from Kriya is off on that computer.",
  rights_blocked: "This edit was refused.",
  not_checked: "The cut couldn't be finished and checked.",
  bad_report: "That computer's report couldn't be read.",
}
const why = (code: unknown) =>
  (typeof code === "string" && WHY[code]) || "The edit couldn't finish."

const HEAD: Record<(typeof TERMINAL)[number] | "lost", string> = {
  delivered: "ready",
  delivered_with_notes: "ready, with notes",
  blocked: "blocked by a check",
  failed: "failed",
  canceled: "canceled",
  expired: "never started",
  lost: "lost touch",
}

/** The thread's card. Built only from the job's checked fields. */
export function cardText(job: EditJob, previewId: string | null, room = false) {
  const head = `**Your edit: ${HEAD[job.status as keyof typeof HEAD]}**`
  const watch = previewId
    ? room
      ? `[Watch and give notes](/edits/${job.id})`
      : `[Watch the preview](/api/editing/preview/${previewId})`
    : "No preview was stored here. The file is on your computer, in the project's exports folder."
  const verdict = (job.verdict ?? {}) as {
    notes?: number
    code?: string
    applied?: number
    skipped?: number
    defaulted?: number
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  // Facts of this cut, from code: what happened to the person's notes and choices
  const extras = [
    verdict.applied && `Took ${plural(verdict.applied, "note")}.`,
    verdict.skipped &&
      `Couldn't do ${plural(verdict.skipped, "note")}; it's still on the cut for you to look at.`,
    verdict.defaulted &&
      `${plural(verdict.defaulted, "choice")} went to the default, because nobody answered in time.`,
  ].filter(Boolean)
  switch (job.status) {
    case "delivered":
      return [
        head,
        "Checked on your computer: every check passed.",
        ...extras,
        watch,
      ].join("\n\n")
    case "delivered_with_notes":
      return [
        head,
        `Checked on your computer, with ${verdict.notes || "some"} note${verdict.notes === 1 ? "" : "s"} to look at.`,
        ...extras,
        watch,
      ].join("\n\n")
    case "blocked":
      return [
        head,
        "Your computer's checks found something that has to be fixed first. Open the project in the Editing Studio there to see it.",
      ].join("\n\n")
    case "failed":
      return [head, why(verdict.code)].join("\n\n")
    case "expired":
      return [head, "That computer didn't pick it up in time. Nothing ran."].join("\n\n")
    case "lost":
      return [
        head,
        "That computer has gone quiet. If it wakes up, the edit carries on from where it was.",
      ].join("\n\n")
    default:
      return head
  }
}

async function post(job: EditJob, id: string, text: string) {
  if (!job.threadId) return
  const threadId = job.threadId
  await privileged.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, job.userId)))
    if (!thread) return
    const posted = await tx
      .insert(messages)
      .values({
        threadId,
        id,
        userId: job.userId,
        role: "assistant",
        parts: [{ type: "text", text }],
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })
    if (posted.length === 0) return
    await tx
      .update(threads)
      .set({
        activeAt: new Date(),
        preview: text.split("\n")[0].replace(/\*/g, "").slice(0, 140),
      })
      .where(and(eq(threads.id, threadId), eq(threads.userId, job.userId)))
  })
}

// Guarded on the status it read, so a pass that lost a race changes nothing
async function move(
  job: EditJob,
  status: EditJob["status"],
  extra: Partial<EditJob> = {}
) {
  const [moved] = await privileged
    .update(editJobs)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(
      and(
        eq(editJobs.id, job.id),
        eq(editJobs.userId, job.userId),
        eq(editJobs.status, job.status)
      )
    )
    .returning()
  return moved ?? job
}

async function finish(job: EditJob, dispatch: string, result: unknown) {
  // A job the computer reported on before this pass saw it start, or woke from lost
  if (job.status === "queued" || job.status === "lost") job = await move(job, "running")
  const finishedAt = new Date()
  if (dispatch === "done") {
    const report = Finished.safeParse(result)
    if (report.success)
      return move(job, report.data.outcome, {
        verdict: report.data,
        finishedAt,
        percent: 100,
      })
    return move(job, "failed", { verdict: { code: "bad_report" }, finishedAt })
  }
  const failed = Failed.safeParse(result)
  return move(job, "failed", {
    verdict: { code: failed.success ? failed.data.code : "failed" },
    finishedAt,
  })
}

async function mirror(
  job: EditJob,
  dispatch: { status: string; result: unknown; expiresAt: Date } | undefined,
  lostMs: number
) {
  const status = dispatch?.status
  if (status === "queued") {
    // A computer that stopped polling never expires its own actions
    if (dispatch!.expiresAt.getTime() < Date.now())
      await privileged
        .update(dispatches)
        .set({ status: "expired", finishedAt: new Date() })
        .where(
          and(
            eq(dispatches.id, job.dispatchId!),
            eq(dispatches.userId, job.userId),
            eq(dispatches.status, "queued")
          )
        )
    return
  }
  if (status === "expired") {
    if (job.status === "queued") await move(job, "expired", { finishedAt: new Date() })
    return
  }
  if (status === "canceled") {
    await move(job, "canceled", { finishedAt: new Date() })
    return
  }
  if (status === "done" || status === "failed") {
    await finish(job, status, dispatch!.result)
    return
  }
  if (status === "claimed" || status === "running" || status === "canceling") {
    if (job.status === "queued") job = await move(job, "running")
    const progress = Progress.safeParse(dispatch!.result)
    const beat = progress.success ? (progress.data.beat ?? 0) : 0
    if (progress.success && beat !== job.beat) {
      if (job.status === "lost") job = await move(job, "running")
      await privileged
        .update(editJobs)
        .set({
          beat,
          stage: progress.data.stage ?? job.stage,
          percent: progress.data.percent ?? job.percent,
          updatedAt: new Date(),
        })
        .where(and(eq(editJobs.id, job.id), eq(editJobs.userId, job.userId)))
      return
    }
  }
  // Silence: a dispatch left running with no new word, or one that's gone
  if (job.status === "running" && Date.now() - job.updatedAt.getTime() > lostMs) {
    const lost = await move(job, "lost")
    if (lost.status === "lost")
      await post(lost, `edit-${job.id}-lost`, cardText(lost, null))
  }
}

async function notify(job: EditJob) {
  const deliverables = await privileged
    .select({
      id: editDeliverables.id,
      kind: editDeliverables.kind,
      status: editDeliverables.status,
      uploadedAt: editDeliverables.uploadedAt,
    })
    .from(editDeliverables)
    .where(
      and(
        eq(editDeliverables.jobId, job.id),
        eq(editDeliverables.userId, job.userId),
        isNull(editDeliverables.deletedAt)
      )
    )
    .orderBy(desc(editDeliverables.createdAt))
  // The card names the preview, so a check still under way holds it back a pass
  if (deliverables.some((d) => d.status === "pending" && d.uploadedAt)) return
  const preview = deliverables.find((d) => d.kind === "preview" && d.status === "ready")
  const room = (await getSetting("editing.review")) === "on"
  await post(job, `edit-${job.id}`, cardText(job, preview?.id ?? null, room))
  await privileged
    .update(editJobs)
    .set({ notifiedAt: new Date() })
    .where(and(eq(editJobs.id, job.id), eq(editJobs.userId, job.userId)))
}

/** One pass: previews checked, statuses mirrored, cards posted. One bad row stops only itself. */
export async function reviewEdits() {
  await verifyPreviews()
  const lostMs = Number(await getSetting("editing.jobLostMinutes")) * 60_000
  const rows = await privileged
    .select({ job: editJobs, dispatch: dispatches })
    .from(editJobs)
    .leftJoin(
      dispatches,
      and(eq(dispatches.id, editJobs.dispatchId), eq(dispatches.userId, editJobs.userId))
    )
    .where(
      and(
        inArray(editJobs.status, ["queued", "running", "lost"]),
        // A computer that never comes back mustn't crowd out everyone's live jobs
        or(
          ne(editJobs.status, "lost"),
          gt(editJobs.updatedAt, new Date(Date.now() - LOST_FOR_GOOD_MS))
        )
      )
    )
    .orderBy(editJobs.updatedAt)
    .limit(BATCH)
  for (const { job, dispatch } of rows) {
    try {
      await mirror(job, dispatch ?? undefined, lostMs)
    } catch (error) {
      log.error("edit job pass failed", { error })
    }
  }
  // After the statuses above, so a revision that just ended settles its notes this pass
  await settleReview()
  const finished = await privileged
    .select()
    .from(editJobs)
    .where(and(isNull(editJobs.notifiedAt), inArray(editJobs.status, [...TERMINAL])))
    .limit(BATCH)
  for (const job of finished) {
    try {
      await notify(job)
    } catch (error) {
      log.error("edit job card failed", { error })
    }
  }
}
