// Adds models to the registry (kriya.models) with prices and declared
// capabilities from OpenRouter's public catalogue. With no arguments it syncs
// every model the routing settings point at.
//
//   DATABASE_URL=... npm run models:sync
//   DATABASE_URL=... npm run models:sync -- deepseek/deepseek-v4.1-flash-1017 google/gemini-3.1-flash-lite

import { getSetting } from "@/lib/config"
import { syncCatalogue } from "@/lib/models"

async function main() {
  const fromArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const routed = await Promise.all(
    (
      [
        "routing.budget",
        "routing.balanced",
        "routing.escalation",
        "routing.fallback",
      ] as const
    ).map((key) => getSetting(key))
  )
  const ids = [
    ...new Set(fromArgs.length ? fromArgs : routed.filter((id): id is string => !!id)),
  ]
  if (ids.length === 0) {
    console.error(
      "No models given and no routing models configured (OPENROUTER_DEFAULT_MODEL…)."
    )
    process.exit(1)
  }
  const result = await syncCatalogue(ids)
  console.log(
    `Synced ${result.updated} model(s): ${ids.filter((id) => !result.missing.includes(id)).join(", ")}`
  )
  if (result.missing.length)
    console.warn(`Not in the catalogue: ${result.missing.join(", ")}`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
