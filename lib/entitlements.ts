import { and, count, eq, gte, inArray, sql, sum } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import {
  agents,
  charges,
  goals,
  plans,
  schedules,
  subscriptions,
  tasks,
  voiceCharges,
  type Plan,
} from "@/db/schema"

// What a person's plan allows, enforced on the server whatever the UI shows.
// Usage is the customer charge (micro-INR) of tasks in the current period:
// the subscription's billing period, or the calendar month (IST) on the
// free plan. Concurrency is enforced when the worker claims a task.

export type Limit = { ok: true } | { ok: false; code: string; message: string }

export async function getPlan(userId: string): Promise<Plan> {
  const result = await privileged.execute(
    sql`select kriya.effective_plan_id(${userId}) as id`
  )
  const id = rowsOf<{ id: string }>(result)[0]?.id
  const [plan] = await privileged
    .select()
    .from(plans)
    .where(eq(plans.id, id ?? ""))
  if (!plan) throw new Error("No default plan is configured.")
  return plan
}

// Start of today and of this month in India
function istStart(unit: "day" | "month") {
  return sql`(date_trunc(${unit}, now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`
}

export async function periodStart(userId: string): Promise<Date> {
  const [sub] = await privileged
    .select({ start: subscriptions.currentPeriodStart })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["active", "past_due"])
      )
    )
    .orderBy(sql`${subscriptions.createdAt} desc`)
    .limit(1)
  if (sub?.start) return sub.start
  const result = await privileged.execute(sql`select ${istStart("month")} as start`)
  return new Date(rowsOf<{ start: string | Date }>(result)[0].start)
}

export async function usageSummary(userId: string) {
  const plan = await getPlan(userId)
  const since = await periodStart(userId)
  const [spent] = await privileged
    .select({
      charge: sum(charges.chargeMicroInr).mapWith(Number),
      unpriced: count(sql`case when ${charges.status} = 'unpriced' then 1 end`),
    })
    .from(charges)
    .where(and(eq(charges.userId, userId), gte(charges.createdAt, since)))
  // Voice tasks spend the same allowance (voice phase 8, F9)
  const [voice] = await privileged
    .select({
      charge: sum(voiceCharges.chargeMicroInr).mapWith(Number),
      unpriced: count(sql`case when ${voiceCharges.status} = 'unpriced' then 1 end`),
    })
    .from(voiceCharges)
    .where(and(eq(voiceCharges.userId, userId), gte(voiceCharges.createdAt, since)))
  const [today] = await privileged
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, istStart("day"))))
  const usedMicroInr = (spent?.charge ?? 0) + (voice?.charge ?? 0)
  const allowance = plan.includedUsageMicroInr
  return {
    plan,
    since,
    usedMicroInr,
    allowanceMicroInr: allowance,
    // A free plan with no rupee allowance is limited by task count alone
    usedPct:
      allowance > 0 ? Math.min(100, Math.round((usedMicroInr / allowance) * 100)) : null,
    unpricedTasks: (spent?.unpriced ?? 0) + (voice?.unpriced ?? 0),
    tasksToday: today?.n ?? 0,
  }
}

export type UsageSummary = Awaited<ReturnType<typeof usageSummary>>

export function checkTaskAllowed(usage: UsageSummary): Limit {
  const { plan } = usage
  if (usage.tasksToday >= plan.maxTasksPerDay) {
    return {
      ok: false,
      code: "daily_limit",
      message: `You've used today's ${plan.maxTasksPerDay} tasks on the ${plan.name} plan. They reset at midnight IST, or upgrade for more.`,
    }
  }
  return checkAllowance(usage)
}

// A phone call spends the same allowance; the daily task count is for agents
export const checkVoiceAllowed = (usage: UsageSummary): Limit => checkAllowance(usage)

function checkAllowance(usage: UsageSummary): Limit {
  const { plan } = usage
  if (usage.allowanceMicroInr > 0 && usage.usedMicroInr >= usage.allowanceMicroInr) {
    const cap =
      usage.allowanceMicroInr + (plan.overageAllowed ? plan.overageCapMicroInr : 0)
    if (usage.usedMicroInr >= cap) {
      return {
        ok: false,
        code: "allowance",
        message: `You've used this period's allowance on the ${plan.name} plan. Upgrade or wait for your next billing period.`,
      }
    }
  }
  return { ok: true }
}

// Goals and schedules that are still open count against the plan (A3)
export async function checkGoalAllowed(userId: string): Promise<Limit> {
  const plan = await getPlan(userId)
  const [row] = await privileged
    .select({ n: count() })
    .from(goals)
    .where(and(eq(goals.userId, userId), inArray(goals.status, ["active", "paused"])))
  if ((row?.n ?? 0) >= plan.maxGoals) {
    return {
      ok: false,
      code: "goal_limit",
      message: `The ${plan.name} plan includes ${plan.maxGoals} open goals. Close one or upgrade to add more.`,
    }
  }
  return { ok: true }
}

// A new version of a saved skill doesn't count again; retired ones don't count
export async function checkSkillAllowed(userId: string, name: string): Promise<Limit> {
  const plan = await getPlan(userId)
  const result = await privileged.execute(
    sql`select count(distinct id)::int as n,
               bool_or(name = ${name}) as existing
        from kriya.skills
        where user_id = ${userId} and status <> 'retired'`
  )
  const row = rowsOf<{ n: number; existing: boolean | null }>(result)[0]
  if (!row?.existing && (row?.n ?? 0) >= plan.maxSkills) {
    return {
      ok: false,
      code: "skill_limit",
      message:
        plan.maxSkills === 0
          ? `The ${plan.name} plan doesn't include saved skills.`
          : `The ${plan.name} plan includes ${plan.maxSkills} saved skills. Retire one or upgrade to add more.`,
    }
  }
  return { ok: true }
}

// `gapMinutes`: the shortest time between two runs of the new rule
export async function checkScheduleAllowed(
  userId: string,
  gapMinutes: number,
  replacing = false
): Promise<Limit> {
  const plan = await getPlan(userId)
  if (gapMinutes < plan.minScheduleIntervalMinutes) {
    return {
      ok: false,
      code: "schedule_interval",
      message: `On the ${plan.name} plan a schedule can run at most once every ${plan.minScheduleIntervalMinutes} minutes.`,
    }
  }
  if (replacing) return { ok: true }
  const [row] = await privileged
    .select({ n: count() })
    .from(schedules)
    .where(
      and(eq(schedules.userId, userId), inArray(schedules.status, ["active", "paused"]))
    )
  if ((row?.n ?? 0) >= plan.maxSchedules) {
    return {
      ok: false,
      code: "schedule_limit",
      message: `The ${plan.name} plan includes ${plan.maxSchedules} schedules. End one or upgrade to add more.`,
    }
  }
  return { ok: true }
}

export async function checkAgentAllowed(userId: string): Promise<Limit> {
  const plan = await getPlan(userId)
  const [row] = await privileged
    .select({ n: count() })
    .from(agents)
    .where(eq(agents.userId, userId))
  if ((row?.n ?? 0) >= plan.maxAgents) {
    return {
      ok: false,
      code: "agent_limit",
      message: `The ${plan.name} plan includes ${plan.maxAgents} agents. Remove one or upgrade to add more.`,
    }
  }
  return { ok: true }
}
