import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { APICallError, RetryError, type LanguageModel } from "ai"
import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { models, TIERS, type Plan, type Tier } from "@/db/schema"
import { isTier } from "@/lib/tiers"
import { getSecret, getSetting } from "@/lib/config"
import { creditsToMicroUsd } from "@/lib/money"

export { isTier, TIER_LABELS } from "@/lib/tiers"

// The model gateway. Agents never name a model: they run on a routing tier
// (budget · balanced · escalation) that the owner maps to OpenRouter models
// in /owner/config or through OPENROUTER_* variables, and that the person's
// plan must allow.

export class ModelConfigError extends Error {
  name = "ModelConfigError"
}

// The tier a task runs on: the agent's choice if the plan allows it, else the
// best tier the plan allows below it, else the platform default.
export async function resolveTier(
  requested: string | null | undefined,
  plan: Plan
): Promise<Tier> {
  const allowed = plan.allowedTiers.filter(isTier)
  const fallback = await getSetting("routing.defaultTier")
  const wanted = isTier(requested) ? requested : isTier(fallback) ? fallback : "budget"
  if (allowed.includes(wanted)) return wanted
  const below = TIERS.slice(0, TIERS.indexOf(wanted) + 1).reverse()
  return below.find((tier) => allowed.includes(tier)) ?? allowed[0] ?? "budget"
}

export async function modelForTier(tier: Tier): Promise<string> {
  const id = await getSetting(`routing.${tier}`)
  if (id) return id
  // Higher tiers fall back to the budget model rather than failing outright
  const budget = await getSetting("routing.budget")
  if (budget) return budget
  throw new ModelConfigError(
    "No model is configured. Set OPENROUTER_DEFAULT_MODEL or choose one in /owner/config."
  )
}

export async function fallbackModel() {
  return (await getSetting("routing.fallback")) ?? null
}

export function isGatewayConfigured() {
  return !!getSecret("OPENROUTER_API_KEY")
}

/* ───────────────────────────── usage ────────────────────────────── */

// What OpenRouter says it charged, read from the final usage chunk. Cost is
// in credits (1 credit = 1 USD).
export type OpenRouterUsage = {
  costMicroUsd: number | null
  upstreamCostMicroUsd: number | null
  isByok: boolean | null
  raw: Record<string, unknown> | null
}

function readUsage(body: unknown): OpenRouterUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage !== "object") return null
  const details = usage.cost_details as { upstream_inference_cost?: unknown } | undefined
  return {
    costMicroUsd: creditsToMicroUsd(usage.cost),
    upstreamCostMicroUsd: creditsToMicroUsd(details?.upstream_inference_cost),
    isByok: typeof usage.is_byok === "boolean" ? usage.is_byok : null,
    raw: usage,
  }
}

// Exposed on providerMetadata.openrouter for onLanguageModelCallEnd
export function usageFromMetadata(metadata: unknown): OpenRouterUsage | null {
  const value = (metadata as { openrouter?: { usage?: string } } | undefined)?.openrouter
  if (!value?.usage) return null
  try {
    return JSON.parse(value.usage) as OpenRouterUsage
  } catch {
    return null
  }
}

function pack(usage: OpenRouterUsage | null) {
  return usage ? { openrouter: { usage: JSON.stringify(usage) } } : undefined
}

export function createGatewayModel(modelId: string): LanguageModel {
  const apiKey = getSecret("OPENROUTER_API_KEY")
  if (!apiKey) {
    throw new ModelConfigError("OPENROUTER_API_KEY is not set on the server.")
  }
  const baseURL = (
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "")
  return createOpenAICompatible({
    name: "openrouter",
    baseURL,
    apiKey,
    includeUsage: true,
    headers: {
      // Attribution OpenRouter shows on its dashboards
      "HTTP-Referer": process.env.KRIYA_APP_URL || "https://kriya.ai",
      "X-Title": "Kriya Tavi",
    },
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }) => pack(readUsage(parsedBody)),
      createStreamExtractor: () => {
        let usage: OpenRouterUsage | null = null
        return {
          // The last chunk carries usage, including cost
          processChunk: (chunk) => {
            usage = readUsage(chunk) ?? usage
          },
          buildMetadata: () => pack(usage),
        }
      },
    },
  }).chatModel(modelId)
}

// Provider failures worth retrying on another model: rate limits, overload,
// outages and timeouts. Bad requests and auth errors are not.
export function isProviderFailure(error: unknown): boolean {
  // After its own retries the SDK wraps the last provider error
  if (RetryError.isInstance(error)) return isProviderFailure(error.lastError)
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0
    return error.isRetryable || status === 429 || status >= 500
  }
  return error instanceof Error && /timeout|ECONNRESET|fetch failed/i.test(error.message)
}

/* ───────────────────────────── catalogue ────────────────────────── */

export async function modelPrices(modelId: string) {
  const [row] = await privileged
    .select({
      input: models.inputMicroUsdPerMtok,
      output: models.outputMicroUsdPerMtok,
    })
    .from(models)
    .where(eq(models.id, modelId))
  return row ?? { input: null, output: null }
}

type CatalogueModel = {
  id: string
  name?: string
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
  architecture?: { input_modalities?: string[] }
}

// "0.000000091" USD per token → micro-USD per million tokens, exactly
function perTokenToMicroPerMtok(value: string | undefined) {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  // × 1e12: shift the decimal point twelve places
  const digits = (whole + fraction.padEnd(12, "0").slice(0, 12)).replace(/^0+(?=\d)/, "")
  return Number(digits)
}

// Refreshes prices and declared capabilities of models already in the
// registry from OpenRouter's public catalogue. Declared support is not proof:
// eval_status only changes when scripts/eval-models.ts has run.
export async function syncCatalogue(ids: string[]) {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  })
  if (!response.ok) throw new Error(`OpenRouter catalogue answered ${response.status}`)
  const { data } = (await response.json()) as { data: CatalogueModel[] }
  const byId = new Map(data.map((model) => [model.id, model]))
  const missing: string[] = []
  for (const id of ids) {
    const model = byId.get(id)
    if (!model) {
      missing.push(id)
      continue
    }
    const values = {
      label: model.name ?? id,
      supportsTools: !!model.supported_parameters?.includes("tools"),
      supportsStructured: !!model.supported_parameters?.includes("structured_outputs"),
      supportsImages: !!model.architecture?.input_modalities?.includes("image"),
      inputMicroUsdPerMtok: perTokenToMicroPerMtok(model.pricing?.prompt),
      outputMicroUsdPerMtok: perTokenToMicroPerMtok(model.pricing?.completion),
      pricesCheckedAt: new Date(),
    }
    await privileged
      .insert(models)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: models.id, set: values })
  }
  return { updated: ids.length - missing.length, missing }
}

export const __test = { perTokenToMicroPerMtok, readUsage }
