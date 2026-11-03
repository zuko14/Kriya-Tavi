import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { z } from "zod"

// The kriya-node protocol (CD-28, CD-31, CD-36; SELF_HOSTED_ARCHITECTURE §4):
// the worker's lifecycle calls to one machine Kriya operates, and the proxy
// path to the runner in each sandbox there. Shared by the node agent and the
// worker's `selfhosted` adapter, so it imports only Node built-ins and zod
// (CT-SH-IMP-01). Nothing here holds or derives anything but a node's key.

export const NODE_PROTOCOL = "kriya-node/1"
export const NODE_AGENT_VERSION = "kriya-node/1.0.0"

export const HEADERS = {
  ts: "x-kriya-node-ts",
  nonce: "x-kriya-node-nonce",
  sig: "x-kriya-node-sig",
  proxy: "x-kriya-proxy",
  fence: "x-kriya-fence",
} as const

// Requests older or newer than this are refused (clock skew allowance)
export const SKEW_MS = 60_000

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
export const NODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
// sh-<node>-<workspace>-<generation>; the SQL check in exec_leases matches
export const REF = new RegExp(`^sh-([a-z0-9][a-z0-9-]{0,31})-(${UUID})-(\\d{1,9})$`)

export function parseRef(ref: string) {
  const match = REF.exec(ref)
  return match
    ? { nodeId: match[1], workspaceId: match[2], generation: Number(match[3]) }
    : null
}

export const refOf = (nodeId: string, workspaceId: string, generation: number) =>
  `sh-${nodeId}-${workspaceId}-${generation}`

// One node's key, derived from KRIYA_NODE_SECRET (worker only): the node
// holds its own key and never the secret, so one node's key opens no other
export const nodeKey = (secret: string, nodeId: string) =>
  createHmac("sha256", secret).update(`kriya-node:${nodeId}`).digest("base64url")

const sha256 = (body: string | Uint8Array) =>
  createHash("sha256").update(body).digest("hex")

export function signature(
  key: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string | Uint8Array
) {
  return createHmac("sha256", key)
    .update(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256(body)}`)
    .digest("base64url")
}

export function signedHeaders(
  key: string,
  method: string,
  path: string,
  body: string | Uint8Array,
  now = Date.now()
) {
  const ts = String(now)
  const nonce = randomBytes(16).toString("base64url")
  return {
    [HEADERS.ts]: ts,
    [HEADERS.nonce]: nonce,
    [HEADERS.sig]: signature(key, method, path, ts, nonce, body),
  }
}

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// The runner proxy's credential for one sandbox at one fence: a holder of an
// older fence can't forge a newer one without the node's key
export const proxyToken = (key: string, ref: string, fence: number) =>
  createHmac("sha256", key).update(`proxy:${ref}:${fence}`).digest("base64url")

export const NETWORKS = ["registries", "offline"] as const

export const openSchema = z
  .object({
    ref: z.string().regex(REF),
    workspaceId: z.string().regex(new RegExp(`^${UUID}$`)),
    generation: z.number().int().min(0).max(999_999_999),
    fence: z.number().int().positive(),
    cpuMillis: z.number().int().min(100).max(64_000),
    memMb: z.number().int().min(256).max(262_144),
    diskMb: z.number().int().min(256).max(1_048_576),
    pids: z.number().int().min(64).max(32_768),
    network: z.enum(NETWORKS),
    idleSeconds: z.number().int().min(60).max(86_400),
    fresh: z.boolean(),
    // The runner's whole environment from Kriya (CD-09): only ever the
    // container's environment, never an argument, label or log
    env: z.object({
      KRIYA_RUNNER_TOKEN: z.string().min(20).max(200),
      KRIYA_RUNNER_LIMITS: z.string().max(4096),
      KRIYA_RUNNER_GENERATION: z.string().regex(/^\d{1,9}$/),
    }),
  })
  .refine((o) => {
    const ref = parseRef(o.ref)
    return (
      ref?.workspaceId === o.workspaceId &&
      ref.generation === o.generation &&
      o.env.KRIYA_RUNNER_GENERATION === String(o.generation)
    )
  }, "ref, workspace and generation disagree")
export type OpenRequest = z.infer<typeof openSchema>

export const fencedSchema = z.object({
  ref: z.string().regex(REF),
  fence: z.number().int().positive(),
})

// Destroy without a fence is the reconcile of a sandbox no lease knows
export const destroySchema = z.object({
  ref: z.string().regex(REF),
  fence: z.number().int().positive().optional(),
})

export type NodeStats = {
  protocol: typeof NODE_PROTOCOL
  agentVersion: string
  nodeId: string
  ready: boolean
  reasons: string[]
  isolation: "gvisor" | "runc" | null
  imageDigest: string | null
  // Allocatable after the node's reserve
  cpuMillis: number
  memMb: number
  diskMb: number
  // Measured now
  memAvailableMb: number | null
  diskFreeMb: number | null
  inodesFree: number | null
  psi: { cpu: number | null; memory: number | null; io: number | null }
  load1: number | null
  containers: number
  running: number
}

export type ListedSandbox = { ref: string; running: boolean; fence: number | null }
