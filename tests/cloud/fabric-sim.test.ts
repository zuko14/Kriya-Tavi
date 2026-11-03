import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Load and fairness simulation of the fabric's scheduler (SH6;
// SELF_HOSTED_BENCHMARK_PLAN §4): the real exec_request / exec_admit SQL on
// PGlite, many concurrent "workers" asking for sandboxes of three sizes,
// holding them for a random time and releasing them. Asserted on every run:
// no node is ever over its memory or (overcommitted) CPU, every request ends
// granted or explicitly refused (none lost), the per-person ceiling holds,
// and a greedy tenant gets no more than its share. KRIYA_FABRIC_SIM=1 runs
// the full profile and writes the report (best-fit vs spread placement).
//
// What this does not measure: Postgres on real hardware (PGlite is
// single-threaded WASM, so admit latency here is an upper bound for one
// connection), the node agents, or container start times (benchmark plan §5,
// on the VPS).

const FULL = process.env.KRIYA_FABRIC_SIM === "1"

type Size = { name: "light" | "standard" | "heavy"; cpu: number; mem: number }
const SIZES: Size[] = [
  { name: "light", cpu: 1000, mem: 1024 },
  { name: "standard", cpu: 2000, mem: 4096 },
  { name: "heavy", cpu: 4000, mem: 8192 },
]
// 40% light, 45% standard, 15% heavy
const pick = (r: number, heavy: number) =>
  r < heavy ? SIZES[2] : r < heavy + (1 - heavy) * 0.47 ? SIZES[0] : SIZES[1]

// Deterministic per run (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pct = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const jain = (xs: number[]) => {
  const sum = xs.reduce((a, b) => a + b, 0)
  const sq = xs.reduce((a, b) => a + b * b, 0)
  return sq === 0 ? 1 : (sum * sum) / (xs.length * sq)
}

async function simulate(options: {
  placement: "best-fit" | "spread"
  tenants: number
  loopsPerTenant: number
  greedyLoops: number
  requestsPerLoop: number
  holdMs: [number, number]
  seed: number
  cpuOvercommitPct: number
  heavyShare: number
}) {
  const pg: TestDb = await createTestDb()
  const random = rng(options.seed)
  // Three KVM 4-like nodes: 4 vCPU, 16 GB, 1 GB and 0.5 CPU kept for the host
  for (const id of ["kvm4-a", "kvm4-b", "kvm4-c"])
    await pg.query(
      `insert into kriya.exec_nodes (id, isolation, cpu_millis, mem_mb, disk_mb, disk_free_mb, healthy, stats_at)
       values ($1, 'gvisor', 3500, 15360, 200000, 200000, true, now())`,
      [id]
    )
  const policy = JSON.stringify({
    admission: "on",
    isolation: "gvisor",
    cpuOvercommitPct: options.cpuOvercommitPct,
    maxPerUser: 2,
    maxQueued: 500,
    maxQueuedPerUser: 50,
    starvationSeconds: 3,
    staleSeconds: 3600,
    abandonSeconds: 120,
    psiCpuMax: 100,
    psiMemMax: 100,
    psiIoMax: 100,
    placement: options.placement,
  })

  const tenants = await Promise.all(
    Array.from({ length: options.tenants + 1 }, () => createUser(pg))
  )
  const greedy = tenants[options.tenants]
  const waits: Record<string, number[]> = { light: [], standard: [], heavy: [] }
  const admitMs: number[] = []
  const granted = new Map<string, number>()
  const waitBy: { greedy: number[]; equal: number[] } = { greedy: [], equal: [] }
  const refused: string[] = []
  let violations = 0
  let maxLive = 0
  let generation = 0

  // Capacity and per-person checks, read from the database itself
  async function check() {
    const { rows } = await pg.query<{ over: number }>(
      `select count(*)::int as over from (
         select n.id from kriya.exec_nodes n left join kriya.exec_leases l
           on l.node_id = n.id and l.status in ('granted', 'running')
         group by n.id, n.mem_mb, n.cpu_millis
         having coalesce(sum(l.mem_mb), 0) > n.mem_mb
             or coalesce(sum(l.cpu_millis), 0) > floor(n.cpu_millis * ${options.cpuOvercommitPct / 100})
       ) x`
    )
    const perUser = await pg.query<{ n: number }>(
      `select coalesce(max(c), 0)::int as n from (select count(*) as c from kriya.exec_leases
        where status in ('granted', 'running') group by user_id) x`
    )
    const live = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.exec_leases where status in ('granted', 'running')"
    )
    maxLive = Math.max(maxLive, live.rows[0].n)
    if (rows[0].over > 0 || perUser.rows[0].n > 2) violations++
  }

  async function loop(user: string) {
    const { rows } = await pg.query<{ id: string }>(
      "insert into kriya.workspaces (user_id, provider, image, size, status) values ($1, 'selfhosted', 'i', '2c-4g', 'paused') returning id",
      [user]
    )
    const ws = rows[0].id
    for (let i = 0; i < options.requestsPerLoop; i++) {
      const size = pick(random(), options.heavyShare)
      const asked = Date.now()
      let lease: number
      try {
        const r = await pg.query<{ id: string }>(
          "select kriya.exec_request($1, $2, $3, $4, $5, 1024, null, null, 0, $6) as id",
          [user, ws, ++generation, size.cpu, size.mem, policy]
        )
        lease = Number(r.rows[0].id)
      } catch {
        refused.push(size.name)
        continue
      }
      for (;;) {
        const t = performance.now()
        const r = await pg.query<{ lease_status: string }>(
          "select lease_status from kriya.exec_admit($1, $2)",
          [lease, policy]
        )
        admitMs.push(performance.now() - t)
        if (r.rows[0].lease_status === "granted") break
        if (r.rows[0].lease_status !== "waiting") throw new Error("lease lost")
        await new Promise((res) => setTimeout(res, 15 + random() * 15))
      }
      waits[size.name].push(Date.now() - asked)
      waitBy[user === greedy ? "greedy" : "equal"].push(Date.now() - asked)
      granted.set(user, (granted.get(user) ?? 0) + 1)
      await pg.query(
        "update kriya.exec_leases set status = 'running', started_at = now() where id = $1",
        [lease]
      )
      await check()
      const [lo, hi] = options.holdMs
      await new Promise((res) => setTimeout(res, lo + random() * (hi - lo)))
      await pg.query(
        "update kriya.exec_leases set status = 'released', ended_at = now(), reason = 'done' where id = $1",
        [lease]
      )
    }
  }

  const started = Date.now()
  await Promise.all([
    ...tenants
      .slice(0, options.tenants)
      .flatMap((u) => Array.from({ length: options.loopsPerTenant }, () => loop(u))),
    ...Array.from({ length: options.greedyLoops }, () => loop(greedy)),
  ])
  const seconds = (Date.now() - started) / 1000
  const total = [...granted.values()].reduce((a, b) => a + b, 0)
  const lost = await pg.query<{ n: number }>(
    "select count(*)::int as n from kriya.exec_leases where status in ('waiting', 'granted', 'running')"
  )
  await pg.close()
  const shareSeconds = [...tenants.slice(0, options.tenants)].map(
    (u) => granted.get(u) ?? 0
  )
  return {
    placement: options.placement,
    seed: options.seed,
    cpuOvercommitPct: options.cpuOvercommitPct,
    heavyShare: options.heavyShare,
    seconds,
    requests:
      (options.tenants * options.loopsPerTenant + options.greedyLoops) *
      options.requestsPerLoop,
    granted: total,
    refused: refused.length,
    leftLive: lost.rows[0].n,
    violations,
    maxLive,
    throughputPerSecond: Math.round((total / seconds) * 10) / 10,
    waitMs: Object.fromEntries(
      Object.entries(waits).map(([k, v]) => [
        k,
        { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) },
      ])
    ),
    admitMs: {
      n: admitMs.length,
      p50: Math.round(pct(admitMs, 50)! * 10) / 10,
      p95: Math.round(pct(admitMs, 95)! * 10) / 10,
      p99: Math.round(pct(admitMs, 99)! * 10) / 10,
    },
    fairness: {
      // Every request completes, so totals equal demand; fairness shows in
      // who waits: equal tenants vs one tenant running many more loops
      jainAcrossEqualTenants: Math.round(jain(shareSeconds) * 1000) / 1000,
      equalWaitMs: { p50: pct(waitBy.equal, 50), p95: pct(waitBy.equal, 95) },
      greedyWaitMs: { p50: pct(waitBy.greedy, 50), p95: pct(waitBy.greedy, 95) },
    },
  }
}

describe("CT-SH-LOAD: the scheduler under concurrent load", () => {
  it(
    "never overcommits a node, loses nothing, and keeps a greedy tenant to its share",
    async () => {
      const profile = FULL
        ? {
            tenants: 10,
            loopsPerTenant: 3,
            greedyLoops: 12,
            requestsPerLoop: 8,
            holdMs: [40, 400] as [number, number],
          }
        : {
            tenants: 4,
            loopsPerTenant: 2,
            greedyLoops: 6,
            requestsPerLoop: 3,
            holdMs: [20, 120] as [number, number],
          }
      // cpu-bound: 150% CPU overcommit, 15% heavy; memory-bound: CPU
      // overcommitted 400% so memory binds, 30% heavy (benchmark plan §4)
      const scenarios = FULL
        ? [
            { cpuOvercommitPct: 150, heavyShare: 0.15 },
            { cpuOvercommitPct: 400, heavyShare: 0.3 },
          ]
        : [{ cpuOvercommitPct: 150, heavyShare: 0.15 }]
      const runs = []
      for (const scenario of scenarios)
        for (const placement of FULL
          ? (["best-fit", "spread"] as const)
          : (["best-fit"] as const))
          for (const seed of FULL ? [20261102, 7, 99] : [20261102])
            runs.push(await simulate({ placement, ...profile, ...scenario, seed }))
      for (const r of runs) {
        expect(r.violations).toBe(0)
        expect(r.leftLive).toBe(0)
        expect(r.granted + r.refused).toBe(r.requests)
        // The greedy tenant's extra loops queue behind its own ceiling, not
        // in front of everyone else
        expect(r.fairness.equalWaitMs.p50!).toBeLessThanOrEqual(
          r.fairness.greedyWaitMs.p50!
        )
        expect(r.fairness.jainAcrossEqualTenants).toBeGreaterThan(0.95)
      }
      if (FULL) {
        const out = path.join(process.cwd(), "screenshots", "cloud-execution", "SH6")
        fs.mkdirSync(out, { recursive: true })
        fs.writeFileSync(
          path.join(out, "fabric-sim.json"),
          JSON.stringify({ at: new Date().toISOString(), profile, runs }, null, 2)
        )
        console.log(JSON.stringify(runs, null, 2))
      }
    },
    FULL ? 900_000 : 120_000
  )
})
