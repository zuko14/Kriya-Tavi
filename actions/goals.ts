"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { GOAL_STATUSES, goals } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { explain, setGoalStatus } from "@/lib/goals"

// The person's controls on the goal page (A3, UX_SPEC §5): pause, resume,
// abandon, reopen, or close as achieved. Closing without a record for every
// checklist item is allowed only when the person confirms it (override).

export type GoalActionResult = { ok: true } | { error: string; needsOverride?: boolean }

const input = z.object({
  goalId: z.string().min(1).max(32),
  status: z.enum(GOAL_STATUSES),
  override: z.boolean().default(false),
})

export async function changeGoal(
  goalId: string,
  status: (typeof GOAL_STATUSES)[number],
  override = false
): Promise<GoalActionResult> {
  const user = await requireUser()
  const parsed = input.safeParse({ goalId, status, override })
  if (!parsed.success) return { error: "That request wasn't valid." }
  try {
    const result = await withUser(user.id, async (tx) => {
      if (parsed.data.status === "achieved" && !parsed.data.override) {
        const [goal] = await tx
          .select({ plan: goals.plan })
          .from(goals)
          .where(eq(goals.id, parsed.data.goalId))
        const proven = goal && goal.plan.length > 0 && goal.plan.every((i) => i.evidence)
        if (goal && !proven) {
          return {
            error: "Not every checklist item is linked to a record of what was done.",
            needsOverride: true,
          }
        }
      }
      await setGoalStatus(tx, parsed.data.goalId, parsed.data.status)
      return { ok: true as const }
    })
    if ("error" in result) return result
  } catch (error) {
    return { error: explain(error, "Couldn't change the goal. Try again.") }
  }
  revalidatePath(`/goals/${parsed.data.goalId}`)
  return { ok: true }
}
