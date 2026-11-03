import fs from "node:fs"

import { NODE_ID, nodeKey } from "@/cloud-node/protocol"

// Writes one kriya-node's key (CD-36) to a file only the owner can read, for
// /etc/kriya-node/env on that machine. Derived from KRIYA_NODE_SECRET, which
// never leaves the worker; the key is never printed (invariant 4).
//
//   KRIYA_NODE_SECRET=… npx tsx scripts/cloud-node-key.ts <node-id> <file>

const [nodeId, file] = process.argv.slice(2)
const secret = process.env.KRIYA_NODE_SECRET ?? ""
if (!nodeId || !NODE_ID.test(nodeId) || !file) {
  console.error("usage: cloud-node-key.ts <node-id> <file>")
  process.exit(1)
}
if (secret.length < 32) {
  console.error("KRIYA_NODE_SECRET must be set (32+ characters)")
  process.exit(1)
}
fs.writeFileSync(
  file,
  `KRIYA_NODE_ID=${nodeId}\nKRIYA_NODE_KEY=${nodeKey(secret, nodeId)}\n`,
  {
    mode: 0o600,
    flag: "wx",
  }
)
console.log(`Wrote ${file} (mode 0600) for node ${nodeId}.`)
