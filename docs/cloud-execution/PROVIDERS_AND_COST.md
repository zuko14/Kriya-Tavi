# Execution providers and cost (track C)

Facts are dated and sourced; anything not read on an official page is
marked. Prices change: re-read each source and the account dashboard
immediately before C8 and before any purchase (owner-gated, CD-07).

## 1. What the provider must give us (must-haves)

| # | Requirement | Why |
| --- | --- | --- |
| M1 | One isolated machine per sandbox with its own kernel (microVM or equivalent), documented by the provider | CD-06 |
| M2 | Egress control: deny all, or a domain allow-list (else the image fallback proxy must work on it) | CD-12 |
| M3 | Pause/stop that keeps the filesystem, and resume by id | CD-04 |
| M4 | An HTTPS URL to a port inside the sandbox, so the worker reaches the runner | CD-05 |
| M5 | Create from our own image/template whose start command runs as root, with a non-root user for commands (CRG-09) | CD-21 |
| M6 | Per-second billing for running time; nothing billed for compute while paused | Cost |
| M7 | API to list sandboxes by tag/metadata | Janitor reconcile |
| M8 | A region within ~150 ms of Render Singapore | Latency per tool call |
| M9 | Session length ≥ the longest plan's `max_task_seconds` (7200 s) | CD-17 |
| M10 | Data-processing terms acceptable for Indian users' code (DPDP) | Counsel (CQ-1) |

## 2. Candidates (read 2026-10-31)

| Candidate | Isolation | Lifecycle | Published compute price | Plan limits | Region | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Existing Render worker | Shared process with platform secrets | Always on | Existing plan | — | Singapore | **Rejected for user code** (CD-06); keeps orchestration |
| Render private service (like `kriya-browser`) | One container for many tenants; no per-task create API | Static service | Instance plan | Blueprint-defined | Singapore | **Rejected for user code** |
| Render Workflows | Separate instance per run (stated); untrusted code not addressed | Run to completion; no inbound ports; same-region private network reachable | flex ≤ 1 CPU / 4 GB: $0.20/CPU-h + $0.05/GB-h (max $0.40/h); `2c-4g` $0.40/h; `4c-8g` $1.00/h; state retention $0.25/GB-month | Default timeout 2 h, max 24 h; 4 MB args; root runs 50/min (Hobby), 1 500/min (Pro) | Same as services | **Not for workspaces** (CD-08); possible batch profile later |
| E2B | Firecracker microVM per sandbox per third-party sources (Fly.io comparison; an aggregator); **not confirmed on an E2B page** (CRG-01) | Pause keeps filesystem and memory (~4 s per GiB RAM), `keepMemory: false` for disk only; resume via `connect()`; auto-pause configurable; kill is final (docs.e2b.dev/sandbox/persistence) | $0.000014/vCPU-s (≈ $0.0504/vCPU-h), $0.0000045/GiB-s (≈ $0.0162/GiB-h); storage included; 1–8 vCPU, 1–8 GiB | Hobby: $0 + one-time $100 credit, 20 concurrent, 1 h sessions, 10 GiB. Pro: $150/month + usage, 100 concurrent, 24 h sessions, 20 GiB | Not stated on pricing page (CRG-03) | **Bake-off candidate** |
| Daytona | v2 docs: one Firecracker microVM per sandbox, egress open by default and lockable per sandbox (IP, CIDR, domain allow-list); current docs: "isolated instance", egress block-all / CIDR / domain allow-list, **restricted on tiers 1–2** (CRG-02) | Compute billed only while running; stopped sandbox keeps state with disk free | Per core-hour (1 core = 2 vCPU): $0.101 (Zen 3 class) on demand, $0.0706 spot; RAM $0.0162/GiB-h; NVMe free; volumes $0.000108/GiB-h | Starter: $200 one-time credit, 100 Linux cores, 1 h sessions, 1 TiB egress. Team: $100/month credit, 5 000 cores, 48 h sessions, 10 TiB | Region choice on all plans at 1.15–2× base (CRG-03) | **Bake-off candidate** |
| Fly Machines | Firecracker microVMs (Fly's own product pages, not re-read here) | Per-machine start/stop API; volumes | Not re-read on 2026-10-31 (CRG-06) | — | Has a Mumbai region (to verify, CRG-06) | **Conditional**: only if both candidates fail a must-have |
| Cloudflare Containers | Container platform | Scale to zero | Not re-read | Runtime constraints | — | **Deferred** |

## 3. How the choice is made (C8)

1. Re-read every source in §7; record date, price and limits in `status.md`.
2. Check M1–M10 per candidate from documentation; a candidate failing M1,
   M2 (with no working fallback), M3 or M4 is out before any paid run.
3. Run EVALUATION_PLAN §3 (W1–W3, 10 runs each per candidate, same model,
   same prompts) on the owner-approved accounts.
4. Pick the candidate with the lowest **cost per successful task** among
   those meeting every threshold in EVALUATION_PLAN §4; tie → lower p50
   resume latency; record the decision as CD-07's result.

## 4. Cost model per successful task

```
cost_task = model_cost                                  (usage_events, existing)
          + compute_seconds × rate_compute              (workspace_seconds)
          + checkpoint_bytes × storage_rate × days     (workspace_storage_bytes)
          + egress_bytes × egress_rate                  (provider dashboard; 0 inside allowance)
          + retries_waste                               (failed attempts' model + compute)
cost_per_success = Σ cost_task over all runs / number of successful runs
```

INR is computed with the owner's `fx.usdInr` rate and source, never an
invented rate; without it the figure is shown in USD and marked unpriced
in rupees (invariant 6).

**Compute arithmetic from the published rates only** (illustration of the
formula, not a forecast; the real duration comes from C8 measurements):

| Size | E2B rate | Daytona on-demand rate | Render Workflows |
| --- | --- | --- | --- |
| 2 vCPU, 4 GiB | 2 × 0.0504 + 4 × 0.0162 = **$0.1656/h** | 1 core × 0.101 + 4 × 0.0162 = **$0.1658/h** | `2c-4g` **$0.40/h** |
| Per 10 running minutes | $0.0276 | $0.0276 | $0.0667 |

Fixed costs to add per month: E2B Pro $150 if sessions over 1 h or more
than 20 concurrent are needed; Daytona Team includes $100/month credit.
Model tokens are expected to dominate per-task cost for code work; that is
measured, not assumed (EVALUATION_PLAN M5).

### What keeps cost low (built in, not optional)

1. No compute between tasks (pause at the end of every task, CD-04).
2. Paused sandboxes destroyed after 24 h; restore from a small patch.
3. Bounded commands, outputs and imports; deadline per task.
4. Platform cap on running sandboxes; plan minutes per month.
5. Model tokens kept down by bounded tool outputs (P2) and the existing
   `compactContext`.
6. Dependency installs are the slow part of cold starts: the image carries
   common toolchains; per-tenant dependency caches are **not** shared
   (brief §9.4) and are deferred until measured worth it.

## 5. Owner money exposure before any paid run

| Item | Exposure | Approval |
| --- | --- | --- |
| E2B Hobby for the bake-off | $0 fee; usage from the one-time credit | CD-07 |
| Daytona Starter for the bake-off | One-time credit | CD-07 |
| Bake-off model tokens (W1–W3 × 10 × 2 providers) | Measured by `usage_events`; cap via a dedicated plan's `max_task_cost_micro_usd` | CD-24 |
| Production provider plan (e.g. E2B Pro $150/month) | Monthly | After C10 |

## 6. Open research (CRG-…)

| Id | Question | How to settle it | Blocks |
| --- | --- | --- | --- |
| CRG-01 | Does E2B state microVM isolation on its own pages, and how is the guest hardened? | Read E2B security/architecture docs; ask E2B in writing | C8 (M1) |
| CRG-02 | Which Daytona isolation model applies to our account and tier, and which egress controls are available on it? | Daytona docs for our tier; a test sandbox: `curl` an allowed and a denied domain | C8 (M1, M2) |
| CRG-03 | Regions and data location for both; latency from Render Singapore | Provider docs; C8 latency probe (EVALUATION_PLAN M3) | C8 (M8, M10) |
| CRG-04 | Can E2B restrict egress to a domain allow-list, or only on/off? | E2B docs; a test sandbox | C8 (M2) |
| CRG-05 | How long do paused (E2B) / stopped (Daytona) sandboxes persist, and are they billed? | Docs; a paused sandbox checked after 48 h | CD-04 tuning |
| CRG-06 | Fly Machines prices, Mumbai region, egress control | Fly pricing pages, docs | Only if Fly enters |
| CRG-07 | Provider session caps across pause/resume (third-party claim: resets on resume) | Provider docs; a 70-minute test across a pause | M9 |
| CRG-08 | Does the provider's resolver allow arbitrary DNS (exfiltration channel, CS-6)? | Test sandbox: resolve a unique subdomain of a domain we control | CD-12 residual risk |
| CRG-09 | Can a template start its process as root (the runner, CD-21) while commands run as `kriya`? | Provider template docs; the C8 image smoke test (`id -u` from the runner and from a command) | C8 (M5) |

## 7. Sources (read 2026-10-31)

- Render Workflows: <https://render.com/docs/workflows>; limits and pricing:
  <https://render.com/docs/workflows-limits>
- E2B pricing: <https://e2b.dev/pricing>; persistence:
  <https://docs.e2b.dev/sandbox/persistence>
- Daytona pricing: <https://www.daytona.com/pricing>; isolation (v2 and
  current): <https://www.daytona.io/docs/en/v2/isolation>,
  <https://www.daytona.io/docs/en/isolation.md>
- Third-party (Secondary): Fly.io, "Fly vs E2B":
  <https://fly.io/learn/fly-vs-e2b/>
- Render persistent disks and background workers (from the brief, not
  re-read): <https://render.com/docs/disks>,
  <https://render.com/docs/background-workers>
- Supabase Queues/PGMQ, billing, egress (from the brief, not re-read; no
  decision depends on them: CD-02 keeps the existing queue)
