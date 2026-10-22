import { and, asc, count, eq, gt, inArray } from "drizzle-orm"

import { privileged, type Tx } from "@/db"
import {
  approvals,
  goals,
  grants,
  ledgerEntries,
  mandates,
  scheduleRuns,
  schedules,
  tasks,
  type Mandate,
} from "@/db/schema"
import { setGoalStatus } from "@/lib/goals"
import { log } from "@/lib/log"
import { crewThreadIds } from "@/lib/operator/crew-threads"
import { allMet, storeVerdict } from "@/lib/operator/verdict"

// The responsibility loop (track O, O6; ARCHITECTURE §7, OD-07). Each
// scheduler tick, with operator.checkIns on, every open job is checked
// against its rows, with no model: past due → expired; every line proven →
// completed; two finished check-ins with no new proof and nothing waiting
// for the person → needs_person; its ₹ budget reached → paused. Only this
// pass marks a job completed, expired or stuck (OS-8).

export const REVIEW_BATCH = 100
const STUCK_RUNS = 2
const OPEN = ["active", "needs_person", "paused"] as const

type Outcome = "expired" | "completed" | "stuck" | "paused"

// One transaction per job; a job that fails is logged by id and skipped
export async function reviewMandates(now = new Date(), limit = REVIEW_BATCH) {
  const open = await privileged
    .select({ id: mandates.id, userId: mandates.userId })
    .from(mandates)
    .where(inArray(mandates.status, OPEN))
    .orderBy(asc(mandates.updatedAt))
    .limit(limit)
  const counts = { reviewed: 0, expired: 0, completed: 0, stuck: 0, paused: 0, failed: 0 }
  for (const { id, userId } of open) {
    try {
      const outcome = await privileged.transaction((tx) => review(tx, id, userId, now))
      counts.reviewed++
      if (outcome) counts[outcome]++
    } catch (error) {
      counts.failed++
      // Titles may hold names (OS-12): ids only
      log.error("mandate review failed", { mandateId: id, error })
    }
  }
  return counts
}

async function review(
  tx: Tx,
  id: string,
  userId: string,
  now: Date
): Promise<Outcome | null> {
  const [job] = await tx
    .select()
    .from(mandates)
    .where(and(eq(mandates.id, id), eq(mandates.userId, userId)))
    .for("update")
  if (!job || !(OPEN as readonly string[]).includes(job.status)) return null
  await joinLedger(tx, job)
  const { results, changed } = await storeVerdict(tx, userId, job, now)

  if (now >= job.dueAt) {
    await close(tx, job, "expired", now)
    return "expired"
  }
  // A paused job waits for the person before it can be done
  if (allMet(results) && job.status !== "paused") {
    await close(tx, job, "completed", now)
    return "completed"
  }
  if (job.status !== "active" || !job.goalId) return null
  const [goal] = await tx
    .select({ threadId: goals.threadId })
    .from(goals)
    .where(and(eq(goals.id, job.goalId), eq(goals.userId, userId)))
  if (!goal) return null

  const mine = and(eq(schedules.goalId, job.goalId), eq(schedules.userId, userId))
  const [budget] = await tx
    .select({ n: count() })
    .from(schedules)
    .where(and(mine, eq(schedules.status, "paused"), eq(schedules.pauseReason, "budget")))
  if ((budget?.n ?? 0) > 0) {
    await tx
      .update(mandates)
      .set({
        status: "paused",
        statusReason: "Paused: this month's ₹ budget is reached.",
      })
      .where(eq(mandates.id, job.id))
    return "paused"
  }

  // Finished check-in runs since the last new proof
  const since = changed ? now : (job.lastEvidenceAt ?? job.approvedAt ?? job.createdAt)
  const [idle] = await tx
    .select({ n: count() })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .innerJoin(tasks, eq(tasks.id, scheduleRuns.taskId))
    .where(
      and(
        mine,
        eq(scheduleRuns.userId, userId),
        eq(scheduleRuns.outcome, "enqueued"),
        gt(scheduleRuns.dueAt, since),
        inArray(tasks.status, ["succeeded", "failed", "canceled"])
      )
    )
  if ((idle?.n ?? 0) < STUCK_RUNS) return null
  // A crew part waiting for an approval is waiting on the person too (O11)
  const threadIds = [goal.threadId, ...(await crewThreadIds(tx, userId, job.id))]
  const [waiting] = await tx
    .select({ n: count() })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        inArray(approvals.threadId, threadIds),
        eq(approvals.status, "pending"),
        gt(approvals.expiresAt, now)
      )
    )
  if ((waiting?.n ?? 0) > 0) return null

  await tx
    .update(mandates)
    .set({
      status: "needs_person",
      statusReason: `No progress in ${STUCK_RUNS} check-ins. Tell Kriya what to do next, wait, or close the job.`,
    })
    .where(eq(mandates.id, job.id))
  await tx
    .update(schedules)
    .set({ status: "paused", pauseReason: "mandate", nextRunAt: null })
    .where(and(mine, eq(schedules.status, "active")))
  return "stuck"
}

// O7: ledger entries the job's own runs drafted become its subjects, so
// "every entry confirmed" (OP-BOOKS) covers them. Code does this, never a
// model. `job.subjects` is updated in place for the verdict that follows.
async function joinLedger(tx: Tx, job: Mandate) {
  if (!job.goalId) return
  const drafted = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .innerJoin(tasks, eq(tasks.id, ledgerEntries.taskId))
    .innerJoin(goals, eq(goals.threadId, tasks.threadId))
    .where(
      and(
        eq(goals.id, job.goalId),
        eq(goals.userId, job.userId),
        eq(tasks.userId, job.userId),
        eq(ledgerEntries.userId, job.userId)
      )
    )
  const known = new Set(job.subjects.ledger ?? [])
  const added = drafted.map((row) => row.id).filter((id) => !known.has(id))
  if (added.length === 0) return
  job.subjects = { ...job.subjects, ledger: [...known, ...added] }
  await tx.update(mandates).set({ subjects: job.subjects }).where(eq(mandates.id, job.id))
}

// Done or out of time: grants end, schedules end, the goal closes with it
async function close(tx: Tx, job: Mandate, status: "expired" | "completed", now: Date) {
  await tx.update(mandates).set({ status, closedAt: now }).where(eq(mandates.id, job.id))
  await tx
    .update(grants)
    .set(
      status === "expired" ? { status: "expired" } : { status: "revoked", revokedAt: now }
    )
    .where(
      and(
        eq(grants.mandateId, job.id),
        eq(grants.userId, job.userId),
        eq(grants.status, "active")
      )
    )
  if (!job.goalId) return
  await tx
    .update(schedules)
    .set({ status: "ended", nextRunAt: null })
    .where(
      and(
        eq(schedules.goalId, job.goalId),
        eq(schedules.userId, job.userId),
        inArray(schedules.status, ["active", "paused"])
      )
    )
  const [goal] = await tx
    .select({ status: goals.status })
    .from(goals)
    .where(and(eq(goals.id, job.goalId), eq(goals.userId, job.userId)))
  if (!goal || goal.status === "achieved" || goal.status === "abandoned") return
  if (status === "expired") return setGoalStatus(tx, job.goalId, "abandoned")
  // The goal table has no paused → achieved step
  if (goal.status === "paused") await setGoalStatus(tx, job.goalId, "active")
  await setGoalStatus(tx, job.goalId, "achieved")
}
