// The isolated-stack guard (P-3, docs/operator/UI_VERIFICATION.md §3). Run
// first in every verification session, with .env.verify exported:
//
//   set -a; source .env.verify; set +a; npm run verify:guard
//
// Exits 1 with the reasons when the environment could reach the live
// database, place a real call or spend money. Prints names and reasons
// only, never a value.

import fs from "node:fs"

// The live Supabase project (UI_VERIFICATION §1)
const LIVE_REF = "kiyfofxkechnzeeluhtv"
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"])
// shortcut: no staging exception (KRIYA_VERIFY_STAGING_REF) until a staging project exists (OB-01)
const URLS = ["DATABASE_URL", "MIGRATION_DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]
const REQUIRED = ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]

type Env = Record<string, string | undefined>
const has = (value: string | undefined) => Boolean(value?.trim())

function hostOf(value: string) {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

// Names set in an env file, from `NAME=...` lines (values are never read out)
export function envFileNames(text: string) {
  return text
    .split("\n")
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
}

export function problems(env: Env, fileNames: string[]) {
  const found: string[] = []
  for (const name of URLS) {
    const value = env[name]
    if (!has(value)) {
      if (REQUIRED.includes(name)) found.push(`${name} is not set.`)
      continue
    }
    if (value!.includes(LIVE_REF)) found.push(`${name} points at the live project.`)
    else if (!LOCAL_HOSTS.has(hostOf(value!) ?? ""))
      found.push(`${name} points at a host that isn't 127.0.0.1 or localhost.`)
  }
  if (has(env.KRIYA_VOICE_LIVE))
    found.push("KRIYA_VOICE_LIVE is set: no live calls here.")
  for (const name of Object.keys(env)
    .filter((n) => n.startsWith("EXOTEL_"))
    .sort())
    if (has(env[name])) found.push(`${name} is set: no live calls here.`)
  if (has(env.OPENROUTER_API_KEY) && env.KRIYA_VERIFY_PAID !== "1") {
    const base = env.OPENROUTER_BASE_URL
    if (!has(base) || !LOCAL_HOSTS.has(hostOf(base!) ?? ""))
      found.push(
        "OPENROUTER_API_KEY is set without the local stub in OPENROUTER_BASE_URL (would spend money)."
      )
  }
  // OF-17: Next.js fills any name left undefined from .env and .env.local
  for (const name of [...new Set(fileNames)].sort())
    if (env[name] === undefined)
      found.push(`${name} would be loaded from .env/.env.local: set it in .env.verify.`)
  return found
}

if (process.argv[1]?.endsWith("verify-guard.ts")) {
  const names = [".env", ".env.local"].flatMap((file) =>
    fs.existsSync(file) ? envFileNames(fs.readFileSync(file, "utf8")) : []
  )
  const found = problems(process.env, names)
  if (found.length > 0) {
    console.error(`verify:guard refused:\n- ${found.join("\n- ")}`)
    process.exit(1)
  }
  console.log("verify:guard OK: local database, local auth, no live calls, stub model.")
}
