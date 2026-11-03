# Self-hosted execution fabric: release readiness

State on 2026-11-02 (Claude Code / Opus 5.5, `main` in place at `455bc43`,
uncommitted). Labels follow the brief's §19: nothing here is
"implemented" in the brief's sense until the end-to-end workflow runs on
the target host, which doesn't exist yet.

## 1. Verdict

| Label (brief §19) | Status | Why |
| --- | --- | --- |
| Implemented | **No** | Works end to end on this machine's Docker (runc) with the real agent process and runner image; never run on the target VPS (OA-1) |
| Security-validated — owner-trusted internal work (`trusted-runc`) | **No** | Container controls proven on Docker Desktop; the host firewall script proven on real iptables in a throwaway container; not yet on the VPS |
| Security-validated — people's code (`gvisor`) | **No** | Needs runsc on the target and CD-30 approval (OA-2, OA-5) |
| Pilot-ready | **No** | Blocked by the two rows above and OA-1…OA-8 |
| Production-ready for any class | **No** | After a pilot only |

## 2. Phases

| Phase | Status | Evidence | Left |
| --- | --- | --- | --- |
| SH0 Audit and decisions | COMPLETE | `SELF_HOSTED_ARCHITECTURE_AUDIT.md`, CD-28…CD-37 (Proposed) | Owner approval of CD-29, CD-30, CD-36 |
| SH1 Contract, state machine, migration | COMPLETE (local) | CT-SH-DB-01…15; rollback refuses over live rows; mutation-checked | Apply on staging, then production (OA-6) |
| SH2 Node agent | IN_PROGRESS | CT-SH-NODE-01…05, CT-SH-SEC-01…05, CT-SH-IMP-01; real Docker CT-SH-DOCKER-01…07; agent process slice | Run on the VPS |
| SH3 Provider and routing | COMPLETE (local) | CT-SH-E2E-01…03, provider selection cases | — |
| SH4 Recovery | COMPLETE (local) | REC-01…04 (fenced takeover, unreachable vs gone, sweep reconcile, drain) | Staging repetition of runbook §11 drills |
| SH5 Security | IN_PROGRESS | Threat model; DOCKER-02…07; host-setup on real iptables | Isolation suite under runsc on target; disk-quota hardening (XFS pquota) |
| SH6 Performance and cost | IN_PROGRESS | Scheduler on PGlite (3 seeds × 4 configs) and Postgres 17 (10–250 waiters); slice latencies | Node envelope and cost per successful task on the VPS (needs prices) |
| SH7 Operations | IN_PROGRESS | Runbook, `exec_metrics()`, owner panel on `/owner/cloud` (2026-11-02), node event logs, alert table | Alert wiring (no alerting system exists in the repo) |
| SH8 Pilot | BLOCKED | — | OA-1…OA-8 |

## 3. Open risks

| Risk | Severity | Mitigation / owner action |
| --- | --- | --- |
| The image's iptables egress firewall may not install under gVisor (netstack gaps) | High for people's code | Fail closed (runner refuses to start); verify first on the VPS (runbook §2 step 6) |
| Disk quota is soft (60 s `du` sweep) | Medium | XFS project quotas on a dedicated Docker disk; node disk reserve; admission requires free disk |
| Single node = single point of failure | Accepted, documented | SLOs scoped to one node; second node only on SLO breach |
| Hostinger AUP for running customer code | Unknown | OA-4 |
| gVisor memory overhead not yet measured | Medium | Benchmark §5 step 2 → reserve |
| Polling load on Supabase at large queues | Low | Caps (`maxQueued` 50), backoff to 2 s; measured cheap (admit p99 < 2 ms) |
| Worker slots held for whole turns (F-1) | Existing | Independent of this work |

## 4. Owner actions

OA-1 buy a staging VPS · OA-2 run `probe-host.sh` · OA-3 DNS and TLS ·
OA-4 AUP and counsel (CQ-1) · OA-5 approve CD-30 · OA-6 approve the
migration · OA-7 set `KRIYA_NODE_SECRET` on staging · OA-8 approve SLOs,
pilot users, duration and budget. Details: runbook §0.
