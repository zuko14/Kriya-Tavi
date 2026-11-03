import { DockerRuntime, PINNED_IMAGE } from "./docker"
import { NODE_ID } from "./protocol"
import { createNodeServer } from "./server"

// kriya-node's entry point on a machine Kriya operates
// (SELF_HOSTED_OPERATIONS_RUNBOOK §2). Configuration is environment only;
// KRIYA_NODE_KEY is this node's derived key (scripts/cloud-node-key.ts),
// never KRIYA_NODE_SECRET. It refuses to start on a bad value, and serves
// /v1/node with ready=false (so it gets no sandboxes) while a security probe
// fails. Listens on loopback; a TLS reverse proxy fronts it.

function env(name: string, pattern: RegExp, fallback?: string) {
  const value = process.env[name] ?? fallback
  if (value === undefined || !pattern.test(value)) {
    console.error(`${name} is missing or invalid`)
    process.exit(1)
  }
  return value
}

const int = (name: string, fallback: string) =>
  Number.parseInt(env(name, /^\d{1,9}$/, fallback), 10)

const nodeId = env("KRIYA_NODE_ID", NODE_ID)
const key = env("KRIYA_NODE_KEY", /^[A-Za-z0-9_-]{43}$/)
delete process.env.KRIYA_NODE_KEY
const runtimeName = env("KRIYA_NODE_RUNTIME", /^(runsc|runc)$/, "runsc") as
  "runsc" | "runc"
const dev = process.env.KRIYA_NODE_DEV === "1"

const runtime = new DockerRuntime({
  image: env("KRIYA_NODE_IMAGE", PINNED_IMAGE),
  runtime: runtimeName,
  network: env("KRIYA_NODE_NETWORK", /^[a-z0-9-]{1,32}$/, "kriya-sbx"),
  publish: dev,
  requireHostFirewall: !dev,
  tmpMb: int("KRIYA_NODE_TMP_MB", "1024"),
})

const node = createNodeServer({
  nodeId,
  key,
  runtime,
  stateDir: env("KRIYA_NODE_STATE_DIR", /^\/[\w./-]+$/, "/var/lib/kriya-node"),
  dataDir: env("KRIYA_NODE_DATA_DIR", /^\/[\w./-]+$/, "/var/lib/docker"),
  reserve: {
    cpuMillis: int("KRIYA_NODE_RESERVE_CPU_MILLIS", "500"),
    memMb: int("KRIYA_NODE_RESERVE_MEM_MB", "1024"),
    diskMb: int("KRIYA_NODE_RESERVE_DISK_MB", "10240"),
  },
  defaults: {
    idleSeconds: int("KRIYA_NODE_IDLE_SECONDS", "900"),
    diskMb: int("KRIYA_NODE_DISK_MB", "10240"),
  },
  // One JSON line per event; no token, key or command text is ever passed
  log: (message, fields) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), message, ...fields })),
})

const probe = await node.reprobe()
console.log(
  JSON.stringify({ message: "probe", ready: probe.ready, reasons: probe.reasons })
)

let sweeps = 0
setInterval(() => {
  sweeps++
  void node.sweep({ usage: sweeps % 4 === 0 }).catch(() => {})
  if (sweeps % 4 === 0) void node.reprobe()
}, 15_000).unref()

const port = int("PORT", "7070")
node.server.listen(
  port,
  dev ? "127.0.0.1" : env("KRIYA_NODE_HOST", /^[\d.:]+$/, "127.0.0.1"),
  () =>
    console.log(JSON.stringify({ message: `kriya-node ${nodeId} listening on ${port}` }))
)

const stop = () => node.server.close(() => process.exit(0))
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
