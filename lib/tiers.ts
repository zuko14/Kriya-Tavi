// Routing tiers as people see them. Safe for the browser: no server imports.

export const TIERS = ["budget", "balanced", "escalation"] as const
export type Tier = (typeof TIERS)[number]

export const TIER_LABELS: Record<Tier, { name: string; blurb: string }> = {
  budget: { name: "Everyday", blurb: "Fast and inexpensive for routine tasks" },
  balanced: { name: "Balanced", blurb: "More reliable on multi-step work" },
  escalation: { name: "Expert", blurb: "The strongest model, for hard problems" },
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
}

export function tierName(value: unknown) {
  return TIER_LABELS[isTier(value) ? value : "budget"].name
}
