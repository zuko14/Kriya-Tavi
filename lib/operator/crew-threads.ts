import { and, eq, inArray } from "drizzle-orm"

import { privileged, type Q } from "@/db"
import { crewParts, crewRuns } from "@/db/schema"
import { getSetting } from "@/lib/config"

// Which threads belong to a job's crews (O11): its grants, evidence and
// stuck rule reach them. Evidence keeps counting with the switch off (it is
// real, verified work); grants need it on. Read the switch outside any
// transaction: on one connection (PGlite) it would wait for that transaction.
// Deploy: the crew migration goes with the jobs migration (both 202612…).

export const crewsOn = async () => (await getSetting("operator.crews")) === "on"

// Every part thread of the job's crews, read as `q` (privileged or the person)
export async function crewThreadIds(q: Q, userId: string, mandateId: string) {
  const rows = await q
    .select({ threadId: crewParts.threadId })
    .from(crewParts)
    .innerJoin(
      crewRuns,
      and(eq(crewRuns.id, crewParts.runId), eq(crewRuns.userId, crewParts.userId))
    )
    .where(and(eq(crewParts.userId, userId), eq(crewRuns.mandateId, mandateId)))
  return rows.map((row) => row.threadId)
}

// The job whose working crew this part thread is in; null for any other thread
export async function partJobId(userId: string, threadId: string) {
  if (!(await crewsOn())) return null
  const [row] = await privileged
    .select({ mandateId: crewRuns.mandateId })
    .from(crewParts)
    .innerJoin(
      crewRuns,
      and(eq(crewRuns.id, crewParts.runId), eq(crewRuns.userId, crewParts.userId))
    )
    .where(
      and(
        eq(crewParts.userId, userId),
        eq(crewParts.threadId, threadId),
        inArray(crewRuns.status, ["running", "joining"])
      )
    )
  return row?.mandateId ?? null
}
