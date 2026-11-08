"use server"

import { randomUUID } from "node:crypto"

import { and, eq, isNull, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { privileged, withUser } from "@/db"
import { editDeliverables, editJobs, editNotes, editQuestions } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { previewStore } from "@/lib/editing/previews"
import { cancel, ControlError, queueEdit } from "@/lib/harness/control"
import { allow } from "@/lib/rate-limit"

// The person's own acts on an edit (TOOLS_AND_CONTRACTS §8): session, zod, withUser. No
// agent tool can reach these (track E rule 13, ET-POL-01). Starting a revision here
// needs no tool approval: the person is the one asking.

const OFF = { error: "That isn't available right now." }
const NOT_THERE = { error: "That edit isn't there." }
const NOTES_PER_JOB = 50
const MAX_FLICKS = 705_600_000 * 86_400

const on = async (key: "editing.tavi" | "editing.review" | "editing.watchFolders") =>
  (await getSetting(key)) === "on"

const refresh = (id?: string) => {
  revalidatePath("/edits")
  revalidatePath("/inbox")
  if (id) revalidatePath(`/edits/${id}`)
}

async function guarded<T>(work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ControlError) return { error: error.message }
    throw error
  }
}

/** Stops a job through the existing cancel; the computer reports the end itself. */
export async function cancelEdit(jobId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(jobId)
  if (!id.success || !(await on("editing.tavi"))) return OFF
  const [job] = await withUser(user.id, (tx) =>
    tx
      .select({ dispatchId: editJobs.dispatchId })
      .from(editJobs)
      .where(eq(editJobs.id, id.data))
  )
  if (!job?.dispatchId) return NOT_THERE
  return guarded(async () => {
    await cancel(user.id, job.dispatchId!)
    refresh(id.data)
    return { ok: true as const }
  })
}

/** A decision card's answer: only a session can write one (ET-RV-02). */
export async function answerEditQuestion(questionId: string, option: number) {
  const user = await requireUser()
  const input = z
    .object({ id: z.uuid(), option: z.number().int().min(0).max(9) })
    .safeParse({ id: questionId, option })
  if (!input.success || !(await on("editing.review"))) return OFF
  return withUser(user.id, async (tx) => {
    const [question] = await tx
      .select({ kind: editQuestions.kind, options: editQuestions.options })
      .from(editQuestions)
      .where(eq(editQuestions.id, input.data.id))
    if (!question || question.kind === "found") return NOT_THERE
    if (!Array.isArray(question.options) || input.data.option >= question.options.length)
      return { error: "That isn't one of the choices." }
    const answered = await tx
      .update(editQuestions)
      .set({
        status: "answered",
        answer: { option: input.data.option },
        answeredAt: new Date(),
      })
      .where(
        and(
          eq(editQuestions.id, input.data.id),
          eq(editQuestions.status, "open"),
          sql`${editQuestions.expiresAt} > now()`
        )
      )
      .returning({ id: editQuestions.id })
    if (answered.length === 0) return { error: "That question has already closed." }
    refresh()
    return { ok: true as const }
  })
}

const NoteInput = z.object({
  jobId: z.uuid(),
  atFlicks: z.number().int().min(0).max(MAX_FLICKS),
  body: z.string().trim().min(1, "Write the note first.").max(1000),
})

/** A note pinned to a moment in the cut. */
export async function addEditNote(input: {
  jobId: string
  atFlicks: number
  body: string
}) {
  const user = await requireUser()
  const parsed = NoteInput.safeParse(input)
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "That note isn't complete." }
  if (!(await on("editing.review"))) return OFF
  const { jobId, atFlicks, body } = parsed.data
  return withUser(user.id, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(editNotes)
      .where(eq(editNotes.jobId, jobId))
    if (count >= NOTES_PER_JOB)
      return { error: "That's as many notes as one cut can hold." }
    const [job] = await tx
      .select({ id: editJobs.id })
      .from(editJobs)
      .where(eq(editJobs.id, jobId))
    if (!job) return NOT_THERE
    // Exactly the columns the person may set (the column grant)
    await tx.execute(sql`
      insert into kriya.edit_notes (user_id, job_id, at_flicks, body)
      values (${user.id}, ${jobId}, ${atFlicks}, ${body})`)
    refresh(jobId)
    return { ok: true as const }
  })
}

export async function removeEditNote(noteId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(noteId)
  if (!id.success || !(await on("editing.review"))) return OFF
  return withUser(user.id, async (tx) => {
    const [gone] = await tx
      .update(editNotes)
      .set({ status: "removed" })
      .where(and(eq(editNotes.id, id.data), eq(editNotes.status, "open")))
      .returning({ jobId: editNotes.jobId })
    if (!gone) return { error: "That note has already gone to your computer." }
    refresh(gone.jobId)
    return { ok: true as const }
  })
}

/**
 * Starts one revision from the open notes. The notes move to it in the same transaction,
 * so a double tap finds none left and starts nothing (ET-RV-04).
 */
export async function sendEditNotes(jobId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(jobId)
  if (!id.success || !(await on("editing.review"))) return OFF
  if (!(await allow(`editing:send:${user.id}`, 10, 60)))
    return { error: "Too many at once. Wait a minute and try again." }
  const [parent] = await withUser(user.id, (tx) =>
    tx.select().from(editJobs).where(eq(editJobs.id, id.data))
  )
  if (!parent) return NOT_THERE
  if (["queued", "running", "lost"].includes(parent.status))
    return { error: "This cut is still being made. Send your notes when it's done." }
  const next = randomUUID()
  return guarded(async () => {
    await queueEdit(
      user.id,
      parent.deviceId,
      {
        project: parent.project,
        job: next,
        brief: parent.brief,
        effort: "best",
        revisionOf: parent.id,
        ...(parent.recipe && { recipe: parent.recipe }),
      },
      {
        threadId: parent.threadId,
        revisionOf: parent.id,
        also: async (tx) => {
          const sent = await tx
            .update(editNotes)
            .set({ status: "sent", sentIn: next })
            .where(and(eq(editNotes.jobId, parent.id), eq(editNotes.status, "open")))
            .returning({ id: editNotes.id })
          if (sent.length === 0)
            throw new ControlError("no_notes", "There are no notes to send.")
        },
      }
    )
    refresh(parent.id)
    return { ok: true as const, id: next }
  })
}

/** "Looks good": closes the job. The one thing a person changes on a job row. */
export async function acceptEdit(jobId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(jobId)
  if (!id.success || !(await on("editing.review"))) return OFF
  const [done] = await withUser(user.id, (tx) =>
    tx
      .update(editJobs)
      .set({ acceptedAt: new Date() })
      .where(and(eq(editJobs.id, id.data), isNull(editJobs.acceptedAt)))
      .returning({ id: editJobs.id })
  )
  if (!done) return NOT_THERE
  refresh(id.data)
  return { ok: true as const }
}

const FoundOptions = z.object({
  project: z.string(),
  name: z.string(),
  seconds: z.number(),
})

/** One tap on a new-recording card: nothing ran until now (ES-21). A double tap starts one. */
export async function startFromFound(questionId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(questionId)
  if (!id.success || !(await on("editing.watchFolders"))) return OFF
  const [question] = await withUser(user.id, (tx) =>
    tx
      .select()
      .from(editQuestions)
      .where(and(eq(editQuestions.id, id.data), eq(editQuestions.kind, "found")))
  )
  const options = FoundOptions.safeParse(question?.options)
  if (!question || !options.success) return NOT_THERE
  const job = randomUUID()
  return guarded(async () => {
    await queueEdit(
      user.id,
      question.deviceId,
      {
        project: options.data.project,
        job,
        brief: `Make a reel from ${options.data.name}`.slice(0, 4000),
        effort: "best",
      },
      {
        threadId: null,
        also: async (tx) => {
          const taken = await tx
            .update(editQuestions)
            .set({ status: "answered", answer: { start: true }, answeredAt: new Date() })
            .where(and(eq(editQuestions.id, id.data), eq(editQuestions.status, "open")))
            .returning({ id: editQuestions.id })
          if (taken.length === 0)
            throw new ControlError(
              "answered",
              "That recording has already been answered."
            )
        },
      }
    )
    refresh(job)
    return { ok: true as const, id: job }
  })
}

export async function dismissFound(questionId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(questionId)
  if (!id.success || !(await on("editing.watchFolders"))) return OFF
  await withUser(user.id, (tx) =>
    tx
      .update(editQuestions)
      .set({ status: "answered", answer: { start: false }, answeredAt: new Date() })
      .where(
        and(
          eq(editQuestions.id, id.data),
          eq(editQuestions.kind, "found"),
          eq(editQuestions.status, "open")
        )
      )
  )
  refresh()
  return { ok: true as const }
}

/** Removes a preview from Kriya now. Found as the person; the row is then written with its owner's id. */
export async function deleteEditPreview(deliverableId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(deliverableId)
  if (!id.success || !(await on("editing.tavi"))) return OFF
  const [row] = await withUser(user.id, (tx) =>
    tx
      .select({
        id: editDeliverables.id,
        jobId: editDeliverables.jobId,
        path: editDeliverables.storagePath,
      })
      .from(editDeliverables)
      .where(and(eq(editDeliverables.id, id.data), isNull(editDeliverables.deletedAt)))
  )
  if (!row) return NOT_THERE
  await previewStore()?.remove([row.path])
  await privileged
    .update(editDeliverables)
    .set({ deletedAt: new Date() })
    .where(and(eq(editDeliverables.id, row.id), eq(editDeliverables.userId, user.id)))
  refresh(row.jobId)
  return { ok: true as const }
}
