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
  voiceAccess,
  voicePrices,
  workers,
} from "@/db/schema"
import {
  describeSetting,
  getSetting,
  secretStatus,
  SETTINGS,
  type SettingKey,
} from "@/lib/config"
import { usageSummary } from "@/lib/entitlements"
import { applyMarkup, parseRate, toMicroInr, usdToInr } from "@/lib/money"
import { voiceSpendToday } from "@/lib/voice/metering"

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

// Goals, schedules, their runs, approvals and "What I did" records (A3):
// counts by status only, never what's in them (AT-OWN-A1)
export async function backgroundCounts() {
  const week = sql`now() - interval '7 days'`
  const result = await privileged.execute(sql`
    select
      (select count(*) from kriya.goals where status in ('active', 'paused'))::int as "openGoals",
      (select count(*) from kriya.schedules where status = 'active')::int as "activeSchedules",
      (select count(*) from kriya.schedules where status = 'paused')::int as "pausedSchedules",
      (select count(*) from kriya.schedule_runs where created_at > ${week})::int as "runs7d",
      (select count(*) from kriya.schedule_runs where created_at > ${week} and outcome = 'enqueued')::int as "enqueued7d",
      (select count(*) from kriya.schedule_runs where created_at > ${week} and outcome like 'skipped%')::int as "skipped7d",
      (select count(*) from kriya.schedule_runs where created_at > ${week} and outcome = 'failed')::int as "failed7d",
      (select count(*) from kriya.schedule_runs where outcome = 'claimed')::int as "claimedNow",
      (select count(*) from kriya.approvals where status = 'pending')::int as "pendingApprovals",
      (select count(*) from kriya.approvals where status = 'expired' and decided_at > ${week})::int as "expired7d",
      (select count(*) from kriya.episodes where created_at > ${week})::int as "episodes7d"`)
  return rowsOf<{
    openGoals: number
    activeSchedules: number
    pausedSchedules: number
    runs7d: number
    enqueued7d: number
    skipped7d: number
    failed7d: number
    claimedNow: number
    pendingApprovals: number
    expired7d: number
    episodes7d: number
  }>(result)[0]
}

// The skill library over the last 7 days, per skill version: how many task
// attempts loaded or skipped it (a squad's agents count once), the latest
// skip reason, and how those attempts ended. A reply waiting for approval
// ends as succeeded.
export async function skillActivity() {
  const result = await privileged.execute(sql`
    select skill_id as "skillId", version,
      count(distinct (task_id, attempt)) filter (where status = 'active')::int as active,
      count(distinct (task_id, attempt)) filter (where status = 'skipped')::int as skipped,
      count(distinct (task_id, attempt)) filter (where status = 'active' and outcome = 'succeeded')::int as succeeded,
      count(distinct (task_id, attempt)) filter (where status = 'active' and outcome = 'failed')::int as failed,
      coalesce(avg(chars) filter (where status = 'active'), 0)::int as chars,
      (array_agg(reason order by created_at desc) filter (where status = 'skipped'))[1] as "lastSkip"
    from kriya.skill_activations
    where created_at > now() - interval '7 days'
    group by skill_id, version
    order by active desc, skill_id`)
  return rowsOf<{
    skillId: string
    version: string
    active: number
    skipped: number
    succeeded: number
    failed: number
    chars: number
    lastSkip: string | null
  }>(result)
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

/* ───────────────────────────── voice ────────────────────────────── */

// Voice cost and operations (COST_AND_METERING §5–6): SQL aggregates over
// usage, charges, calls and attempts only. Never what was said: no
// transcript, outcome or note column is selected here (T-OWN-01)

// Per currency, so USD converts once with the owner's rate
const COST = sql`
  coalesce(sum(coalesce(u.reported_cost_micro, u.estimated_cost_micro))
    filter (where coalesce(u.reported_currency, u.estimated_currency) = 'INR'), 0)::bigint as inr,
  coalesce(sum(coalesce(u.reported_cost_micro, u.estimated_cost_micro))
    filter (where coalesce(u.reported_currency, u.estimated_currency) = 'USD'), 0)::bigint as usd,
  coalesce(sum(u.reported_cost_micro) filter (where u.reported_currency is not null), 0)::bigint as reported,
  count(*) filter (where u.reported_cost_micro is null and u.estimated_cost_micro is not null)::int as estimated,
  count(*) filter (where u.reported_cost_micro is null and u.estimated_cost_micro is null)::int as unmetered`

type CostRow = {
  inr: string
  usd: string
  reported: string
  estimated: number
  unmetered: number
}

export async function voiceFinance(days = 30) {
  const since = daysAgo(days)
  const rate = parseRate(await getSetting("fx.usdInr"))
  // Null when there's USD cost and no rate to convert it
  const inr = (row: CostRow | undefined) => {
    const usd = toMicroInr({ micro: n(row?.usd), currency: "USD" }, rate)
    return n(row?.usd) === 0 ? n(row?.inr) : usd == null ? null : n(row?.inr) + usd
  }
  const byComponent = rowsOf<
    CostRow & { component: string; provider: string; items: number }
  >(
    await privileged.execute(sql`
      select u.component, u.provider, count(*)::int as items, ${COST}
      from kriya.voice_usage u where u.created_at >= ${since}
      group by 1, 2 order by 1, 2`)
  ).map((row) => ({ ...row, microInr: inr(row) }))
  // Busy, unanswered and failed attempts, apart (§6)
  const failed = rowsOf<CostRow & { attempts: number }>(
    await privileged.execute(sql`
      select count(distinct a.id)::int as attempts, ${COST}
      from kriya.call_attempts a
      left join kriya.voice_usage u on u.call_attempt_id = a.id
      where a.created_at >= ${since}
        and a.status in ('busy', 'no_answer', 'rejected', 'failed', 'canceled')`)
  )[0]
  const [attempts] = rowsOf<{ attempts: number; tasks: number }>(
    await privileged.execute(sql`
      select count(*)::int as attempts, count(distinct c.voice_task_id)::int as tasks
      from kriya.call_attempts a join kriya.voice_calls c on c.id = a.voice_call_id
      where a.created_at >= ${since} and c.kind = 'outreach'`)
  )
  // Cost per successful task: all finished tasks' cost ÷ completed tasks
  // whose result isn't call_failed (§6; failed tasks stay in the numerator)
  const [tasksRow] = rowsOf<{
    tasks: number
    successful: number
    unpriced: number
    cost: string
    charged: string
  }>(
    await privileged.execute(sql`
      select count(*)::int as tasks,
             count(*) filter (where t.status = 'completed' and t.result <> 'call_failed')::int as successful,
             count(*) filter (where ch.status = 'unpriced')::int as unpriced,
             coalesce(sum(ch.provider_cost_micro_inr), 0)::bigint as cost,
             coalesce(sum(ch.charge_micro_inr), 0)::bigint as charged
      from kriya.voice_charges ch join kriya.voice_tasks t on t.id = ch.voice_task_id
      where t.finished_at >= ${since}`)
  )
  const [unpricedToday] = rowsOf<{ n: number }>(
    await privileged.execute(sql`
      select count(*)::int as n from kriya.voice_charges
      where unmetered_items > 0
        and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`)
  )
  const feeBps = Number((await getSetting("finance.paymentFeeBps")) ?? NaN)
  const cost = n(tasksRow?.cost)
  const charged = n(tasksRow?.charged)
  const fee = Number.isFinite(feeBps) ? applyMarkup(charged, feeBps) : null
  return {
    days,
    byComponent,
    failed: {
      attempts: failed?.attempts ?? 0,
      microInr: inr(failed),
      unmetered: failed?.unmetered ?? 0,
    },
    attemptsPerTask: attempts?.tasks ? attempts.attempts / attempts.tasks : null,
    tasks: tasksRow?.tasks ?? 0,
    successful: tasksRow?.successful ?? 0,
    unpricedTasks: tasksRow?.unpriced ?? 0,
    costMicroInr: cost,
    costPerSuccessMicroInr: tasksRow?.successful
      ? Math.round(cost / tasksRow.successful)
      : null,
    chargedMicroInr: charged,
    feeMicroInr: fee,
    contributionMicroInr: fee == null ? null : charged - cost - fee,
    unpricedToday: unpricedToday?.n ?? 0,
  }
}

export async function voiceOperations() {
  const cap = await getSetting("voice.dailySpendCapMicroInr")
  const spent = await voiceSpendToday()
  const capMicroInr = cap ? Number(cap) : null
  const calls = rowsOf<{ kind: string; status: string; n: number }>(
    await privileged.execute(sql`
      select kind, status, count(*)::int as n from kriya.voice_calls
      where status in ('scheduled', 'dialing', 'in_call', 'retry_wait', 'needs_owner', 'blocked')
      group by 1, 2 order by 1, 2`)
  )
  const attempts = rowsOf<{ status: string; end_reason: string | null; n: number }>(
    await privileged.execute(sql`
      select status, end_reason, count(*)::int as n from kriya.call_attempts
      where created_at >= now() - interval '1 day' group by 1, 2 order by 3 desc`)
  )
  const [stuck] = rowsOf<{ n: number }>(
    await privileged.execute(sql`
      select count(*)::int as n from kriya.voice_calls
      where status in ('dialing', 'in_call') and lease_expires_at < now()`)
  )
  // Owners at 80 % of their allowance (§5)
  const voiceUsers = await privileged
    .select({ userId: voiceAccess.userId })
    .from(voiceAccess)
  const nearAllowance = (
    await Promise.all(
      voiceUsers.map(async ({ userId }) => ({ userId, ...(await usageSummary(userId)) }))
    )
  )
    .filter((u) => u.usedPct != null && u.usedPct >= 80)
    .map((u) => ({ userId: u.userId, usedPct: u.usedPct!, plan: u.plan.name }))
  return {
    spentMicroInr: spent.microInr,
    unmeteredToday: spent.unmetered,
    capMicroInr,
    capPct:
      capMicroInr && spent.microInr != null
        ? Math.round((spent.microInr / capMicroInr) * 100)
        : null,
    calls,
    attempts,
    stuck: stuck?.n ?? 0,
    nearAllowance,
  }
}

export const voicePriceSheet = () =>
  privileged
    .select()
    .from(voicePrices)
    .orderBy(voicePrices.provider, voicePrices.product, desc(voicePrices.effectiveFrom))

export { n }
