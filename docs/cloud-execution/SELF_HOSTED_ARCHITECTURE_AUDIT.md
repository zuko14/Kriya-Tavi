# Self-hosted execution fabric: repository audit and architecture decision

Spec: `docs/kriya_self_hosted_ecxecution_fabric.md` (untracked, owner's
brief, left as it is). Audit made 2026-11-02 on `main` at `455bc43`, in
place, with the owner's uncommitted change `supabase/.temp/cli-latest`
preserved. Decisions are CD-28…CD-37 in `DECISIONS.md`; the target
architecture is in `SELF_HOSTED_ARCHITECTURE.md`.

## 1. Baseline

| Item | Finding |
| --- | --- |
| Branch, commit | `main`, `455bc43` (docs(status): Skills page …) |
| Working tree | `M supabase/.temp/cli-latest` (owner's, untouched); `?? docs/kriya_self_hosted_ecxecution_fabric.md` (the brief) |
| CI | No CI workflow runs `npm run check` for track C; the gate is `env -u OPENROUTER_API_KEY npm run check` run locally (status.md). Result before any change is recorded in status.md "Phase SH0" |
| Production flags | Repository defaults: `cloud.workspaces=off`, `cloud.provider=none`, `cloud.publish=off`, `harness.*=off` (`lib/config.ts`). Deployed values are **UNKNOWN** from the repository (they live in Render env and `kriya.settings`); verify on `/owner/config` |
| E2B / Daytona | Adapters built (C8), tested against fixtures from published API descriptions only, never against a live account (CB-02). No provider chosen; CR-2 open |
| Render / Supabase | `render.yaml`: `kriya-web`, `kriya-worker`, `kriya-browser` (pserv), `kriya-voice`, `kriya-relay`. One Postgres (Supabase), Storage bucket `kriya-files`. Render services cannot start containers (CD-06 evidence) |
| Local tooling here | Node 24.22, PGlite for tests, Docker Desktop (started for this work), no native Postgres, no gVisor (`runsc`), no Hostinger access |

## 2. What already exists (and maps onto the brief)

| Brief concept (§) | Existing implementation | Verdict |
| --- | --- | --- |
| Durable task queue, leases, per-tenant fairness (§5.1, §5.3) | `kriya.tasks` + `claim_task` (`FOR UPDATE SKIP LOCKED`, least-running-user first, plan `max_concurrent_tasks`), `heartbeat_task`, `recover_tasks` (side-effect-aware) — `supabase/migrations/20261016000000_kriya_core.sql` | **Reuse unchanged.** Protected by every track (CD-02). A second queue would be a second owner of task state |
| Agent reasoning event-driven, not resident (§3.1) | The model loop runs in `kriya-worker` (`runTask`); a sandbox exists only from the first `workspace_*` call to the end of the turn, then is checkpointed and paused (CD-16) | **Already true.** Logical sessions (threads, waiting approvals) hold no compute |
| Provider abstraction (§4.3) | `WorkspaceProvider` (`lib/cloud/provider.ts`): create/resume/pause/destroy/extend/list; adapters `local`, `e2b`, `daytona`, `device` | **Extend** with one adapter, `selfhosted` |
| Narrow worker protocol into the sandbox (§4.4) | The runner protocol (`runner/protocol.ts`, CD-05, CD-26): bearer token derived per workspace and generation (`lib/cloud/token.ts`), no DB, no secret | **Reuse unchanged** inside the self-hosted container |
| Execution epoch / fencing (§6) | `workspaces.generation` (+1 per fresh sandbox) is part of the runner token: a previous sandbox's client gets 401 | **Extend**: generation fences sandboxes, not two workers on the *same* sandbox. Added a per-open fence (CD-31) |
| Checkpoints (§6.3, §9) | `lib/cloud/checkpoint.ts`: diff against the pinned `base_sha`, sha256-verified, Supabase Storage `workspaces/<user>/<id>/<gen>-<seq>.patch`; never destroyed without a newer checkpoint (CS-14) | **Reuse unchanged** |
| Janitor, orphans, reconcile (§9) | `lib/cloud/janitor.ts`: stale sessions, close requests, retention, idle destroy after checkpoint, provider reconcile, storage sweep | **Reuse**, plus one fabric step (node health, reservation reconcile, drain) |
| Quotas, metering (§5.3, §8) | `open_workspace_session`: plan minutes, platform running cap (`cloud.maxRunning`), one open session per workspace; `resource_usage.workspace_seconds` priced only from the owner's rate | **Reuse unchanged**; per-node capacity admission added below it |
| Egress (§7.4) | In-image firewall (`runner/egress.ts`, CD-12): command uid → loopback only; allow-listed CONNECT proxy to package registries; fail closed without `NET_ADMIN`. 14 probes pass on the real image in Docker (C9) | **Reuse**, plus a host-level layer on the node (CD-34) |
| Cancellation (§5.6) | Heartbeat sees `cancel_requested` → abort → runner kills the process group (SIGTERM, SIGKILL after grace) when the caller's connection drops | **Reuse**; the node proxy must propagate the abort (tested, §5 of the architecture) |
| Isolation floor (§7) | CD-06 (owner-approved): one machine per workspace **with its own kernel**; runc containers rejected | **Binding.** Drives CD-30 |

## 3. Gaps the self-hosted fabric must close

| # | Gap | Where closed |
| --- | --- | --- |
| G1 | No adapter can run sandboxes on Kriya-operated machines | `lib/cloud/providers/selfhosted.ts`, `cloud-node/` (CD-28) |
| G2 | Capacity admission is one platform-wide count (`cloud.maxRunning`); nothing knows a machine's CPU, memory, disk or pressure, and a busy platform refuses instead of queueing | `kriya.exec_leases`, `kriya.exec_admit` (CD-29, CD-32) |
| G3 | Two workers can drive the same sandbox after an orphaned session is closed (generation is unchanged on resume) | Per-open fence enforced by the node (CD-31) |
| G4 | The VM boundary of CD-06 is a provider promise; on a VPS it must be provided and verified by Kriya | gVisor required by the node agent, fail closed (CD-30) |
| G5 | Nothing stops a sandbox on a node if the control plane disappears (vendors have their own timeout) | Node-side idle stop (CD-33) |
| G6 | No node registry, drain or kill switch | `selfhosted.*` settings, `kriya.exec_nodes` (CD-35) |

Existing gaps noted, **not** changed here (outside this brief, recorded):
F-1 worker slots are held for a whole turn (`WORKER_CONCURRENCY`, CF-04) —
the first throughput limit for long code turns, independent of where
sandboxes run; F-2 `TaskWorkspace` passes a row created on one provider to
whichever provider is configured now (a provider switch rebuilds from the
checkpoint by accident of `resume` returning null; works, but the old
sandbox waits for the other provider's own timeout).

## 4. Constraints

| Constraint | Source | Consequence |
| --- | --- | --- |
| Hostinger VPS has **nested virtualization disabled** | Hostinger support article "Is nested virtualization supported?" (support.hostinger.com/en/articles/10429687, read 2026-11-02): "No, it is not." | Firecracker and Kata (KVM) are **out** on Hostinger. `/dev/kvm` probe kept in the capability script to confirm on the instance |
| gVisor `systrap` platform needs no KVM | gvisor.dev/docs/architecture_guide/platforms (read 2026-11-02): default since mid-2023, uses seccomp `SECCOMP_RET_TRAP` | gVisor is the only own-kernel boundary available on a Hostinger KVM guest |
| gVisor implements iptables incl. owner match in netstack; known gaps in some releases | gvisor.dev networking guide; `pkg/sentry/socket/netfilter` (OwnerMatcher); google/gvisor issues #9917, #9865 | The image's CD-12 firewall **must be re-probed under runsc** on the target host (UNKNOWN until then); fail closed if it doesn't install |
| PSI pressure (`/proc/pressure/*`) | docs.kernel.org/accounting/psi.html (read 2026-11-02) | Admission uses `some avg10` for cpu/memory/io as the overload signal (CD-32) |
| Single VPS = single point of failure | — | No availability SLO beyond what one node gives; tasks degrade to "busy", state survives in Postgres + Storage (SLOs in `SELF_HOSTED_ARCHITECTURE.md` §8) |
| Hostinger acceptable-use terms for running third-party code | **UNKNOWN** — owner reads the current terms before the pilot (owner action OA-4) |
| Hostinger real CPU/RAM/disk/kernel/cgroup controllers | **UNKNOWN** — `cloud-node/probe-host.sh` on the instance (OA-2) |

## 5. Alternatives considered (summary; ADRs in DECISIONS.md)

| Area | Selected | Rejected (why) |
| --- | --- | --- |
| Control plane | Existing `kriya-worker` + `kriya.tasks` + `TaskWorkspace` | Nomad / Kubernetes (k3s) control plane (a second scheduler and state store for ≤ a few nodes); Temporal (second durable-state owner, extra service) |
| Capacity queue | Postgres `exec_leases` + `exec_admit` (short transactions; one scheduling pass at a time under a try-lock, skipped when nothing changed; polling with jittered backoff). A first version that ran a pass on every poll under a blocking lock collapsed from 25.8 to 6.5 grants/s at 250 waiters on Postgres 17; the shipped version holds 22.4 with admit p99 1.9 ms (benchmark plan §4.2) | Redis/BullMQ, NATS JetStream, RabbitMQ (new service, new failure mode, duplicate truth); LISTEN/NOTIFY (Supabase's transaction pooler doesn't keep LISTEN sessions; polling at ≤ 1 req/s per waiter is cheap at this scale) |
| Isolation | Docker with `runsc` (gVisor systrap), hardened flags, fail closed | runc alone (shared host kernel: violates CD-06); Firecracker/Kata (need `/dev/kvm`, unavailable on Hostinger); rootless Docker + runc (better host protection, still a shared kernel) |
| Placement | Best-fit on memory with CPU overcommit and PSI gates | Spread/worst-fit (measured in `tests/cloud/fabric-sim.test.ts`: within noise of best-fit at this scale; best-fit kept because it packs onto fewer nodes, leaving whole nodes to drain or scale down); DRF across nodes (unneeded with three size classes on ≤ a few nodes) |
| Fairness | Fewest active leases per tenant first, then age; strict head-of-line after a starvation age | Weighted fair queuing with per-tenant virtual time (needs weights the product doesn't define; the tenant cap + least-active order gives equal shares, measured in the simulation) |
| Node auth | HMAC-signed requests (per-node key derived from one env secret), timestamp window, nonce cache; TLS by a reverse proxy | mTLS (cert distribution and rotation for ≤ 3 nodes isn't justified yet; reconsider at multi-node) |
| Observability | Structured logs + SQL metrics function + owner page rows | OpenTelemetry collector on a 2-vCPU node (resource cost exceeds the signal at this scale; reconsider when > 1 node) |

## 6. Phased plan (executed; status per phase in status.md)

| Phase | Content | Exit |
| --- | --- | --- |
| SH0 | This audit, ADRs, threat model, benchmark plan | Documents consistent, baseline recorded |
| SH1 | Migration (nodes, leases, admission function), schema, settings, provider name | PGlite tests: admission, fairness, fences, RLS, rollback |
| SH2 | Node agent (`cloud-node/`): signed API, runtime adapter, hardened docker args, runner proxy with fences, idle stop, stats | Unit + integration tests with the real runner as the "container" |
| SH3 | `SelfHostedWorkspaceProvider` + `workspaceProvider()` routing; TaskWorkspace end-to-end through the node | CT-SH-E2E pass on PGlite + node agent |
| SH4 | Recovery: fences, stale worker, node restart, lease expiry, janitor fabric step, drain | Drills pass |
| SH5 | Security: docker args policy, host egress rules, capability probe, adversarial suite on a real container | Probes on Docker (runc, recorded as *not* the target boundary); on the VPS with runsc: owner action |
| SH6 | Simulation and load: admission throughput, fairness, capacity envelope model | Report with p50/p95/p99 |
| SH7 | Runbook, alerts, metrics | Runbook reviewed against the code |
| SH8 | Pilot | **BLOCKED**: needs the VPS (OA-1…OA-6) |
