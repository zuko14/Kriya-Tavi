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
  // Agent platform switches (docs/agent-platform). Each is off by default,
  // and off means existing agents get the same prompt and tools as before.
  // Memory v2: typed, shared and retrieved memory, thread summaries
  "agents.memoryV2": {
    env: "KRIYA_AGENTS_MEMORY_V2",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Model spend on summaries and memory consolidation, per person per day.
  // A platform cost, never charged to the person. 0 runs no such job.
  "agents.maintenanceCapMicroUsd": {
    env: "KRIYA_MAINTENANCE_CAP_MICRO_USD",
    fallback: "0",
    pattern: /^\d{1,9}$/,
    hint: "Micro-USD per person per day, e.g. 20000 for $0.02",
  },
  // Onboarding offers "Meet your team": the use case's role pack as a squad (A2)
  "agents.rolePacks": {
    env: "KRIYA_AGENTS_ROLE_PACKS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Agent browser tools (A4). Also needs the plan's browser minutes and
  // KRIYA_BROWSER_URL + KRIYA_BROWSER_SECRET on the worker.
  "agents.browser": {
    env: "KRIYA_AGENTS_BROWSER",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Inbox and "What I did" (A3): approvals indexed for the Inbox and expired
  // after agents.approvalTtlHours, records of verified actions after each task
  "agents.inbox": {
    env: "KRIYA_AGENTS_INBOX",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  "agents.approvalTtlHours": {
    env: "KRIYA_APPROVAL_TTL_HOURS",
    fallback: "72",
    pattern: /^\d{1,4}$/,
    hint: "Hours an approval waits before it counts as declined, e.g. 72",
  },
  // Goal and schedule tools (A3). Runs also need KRIYA_SCHEDULES_ENABLED=1
  // on the worker.
  "agents.goals": {
    env: "KRIYA_AGENTS_GOALS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // GitHub, Sheets, YouTube and Instagram tools and their Account options (A8)
  "agents.connectors": {
    env: "KRIYA_AGENTS_CONNECTORS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The Undo window for reversible tools (K3): 10 minutes, run by the worker
  "agents.undo": {
    env: "KRIYA_AGENTS_UNDO",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Skills (A9): save, approve and replay procedures
  "agents.skills": {
    env: "KRIYA_AGENTS_SKILLS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Receipt cards and "Verify my records" (K1)
  "agents.receipts": {
    env: "KRIYA_AGENTS_RECEIPTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Files, generated PDFs and Kriya Share (A5, K8): uploads, extraction in
  // the worker, receipt PDFs and share links
  "agents.files": {
    env: "KRIYA_AGENTS_FILES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // A vision-capable model that reads PDFs and images; unset = they wait
  "agents.fileReaderModel": {
    env: "KRIYA_FILE_READER_MODEL",
    pattern: MODEL_ID,
    hint: "an OpenRouter model id that accepts images and PDFs",
  },
  // Accounts (A7): ledger entries, GST invoices with gapless numbers, CA
  // exports. Each plan also needs ledger_enabled in /owner (default off)
  "agents.ledger": {
    env: "KRIYA_AGENTS_LEDGER",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K7 step 2: a cheap model checks cited, quote-less claims (never money)
  "agents.crossCheck": {
    env: "KRIYA_AGENTS_CROSS_CHECK",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  "agents.crossCheckModel": {
    env: "KRIYA_CROSS_CHECK_MODEL",
    pattern: MODEL_ID,
    hint: "a budget OpenRouter model, ideally another provider than the agents'",
  },
  // K5 watchers: schedule_create can watch a page; unchanged pages cost no
  // task or model call (fetches are metered)
  "agents.watchers": {
    env: "KRIYA_AGENTS_WATCHERS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K4 Radar: obligations with their quotes; reminders in-app until voice
  "agents.radar": {
    env: "KRIYA_AGENTS_RADAR",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K6 public facts commons: the fact job and facts_lookup
  "agents.facts": {
    env: "KRIYA_AGENTS_FACTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Governed improvement (A12, AD-25): tasks use the active or canary policy
  // bundle and are stamped with its version; off = the code baseline
  "agents.improvement": {
    env: "KRIYA_AGENTS_IMPROVEMENT",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Login profiles and take-over (A6, AD-05): Account → Logins, and tasks
  // use a saved sign-in. Also needs KRIYA_TOKEN_KEY and kriya-browser
  "agents.loginProfiles": {
    env: "KRIYA_AGENTS_LOGIN_PROFILES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Ready-to-apply kits (K9, AD-35): kit_prepare and kit_check
  "agents.kits": {
    env: "KRIYA_AGENTS_KITS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // ₹ quotes and caps (K2)
  "agents.quotes": {
    env: "KRIYA_AGENTS_QUOTES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
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
  // Only during a key rotation (runbooks/key-rotation.md)
  "KRIYA_TOKEN_KEY_PREVIOUS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "KRIYA_BROWSER_SECRET",
  // A8 connectors (AB-06: the owner creates the apps)
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  // Voice (phase 3): HMAC key for recipient number hashes (limits, opt-outs)
  "KRIYA_PHONE_HASH_KEY",
] as const

export type SecretName = (typeof SECRETS)[number]

export function getSecret(name: SecretName) {
  return process.env[name]?.trim() || undefined
}

export function secretStatus() {
  return SECRETS.map((name) => ({ name, set: !!getSecret(name) }))
}
