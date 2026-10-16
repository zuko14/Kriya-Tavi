// Applies supabase/migrations/*.sql in order, once each, inside a
// transaction per file. Equivalent to `supabase db push` for people without
// the Supabase CLI, and records versions in the same table the CLI uses, so
// the two can be mixed. Use the direct (5432) or session-pooler connection:
//
//   DATABASE_URL=... npm run db:migrate             apply what's pending
//   DATABASE_URL=... npm run db:migrate -- --status list applied / pending
//   DATABASE_URL=... npm run db:migrate -- --dry-run list what would run

import fs from "node:fs"
import path from "node:path"

import postgres from "postgres"

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL
if (!url) {
  console.error("Set DATABASE_URL (or MIGRATION_DATABASE_URL) first.")
  process.exit(1)
}

const dir = path.join(process.cwd(), "supabase", "migrations")
const files = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
const version = (file: string) => file.split("_")[0]
const dryRun = process.argv.includes("--dry-run")
const statusOnly = process.argv.includes("--status")

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

async function main() {
  await sql`create schema if not exists supabase_migrations`
  await sql`create table if not exists supabase_migrations.schema_migrations (
    version text primary key, statements text[], name text)`
  const rows = await sql<{ version: string }[]>`
    select version from supabase_migrations.schema_migrations`
  const applied = new Set(rows.map((row) => row.version))

  if (statusOnly) {
    for (const file of files) {
      console.log(`${applied.has(version(file)) ? "applied" : "pending"}  ${file}`)
    }
    return
  }
  const pending = files.filter((file) => !applied.has(version(file)))
  if (pending.length === 0) {
    console.log("Database is up to date.")
    return
  }
  for (const file of pending) {
    if (dryRun) {
      console.log(`would apply ${file}`)
      continue
    }
    const body = fs.readFileSync(path.join(dir, file), "utf8")
    const name = file
      .replace(/\.sql$/, "")
      .split("_")
      .slice(1)
      .join("_")
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`insert into supabase_migrations.schema_migrations (version, name, statements)
               values (${version(file)}, ${name}, ${[body]})`
    })
    console.log(`applied ${file}`)
  }
}

main()
  .catch((error) => {
    console.error(
      "Migration failed; nothing from the failing file was applied:",
      error.message
    )
    process.exitCode = 1
  })
  .finally(() => sql.end())
