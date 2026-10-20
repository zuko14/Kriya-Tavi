import { and, asc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm"

import { privileged, rowsOf, type Q } from "@/db"
import {
  models,
  plans,
  voiceCharges,
  voicePrices,
  voiceTasks,
  voiceUsage,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"
import {
  applyMarkup,
  estimateMicroUsd,
  formatRate,
  parseRate,
  toMicroInr,
} from "@/lib/money"

import { TERMINAL_TASK } from "./tasks"

// What voice work cost (COST_AND_METERING.md). Usage rows are written where
// the work happens (telephony by the verifier, STT/TTS/LLM by kriya-voice);
// this file prices them and writes one charge per finished task. Prices come
// only from the owner's sheet (kriya.voice_prices) or, for model requests,
// the model catalogue: no row means no estimate, counted as unmetered.

type Price = typeof voicePrices.$inferSelect
type Usage = typeof voiceUsage.$inferSelect

// Units a price is billed in, from the usage row's quantity
function billable(price: Price, usage: Usage): number | null {
  if (price.unit === "attempt") return 1
  if (usage.quantity == null) return null
  if (price.unit === "character")
    return usage.unit === "character" ? usage.quantity : null
  if (usage.unit !== "second") return null
  if (price.unit === "minute_pulse_60") return Math.ceil(usage.quantity / 60)
  if (price.unit === "minute_pulse_30") return Math.ceil(usage.quantity / 30)
  return usage.quantity
}

// The owner's price for this row: same provider and product, the latest in
// effect when the work happened. ponytail: one price per provider+product;
// a product billed two ways (per attempt and per minute) needs two products
function priceFor(prices: Price[], usage: Usage) {
  return prices
    .filter(
      (p) =>
        p.provider === usage.provider &&
        p.product === usage.product &&
        p.effectiveFrom <= usage.createdAt
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0]
}

// Fills in estimates for rows with no reported cost and none yet. Safe to
// run again: rows already estimated or reported are never touched
export async function estimateUsage(q: Q, where: SQL | undefined) {
  const rows = await q
    .select()
    .from(voiceUsage)
    .where(
      and(
        where,
        isNull(voiceUsage.reportedCostMicro),
        isNull(voiceUsage.estimatedCostMicro)
      )
    )
  if (rows.length === 0) return
  const prices = await q.select().from(voicePrices)
  for (const usage of rows) {
    let estimate: { micro: number; currency: "INR" | "USD"; priceId: string } | null =
      null
    const price = priceFor(prices, usage)
    const units = price ? billable(price, usage) : null
    if (price && units != null) {
      estimate = {
        micro: units * price.priceMicro,
        currency: price.currency,
        priceId: price.id,
      }
    } else if (usage.component === "llm") {
      // The catalogue price, read through q: inside a transaction a second
      // connection would wait on this one
      const [catalogue] = await q
        .select({
          input: models.inputMicroUsdPerMtok,
          output: models.outputMicroUsdPerMtok,
        })
        .from(models)
        .where(eq(models.id, usage.product))
      const micro = estimateMicroUsd(
        { input: usage.inputTokens, output: usage.outputTokens },
        catalogue ?? { input: null, output: null }
      )
      if (micro != null)
        estimate = { micro, currency: "USD", priceId: `model:${usage.product}` }
    }
    if (!estimate) continue
    await q
      .update(voiceUsage)
      .set({
        estimatedCostMicro: estimate.micro,
        estimatedCurrency: estimate.currency,
        priceId: estimate.priceId,
        costSource: "estimate",
      })
      .where(and(eq(voiceUsage.id, usage.id), isNull(voiceUsage.estimatedCostMicro)))
  }
}

type Costed = Pick<
  Usage,
  "reportedCostMicro" | "reportedCurrency" | "estimatedCostMicro" | "estimatedCurrency"
>

// What a set of usage rows cost in micro-INR. Rows with neither a reported
// nor an estimated cost are counted, never treated as free
export function sumVoiceCost(rows: Costed[], rateE4: bigint | null) {
  let microInr = 0
  let estimated = false
  let unmetered = 0
  let needsRate = false
  for (const row of rows) {
    const item =
      row.reportedCostMicro != null && row.reportedCurrency
        ? { micro: row.reportedCostMicro, currency: row.reportedCurrency }
        : row.estimatedCostMicro != null && row.estimatedCurrency
          ? { micro: row.estimatedCostMicro, currency: row.estimatedCurrency }
          : null
    if (!item) {
      unmetered++
      continue
    }
    if (row.reportedCostMicro == null) estimated = true
    const inr = toMicroInr(item, rateE4)
    if (inr == null) needsRate = true
    else microInr += inr
  }
  return { microInr, estimated, unmetered, needsRate, priced: rows.length - unmetered }
}

// Read before a transaction opens: getSetting uses its own connection
export const fxSettings = async () => ({
  rate: parseRate(await getSetting("fx.usdInr")),
  source: (await getSetting("fx.source")) ?? "unspecified",
})

async function computeCharge(
  q: Q,
  taskId: string,
  fx: Awaited<ReturnType<typeof fxSettings>>
) {
  await estimateUsage(q, eq(voiceUsage.voiceTaskId, taskId))
  const [task] = await q
    .select({ userId: voiceTasks.userId, planId: voiceTasks.planId })
    .from(voiceTasks)
    .where(eq(voiceTasks.id, taskId))
  if (!task) return null
  const rows = await q.select().from(voiceUsage).where(eq(voiceUsage.voiceTaskId, taskId))
  const [plan] = await q
    .select({ markupBps: plans.markupBps })
    .from(plans)
    .where(eq(plans.id, task.planId))
  const rate = fx.rate
  const markupBps = plan?.markupBps ?? 10000
  const cost = sumVoiceCost(rows, rate)
  const basis: "provider" | "estimate" | "none" =
    rows.length === 0
      ? "none"
      : cost.estimated || cost.unmetered > 0
        ? "estimate"
        : "provider"
  // Unpriced: a USD amount with no rate, or nothing could be priced at all
  const unpriced = cost.needsRate || (cost.unmetered > 0 && cost.priced === 0)
  return {
    userId: task.userId,
    planId: task.planId,
    providerCostMicroInr: unpriced ? null : cost.microInr,
    costBasis: basis,
    unmeteredItems: cost.unmetered,
    fxUsdInr: rate ? formatRate(rate) : null,
    fxSource: rate ? fx.source : null,
    markupBps,
    chargeMicroInr: unpriced ? null : applyMarkup(cost.microInr, markupBps),
    status: unpriced
      ? ("unpriced" as const)
      : basis === "estimate"
        ? ("estimated" as const)
        : ("final" as const),
  }
}

// The per-task budget before a dial (§5): what the task cost so far plus one
// more call at the telephony price for its full length. Fails closed for a
// real provider: no telephony price, or anything unmetered so far, counts as
// over, as does spend that can't be converted (USD without a rate). The mock
// costs nothing, so it's held only to what was priced
export async function overBudget(
  q: Q,
  task: { id: string; costBudgetMicroInr: number; maxCallSeconds: number },
  provider: string,
  fx: Awaited<ReturnType<typeof fxSettings>>
) {
  await estimateUsage(q, eq(voiceUsage.voiceTaskId, task.id))
  const spent = sumVoiceCost(
    await q.select().from(voiceUsage).where(eq(voiceUsage.voiceTaskId, task.id)),
    fx.rate
  )
  if (spent.needsRate) return true
  const live = provider !== "mock"
  if (live && spent.unmetered > 0) return true
  const call = {
    quantity: task.maxCallSeconds,
    unit: "second",
    provider,
    product: "outbound",
    createdAt: new Date(),
  } as Usage
  const price = priceFor(await q.select().from(voicePrices), call)
  const units = price ? billable(price, call) : null
  const projected =
    price && units != null
      ? toMicroInr({ micro: units * price.priceMicro, currency: price.currency }, fx.rate)
      : 0
  if (projected == null || (live && units == null)) return true
  return spent.microInr + projected > task.costBudgetMicroInr
}

// One charge per voice task, whatever its end (failed and cancelled tasks
// can still have cost). A second call changes nothing
export async function chargeVoiceTask(taskId: string) {
  const fx = await fxSettings()
  return privileged.transaction(async (tx) => {
    const charge = await computeCharge(tx, taskId, fx)
    if (!charge) return null
    await tx
      .insert(voiceCharges)
      .values({ voiceTaskId: taskId, ...charge })
      .onConflictDoNothing({ target: voiceCharges.voiceTaskId })
    return charge
  })
}

// After the owner adds a price or a provider reports a cost: an estimated
// or unpriced charge is recomputed. A final charge is never changed
export async function repriceVoiceTask(taskId: string) {
  const fx = await fxSettings()
  return privileged.transaction(async (tx) => {
    const charge = await computeCharge(tx, taskId, fx)
    if (!charge) return null
    await tx
      .update(voiceCharges)
      .set(charge)
      .where(
        and(
          eq(voiceCharges.voiceTaskId, taskId),
          inArray(voiceCharges.status, ["estimated", "unpriced"])
        )
      )
    return charge
  })
}

// Finished tasks without a charge yet, from the worker's voice sweep: every
// way a task can end (verifier, cancel, the expiry janitor) is covered here
export async function chargeFinishedVoiceTasks(limit = 100) {
  const due = await privileged
    .select({ id: voiceTasks.id })
    .from(voiceTasks)
    .leftJoin(voiceCharges, eq(voiceCharges.voiceTaskId, voiceTasks.id))
    .where(and(inArray(voiceTasks.status, TERMINAL_TASK), isNull(voiceCharges.id)))
    .orderBy(asc(voiceTasks.finishedAt))
    .limit(limit)
  for (const { id } of due) await chargeVoiceTask(id)
  return due.length
}

// Today's (IST) voice cost across the platform, reported + estimated
export async function voiceSpendToday() {
  const today = sql`(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`
  await estimateUsage(privileged, gte(voiceUsage.createdAt, today))
  const result = await privileged.execute(sql`
    select coalesce(sum(coalesce(reported_cost_micro, estimated_cost_micro))
             filter (where coalesce(reported_currency, estimated_currency) = 'INR'), 0)::bigint as inr,
           coalesce(sum(coalesce(reported_cost_micro, estimated_cost_micro))
             filter (where coalesce(reported_currency, estimated_currency) = 'USD'), 0)::bigint as usd,
           count(*) filter (where reported_cost_micro is null and estimated_cost_micro is null)::int as unmetered
    from kriya.voice_usage where created_at >= ${today}`)
  const row = rowsOf<{ inr: string; usd: string; unmetered: number }>(result)[0]
  const usd = Number(row?.usd ?? 0)
  const usdInr = usd
    ? toMicroInr(
        { micro: usd, currency: "USD" },
        parseRate(await getSetting("fx.usdInr"))
      )
    : 0
  return {
    // Null: USD spend with no rate to convert it
    microInr: usdInr == null ? null : Number(row?.inr ?? 0) + usdInr,
    unmetered: row?.unmetered ?? 0,
  }
}

// The platform daily cap (§5). Unset: only the mock provider may dial, so
// no live call happens before the owner sets one. ponytail: recomputed on
// every claim; cache per minute if claims ever get frequent
export async function dailyCapAllows(providerName: string) {
  const raw = await getSetting("voice.dailySpendCapMicroInr")
  const cap = raw ? Number(raw) : null
  if (cap == null) {
    if (providerName === "mock") return true
    log.warn("voice claim refused: voice.dailySpendCapMicroInr is not set")
    return false
  }
  const spent = await voiceSpendToday()
  // Spend that can't be converted, or that has no price yet, counts as over
  // the cap for a real provider: never dial blind
  if (
    spent.microInr == null ||
    spent.microInr >= cap ||
    (providerName !== "mock" && spent.unmetered > 0)
  ) {
    log.warn("voice claim refused: daily spend cap reached", {
      spentMicroInr: spent.microInr,
      capMicroInr: cap,
    })
    return false
  }
  if (spent.microInr >= cap * 0.8) {
    log.warn("voice daily spend above 80% of the cap", {
      spentMicroInr: spent.microInr,
      capMicroInr: cap,
    })
  }
  return true
}
