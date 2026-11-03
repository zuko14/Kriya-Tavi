# Self-hosted execution fabric: operations runbook

For the owner (or an operator they name). Extends `OPERATIONS_RUNBOOK.md`
(image build, rotations, outages, deletion on request, drills), which still
applies. Every step that spends money, touches a real machine, changes a
production setting or secret, or runs a migration on production needs the
owner's explicit go-ahead at the time (AGENTS.md voice rule 3, operator
rule 6). Nothing here was run on a real VPS yet: steps are written from
the code and the local runs in status.md "Phase SH…".

## 0. Owner actions (blocking the pilot)

| Id | Action | Unblocks |
| --- | --- | --- |
| OA-1 | Choose and buy a staging VPS (Hostinger KVM 4 suggested for the first measurements; KVM 2 only for a trusted-runc trial). Re-read the current price and renewal price on Hostinger's page; enter the monthly rent in micro-USD into `cloud.costMicroUsdPerHour` only after dividing by the hours you count | Everything below |
| OA-2 | Run `bash cloud-node/probe-host.sh` on it and paste the output into status.md (CPU, RAM, disk, kernel, cgroup v2 controllers, PSI, `/dev/kvm`, filesystem, IPv6) | Capacity numbers, runtime choice |
| OA-3 | A DNS name for the node and a TLS certificate (Caddy obtains one automatically) | B1 over TLS |
| OA-4 | Read Hostinger's current acceptable-use and terms for running other people's code; ask counsel whether CQ-1 (code at a processor under DPDP) also covers a VPS host; add the host to the privacy notice draft | Pilot with people's code |
| OA-5 | Approve CD-30 (gVisor as the self-hosted isolation floor, interpreting CD-06) — or keep self-hosted nodes `trusted-runc`-only for internal work | People's code on self-hosted |
| OA-6 | Approve the migration `20270501000000_cloud_fabric.sql` for staging, then production | Any self-hosted workspace |
| OA-7 | Set `KRIYA_NODE_SECRET` (32+ random bytes, base64) on the staging worker only | Node keys |
| OA-8 | Approve SLO targets (architecture §8) and the pilot's users, duration and budget cap | Pilot |

## 1. Components and where they run

| Piece | Where | Config |
| --- | --- | --- |
| `selfhosted` provider, fabric sweep | `kriya-worker` (Render) | `cloud.provider=selfhosted`, `selfhosted.*`, `KRIYA_NODE_SECRET` |
| `kriya-node` | The VPS, systemd (`cloud-node/kriya-node.service`) | `/etc/kriya-node/env` |
| TLS proxy | The VPS (Caddy) | `node.example.com { reverse_proxy 127.0.0.1:7070 }` |
| Docker + gVisor | The VPS | `runsc` registered as a Docker runtime |
| Sandboxes | The VPS, one container per workspace generation | from the agent |

## 2. Bring up a staging node

1. **Probe** (read-only): `bash cloud-node/probe-host.sh`. Stop if cgroup
   is not v2 or PSI is unavailable.
2. **OS updates and a non-root admin user**; SSH keys only; the provider
   firewall allowing 22 (your IP) and 443 only.
3. **Docker Engine** from Docker's official apt repository (docs.docker.com/engine/install).
   Do not add users to the `docker` group.
4. **gVisor** from its official apt repository (gvisor.dev/docs/user_guide/install),
   then `runsc install` (adds the `runsc` runtime to `/etc/docker/daemon.json`)
   and `systemctl restart docker`. Check: `docker run --rm --runtime=runsc hello-world`.
5. **Host network and firewall:** copy `cloud-node/` to `/opt/kriya-node`,
   then `sudo bash /opt/kriya-node/cloud-node/host-setup.sh` and
   `sudo bash … --check` → "kriya-node host rules: OK". Persist the rules
   (`apt install iptables-persistent` → `netfilter-persistent save`).
   Re-run `--check` after every reboot until persistence is confirmed.
6. **Image and isolation suite under runsc:** build `runner/Dockerfile`
   (OPERATIONS_RUNBOOK §1), push it to a registry the node can pull from,
   pull it **by digest**. Then, on the node, with Node 24 and the
   repository checked out (no `.env`): the image probes with gVisor —
   `KRIYA_ISO_TARGET=docker KRIYA_ISO_IMAGE=<image@sha256:…>` with Docker's
   default runtime set to runsc for the run, and
   `KRIYA_NODE_DOCKER=1 npx vitest run tests/cloud/node-docker.test.ts`
   after setting its policy runtime to `runsc` (the suite asserts the
   seven-capability bounding set, read-only root, cgroup limits, OOM and
   pids containment, fence restart, cleanup). **Record every result**;
   any failure means the node stays `trusted-runc` (eligibility table,
   threat model §4). Known risk: the image's iptables firewall inside
   gVisor (google/gvisor#9917 class) — if it doesn't install, the runner
   refuses to start (fail closed) and gVisor's own network policy or a
   `network=offline` default must be designed first.
7. **Node key and service:** on a trusted machine with `KRIYA_NODE_SECRET`
   exported: `npx tsx scripts/cloud-node-key.ts kvm4-1 kvm4-1.env`
   (mode 0600, never printed). Copy to `/etc/kriya-node/env` (root, 0600),
   add `KRIYA_NODE_IMAGE=<image@sha256:…>`, `KRIYA_NODE_RUNTIME=runsc`, and
   reserves sized from step 1 (default reserve: 0.5 CPU, 1 GB RAM, 10 GB
   disk; raise the memory reserve by gVisor's measured overhead). Install
   the unit, `systemctl enable --now kriya-node`, check the journal for
   `probe ready: true`.
8. **TLS:** Caddy in front (`reverse_proxy 127.0.0.1:7070`); check
   `curl https://node…/v1/health` → `{"ok":true,"protocol":"kriya-node/1"}`.
9. **Register (staging settings):** `selfhosted.nodes = kvm4-1=https://node…`,
   `selfhosted.users` = the pilot ids, `selfhosted.isolation = gvisor`
   (or `trusted-runc` for internal-only), `cloud.provider = selfhosted`.
   Within one janitor round (30 s) `select kriya.exec_metrics()` (Supabase
   SQL editor, owner) shows the node healthy with its capacity.
10. **Smoke:** one workspace task on the staging app; then the drills in §5.

## 3. Switches

| Need | Do | Effect |
| --- | --- | --- |
| Stop new sandboxes now (kill switch) | `selfhosted.holdAdmissions = on` | Waiters stay waiting then get "busy"; running sandboxes continue |
| Stop one person | Remove them from `selfhosted.users` | No new sandboxes; their paused workspaces still resume and close |
| Leave self-hosted | `cloud.provider` back to its previous value; drain nodes first (§5) | Existing self-hosted workspaces are restored from checkpoints on the new provider when next used (generation + 1) |
| Trusted-only node | `selfhosted.isolation = trusted-runc` and `KRIYA_NODE_RUNTIME=runc` | Plain containers; never for people's code |

## 4. Rotations

- **One node's key** (suspected leak on that host): new id or same id with
  a new `KRIYA_NODE_SECRET`? A node key is derived, so rotating it means
  rotating `KRIYA_NODE_SECRET` (all nodes) — or retiring that node id and
  registering the machine under a new id (preferred: only that node
  changes). Drain the old id first (§5).
- **`KRIYA_NODE_SECRET`:** set the new value on the worker and regenerate
  every node's env (step 7) in one window; nodes refuse the worker until
  both sides match (sandboxes keep running and stop on their idle timer;
  their workspaces resume once keys match).
- **`KRIYA_WORKSPACE_SECRET`:** unchanged procedure (OPERATIONS_RUNBOOK §3):
  running runners refuse the worker; workspaces rebuild from checkpoints.

## 5. Drain, maintenance, reboot, replace

1. `selfhosted.drain = kvm4-1`. The node takes no new sandboxes; resumes of
   its own paused workspaces still work (their disk is there).
2. Each janitor round checkpoints and removes up to 20 paused sandboxes on
   the node. Watch: `select count(*) from kriya.exec_leases where node_id =
   'kvm4-1' and status in ('granted','running','stopped')` → 0.
3. Running sandboxes finish with their task (or `cloud.orphanSeconds` after a
   crash). To force: wait, or `selfhosted.holdAdmissions = on` platform-wide.
4. When 0: maintenance or reboot. Containers don't restart by themselves
   (`--restart no`); the agent restarts with systemd and re-probes.
5. Back: remove it from `selfhosted.drain`. Replace: register the new
   machine under a new id, then remove the old id from `selfhosted.nodes`
   (its leases are released as `node_retired`).

Unplanned reboot: sandboxes come back stopped; their leases still say
running until the next resume (which starts them) or the sweep (which
releases leases whose sandbox is gone). Paused workspaces lose nothing that
was on disk.

## 6. Metrics, alerts, dashboards

**Owner page:** `/owner/cloud` → "Self-hosted nodes" (read-only; shown
when `cloud.provider = selfhosted` or any `kriya.exec_nodes` row exists).
It shows `kriya.exec_metrics()`: queued now and the oldest wait, last
hour's grants/expired/cancelled/start failures and wait p50/p95/p99, and
per node status and health, isolation, report age, CPU/memory/disk
reserved vs capacity, PSI cpu/mem/io, free disk and reason. The same jsonb
is `select kriya.exec_metrics()` in the Supabase SQL editor as the owner
(no client role can call it); use that for fields the panel leaves out.
Node logs: one JSON line per event (`sandbox open|stopped|destroyed`,
`reason: idle|disk_quota|asked`, `sandbox create failed`).

| Alert | Condition | First response |
| --- | --- | --- |
| Queue backlog | `oldestWaitSeconds` > 60 for 15 min, or `waitP95` > 60 | §9 "Queue backlog" |
| Node unhealthy | a node `healthy=false` for 2 rounds | Read `reason`; §9 |
| Worker heartbeat loss | janitor `orphans` > 0 repeatedly | Existing runbook (worker crash) |
| Start failures | `startFailed` > 3 in 1 h | Node journal for `create failed` |
| Memory pressure | `psiMem` > 10 sustained | Lower `cpuOvercommitPct`/size; check gVisor overhead |
| Disk | `diskFreeMb` < 2 × `selfhosted.diskGb` | Drain or grow disk; check `disk_quota` stops |
| Egress / firewall | node `reason` mentions KRIYA-SBX, or the runner refuses to start | §9 "Egress policy failure" |
| Reconcile churn | `leasesReleased` > 5/day | Look for crashes between grant and open |
| Cost | Workspace seconds/day above plan × 1.5 | Existing cost-runaway runbook |

## 7. Patching

Weekly: `apt upgrade` (kernel → drain + reboot), Docker and gVisor
releases (gVisor publishes dated releases; read their notes for security
fixes). After any runtime or kernel change: re-run §2 step 6 before
removing the drain.

## 8. Rollback

Code: everything is behind `cloud.provider=selfhosted`; switching it off
stops new self-hosted use. Data: drain every node, let the janitor close or
checkpoint every self-hosted workspace (`select count(*) from
kriya.workspaces where provider='selfhosted' and status <> 'closed'`), then
the rollback file refuses until those rows are gone:
`psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270501000000_cloud_fabric.down.sql`.

## 9. Incidents

| Incident | Steps |
| --- | --- |
| **Suspected cross-tenant access or escape** | `selfhosted.holdAdmissions=on`; drain the node; snapshot the VPS disk if the provider allows (evidence); take the node off the network after checkpoints finish (or immediately if exfiltration is ongoing — accept loss since last checkpoint); rotate `KRIYA_NODE_SECRET`; rebuild the node from scratch; notify per the DPDP plan (voice track's incident process) |
| **Node compromise** | As above; every workspace that ran on it is exposed: list them from `exec_leases where node_id = …` |
| **Egress policy failure** (KRIYA-SBX missing, runner refuses to start) | The node reports not ready and takes nothing (fail closed). Run `host-setup.sh --check`; re-apply; persist; re-probe |
| **Queue backlog** | Check node health and PSI first; if healthy and full: lower `cloud.size`/raise `selfhosted.cpuOvercommitPct` only within §6 pressure limits, or add a node (owner, OA-1) |
| **OOM storms** | Node journal + `docker inspect … OOMKilled`; the workspace size is too small for the repository: raise `cloud.size` for that plan |
| **Database saturation** | Polling is ≤ 1 call per waiter per 0.25–2 s; lower `selfhosted.maxQueued`; check `pg_stat_activity` for `exec_admit` |
| **Checkpoint corruption/failure** | Existing CD-13 rules: sandbox kept while `checkpoint_failed_at` is set; never drain-destroy a workspace with that mark (the janitor doesn't) |
| **Node unreachable** | Workspaces on it stay paused (not "gone"); new starts go to other nodes or say busy; fix the node or retire it (accept loss since last checkpoint) |

## 10. Backup and disaster recovery

The node holds no state Kriya can't rebuild: workspace identity and
checkpoints live in Postgres and Storage (Supabase's own backups apply).
RPO for a workspace = its last checkpoint (end of each task, before each
publish). A lost node: retire it; its workspaces restore from checkpoints
on the next use. `fences.json` matters only while the node lives.

## 11. Drills (record in status.md)

| Drill | How | Pass |
| --- | --- | --- |
| Worker kill mid-command | Kill the worker process during a long `workspace_run` | Janitor takes over under a new fence; the next turn resumes with files (REC-01 on staging) |
| Agent restart | `systemctl restart kriya-node` during idle and during a command | Running sandboxes survive idle restart; fences persist (an old token is refused) |
| Node reboot | Reboot the drained-then-undrained node with paused sandboxes | Resume works; sweep releases nothing wrongly |
| Kill switch | `holdAdmissions=on` with waiters | All get "busy" within `maxWaitSeconds`; running unaffected |
| Drain | §5 with 3 paused workspaces | All checkpointed and removed; resumed elsewhere/after |
| Disk quota | `fallocate` beyond quota inside a sandbox | Stopped within a minute; host free disk stays above reserve |
| Egress | `host-setup.sh` rules removed | Node not ready within 1 min; no new sandboxes |
