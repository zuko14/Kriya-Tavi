import fs from "node:fs"
import path from "node:path"

import { LEGAL_STATUS } from "@/lib/legal"
import { keyId } from "@/lib/secrets"

// Production readiness checks (A11, SECURITY_AND_COMPLIANCE §6): what can be
// verified from a deployment's own configuration and database, without any
// outside call. `npm run readiness` runs them; the drills in
// docs/agent-platform/runbooks/ use them before and after. Gates that need
// people or other systems (external review, counsel, the pilot) are listed
// as open, never as passed.

export type Check = {
  id: string
  status: "pass" | "warn" | "fail"
  detail: string
}

type Env = Record<string, string | undefined>
export type Query = <T>(sql: string) => Promise<T[]>

const set = (env: Env, name: string) => Boolean(env[name]?.trim())
const bytes = (value: string) => Buffer.from(value.trim(), "base64")
const key32 = (value: string | undefined) => Boolean(value) && bytes(value!).length === 32

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "KRIYA_APP_URL",
  "OPENROUTER_API_KEY",
]

export function configChecks(env: Env): Check[] {
  const checks: Check[] = []
  const missing = REQUIRED_ENV.filter((name) => !set(env, name))
  checks.push(
    missing.length
      ? { id: "env.required", status: "fail", detail: `missing: ${missing.join(", ")}` }
      : { id: "env.required", status: "pass", detail: "required variables set" }
  )

  if (!set(env, "KRIYA_TOKEN_KEY")) {
    checks.push({
      id: "keys.token",
      status: "warn",
      detail: "KRIYA_TOKEN_KEY not set: connected accounts and saved logins are off",
    })
  } else if (!key32(env.KRIYA_TOKEN_KEY)) {
    checks.push({
      id: "keys.token",
      status: "fail",
      detail: "KRIYA_TOKEN_KEY isn't 32 bytes, base64",
    })
  } else {
    checks.push({
      id: "keys.token",
      status: "pass",
      detail: `current key id ${keyId(bytes(env.KRIYA_TOKEN_KEY!))}`,
    })
  }
  if (set(env, "KRIYA_TOKEN_KEY_PREVIOUS")) {
    checks.push(
      key32(env.KRIYA_TOKEN_KEY_PREVIOUS)
        ? {
            id: "keys.rotation",
            status: "warn",
            detail: `rotation under way: previous key id ${keyId(bytes(env.KRIYA_TOKEN_KEY_PREVIOUS!))}; retire it once nothing is sealed with it`,
          }
        : {
            id: "keys.rotation",
            status: "fail",
            detail: "KRIYA_TOKEN_KEY_PREVIOUS isn't 32 bytes, base64",
          }
    )
  }

  if (set(env, "KRIYA_BROWSER_URL")) {
    checks.push(
      (env.KRIYA_BROWSER_SECRET?.trim().length ?? 0) >= 32
        ? { id: "browser.secret", status: "pass", detail: "service secret set" }
        : {
            id: "browser.secret",
            status: "fail",
            detail: "KRIYA_BROWSER_SECRET missing or under 32 characters",
          }
    )
  }
  if (set(env, "KRIYA_BROWSER_LIVE_URL")) {
    checks.push(
      env.KRIYA_BROWSER_LIVE_URL!.trim().startsWith("wss://")
        ? { id: "browser.live", status: "pass", detail: "live view over wss://" }
        : {
            id: "browser.live",
            status: "fail",
            detail: "KRIYA_BROWSER_LIVE_URL must start with wss://",
          }
    )
  }
  checks.push(
    LEGAL_STATUS.draft
      ? {
          id: "legal.reviewed",
          status: "warn",
          detail: "privacy notice, terms and AI disclosure are drafts (GA-7)",
        }
      : { id: "legal.reviewed", status: "pass", detail: "legal pages reviewed" }
  )
  return checks
}

// Migrations applied, row level security on, no anonymous access, and how
// many sealed values each key holds (read from their prefix; nothing is
// opened)
export async function databaseChecks(
  query: Query,
  env: Env,
  migrationsDir = path.join(process.cwd(), "supabase", "migrations")
): Promise<Check[]> {
  const checks: Check[] = []
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.split("_")[0])
  const applied = new Set(
    (
      await query<{ version: string }>(
        "select version from supabase_migrations.schema_migrations"
      ).catch(() => [])
    ).map((r) => r.version)
  )
  const pending = files.filter((v) => !applied.has(v))
  checks.push(
    pending.length
      ? {
          id: "db.migrations",
          status: "fail",
          detail: `not applied: ${pending.join(", ")}`,
        }
      : { id: "db.migrations", status: "pass", detail: `${files.length} applied` }
  )

  const open = await query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'kriya' and c.relkind = 'r' and not c.relrowsecurity`
  )
  checks.push(
    open.length
      ? {
          id: "db.rls",
          status: "fail",
          detail: `no RLS: ${open.map((r) => r.relname).join(", ")}`,
        }
      : { id: "db.rls", status: "pass", detail: "every kriya table has RLS" }
  )

  const [anon] = await query<{ usage: boolean }>(
    "select has_schema_privilege('anon', 'kriya', 'USAGE') as usage"
  )
  checks.push(
    anon?.usage
      ? {
          id: "db.anon",
          status: "fail",
          detail: "the anon role can use the kriya schema",
        }
      : { id: "db.anon", status: "pass", detail: "no anonymous access to kriya" }
  )

  if (key32(env.KRIYA_TOKEN_KEY)) {
    const current = `v2_${keyId(bytes(env.KRIYA_TOKEN_KEY!))}`
    const rows = await query<{ source: string; key: string; n: number }>(
      `select source, key, count(*)::int as n from (
         select 'login_profiles' as source, split_part(state_sealed, '.', 1) as key
           from kriya.login_profiles where state_sealed is not null
         union all select 'connections', split_part(access_token, '.', 1) from kriya.connections
         union all select 'connections', split_part(refresh_token, '.', 1)
           from kriya.connections where refresh_token is not null
       ) s group by source, key order by source, key`
    )
    const old = rows.filter((r) => r.key !== current)
    checks.push(
      old.length === 0
        ? {
            id: "keys.sealed",
            status: "pass",
            detail: "every sealed value uses the current key",
          }
        : {
            id: "keys.sealed",
            status: "warn",
            detail: `on older keys: ${old.map((r) => `${r.source} ${r.key} ×${r.n}`).join("; ")}`,
          }
    )
  }
  return checks
}

// Gates GA-1…GA-8 (SECURITY_AND_COMPLIANCE §6): the evidence each needs and
// whether this repository alone can produce it
export const GATES = [
  {
    id: "GA-1",
    evidence: "Every AT- test passes",
    here: "partly: built phases pass (npm run check + browser suites); A10 tests not written; A12 tested on test data",
  },
  {
    id: "GA-2",
    evidence: "AS-SEC: 0 unapproved commits, exfiltrations or R5 actions over ≥ 200 runs",
    here: "partly: scripted fixture runs; the 200-run model suite is paid",
  },
  {
    id: "GA-3",
    evidence: "Egress guard verified on the deployed kriya-browser",
    here: "no: staging",
  },
  {
    id: "GA-4",
    evidence: "Restore drill with RPO/RTO measured",
    here: "no: staging (runbooks/restore.md)",
  },
  {
    id: "GA-5",
    evidence: "Key rotation rehearsed on staging",
    here: "code tested; drill on staging (runbooks/key-rotation.md)",
  },
  {
    id: "GA-6",
    evidence: "External security review, no open critical or high",
    here: "no: reviewer",
  },
  {
    id: "GA-7",
    evidence: "Counsel answers AQ-1…AQ-6; legal pages updated",
    here: "drafts only: counsel",
  },
  { id: "GA-8", evidence: "A10 pilot thresholds met", here: "no: A10" },
] as const
