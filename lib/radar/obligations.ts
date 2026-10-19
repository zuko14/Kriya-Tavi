import { randomUUID } from "node:crypto"

import { and, asc, eq, inArray, lt } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { obligations } from "@/db/schema"
import { reminderTimes } from "@/lib/radar/extract"

// Radar rows (K4): the person's list and their own actions through withUser;
// the worker's `missed` sweep through privileged (status and time only).

export async function upcomingObligations(userId: string, limit = 100) {
  const rows = await withUser(userId, (tx) =>
    tx
      .select()
      .from(obligations)
      .where(inArray(obligations.status, ["upcoming", "missed"]))
      .orderBy(asc(obligations.dueAt))
      .limit(limit)
  )
  const now = Date.now()
  return rows.map((o) => ({
    ...o,
    // In a lead window now: shown as a reminder in Kriya
    remindNow:
      o.status === "upcoming" &&
      o.dueAt.getTime() > now &&
      reminderTimes(o.dueAt, o.leadDays).some((t) => t.getTime() <= now),
  }))
}

// Done or dismissed: only the person (DATA_MODEL §3.9)
export async function markObligation(
  userId: string,
  id: string,
  status: "done" | "dismissed"
) {
  const rows = await withUser(userId, (tx) =>
    tx
      .update(obligations)
      .set({ status })
      .where(
        and(
          eq(obligations.id, id),
          inArray(
            obligations.status,
            status === "done" ? ["upcoming", "missed"] : ["upcoming"]
          )
        )
      )
      .returning({ id: obligations.id })
  )
  return rows.length > 0
}

// The person's own deadline: their word is the source and the quote
export async function addPersonObligation(
  userId: string,
  input: { kind: string; title: string; dueAt: Date; note: string }
) {
  const [row] = await withUser(userId, (tx) =>
    tx
      .insert(obligations)
      .values({
        id: randomUUID().slice(0, 12),
        userId,
        kind: input.kind,
        title: input.title,
        dueAt: input.dueAt,
        quote: input.note,
        sourceKind: "person",
        sourceRef: "person",
        readAt: new Date(),
        verified: true,
      })
      .returning()
  )
  return row
}

// Worker: past their time, still upcoming → missed
export async function markMissed(now = new Date()) {
  const rows = await privileged
    .update(obligations)
    .set({ status: "missed" })
    .where(and(eq(obligations.status, "upcoming"), lt(obligations.dueAt, now)))
    .returning({ id: obligations.id })
  return rows.length
}
