import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { platformSettings } from "@/db/schema"

// Platform configuration. Every setting is defined once here with its
// environment variable and default. The owner can override a setting from
// /owner/config; that value (kriya.platform_settings) wins over the
// environment, which wins over the default.
//
// Secrets are never settings: they come from the environment only and never
// leave the server. See SECRETS below.

type SettingDef = {
  env: string | null
  fallback?: string
  // Checked before an owner can save a value
  pattern?: RegExp
  hint?: string
}

const MODEL_ID = /^[a-z0-9-]+\/[A-Za-z0-9._:~-]+$/

export const SETTINGS = {
  // OpenRouter model ids for each routing tier
  "routing.budget": {
    env: "OPENROUTER_DEFAULT_MODEL",
    pattern: MODEL_ID,
    hint: "An OpenRouter model id, e.g. deepseek/deepseek-v4-flash",
  },
  "routing.balanced": { env: "OPENROUTER_BALANCED_MODEL", pattern: MODEL_ID },
  "routing.escalation": { env: "OPENROUTER_ESCALATION_MODEL", pattern: MODEL_ID },
  // Used for a retry when a tier's model fails with a provider error
  "routing.fallback": { env: "OPENROUTER_FALLBACK_MODEL", pattern: MODEL_ID },
  // Tier for agents that don't choose one
  "routing.defaultTier": {
    env: "KRIYA_DEFAULT_TIER",
    fallback: "budget",
    pattern: /^(budget|balanced|escalation)$/,
  },
  // Hard ceiling over every plan's step limit
  "agent.maxSteps": { env: "KRIYA_MAX_STEPS", fallback: "60", pattern: /^\d{1,3}$/ },
  // INR per USD for converting provider costs. No default: Kriya never makes
  // up an exchange rate. Until it is set, charges are recorded as unpriced.
  "fx.usdInr": {
    env: "KRIYA_FX_USD_INR",
    pattern: /^\d{1,4}(\.\d{1,4})?$/,
    hint: "e.g. 84.2500",
  },
  // Where the rate came from, stored with every charge
  "fx.source": { env: "KRIYA_FX_SOURCE", hint: "e.g. RBI reference rate, 2026-10-15" },
  "firecrawl.apiUrl": {
    env: "FIRECRAWL_API_URL",
    fallback: "https://api.firecrawl.dev",
    pattern: /^https:\/\//,
  },
  // Shown to users who reach a limit
  "support.email": { env: "KRIYA_SUPPORT_EMAIL" },
  // Monthly hosting and services cost in rupees (Render, Supabase, Firecrawl…),
  // entered by the owner. Used only for contribution estimates in /owner.
  "finance.infraMonthlyInr": {
    env: "KRIYA_INFRA_MONTHLY_INR",
    pattern: /^\d{1,9}$/,
    hint: "Whole rupees per month, e.g. 4500",
  },
  // Payment processing fee in basis points of revenue, for estimates only
  "finance.paymentFeeBps": {
    env: "KRIYA_PAYMENT_FEE_BPS",
    pattern: /^\d{1,4}$/,
    hint: "Basis points, e.g. 236 for 2.36%",
  },
} satisfies Record<string, SettingDef>

export type SettingKey = keyof typeof SETTINGS

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS
}

const CACHE_MS = 15_000
const globalForSettings = globalThis as unknown as {
  __kriyaSettings?: { at: number; values: Map<string, string> }
}

async function stored() {
  const cache = globalForSettings.__kriyaSettings
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values
  const rows = await privileged.select().from(platformSettings)
  const values = new Map(rows.map((row) => [row.key, row.value]))
  globalForSettings.__kriyaSettings = { at: Date.now(), values }
  return values
}

function envValue(key: SettingKey) {
  const def: SettingDef = SETTINGS[key]
  return (def.env && process.env[def.env]?.trim()) || undefined
}

export async function getSetting(key: SettingKey): Promise<string | undefined> {
  const def: SettingDef = SETTINGS[key]
  return (await stored()).get(key) || envValue(key) || def.fallback
}

export type SettingSource = "owner" | "env" | "default" | null

export async function describeSetting(key: SettingKey) {
  const def: SettingDef = SETTINGS[key]
  const saved = (await stored()).get(key)
  const env = envValue(key)
  const source: SettingSource = saved
    ? "owner"
    : env
      ? "env"
      : def.fallback
        ? "default"
        : null
  return {
    key,
    env: def.env,
    source,
    value: saved || env || def.fallback || null,
    hint: def.hint ?? null,
  }
}

export type SettingView = Awaited<ReturnType<typeof describeSetting>>

// Validates and saves (null or "" removes the override). Callers must have
// checked that the actor is an owner.
export async function setSetting(key: SettingKey, value: string | null, actorId: string) {
  const def: SettingDef = SETTINGS[key]
  const trimmed = value?.trim()
  if (!trimmed) {
    await privileged.delete(platformSettings).where(eq(platformSettings.key, key))
  } else {
    if (def.pattern && !def.pattern.test(trimmed)) {
      throw new Error(`${key}: ${def.hint ?? "invalid value"}`)
    }
    await privileged
      .insert(platformSettings)
      .values({ key, value: trimmed, updatedBy: actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: trimmed, updatedBy: actorId, updatedAt: new Date() },
      })
  }
  globalForSettings.__kriyaSettings = undefined
}

export async function getMaxSteps() {
  const value = Number.parseInt((await getSetting("agent.maxSteps")) ?? "", 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 60
}

/* ───────────────────────────── secrets ──────────────────────────── */

// Environment-only. Reported to the owner as present or missing, never shown.
export const SECRETS = [
  "DATABASE_URL",
  "SUPABASE_SECRET_KEY",
  "OPENROUTER_API_KEY",
  "FIRECRAWL_API_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "KRIYA_TOKEN_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
] as const

export type SecretName = (typeof SECRETS)[number]

export function getSecret(name: SecretName) {
  return process.env[name]?.trim() || undefined
}

export function secretStatus() {
  return SECRETS.map((name) => ({ name, set: !!getSecret(name) }))
}
