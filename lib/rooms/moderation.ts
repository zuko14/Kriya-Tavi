import { and, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { roomReports, rooms } from "@/db/schema"
import { postSystemLine } from "@/lib/rooms/agents"

// The Kriya owner's answer to a room report (R9, RC-5). Server writes, so
// only after the caller's requireOwner(): the report closes once (open →
// reviewed or dismissed, kriya.check_transition), and "archive" also stops
// the reported room with a line saying Kriya did it. False when the report
// isn't open any more.
export async function closeReport(
  ownerId: string,
  reportId: string,
  outcome: "reviewed" | "dismissed" | "archive"
) {
  const [report] = await privileged
    .update(roomReports)
    .set({
      status: outcome === "dismissed" ? "dismissed" : "reviewed",
      reviewedBy: ownerId,
      reviewedAt: new Date(),
    })
    .where(and(eq(roomReports.id, reportId), eq(roomReports.status, "open")))
    .returning({ roomId: roomReports.roomId })
  if (!report) return false
  if (outcome === "archive") {
    const archived = await privileged
      .update(rooms)
      .set({ status: "archived" })
      .where(and(eq(rooms.id, report.roomId), eq(rooms.status, "active")))
      .returning({ id: rooms.id })
    if (archived.length) {
      await postSystemLine(report.roomId, "Kriya archived this room after a report.")
    }
  }
  return true
}
