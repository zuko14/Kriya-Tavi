// Production readiness check (A11): configuration and database of the
// environment you point it at; no other outside call. Values are never
// printed, only names, counts and key ids.
//
//   npm run readiness                    configuration only
//   DATABASE_URL=... npm run readiness   + migrations, RLS, sealed values

import postgres from "postgres"

import { configChecks, databaseChecks, GATES, type Check } from "@/lib/readiness"

const env = process.env
const checks: Check[] = configChecks(env)
const url = env.MIGRATION_DATABASE_URL || env.DATABASE_URL

if (url) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    checks.push(
      ...(await databaseChecks(
        async <T>(text: string) => (await sql.unsafe(text)) as unknown as T[],
        env
      ))
    )
  } finally {
    await sql.end()
  }
}

const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" }
for (const check of checks)
  console.log(`${mark[check.status]}  ${check.id}: ${check.detail}`)
console.log("\nGates (SECURITY_AND_COMPLIANCE §6), evidence recorded in status.md:")
for (const gate of GATES) console.log(`  ${gate.id}  ${gate.evidence}  [${gate.here}]`)
process.exit(checks.some((c) => c.status === "fail") ? 1 : 0)
