import { and, asc, desc, eq, gte, sql } from "drizzle-orm"

import { withUser } from "@/db"
import { charges, goals, schedules, tasks, threads } from "@/db/schema"
import { describeRule, ruleSchema } from "@/lib/schedules"
import { goalEpisodes, threadHref } from "@/queries/episodes"

// Goals for the goal page (A3, UX_SPEC §5), read as the person.

const istMonthStart = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`

export async function getGoals(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select({
        id: goals.id,
        title: goals.title,
        status: goals.status,
        plan: goals.plan,
        updatedAt: goals.updatedAt,
      })
      .from(goals)
      .orderBy(desc(goals.createdAt))
  )
}

export async function getGoal(userId: string, goalId: string) {
  const view = await withUser(userId, async (tx) => {
    const [goal] = await tx.select().from(goals).where(eq(goals.id, goalId))
    if (!goal) return null
    const [thread] = await tx
      .select({ id: threads.id, agentId: threads.agentId, squadId: threads.squadId })
      .from(threads)
      .where(eq(threads.id, goal.threadId))
    const rows = await tx
      .select()
      .from(schedules)
      .where(eq(schedules.goalId, goal.id))
      .orderBy(asc(schedules.createdAt))
    // This month's (IST) charges for the goal's thread, against its ₹ budget
    const [spend] = await tx
      .select({
        spent: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
          Number
        ),
        unpriced: sql<number>`count(*) filter (where ${charges.status} = 'unpriced')::int`,
      })
      .from(charges)
      .innerJoin(tasks, eq(tasks.id, charges.taskId))
      .where(and(eq(tasks.threadId, goal.threadId), gte(tasks.createdAt, istMonthStart)))
    return {
      goal,
      href: thread ? threadHref(thread) : null,
      schedules: rows.map((row) => {
        const rule = ruleSchema.safeParse(row.rule)
        return {
          ...row,
          cadence: rule.success ? describeRule(rule.data) : "A rule Kriya can't read",
        }
      }),
      spentMicroInr: spend?.spent ?? 0,
      unpricedRuns: spend?.unpriced ?? 0,
      budgetMicroInr: goal.monthlyBudgetMicroInr,
    }
  })
  if (!view) return null
  return { ...view, episodes: await goalEpisodes(userId, goalId) }
}

export type GoalView = NonNullable<Awaited<ReturnType<typeof getGoal>>>
