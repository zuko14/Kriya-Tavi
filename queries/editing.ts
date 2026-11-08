import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm"

import { withUser } from "@/db"
import {
  editDeliverables,
  editJobs,
  editNotes,
  editQuestions,
  harnessDevices,
} from "@/db/schema"
import type { EditCard } from "@/queries/editing-types"

/** The person's latest edits from Tavi, each with its checked preview if any. */
export async function listEdits(userId: string, limit = 10) {
  return withUser(userId, async (tx) => {
    const jobs = await tx
      .select({
        id: editJobs.id,
        brief: editJobs.brief,
        status: editJobs.status,
        stage: editJobs.stage,
        percent: editJobs.percent,
        createdAt: editJobs.createdAt,
        device: harnessDevices.name,
      })
      .from(editJobs)
      .innerJoin(harnessDevices, eq(harnessDevices.id, editJobs.deviceId))
      .orderBy(desc(editJobs.createdAt))
      .limit(limit)
    const previews = jobs.length
      ? await tx
          .select({ id: editDeliverables.id, jobId: editDeliverables.jobId })
          .from(editDeliverables)
          .where(
            and(
              inArray(
                editDeliverables.jobId,
                jobs.map((j) => j.id)
              ),
              eq(editDeliverables.kind, "preview"),
              eq(editDeliverables.status, "ready"),
              isNull(editDeliverables.deletedAt)
            )
          )
      : []
    return jobs.map((job) => ({
      ...job,
      preview: previews.find((p) => p.jobId === job.id)?.id ?? null,
    }))
  })
}
export type EditRow = Awaited<ReturnType<typeof listEdits>>[number]

/** One job for the Review Room, as the person; null when it isn't theirs. */
export async function editRoom(userId: string, id: string) {
  return withUser(userId, async (tx) => {
    const [job] = await tx.select().from(editJobs).where(eq(editJobs.id, id))
    if (!job) return null
    // This cut and every cut of the same line: its parent chain and its revisions
    const family = await tx
      .select({
        id: editJobs.id,
        status: editJobs.status,
        revisionOf: editJobs.revisionOf,
        createdAt: editJobs.createdAt,
      })
      .from(editJobs)
      .where(and(eq(editJobs.deviceId, job.deviceId), eq(editJobs.project, job.project)))
      .orderBy(editJobs.createdAt)
    const line = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const row of family) {
        const linked =
          (row.revisionOf && line.has(row.revisionOf)) ||
          family.some((f) => line.has(f.id) && f.revisionOf === row.id)
        if (linked && !line.has(row.id)) {
          line.add(row.id)
          grew = true
        }
      }
    }
    const cuts = family.filter((row) => line.has(row.id))
    const previews = await tx
      .select({
        id: editDeliverables.id,
        jobId: editDeliverables.jobId,
        durationFlicks: editDeliverables.durationFlicks,
      })
      .from(editDeliverables)
      .where(
        and(
          inArray(
            editDeliverables.jobId,
            cuts.map((c) => c.id)
          ),
          eq(editDeliverables.kind, "preview"),
          eq(editDeliverables.status, "ready"),
          isNull(editDeliverables.deletedAt)
        )
      )
    const notes = await tx
      .select({
        id: editNotes.id,
        atFlicks: editNotes.atFlicks,
        body: editNotes.body,
        status: editNotes.status,
        sentIn: editNotes.sentIn,
      })
      .from(editNotes)
      .where(
        and(
          or(eq(editNotes.jobId, id), eq(editNotes.sentIn, id)),
          ne(editNotes.status, "removed")
        )
      )
      .orderBy(editNotes.atFlicks)
    return {
      job,
      notes: notes.map(({ sentIn, ...note }) => ({ ...note, inThisCut: sentIn === id })),
      cuts: cuts.map((cut, i) => ({
        id: cut.id,
        status: cut.status,
        label: `Cut ${String.fromCharCode(65 + (i % 26))}`,
        preview: previews.find((p) => p.jobId === cut.id) ?? null,
      })),
    }
  })
}
export type EditRoom = NonNullable<Awaited<ReturnType<typeof editRoom>>>

/** Cards waiting for the person: choices from a job, and new recordings. */
export async function editCards(
  userId: string,
  kinds: "all" | "choices" | "found"
): Promise<EditCard[]> {
  return withUser(userId, (tx) =>
    tx
      .select({
        id: editQuestions.id,
        kind: editQuestions.kind,
        prompt: editQuestions.prompt,
        jobId: editQuestions.jobId,
        expiresAt: editQuestions.expiresAt,
        options: editQuestions.options,
        defaultOption: editQuestions.defaultOption,
        deviceName: harnessDevices.name,
      })
      .from(editQuestions)
      .innerJoin(harnessDevices, eq(harnessDevices.id, editQuestions.deviceId))
      .where(
        and(
          eq(editQuestions.status, "open"),
          gt(editQuestions.expiresAt, new Date()),
          kinds === "found"
            ? eq(editQuestions.kind, "found")
            : kinds === "choices"
              ? ne(editQuestions.kind, "found")
              : undefined
        )
      )
      .orderBy(desc(editQuestions.createdAt))
      .limit(30)
  )
}
