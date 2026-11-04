import { and, eq, lt, sql } from "drizzle-orm"

import { privileged } from "@/db"
import { harnessUsage, type Tier } from "@/db/schema"
import {
  applyMarkup,
  creditsToMicroUsd,
  estimateMicroUsd,
  formatRate,
  usdToInr,
} from "@/lib/money"

// The harness ledger (HD-07, DATA_MODEL §4): one kriya.harness_usage row per
// gateway request, reserved in SQL before forwarding (the cap holds there),
// settled from the provider's final usage chunk. Reported cost, our
// estimate and the customer charge stay apart; a missing cost is never zero.
// kriya.usage_events and kriya.charges are untouched.

// A reservation older than this was abandoned (no settle reached it); the
// same 15 minutes and HD-16's three open answers are in
// kriya.reserve_harness_spend (20270301000200)
const STALE_MINUTES = 15

type Price = { input: number | null; output: number | null }

// The most a request can cost in micro-USD: input counted generously
// (characters / 3) plus the full output allowance. Null when unpriced
export function upperEstimateMicroUsd(
  inputChars: number,
  maxTokens: number,
  price: Price
) {
  return estimateMicroUsd({ input: Math.ceil(inputChars / 3), output: maxTokens }, price)
}

export function chargeFor(input: {
  costMicroUsd: number | null
  estimateMicroUsd: number | null
  rateE4: bigint | null
  markupBps: number
}): { chargeMicroInr: number | null; chargeStatus: "final" | "estimated" | "unpriced" } {
  const usd = input.costMicroUsd ?? input.estimateMicroUsd
  if (usd === null || !input.rateE4)
    return { chargeMicroInr: null, chargeStatus: "unpriced" }
  return {
    chargeMicroInr: applyMarkup(usdToInr(usd, input.rateE4), input.markupBps),
    chargeStatus: input.costMicroUsd !== null ? "final" : "estimated",
  }
}

// SQL decides against the IST month's cap and the open-answers limit
// (under the same per-person lock); "cap", "plan" or "open" when refused
export async function reserve(input: {
  userId: string
  deviceId: string
  requestKey: string
  tier: Tier
  model: string
  estimateMicroInr: number
}) {
  try {
    await privileged.execute(
      sql`select kriya.reserve_harness_spend(${input.userId}::uuid, ${input.deviceId}::uuid, ${input.requestKey}, ${input.tier}, ${input.model}, ${input.estimateMicroInr}::bigint)`
    )
    return null
  } catch (error) {
    // Drizzle wraps the database's message in `cause`
    const { message, cause } = error as { message?: string; cause?: { message?: string } }
    const text = `${message} ${cause?.message}`
    if (/harness cap reached/.test(text)) return "cap" as const
    if (/harness not in plan/.test(text)) return "plan" as const
    if (/harness too many open/.test(text)) return "open" as const
    throw error
  }
}

// What the final usage chunk (or JSON answer) says
export type UpstreamUsage = {
  promptTokens: number | null
  completionTokens: number | null
  cachedTokens: number | null
  costMicroUsd: number | null
}

export function readUsage(body: unknown): UpstreamUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage !== "object") return null
  const int = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined
  return {
    promptTokens: int(usage.prompt_tokens),
    completionTokens: int(usage.completion_tokens),
    cachedTokens: int(details?.cached_tokens),
    costMicroUsd: creditsToMicroUsd(usage.cost),
  }
}

const reserved = (requestKey: string, userId: string) =>
  and(
    eq(harnessUsage.requestKey, requestKey),
    eq(harnessUsage.userId, userId),
    eq(harnessUsage.status, "reserved")
  )

export async function settle(
  requestKey: string,
  userId: string,
  input: {
    model: string
    usage: UpstreamUsage
    price: Price
    rateE4: bigint | null
    markupBps: number
    generationId: string | null
    finishReason: string | null
    latencyMs: number
  }
) {
  const estimate = estimateMicroUsd(
    { input: input.usage.promptTokens, output: input.usage.completionTokens },
    input.price
  )
  const charge = chargeFor({
    costMicroUsd: input.usage.costMicroUsd,
    estimateMicroUsd: estimate,
    rateE4: input.rateE4,
    markupBps: input.markupBps,
  })
  await privileged
    .update(harnessUsage)
    .set({
      status: "settled",
      model: input.model,
      inputTokens: input.usage.promptTokens,
      outputTokens: input.usage.completionTokens,
      cachedTokens: input.usage.cachedTokens,
      costMicroUsd: input.usage.costMicroUsd,
      estimatedCostMicroUsd: estimate,
      chargeMicroInr: charge.chargeMicroInr,
      chargeStatus: charge.chargeStatus,
      fxRate: input.rateE4 ? formatRate(input.rateE4) : null,
      markupBps: input.markupBps,
      generationId: input.generationId?.slice(0, 200) ?? null,
      finishReason: input.finishReason?.slice(0, 40) ?? null,
      latencyMs: input.latencyMs,
      settledAt: new Date(),
    })
    .where(reserved(requestKey, userId))
}

// No usage arrived (the stream was cut): charged at the reservation, estimated
export async function settleAborted(requestKey: string, userId: string, model: string) {
  await privileged
    .update(harnessUsage)
    .set({
      status: "estimated",
      model,
      chargeMicroInr: sql`${harnessUsage.reservedMicroInr}`,
      chargeStatus: "estimated",
      settledAt: new Date(),
    })
    .where(reserved(requestKey, userId))
}

// Nothing was produced (refused or failed upstream): no charge
export async function settleFailed(requestKey: string, userId: string) {
  await privileged
    .update(harnessUsage)
    .set({ status: "failed", settledAt: new Date() })
    .where(reserved(requestKey, userId))
}

// The worker's hourly janitor: abandoned reservations, estimated at their
// reserved amount for reconciliation (never zero)
export async function expireReservations() {
  const expired = await privileged
    .update(harnessUsage)
    .set({
      status: "estimated",
      chargeMicroInr: sql`${harnessUsage.reservedMicroInr}`,
      chargeStatus: "estimated",
      settledAt: new Date(),
    })
    .where(
      and(
        eq(harnessUsage.status, "reserved"),
        lt(harnessUsage.createdAt, sql`now() - make_interval(mins => ${STALE_MINUTES})`)
      )
    )
    .returning({ id: harnessUsage.id })
  return expired.length
}
