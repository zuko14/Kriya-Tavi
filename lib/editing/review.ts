import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"

import { privileged } from "@/db"
import {
  editJobs,
  editNotes,
  editQuestions,
  harnessDeviceState as state,
} from "@/db/schema"
import { DaemonProject } from "@/lib/harness/contract"

// The device's half of decision cards, notes and watch folders (TAVI_INTEGRATION §5,
// §6, §8). Privileged after authenticateDevice, always scoped by the device's person
// and the device itself. Nothing here answers a question or adds a note: those are the
// person's alone, and live in actions/editing.ts (track E rule 13).

type Device = { id: string; deviceId: string }

const POLL_MS = 1_000
const FOUND_DAYS = 7
// New-recording cards waiting on one computer: a noisy folder can't fill the Inbox
const FOUND_OPEN_MAX = 20

const ownJob = (device: Device, jobId: string) =>
  and(
    eq(editJobs.id, jobId),
    eq(editJobs.userId, device.id),
    eq(editJobs.deviceId, device.deviceId)
  )

/** Only while the job is open; null when it isn't this computer's. */
export async function askQuestion(
  device: Device,
  jobId: string,
  body: {
    kind: "take" | "hook" | "file" | "name" | "taste" | "order"
    prompt: string
    options: { label: string; clip?: string }[]
    defaultOption: number
    timeoutSeconds: number
  }
) {
  const [job] = await privileged
    .select({ status: editJobs.status })
    .from(editJobs)
    .where(ownJob(device, jobId))
  if (!job || !["queued", "running", "lost"].includes(job.status)) return null
  const [row] = await privileged
    .insert(editQuestions)
    .values({
      userId: device.id,
      deviceId: device.deviceId,
      jobId,
      kind: body.kind,
      prompt: body.prompt,
      options: body.options,
      defaultOption: body.defaultOption,
      expiresAt: sql`now() + make_interval(secs => ${body.timeoutSeconds})`,
    })
    .returning({ id: editQuestions.id, expiresAt: editQuestions.expiresAt })
  return { id: row.id, expiresAt: row.expiresAt.toISOString() }
}

const mine = (device: Device, id: string) =>
  and(
    eq(editQuestions.id, id),
    eq(editQuestions.userId, device.id),
    eq(editQuestions.deviceId, device.deviceId)
  )

const Answer = z.object({ option: z.number().int().min(0).max(9) })

type Reply = { status: "open" | "answered" | "defaulted" | "expired"; option?: number }

async function readAnswer(device: Device, id: string): Promise<Reply | null> {
  const [row] = await privileged
    .select({
      status: editQuestions.status,
      answer: editQuestions.answer,
      defaultOption: editQuestions.defaultOption,
      over: sql<boolean>`${editQuestions.expiresAt} <= now()`,
    })
    .from(editQuestions)
    .where(mine(device, id))
  if (!row) return null
  if (row.status === "open" && row.over) {
    const option = row.defaultOption ?? 0
    const [moved] = await privileged
      .update(editQuestions)
      .set({ status: "defaulted", answer: { option } })
      .where(and(mine(device, id), eq(editQuestions.status, "open")))
      .returning({ id: editQuestions.id })
    // Answered in the meantime: that answer stands
    return moved ? { status: "defaulted" as const, option } : readAnswer(device, id)
  }
  const option = Answer.safeParse(row.answer).data?.option
  return { status: row.status, ...(option !== undefined && { option }) }
}

/** The answer, waiting up to `seconds` as an approval's long poll does. */
export async function waitForEditAnswer(
  device: Device,
  id: string,
  seconds: number,
  signal: AbortSignal
) {
  const deadline = Date.now() + seconds * 1_000
  for (;;) {
    const answer = await readAnswer(device, id)
    const left = deadline - Date.now()
    if (!answer || answer.status !== "open" || left <= 0 || signal.aborted) return answer
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)))
  }
}

/** The notes sent in this revision, in the person's own words; null when it isn't this computer's. */
export async function notesForJob(device: Device, jobId: string) {
  const [job] = await privileged
    .select({ id: editJobs.id })
    .from(editJobs)
    .where(ownJob(device, jobId))
  if (!job) return null
  return privileged
    .select({ id: editNotes.id, atFlicks: editNotes.atFlicks, body: editNotes.body })
    .from(editNotes)
    .where(
      and(
        eq(editNotes.sentIn, jobId),
        eq(editNotes.userId, device.id),
        eq(editNotes.status, "sent")
      )
    )
    .orderBy(editNotes.atFlicks)
}

/**
 * A new recording in a folder this computer watches: its name and duration only (ES-21).
 * Nothing runs until the person taps. "no_project" when the computer doesn't offer that
 * folder, "full" past the limit of open cards.
 */
export async function foundRecording(
  device: Device,
  body: { project: string; name: string; seconds: number }
) {
  const [info] = await privileged
    .select({ projects: state.projects })
    .from(state)
    .where(and(eq(state.deviceId, device.deviceId), eq(state.userId, device.id)))
  const offered = (info?.projects ?? []).some(
    (p) => DaemonProject.safeParse(p).data?.id === body.project
  )
  if (!offered) return "no_project" as const
  // Under a per-computer lock, so parallel reports can't pass the limit together
  return privileged.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`edit_found:${device.deviceId}`}))`
    )
    const [{ open }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(editQuestions)
      .where(
        and(
          eq(editQuestions.deviceId, device.deviceId),
          eq(editQuestions.kind, "found"),
          eq(editQuestions.status, "open"),
          sql`${editQuestions.expiresAt} > now()`
        )
      )
    if (open >= FOUND_OPEN_MAX) return "full" as const
    const [row] = await tx
      .insert(editQuestions)
      .values({
        userId: device.id,
        deviceId: device.deviceId,
        kind: "found",
        prompt: "New recording",
        options: { project: body.project, name: body.name, seconds: body.seconds },
        expiresAt: sql`now() + make_interval(days => ${FOUND_DAYS})`,
      })
      .returning({ id: editQuestions.id })
    return { id: row.id }
  })
}

/** Worker: questions nobody answered take their default; old cards leave; notes settle. */
export async function settleReview() {
  await privileged.execute(sql`
    update kriya.edit_questions set status = 'expired'
    where status = 'open' and kind = 'found' and expires_at <= now()`)
  await privileged.execute(sql`
    update kriya.edit_questions
    set status = 'defaulted', answer = jsonb_build_object('option', coalesce(default_option, 0))
    where status = 'open' and kind <> 'found' and expires_at <= now()`)
  // A cut came back: its notes are done. It didn't: they're the person's to send again
  await privileged.execute(sql`
    update kriya.edit_notes n set status = 'done'
    from kriya.edit_jobs j
    where n.sent_in = j.id and n.user_id = j.user_id and n.status = 'sent'
      and j.status in ('delivered', 'delivered_with_notes', 'blocked')`)
  await privileged.execute(sql`
    update kriya.edit_notes n set status = 'open', sent_in = null
    from kriya.edit_jobs j
    where n.sent_in = j.id and n.user_id = j.user_id and n.status = 'sent'
      and j.status in ('failed', 'canceled', 'expired')`)
}
