# Self-hosted execution fabric: benchmark plan and results

What is measured, how, against which thresholds — and what has actually
been measured so far (2026-11-02, on the owner's Mac; **no VPS yet**).
Extends `EVALUATION_PLAN.md` (M1–M11, workloads W1–W3), whose bake-off
method still decides between providers.

## 1. Questions

1. Does admission stay correct (no overcommit, no lost or duplicated lease,
   fair across people) under concurrent load? *(answered locally, §4)*
2. Does the scheduler stay cheap as queues grow? *(answered locally, §4.2)*
3. What does one node actually hold per workload class with gVisor, and
   where is the failure cliff? *(VPS, §5)*
4. What does a successful task cost on self-hosted vs managed? *(VPS +
   owner prices, §6)*

## 2. Workloads

| Class | Size (`cloud.size`) | Representative commands | Source |
| --- | --- | --- | --- |
| Light | `1c-1g` | `ls`, `rg`, small reads/edits, `node -e` | W1 of EVALUATION_PLAN |
| Standard | `2c-4g` | `npm ci` (cache warm), targeted `vitest`, `pytest -k` | W2 |
| Heavy | `4c-8g` | `npm ci` cold, `next build`, full test suite | W3 |
| Adversarial | any | fork bomb, memory balloon, disk fill, egress probes | CT-ISO-*, CT-SH-DOCKER-* |

Repositories: the fixture repository (`tests/fixtures/cloud/repo`) and a
synthetic Node/TypeScript and Python repository the owner controls (CB-04).
No customer repository or secret.

## 3. Metrics

Queue wait p50/p95/p99 by class; admit call latency; grants/s; workspace
start (create → healthy), resume, checkpoint, exec round trip; CPU seconds,
peak RSS, disk bytes per task; OOM and pids events; node PSI over time;
start-failure and busy-refusal rates; cost per successful task.

## 4. Results so far (local)

### 4.1 Scheduler correctness and fairness on PGlite (`tests/cloud/fabric-sim.test.ts`, `KRIYA_FABRIC_SIM=1`)

Three nodes shaped like a KVM 4 (3500 m CPU, 15 GB allocatable), 10 equal
tenants × 3 loops + one greedy tenant × 12 loops, 8 requests each (336
requests per run), sizes 40/45/15% light/standard/heavy, hold 40–400 ms,
`maxPerUser` 2, `starvationSeconds` 3. Three seeds per configuration.
Report: `screenshots/cloud-execution/SH6/fabric-sim.json`.

| Scenario | Placement | Grants/s | Max live | Overcommit violations | Lost leases | Light wait p50 / p95 | Standard p50 / p95 | Heavy p50 / p95 | Equal tenants p50 | Greedy p50 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: |
| CPU-bound (150%) | best-fit | 24.2 | 13 | 0 | 0 | 118 / 1114 ms | 718 / 2465 | 2398 / 3219 | 283 ms | 1092 ms |
| CPU-bound (150%) | spread | 24.6 | 13 | 0 | 0 | 64 / 1089 | 761 / 2730 | 2492 / 3385 | 206 | 1090 |
| Memory-bound (400%, 30% heavy) | best-fit | 25.6 | 18 | 0 | 0 | 2 / 1031 | 273 / 1766 | 1479 / 3117 | 148 | 993 |
| Memory-bound (400%, 30% heavy) | spread | 26.0 | 18 | 0 | 0 | 2 / 1107 | 237 / 1463 | 1612 / 3066 | 111 | 1004 |

Findings: (1) capacity and the per-person ceiling held at every grant
(checked against the database after each one); (2) every request ended
granted (0 refused at these queue caps); (3) fairness — the greedy tenant's
extra loops wait behind its own ceiling (p50 ≈ 1 s) while equal tenants are
served first (p50 0.1–0.3 s); Jain index across equal tenants 1.0; (4)
**best-fit and spread are within noise at this scale** (n = 3 seeds; an
earlier claim in the audit that best-fit admits more large requests was not
supported and has been corrected). Best-fit stays the default because it
packs work onto fewer nodes, leaving whole nodes free to drain or scale
down — an operational benefit, not a measured latency one.

### 4.2 Scheduler on real Postgres 17 (`scripts/fabric-bench.ts`)

Supabase's Postgres 17.11 image in local Docker (throwaway database,
loopback only), 40 pooled connections, three KVM 4-shaped nodes, 6
requests per waiter, hold 50–500 ms, polling every 20–40 ms (10× more
aggressive than production's 250 ms → 2 s backoff). Report:
`screenshots/cloud-execution/SH6/fabric-bench-postgres.json`.

| Concurrent waiters | Design | Grants/s | Admit p50 / p95 / p99 | Admit calls/s | Violations | Lost |
| ---: | --- | ---: | --- | ---: | ---: | ---: |
| 10 | v1 (every poll runs a pass under a blocking lock) | 25.8 | 0.9 / 4.8 / 7.0 ms | 76 | 0 | 0 |
| 50 | v1 | 22.8 | 19.9 / 63.3 / 69.8 | 528 | 0 | 0 |
| 100 | v1 | 16.1 | 21.2 / 178 / 513 | 1126 | 0 | 0 |
| 250 | v1 | **6.5** | 183 / 539 / 700 | 909 | 0 | 0 |
| 10 | v2 (try-lock, one pass, skip when nothing changed) | 17.8 | 0.9 / 2.4 / 3.5 ms | 93 | 0 | 0 |
| 50 | v2 | 24.4 | 0.6 / 1.0 / 1.5 | 972 | 0 | 0 |
| 100 | v2 | 23.7 | 0.7 / 1.2 / 1.7 | 2575 | 0 | 0 |
| 250 | v2 | **22.4** | 0.9 / 1.5 / 1.9 | 7279 | 0 | 0 |

v1 collapsed under its own polling (a thundering herd on one lock); v2,
now in the migration, keeps throughput at what node capacity allows (≈ 22–25
grants/s for these holds) and admit p99 under 2 ms at 250 waiters. The 10-
waiter row is demand-bound, not a regression. Production polling (≥ 250 ms)
puts 50 queued waiters at ≤ 200 calls/s worst case, ≈ 25/s steady.

### 4.3 Vertical slice on Docker (`tests/cloud/selfhosted-docker.test.ts`)

Real `cloud-node/index.ts` process (dev mode, runc) on Docker Desktop
29.9.2 (Linux 7.0.14 linuxkit, cgroup v2, arm64), real runner image
`kriya-runner:c9` (`sha256:0f0b936c…`), control-plane code on PGlite,
`1c-1g`. Report: `screenshots/cloud-execution/SH6/selfhosted-docker-slice.json`.
One run (n = 1 for open/resume; n = 20 for exec):

| Step | Latency |
| --- | ---: |
| Open (admission + container create/start + runner health + fixture import) | 457 ms |
| Checkpoint + pause (stop) | 150 ms |
| Resume (new lease + start + health) | 391 ms |
| Exec round trip through the node proxy (`true`) | p50 19 ms, p95 21 ms, max 22 ms |

These are laptop numbers under runc, not gVisor and not the VPS.

## 5. On the VPS (owner-gated: OA-1…OA-3)

1. Probe and record (`probe-host.sh`).
2. **Overhead:** idle sandbox RSS and start time, runc vs runsc, n = 30
   each; gVisor's memory overhead feeds `KRIYA_NODE_RESERVE_MEM_MB` and the
   size table.
3. **Isolation:** CT-ISO-01…08 and CT-SH-DOCKER-01…07 with `runsc`
   (runbook §2 step 6). Any failure → node stays `trusted-runc`.
4. **Capacity per class:** for light, standard, heavy separately, raise
   concurrent sandboxes 1, 2, 3, … running the class's commands in a loop
   for 10 minutes each; stop at the first of: PSI memory some avg10 > 10,
   any OOM outside a deliberate balloon, p95 command time > 2× the
   single-sandbox p95, start failures. Operating envelope = last passing
   level − 1.
5. **Mixed:** 40/45/15 mix at 50%, 75%, 100% of the envelope for 30 min;
   queue wait p50/p95/p99, start success, PSI graphs.
6. **Failure injection** (runbook §11 drills) during the mixed run.
7. **Logical sessions:** 10, 25, 50, 100, 250, 500 threads with workspaces,
   of which only the active fraction holds sandboxes; confirm idle ones
   hold no CPU/memory (they hold rows and paused disks: measure disk).

Acceptance (staging): start success ≥ 99% of admitted starts; queue wait
p95 ≤ 30 s at 75% of the envelope; 0 overcommit violations; 0 lost leases;
0 isolation probe failures; cleanup leaves no container or volume after
close.

### 5.1 Admission ceiling from configuration (not a measurement)

With the defaults (reserve 0.5 CPU and 1 GB; `cpuOvercommitPct` 150) and a
KVM 4 **as advertised** (4 vCPU, 16 GB — UNKNOWN until probed), admission
allows at most: light `1c-1g` 5, standard `2c-4g` 2, heavy `4c-8g` 1
concurrently (CPU binds before memory). Disk: (disk − 10 GB reserve) /
`selfhosted.diskGb` sandboxes, running or paused. These ceilings are where
the scheduler stops granting, not proof the node performs well there; §5
step 4 decides the real envelope and may lower the sizes or overcommit.

## 6. Cost model

`cost_per_successful_task = (node rent + backups + egress + share of
control plane, Storage, logs + operator time) / successfully verified
eligible tasks` over the same period, per class and per plan. Inputs the
owner enters from current price pages (Kriya never invents a price,
invariant 6): VPS monthly and renewal rent, snapshot/backup price, egress
allowance and overage, E2B/Daytona per-second prices for the same size.
Outputs from §5: tasks/hour per class at the envelope, success rate,
utilisation (busy sandbox-seconds / available sandbox-seconds).

Decision rule: self-hosted is the default for an eligible class only when
its cost per successful task is lower than the managed provider's at the
measured utilisation **and** its start-success and queue-wait SLOs hold;
a second node is justified only by an SLO breach at ≥ 75% utilisation or
an availability target one node can't meet (architecture §8).
