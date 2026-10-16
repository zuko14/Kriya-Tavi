import "server-only"

import { and, desc, eq, gte, ilike, inArray, isNull, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import {
  auditEvents,
  charges,
  models,
  payments,
  plans,
  profiles,
  subscriptions,
  tasks,
  usageEvents,
  workers,
} from "@/db/schema"
import {
  describeSetting,
  getSetting,
  secretStatus,
  SETTINGS,
  type SettingKey,
} from "@/lib/config"
import { applyMarkup, parseRate, usdToInr } from "@/lib/money"

// Reads for the owner console. Everything here is aggregate or account
// metadata: no conversation, memory or message content is ever selected.
// Callers must have passed requireOwner().

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
const n = (value: unknown) => Number(value ?? 0)

export async function audit(
  actorId: string,
  action: string,
  target?: { type: string; id: string },
  details?: Record<string, unknown>
) {
  await privileged.insert(auditEvents).values({
    actorId,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    details: details ?? null,
  })
}

/* ───────────────────────────── overview ─────────────────────────── */

// Definitions (also shown on the page):
// - active user (DAU / MAU): created at least one task in the last 1 / 30 days
// - new registration: account created in the window
export async function overview() {
  const [users] = await privileged
    .select({
      total: sql<number>`count(*)::int`,
      new7: sql<number>`count(*) filter (where ${profiles.createdAt} > now() - interval '7 days')::int`,
      new30: sql<number>`count(*) filter (where ${profiles.createdAt} > now() - interval '30 days')::int`,
      suspended: sql<number>`count(*) filter (where ${profiles.status} = 'suspended')::int`,
    })
    .from(profiles)

  const [active] = await privileged
    .select({
      dau: sql<number>`count(distinct ${tasks.userId}) filter (where ${tasks.createdAt} > now() - interval '1 day')::int`,
      mau: sql<number>`count(distinct ${tasks.userId}) filter (where ${tasks.createdAt} > now() - interval '30 days')::int`,
    })
    .from(tasks)

  const taskStates = await privileged
    .select({ status: tasks.status, count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(gte(tasks.createdAt, daysAgo(1)))
    .groupBy(tasks.status)

  const [now] = await privileged
    .select({
      queued: sql<number>`count(*) filter (where ${tasks.status} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${tasks.status} = 'running')::int`,
    })
    .from(tasks)
    .where(inArray(tasks.status, ["queued", "running"]))

  const planMix = await privileged
    .select({ planId: subscriptions.planId, count: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(inArray(subscriptions.status, ["active", "past_due"]))
    .groupBy(subscriptions.planId)

  const failuresByDay = await privileged
    .select({
      day: sql<string>`to_char(${tasks.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
    })
    .from(tasks)
    .where(gte(tasks.createdAt, daysAgo(14)))
    .groupBy(sql`1`)
    .orderBy(sql`1`)

  const workerRows = await privileged
    .select()
    .from(workers)
    .where(isNull(workers.stoppedAt))
    .orderBy(desc(workers.heartbeatAt))
    .limit(20)

  return {
    users: users ?? { total: 0, new7: 0, new30: 0, suspended: 0 },
    active: active ?? { dau: 0, mau: 0 },
    taskStates: Object.fromEntries(taskStates.map((row) => [row.status, row.count])),
    queue: now ?? { queued: 0, running: 0 },
    planMix,
    failuresByDay,
    workers: workerRows.map((worker) => ({
      ...worker,
      healthy: Date.now() - worker.heartbeatAt.getTime() < 45_000,
    })),
  }
}

/* ───────────────────────────── finance ──────────────────────────── */

export async function finance(days = 30) {
  const since = daysAgo(days)
  const rate = parseRate(await getSetting("fx.usdInr"))
  const toInr = (microUsd: number) => (rate ? usdToInr(microUsd, rate) : null)

  const [usage] = await privileged
    .select({
      calls: sql<number>`count(*)::int`,
      reported:
        sql<number>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::bigint`.mapWith(
          Number
        ),
      estimated:
        sql<number>`coalesce(sum(${usageEvents.estimatedCostMicroUsd}) filter (where ${usageEvents.costMicroUsd} is null), 0)::bigint`.mapWith(
          Number
        ),
      unmetered: sql<number>`count(*) filter (where ${usageEvents.costMicroUsd} is null and ${usageEvents.estimatedCostMicroUsd} is null)::int`,
      missingUsage: sql<number>`count(*) filter (where ${usageEvents.usageStatus} = 'missing')::int`,
      inputTokens:
        sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`.mapWith(Number),
      outputTokens:
        sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::bigint`.mapWith(
          Number
        ),
      retryCost:
        sql<number>`coalesce(sum(coalesce(${usageEvents.costMicroUsd}, ${usageEvents.estimatedCostMicroUsd})) filter (where ${usageEvents.attempt} > 1), 0)::bigint`.mapWith(
          Number
        ),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))

  const byModel = await privileged
    .select({
      model: usageEvents.model,
      calls: sql<number>`count(*)::int`,
      tokens:
        sql<number>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)::bigint`.mapWith(
          Number
        ),
      cost: sql<number>`coalesce(sum(coalesce(${usageEvents.costMicroUsd}, ${usageEvents.estimatedCostMicroUsd})), 0)::bigint`.mapWith(
        Number
      ),
      avgLatency: sql<number>`coalesce(avg(${usageEvents.latencyMs}), 0)::int`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`4`))

  const [taskCosts] = await privileged
    .select({
      tasks: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${tasks.status} = 'succeeded')::int`,
      providerCost:
        sql<number>`coalesce(sum(${charges.providerCostMicroUsd}), 0)::bigint`.mapWith(
          Number
        ),
      charged: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
        Number
      ),
      unpriced: sql<number>`count(*) filter (where ${charges.status} = 'unpriced')::int`,
      estimatedCharges: sql<number>`count(*) filter (where ${charges.status} = 'estimated')::int`,
      uncharged: sql<number>`count(*) filter (where ${charges.id} is null and ${tasks.status} in ('succeeded', 'failed', 'canceled'))::int`,
    })
    .from(tasks)
    .leftJoin(charges, eq(charges.taskId, tasks.id))
    .where(gte(tasks.createdAt, since))

  const byPlan = await privileged
    .select({
      planId: charges.planId,
      tasks: sql<number>`count(*)::int`,
      providerCost:
        sql<number>`coalesce(sum(${charges.providerCostMicroUsd}), 0)::bigint`.mapWith(
          Number
        ),
      charged: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
        Number
      ),
    })
    .from(charges)
    .where(gte(charges.createdAt, since))
    .groupBy(charges.planId)

  const topUsers = await privileged
    .select({
      userId: charges.userId,
      email: sql<
        string | null
      >`(select email from auth.users u where u.id = ${charges.userId})`,
      tasks: sql<number>`count(*)::int`,
      providerCost:
        sql<number>`coalesce(sum(${charges.providerCostMicroUsd}), 0)::bigint`.mapWith(
          Number
        ),
      charged: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
        Number
      ),
    })
    .from(charges)
    .where(gte(charges.createdAt, since))
    .groupBy(charges.userId)
    .orderBy(desc(sql`4`))
    .limit(15)

  const [revenue] = await privileged
    .select({
      payments: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${payments.amountPaise}), 0)::bigint`.mapWith(
        Number
      ),
      fees: sql<number>`coalesce(sum(${payments.feePaise}), 0)::bigint`.mapWith(Number),
      taxes: sql<number>`coalesce(sum(${payments.taxPaise}), 0)::bigint`.mapWith(Number),
    })
    .from(payments)
    .where(and(eq(payments.status, "captured"), gte(payments.paidAt, since)))

  const daily = await privileged
    .select({
      day: sql<string>`to_char(${usageEvents.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
      reported:
        sql<number>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::bigint`.mapWith(
          Number
        ),
      estimated:
        sql<number>`coalesce(sum(${usageEvents.estimatedCostMicroUsd}) filter (where ${usageEvents.costMicroUsd} is null), 0)::bigint`.mapWith(
          Number
        ),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(sql`1`)
    .orderBy(sql`1`)

  // Contribution estimate, with every assumption spelled out on the page
  const infraMonthly = Number((await getSetting("finance.infraMonthlyInr")) ?? NaN)
  const feeBps = Number((await getSetting("finance.paymentFeeBps")) ?? NaN)
  const revenueMicroInr = (revenue?.amount ?? 0) * 10_000
  const reportedFees = (revenue?.fees ?? 0) * 10_000
  const providerCostMicroUsd = (usage?.reported ?? 0) + (usage?.estimated ?? 0)
  const providerCostMicroInr = toInr(providerCostMicroUsd)
  const infraMicroInr = Number.isFinite(infraMonthly)
    ? Math.round((infraMonthly * 1_000_000 * days) / 30)
    : null
  const feeMicroInr =
    reportedFees > 0
      ? reportedFees
      : Number.isFinite(feeBps)
        ? applyMarkup(revenueMicroInr, feeBps)
        : null
  const contribution =
    providerCostMicroInr != null && infraMicroInr != null && feeMicroInr != null
      ? revenueMicroInr - providerCostMicroInr - infraMicroInr - feeMicroInr
      : null

  return {
    days,
    fx: { rate: await getSetting("fx.usdInr"), source: await getSetting("fx.source") },
    usage: usage!,
    byModel,
    taskCosts: taskCosts!,
    byPlan,
    topUsers,
    revenue: revenue!,
    daily,
    estimate: {
      revenueMicroInr,
      providerCostMicroInr,
      infraMicroInr,
      feeMicroInr,
      feesFromProvider: reportedFees > 0,
      taxMicroInr: (revenue?.taxes ?? 0) * 10_000,
      contribution,
    },
    toInr,
  }
}

/* ───────────────────────────── users ────────────────────────────── */

export async function searchUsers(query: string) {
  const term = query.trim()
  const result = await privileged.execute(sql`
    select u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at,
           p.display_name, p.status, p.use_case,
           kriya.effective_plan_id(u.id) as plan_id,
           (select count(*)::int from kriya.tasks t where t.user_id = u.id) as tasks,
           (select coalesce(sum(c.charge_micro_inr), 0)::bigint from kriya.charges c where c.user_id = u.id) as charged
    from auth.users u
    left join kriya.profiles p on p.id = u.id
    ${term ? sql`where u.email ilike ${`%${term.replace(/[%_]/g, "\\$&")}%`} or u.id::text = ${term}` : sql``}
    order by u.created_at desc
    limit 50
  `)
  return rowsOf<{
    id: string
    email: string | null
    created_at: string
    last_sign_in_at: string | null
    email_confirmed_at: string | null
    display_name: string | null
    status: string | null
    use_case: string | null
    plan_id: string
    tasks: number
    charged: string
  }>(result)
}

export async function userDetail(userId: string) {
  const [account] = rowsOf<{
    id: string
    email: string | null
    created_at: string
    last_sign_in_at: string | null
    email_confirmed_at: string | null
  }>(
    await privileged.execute(
      sql`select id, email, created_at, last_sign_in_at, email_confirmed_at from auth.users where id = ${userId}`
    )
  )
  if (!account) return null
  const [profile] = await privileged
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
  const subs = await privileged
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(10)
  const recentTasks = await privileged
    .select({
      id: tasks.id,
      status: tasks.status,
      tier: tasks.tier,
      model: tasks.model,
      attempts: tasks.attempts,
      errorCode: tasks.errorCode,
      createdAt: tasks.createdAt,
      finishedAt: tasks.finishedAt,
      charge: charges.chargeMicroInr,
      cost: charges.providerCostMicroUsd,
    })
    .from(tasks)
    .leftJoin(charges, eq(charges.taskId, tasks.id))
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(25)
  const userPayments = await privileged
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.paidAt))
    .limit(10)
  const auditTrail = await privileged
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, "user"), eq(auditEvents.targetId, userId)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(20)
  const planId = rowsOf<{ id: string }>(
    await privileged.execute(sql`select kriya.effective_plan_id(${userId}) as id`)
  )[0]?.id
  return {
    account,
    profile,
    planId,
    subs,
    recentTasks,
    payments: userPayments,
    auditTrail,
  }
}

/* ──────────────────────────── config ────────────────────────────── */

export async function configView() {
  const settings = await Promise.all(
    (Object.keys(SETTINGS) as SettingKey[]).map((key) => describeSetting(key))
  )
  const planRows = await privileged.select().from(plans).orderBy(plans.sort)
  const modelRows = await privileged.select().from(models).orderBy(models.id)
  return { settings, plans: planRows, models: modelRows, secrets: secretStatus() }
}

/* ──────────────────────────── operations ────────────────────────── */

export async function operations() {
  const failed = await privileged
    .select({
      id: tasks.id,
      userId: tasks.userId,
      status: tasks.status,
      tier: tasks.tier,
      model: tasks.model,
      attempts: tasks.attempts,
      maxAttempts: tasks.maxAttempts,
      errorCode: tasks.errorCode,
      error: tasks.error,
      createdAt: tasks.createdAt,
      finishedAt: tasks.finishedAt,
      sideEffects: sql<boolean>`exists (select 1 from kriya.tool_executions e where e.task_id = ${tasks.id} and e.side_effect)`,
    })
    .from(tasks)
    .where(eq(tasks.status, "failed"))
    .orderBy(desc(tasks.finishedAt))
    .limit(50)
  const stuck = await privileged
    .select({
      id: tasks.id,
      status: tasks.status,
      createdAt: tasks.createdAt,
      leaseOwner: tasks.leaseOwner,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["queued", "running"]),
        sql`${tasks.createdAt} < now() - interval '15 minutes'`
      )
    )
    .limit(50)
  const workerRows = await privileged
    .select()
    .from(workers)
    .orderBy(desc(workers.heartbeatAt))
    .limit(30)
  const [reconcile] = await privileged
    .select({
      pending: sql<number>`count(*) filter (where ${usageEvents.costMicroUsd} is null and ${usageEvents.generationId} is not null)::int`,
      unrecoverable: sql<number>`count(*) filter (where ${usageEvents.costMicroUsd} is null and ${usageEvents.generationId} is null)::int`,
    })
    .from(usageEvents)
  const now = Date.now()
  return {
    failed,
    stuck,
    workers: workerRows.map((worker) => ({
      ...worker,
      live: !worker.stoppedAt && now - worker.heartbeatAt.getTime() < 45_000,
    })),
    reconcile: reconcile!,
    secrets: secretStatus(),
  }
}

export async function auditLog(filter?: string) {
  return privileged
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      details: auditEvents.details,
      createdAt: auditEvents.createdAt,
      actor: sql<
        string | null
      >`(select email from auth.users u where u.id = ${auditEvents.actorId})`,
    })
    .from(auditEvents)
    .where(filter ? ilike(auditEvents.action, `%${filter}%`) : undefined)
    .orderBy(desc(auditEvents.createdAt))
    .limit(200)
}

export { n }
