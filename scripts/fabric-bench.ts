import fs from "node:fs"
import path from "node:path"

import postgres from "postgres"

// The fabric scheduler on a real Postgres (SELF_HOSTED_BENCHMARK_PLAN §4.2):
// many concurrent waiters, each on a pooled connection, polling exec_admit,
// holding a lease for a random time and releasing it. Measures admit latency
// and lease waits by queue depth, and checks after every grant that no node
// is over capacity. Refuses any database that isn't on this machine
// (operator rule 6): it drops and recreates its own database.
//
//   FABRIC_BENCH_URL=postgres://postgres:…@127.0.0.1:55432/postgres npx tsx scripts/fabric-bench.ts

const url = new URL(process.env.FABRIC_BENCH_URL ?? "")
if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
  console.error("FABRIC_BENCH_URL must point at 127.0.0.1 or localhost")
  process.exit(1)
}
const DB = "kriya_fabric_bench"
const LEVELS = (process.env.FABRIC_BENCH_LEVELS ?? "10,50,100,250").split(",").map(Number)
const PER_WAITER = Number(process.env.FABRIC_BENCH_REQUESTS ?? "6")

const SHIM = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb, email_confirmed_at timestamptz,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid $$;
`

const SIZES = [
  { name: "light", cpu: 1000, mem: 1024 },
  { name: "standard", cpu: 2000, mem: 4096 },
  { name: "heavy", cpu: 4000, mem: 8192 },
] as const
const pick = () => {
  const r = Math.random()
  return r < 0.4 ? SIZES[0] : r < 0.85 ? SIZES[1] : SIZES[2]
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return (
    Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10
  )
}

async function setup() {
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`drop database if exists ${DB} with (force)`)
  await admin.unsafe(`create database ${DB}`)
  await admin.end()
  const target = new URL(url)
  target.pathname = `/${DB}`
  const sql = postgres(target.toString(), { max: 1, onnotice: () => {} })
  await sql.unsafe(SHIM)
  const dir = path.join(process.cwd(), "supabase", "migrations")
  for (const file of fs.readdirSync(dir).sort())
    await sql.unsafe(fs.readFileSync(path.join(dir, file), "utf8"))
  await sql.end()
  return target.toString()
}

async function level(target: string, waiters: number) {
  const pool = postgres(target, { max: Math.min(waiters, 40), onnotice: () => {} })
  await pool`delete from kriya.exec_leases`
  await pool`delete from kriya.exec_nodes`
  for (const id of ["kvm4-a", "kvm4-b", "kvm4-c"])
    await pool`insert into kriya.exec_nodes (id, isolation, cpu_millis, mem_mb, disk_mb, disk_free_mb, healthy, stats_at)
               values (${id}, 'gvisor', 3500, 15360, 200000, 200000, true, now() + interval '1 hour')`
  const tenants = Math.max(5, Math.round(waiters / 3))
  const users: string[] = []
  for (let i = 0; i < tenants; i++) {
    const [u] =
      await pool`insert into auth.users (id, email) values (gen_random_uuid(), ${`b${waiters}-${i}@bench.local`}) returning id`
    users.push(u.id)
  }
  const policy = {
    admission: "on",
    isolation: "gvisor",
    cpuOvercommitPct: 150,
    maxPerUser: 2,
    maxQueued: 1000,
    maxQueuedPerUser: 100,
    starvationSeconds: 5,
    staleSeconds: 7200,
    abandonSeconds: 120,
    psiCpuMax: 100,
    psiMemMax: 100,
    psiIoMax: 100,
  }
  const admitMs: number[] = []
  const requestMs: number[] = []
  const waits: Record<string, number[]> = { light: [], standard: [], heavy: [] }
  let violations = 0
  let errors = 0
  let maxDepth = 0
  let gen = 0

  async function waiter(i: number) {
    const user = users[i % users.length]
    const [ws] =
      await pool`insert into kriya.workspaces (user_id, provider, image, size, status)
                            values (${user}, 'selfhosted', 'i', '2c-4g', 'paused') returning id`
    for (let n = 0; n < PER_WAITER; n++) {
      const size = pick()
      const asked = performance.now()
      let lease: number
      try {
        const t = performance.now()
        const [r] =
          await pool`select kriya.exec_request(${user}, ${ws.id}, ${++gen}, ${size.cpu}, ${size.mem}, 1024, null, null, 0, ${pool.json(policy)}) as id`
        requestMs.push(performance.now() - t)
        lease = Number(r.id)
      } catch {
        errors++
        continue
      }
      for (;;) {
        const t = performance.now()
        const [r] =
          await pool`select lease_status from kriya.exec_admit(${lease}, ${pool.json(policy)})`
        admitMs.push(performance.now() - t)
        if (r.lease_status === "granted") break
        if (r.lease_status !== "waiting") throw new Error(`lease ${r.lease_status}`)
        await new Promise((res) => setTimeout(res, 20 + Math.random() * 20))
      }
      waits[size.name].push(performance.now() - asked)
      await pool`update kriya.exec_leases set status = 'running', started_at = now() where id = ${lease}`
      const [over] = await pool`select count(*)::int as n from (
          select n.id from kriya.exec_nodes n left join kriya.exec_leases l
            on l.node_id = n.id and l.status in ('granted', 'running')
          group by n.id, n.mem_mb, n.cpu_millis
          having coalesce(sum(l.mem_mb), 0) > n.mem_mb or coalesce(sum(l.cpu_millis), 0) > floor(n.cpu_millis * 1.5)) x`
      if (over.n > 0) violations++
      const [depth] =
        await pool`select count(*)::int as n from kriya.exec_leases where status = 'waiting'`
      maxDepth = Math.max(maxDepth, depth.n)
      await new Promise((res) => setTimeout(res, 50 + Math.random() * 450))
      await pool`update kriya.exec_leases set status = 'released', ended_at = now() where id = ${lease}`
    }
  }

  const started = performance.now()
  await Promise.all(Array.from({ length: waiters }, (_, i) => waiter(i)))
  const seconds = (performance.now() - started) / 1000
  const [left] =
    await pool`select count(*)::int as n from kriya.exec_leases where status in ('waiting','granted','running')`
  await pool.end()
  const granted = Object.values(waits).reduce((a, w) => a + w.length, 0)
  return {
    waiters,
    tenants,
    connections: Math.min(waiters, 40),
    requests: waiters * PER_WAITER,
    granted,
    refused: errors,
    leftLive: left.n,
    violations,
    maxQueueDepth: maxDepth,
    seconds: Math.round(seconds * 10) / 10,
    grantsPerSecond: Math.round((granted / seconds) * 10) / 10,
    admitCallsPerSecond: Math.round(admitMs.length / seconds),
    admitMs: {
      n: admitMs.length,
      p50: pct(admitMs, 50),
      p95: pct(admitMs, 95),
      p99: pct(admitMs, 99),
    },
    requestMs: {
      p50: pct(requestMs, 50),
      p95: pct(requestMs, 95),
      p99: pct(requestMs, 99),
    },
    waitMs: Object.fromEntries(
      Object.entries(waits).map(([k, v]) => [
        k,
        { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) },
      ])
    ),
  }
}

const target = await setup()
const results = []
for (const waiters of LEVELS) {
  const r = await level(target, waiters)
  console.log(JSON.stringify(r))
  results.push(r)
}
const admin = postgres(url.toString(), { max: 1 })
const [version] = await admin`select version() as v`
await admin.unsafe(`drop database if exists ${DB} with (force)`)
await admin.end()
const out = path.join(process.cwd(), "screenshots", "cloud-execution", "SH6")
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(
  path.join(out, "fabric-bench-postgres.json"),
  JSON.stringify(
    { at: new Date().toISOString(), postgres: version.v, perWaiter: PER_WAITER, results },
    null,
    2
  )
)
const bad = results.filter(
  (r) => r.violations || r.leftLive || r.granted + r.refused !== r.requests
)
process.exit(bad.length ? 1 : 0)
