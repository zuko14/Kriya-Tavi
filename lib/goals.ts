import { and, eq, inArray, isNull } from "drizzle-orm"
import { nanoid } from "nanoid"

import type { Tx } from "@/db"
import {
  episodes,
  goals,
  schedules,
  threads,
  type GoalStatus,
  type PlanItem,
} from "@/db/schema"
import { ScheduleError } from "@/lib/schedules"

// Goals (A3): a title, success criteria and a checklist, worked on in the
// goal's own thread. Everything here runs inside the caller's withUser
// transaction, so another person's goal simply isn't found.

export class GoalError extends Error {}

export async function createGoal(
  tx: Tx,
  input: {
    userId: string
    agentId: string
    title: string
    successCriteria?: string
    plan: string[]
  }
) {
  const goalId = nanoid(12)
  const threadId = nanoid(12)
  await tx.insert(threads).values({
    id: threadId,
    userId: input.userId,
    agentId: input.agentId,
    title: input.title.slice(0, 80),
  })
  await tx.insert(goals).values({
    id: goalId,
    userId: input.userId,
    agentId: input.agentId,
    threadId,
    title: input.title,
    successCriteria: input.successCriteria ?? null,
    plan: input.plan.map((text) => ({ id: nanoid(6), text, status: "todo" as const })),
  })
  return { goalId, threadId }
}

export type PlanUpdate = {
  id: string
  status: PlanItem["status"]
  evidenceEpisodeId?: string
}

// A goal is achieved only with proof: every item done and linked to an
// episode, a record derived from verified tool runs (DATA_MODEL §3.1)
export async function updateGoal(
  tx: Tx,
  goalId: string,
  {
    planUpdates = [],
    status,
  }: { planUpdates?: PlanUpdate[]; status?: "achieved" | "paused" }
) {
  const [goal] = await tx.select().from(goals).where(eq(goals.id, goalId))
  if (!goal) throw new GoalError(`No goal with id ${goalId}.`)

  const cited = [
    ...new Set(planUpdates.flatMap((update) => update.evidenceEpisodeId ?? [])),
  ]
  if (cited.length > 0) {
    const found = await tx
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(inArray(episodes.id, cited), isNull(episodes.deletedAt)))
    const missing = cited.filter((id) => !found.some((row) => row.id === id))
    if (missing.length > 0) {
      throw new GoalError(`No record of what was done has the id ${missing.join(", ")}.`)
    }
  }

  const plan = goal.plan.map((item) => {
    const update = planUpdates.find((u) => u.id === item.id)
    if (!update) return item
    return {
      ...item,
      status: update.status,
      ...(update.evidenceEpisodeId && { evidence: update.evidenceEpisodeId }),
    }
  })
  const unknown = planUpdates.filter((u) => !goal.plan.some((item) => item.id === u.id))
  if (unknown.length > 0) {
    throw new GoalError(
      `The checklist has no item ${unknown.map((u) => u.id).join(", ")}.`
    )
  }
  if (
    status === "achieved" &&
    (plan.length === 0 || plan.some((item) => item.status !== "done" || !item.evidence))
  ) {
    throw new GoalError(
      "A goal is achieved only when every checklist item is done and linked to a record of what was done. Ask the person to close it if they consider it achieved."
    )
  }

  await tx
    .update(goals)
    .set({
      plan,
      ...(status && { status }),
      ...(status === "achieved" && { closedAt: new Date() }),
    })
    .where(eq(goals.id, goalId))
  return { goalId, plan, status: status ?? goal.status }
}

/* ─────────────────────────── the person's ───────────────────────── */

// Only the person's actions call these. They may close a goal as achieved
// without evidence (it's their goal) or abandon it. A goal that stops
// running stops its schedules: paused with it, or ended when it closes.
// Resuming the goal leaves each schedule for the person to resume.
export async function setGoalStatus(tx: Tx, goalId: string, status: GoalStatus) {
  const closed = status === "achieved" || status === "abandoned"
  const rows = await tx
    .update(goals)
    .set({ status, closedAt: closed ? new Date() : null })
    .where(eq(goals.id, goalId))
    .returning({ id: goals.id })
  if (rows.length === 0) throw new GoalError(`No goal with id ${goalId}.`)
  if (status === "active") return
  await tx
    .update(schedules)
    .set(
      closed
        ? { status: "ended", nextRunAt: null }
        : { status: "paused", pauseReason: "goal", nextRunAt: null }
    )
    .where(
      and(
        eq(schedules.goalId, goalId),
        inArray(schedules.status, closed ? ["active", "paused"] : ["active"])
      )
    )
}

// The goal's monthly ₹ budget (K2); null removes it
export async function setGoalBudget(tx: Tx, goalId: string, capMicroInr: number | null) {
  const rows = await tx
    .update(goals)
    .set({ monthlyBudgetMicroInr: capMicroInr })
    .where(eq(goals.id, goalId))
    .returning({ id: goals.id })
  if (rows.length === 0) throw new GoalError(`No goal with id ${goalId}.`)
}

// One plain sentence for the UI. The transition table's refusal arrives
// wrapped by the driver (Drizzle puts it in `cause`).
export function explain(error: unknown, fallback: string) {
  if (error instanceof GoalError || error instanceof ScheduleError) return error.message
  for (let e = error as { message?: string; cause?: unknown } | undefined; e;) {
    if (/can't go from/.test(e.message ?? ""))
      return "That change isn't possible from here."
    e = e.cause as typeof e
  }
  return fallback
}
