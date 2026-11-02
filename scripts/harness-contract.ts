// Writes docs/kriya-harness/contract.json from lib/harness/contract.ts (the
// client repository tests against it; HT-API-01 fails while it's stale):
//
//   npx tsx scripts/harness-contract.ts && npx prettier --write docs/kriya-harness/contract.json

import fs from "node:fs"
import path from "node:path"

import { contractJson } from "@/lib/harness/contract"

const file = path.join(process.cwd(), "docs", "kriya-harness", "contract.json")
fs.writeFileSync(file, `${JSON.stringify(contractJson(), null, 2)}\n`)
console.log(`wrote ${path.relative(process.cwd(), file)}`)
