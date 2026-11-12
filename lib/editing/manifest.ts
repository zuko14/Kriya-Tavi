import { sign } from "node:crypto"

import runtime20261100 from "./runtime/manifest.2026.11.0.json"
import runtime20261101 from "./runtime/manifest.2026.11.1.json"

// The Media Runtime manifest (DECISIONS EDD-05, OPERATIONS_RUNBOOK §2). Each
// version is pinned by hand in lib/editing/runtime/ and signed offline with a
// key that never reaches this service, so a compromised web service can't sign
// a poisoned runtime. A client refuses a manifest with no valid signature.

export type Runtime = typeof runtime20261100
type Signed = { manifest: Runtime; signature: string | null }

// Paste the output of `npx tsx lib/editing/sign.ts sign <key file>` here
export const RUNTIMES: Record<string, Signed> = {
  "2026.11.0": {
    manifest: runtime20261100,
    signature:
      "UNTrNE1MTsxf6PCdnN5fJbkqK4ncz01MBIiSBmbK+q7RlWSaTx0AxJBReMgD5smiW4u3MD01Hf0kQROtA26ABQ==",
  },
  // TP7 (EDD-67, EB-09): 2026.11.0 plus platforms.<id>.packs["pack-fonts"], nothing else
  // moved. Unsigned until the owner signs it offline; no channel names it until then
  "2026.11.1": { manifest: runtime20261101, signature: null },
}

export const CHANNELS: Record<string, string> = {
  stable: "2026.11.0",
  beta: "2026.11.0",
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
  return Object.fromEntries(entries.map(([key, item]) => [key, sorted(item)]))
}

/** The exact text a signature covers: sorted keys, so the same manifest always gives the same bytes. */
export const manifestText = (manifest: Runtime) => JSON.stringify(sorted(manifest))

export function servedManifest(channel: string) {
  const version = CHANNELS[channel]
  const runtime = Object.hasOwn(CHANNELS, channel) ? RUNTIMES[version] : undefined
  if (!runtime) throw new RangeError(`no runtime for channel "${channel}"`)
  return { manifest: manifestText(runtime.manifest), signature: runtime.signature }
}

/** Ed25519, base64. Only lib/editing/sign.ts calls this with a real key, offline. */
export function signManifest(text: string, privateKeyPem: string) {
  return sign(null, Buffer.from(text), privateKeyPem).toString("base64")
}
