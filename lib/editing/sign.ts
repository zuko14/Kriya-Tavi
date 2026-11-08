import { generateKeyPairSync } from "node:crypto"
import fs from "node:fs"

import { manifestText, RUNTIMES, signManifest } from "./manifest"

// The owner's offline signing step (OPERATIONS_RUNBOOK §2), run on their own
// machine, never on a server. The key file stays out of every repository.
//
//   npx tsx lib/editing/sign.ts keygen <key file>
//     writes a new private key and prints the public key for TRUSTED_KEYS in
//     the client's src/edit/runtime/manifest.js
//   npx tsx lib/editing/sign.ts sign <key file>
//     prints each version's signature for RUNTIMES in lib/editing/manifest.ts

const [command, file] = process.argv.slice(2)

if (command === "keygen" && file) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  // wx: an existing key is never overwritten
  fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" })
  console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"))
} else if (command === "sign" && file) {
  const pem = fs.readFileSync(file, "utf8")
  for (const [version, { manifest }] of Object.entries(RUNTIMES)) {
    console.log(`${version} ${signManifest(manifestText(manifest), pem)}`)
  }
} else {
  console.error("Usage: sign.ts keygen <key file> | sign <key file>")
  process.exitCode = 1
}
