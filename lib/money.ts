// Money as integers. Amounts are micro-units (1e-6) of USD or INR; plan
// prices are paise. Multiplication happens in BigInt so no float ever touches
// a stored amount; results round half up to the nearest micro-unit.

const MICRO = 1_000_000n

function divRound(numerator: bigint, denominator: bigint) {
  const half = denominator / 2n
  return numerator >= 0n
    ? (numerator + half) / denominator
    : (numerator - half) / denominator
}

// "84.25" → 842500 (rate scaled by 1e4). Null for anything not a plain decimal.
export function parseRate(value: string | undefined | null): bigint | null {
  const match = value?.trim().match(/^(\d{1,4})(?:\.(\d{1,4}))?$/)
  if (!match) return null
  const rate = BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"))
  return rate > 0n ? rate : null
}

export function formatRate(rateE4: bigint) {
  return `${rateE4 / 10_000n}.${(rateE4 % 10_000n).toString().padStart(4, "0")}`
}

export function usdToInr(microUsd: number, rateE4: bigint) {
  return Number(divRound(BigInt(microUsd) * rateE4, 10_000n))
}

// Basis points: 10000 = 1×, 15000 = 1.5×
export function applyMarkup(microInr: number, bps: number) {
  return Number(divRound(BigInt(microInr) * BigInt(bps), 10_000n))
}

// OpenRouter reports cost in credits (1 credit = 1 USD) as a JSON number.
// Converted through its decimal string so float error can't creep in.
export function creditsToMicroUsd(cost: unknown): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null
  const [whole, fraction = ""] = cost.toFixed(9).split(".")
  const micro = BigInt(whole) * MICRO + BigInt(fraction.slice(0, 6))
  // Round on the 7th decimal
  return Number(Number(fraction[6] ?? "0") >= 5 ? micro + 1n : micro)
}

// Catalogue price × tokens. Prices are micro-USD per million tokens.
export function estimateMicroUsd(
  tokens: { input: number | null; output: number | null },
  price: { input: number | null; output: number | null }
): number | null {
  if (tokens.input == null || tokens.output == null) return null
  if (price.input == null || price.output == null) return null
  return Number(
    divRound(
      BigInt(tokens.input) * BigInt(price.input) +
        BigInt(tokens.output) * BigInt(price.output),
      MICRO
    )
  )
}

export type UsageForCharge = {
  costMicroUsd: number | null
  estimatedCostMicroUsd: number | null
}

// A task's provider cost from its model requests. Requests with neither a
// reported nor an estimated cost are counted, never treated as free.
export function sumTaskCost(rows: UsageForCharge[]) {
  let costMicroUsd = 0
  let estimated = false
  let unmetered = 0
  for (const row of rows) {
    if (row.costMicroUsd != null) costMicroUsd += row.costMicroUsd
    else if (row.estimatedCostMicroUsd != null) {
      costMicroUsd += row.estimatedCostMicroUsd
      estimated = true
    } else unmetered++
  }
  const basis: "provider" | "estimate" | "none" =
    rows.length === 0 ? "none" : estimated || unmetered > 0 ? "estimate" : "provider"
  return { costMicroUsd, basis, unmetered }
}

export type Charge = {
  providerCostMicroUsd: number
  costBasis: "provider" | "estimate" | "none"
  unmeteredRequests: number
  fxUsdInr: string | null
  fxSource: string | null
  providerCostMicroInr: number | null
  markupBps: number
  chargeMicroInr: number | null
  status: "final" | "estimated" | "unpriced"
}

export function priceTask(
  usage: UsageForCharge[],
  fx: { rate: string | undefined; source: string | undefined },
  markupBps: number
): Charge {
  const { costMicroUsd, basis, unmetered } = sumTaskCost(usage)
  const rate = parseRate(fx.rate)
  const base = {
    providerCostMicroUsd: costMicroUsd,
    costBasis: basis,
    unmeteredRequests: unmetered,
    markupBps,
  }
  if (!rate) {
    return {
      ...base,
      fxUsdInr: null,
      fxSource: null,
      providerCostMicroInr: null,
      chargeMicroInr: null,
      status: "unpriced",
    }
  }
  const providerCostMicroInr = usdToInr(costMicroUsd, rate)
  return {
    ...base,
    fxUsdInr: formatRate(rate),
    fxSource: fx.source ?? "unspecified",
    providerCostMicroInr,
    chargeMicroInr: applyMarkup(providerCostMicroInr, markupBps),
    status: basis === "estimate" ? "estimated" : "final",
  }
}

// The person's ₹ cap (K2) as a provider budget for a task, with the same
// owner-set rate and markup chargeTask uses. Floored, so the charge never
// passes the cap. Null without a rate or a markup to divide by.
export function capToProviderMicroUsd(
  capMicroInr: number,
  rateE4: bigint | null,
  markupBps: number
): number | null {
  if (!rateE4 || markupBps <= 0) return null
  return Number((BigInt(capMicroInr) * 100_000_000n) / (rateE4 * BigInt(markupBps)))
}

/* ───────────────────────────── display ──────────────────────────── */

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" })
const inrFine = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 4,
})

// Small amounts keep four decimals so a ₹0.0042 task doesn't read as ₹0.00
export function formatInr(microInr: number | null | undefined) {
  if (microInr == null) return "—"
  const rupees = microInr / 1_000_000
  return Math.abs(rupees) < 1 && rupees !== 0
    ? inrFine.format(rupees)
    : inr.format(rupees)
}

export function formatPaise(paise: number | null | undefined) {
  if (paise == null) return "—"
  return inr.format(paise / 100)
}

export function formatUsd(microUsd: number | null | undefined) {
  if (microUsd == null) return "—"
  const dollars = microUsd / 1_000_000
  return `$${dollars < 1 ? dollars.toFixed(6) : dollars.toFixed(2)}`
}
