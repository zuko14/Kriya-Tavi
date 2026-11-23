# KRIYA HARNESS: Master Architectural Vision & Autonomous Workforce Specification

> **Repository:** `Kriya-Tavi` (`docs/kriya-harness/upgrade_2.0`)  
> **Core Objective:** Transform a coding agent harness into a **Top 1% Autonomous Software Engineering Workforce** with self-evolving domain intelligence, deterministic verification gates, and asymmetric cost-to-intelligence scaling.

---

## 1. The Core Thesis: Asymmetric Intelligence Amplification

A raw Large Language Model (LLM) is merely a probabilistic reasoning engine. When an unguided LLM attempts to build a complete, production-grade digital product in a single context window, it inevitably degrades due to **attention dilution**, **single-perspective bias**, **premature completion**, and **unverified assumptions**.

**Kriya Harness** solves this by decoupling *reasoning* (the LLM) from *engineering discipline, domain taste, institutional memory, and verification* (the Harness). This establishes two non-negotiable performance laws:

1. **Floor Elevation (Mid-Tier Models $\rightarrow$ Frontier Output):**  
   A fast, low-cost model (e.g., DeepSeek, Kimi, Flash, Haiku) running inside Kriya Harness must consistently produce **frontier-grade, production-ready engineering output** at a fraction of standard API costs—achieved by constraining the model with role-specific cognitive rubrics, strict typed contracts, and automated physical verification loops.
2. **Ceiling Breakthrough (Frontier Models + Harness $\gg$ Solo Frontier Model):**  
   A frontier reasoning model paired with Kriya Harness must achieve **super-frontier engineering quality** that the same frontier model executing solo *cannot* produce—achieved through multi-role adversarial synthesis, isolated specialist contexts, long-horizon DAG state checkpointing, and live execution feedback across real browsers, databases, compilers, and security scanners.

---

## 2. First-Principles Architectural Pillars

### Pillar 1: Ephemeral Role-Scoped Cognition (Skill Cartridges)
A single prompt cannot simultaneously hold the mental models of a Principal UI/UX Designer, a Distributed Systems Architect, and an Adversarial Security Engineer without diluting attention.
* Kriya Harness packages every engineering discipline as an isolated **Skill Cartridge** (`SKILL.md` + `rubric.json` + `anti_patterns.yaml`).
* For any given node in the execution graph, the harness mounts **only the single active role cartridge** and the exact file slice required, keeping context lean, sharp, and deeply specialized.

### Pillar 2: "Taste" and Principal Standards as Executable Constraints
Vague instructions like *"make a top 1% frontend"* or *"write secure backend code"* fail on mid-tier models. Kriya Harness translates subjective principal-level judgment into **enforceable engineering invariants**:
* **Design Taste:** Mandatory design token scales (8pt spacing grid, semantic color tokens, fluid typography ratios), mandatory UI state completeness (`loading`, `empty`, `partial`, `error`, `populated`), motion physics curves, and strict bans on generic layout tropes.
* **Systems Taste:** Mandatory idempotency keys, explicit timeout/retry budgets, boundary schema validation, multi-tenant Row-Level Security (RLS), and zero-downtime migration patterns.

### Pillar 3: The Typed Contract Bus (Zero Conversational Drift)
Specialist roles never communicate through verbose, ambiguous chat summaries. Instead, roles hand off **machine-verifiable artifacts** over a typed Contract Bus:
* **Architect / Backend $\rightarrow$ Frontend / Mobile / QA:** Emits `openapi.yaml`, `schema.sql`, and `auth_matrix.json`.
* **Designer $\rightarrow$ Frontend / Mobile:** Emits `design_tokens.json` and `component_states.yaml`.
* **Security $\rightarrow$ All Pods:** Emits `threat_model.json` and `security_invariants.yaml`.
* This cuts cross-agent input token volume by **70–85%** while making API mismatches and hallucinated fields structurally impossible.

### Pillar 4: Zero-Trust Deterministic Verification Gates
**No LLM is allowed to self-certify its own work as `DONE`.** Every role cartridge is paired with a non-LLM, deterministic verification gate (exit code `0` = PASS). If a gate fails, the exact compiler error, DOM layout violation, or security exploit trace is fed back into the loop for targeted repair.

### Pillar 5: Long-Horizon State Machine (`status.md`)
For complex, multi-hour or multi-day builds, `status.md` acts as the deterministic execution ledger:
* Tracks the task Dependency Acyclic Graph (DAG), active role cartridge, artifact hashes, verification gate logs, and rollback checkpoints.
* Prevents infinite loops, context rot, and silent regressions across long-horizon execution.

### Pillar 6: Cost-Optimal Model Cascading & KV-Cache Prefixing
* **Stage 1 — Architecture & Contract Design (10–15% of tokens):** Frontier model decomposes user intent into the `status.md` DAG, security invariants, and typed contracts.
* **Stage 2 — Cartridge Execution (75–80% of tokens):** Low-cost/mid-tier worker model executes isolated tasks constrained by the loaded Skill Cartridge and Contract Bus. Static cartridge prefixes remain pinned at the start of the prompt to achieve **80%+ provider KV-cache hit rates**.
* **Stage 3 — Deterministic Gate ($0 tokens):** Automated verifier executes locally/in-container.
* **Stage 4 — Surgical Escalation (5–10% of tokens):** Triggered *only* when a worker model fails the same deterministic gate twice; routes the exact failure diff and stderr trace to a frontier model to resolve the root cause.

---

## 3. The 13-Discipline Top 1% Engineering Workforce

Kriya Harness embeds principal-level thinking, execution standards, and deterministic verification across all four pillars of software engineering:

### A. Application & Product Development

| Role Cartridge | Principal Mental Model & Design Approach | Mandatory Execution Rules & Banned Anti-Patterns | Deterministic Verification Gate |
| :--- | :--- | :--- | :--- |
| **1. Front-End Engineer** | Designs deterministic UI state machines before writing markup. Maps every screen across 5 states (`loading`, `empty`, `partial`, `error`, `populated`), enforces a strict visual hierarchy, and separates server cache from local UI state. | **Enforces:** 8pt spacing grid, semantic design tokens, keyboard accessibility, optimistic UI with rollback, responsive breakpoints.<br>**Bans:** Magic pixel/hex values, cumulative layout shift (CLS), unstyled error/empty states, waterfall data fetches. | **Headless Browser Audit (Playwright):** Renders desktop (`1440px`) + mobile (`390px`), checks `0` console/network errors, `0` horizontal overflow, WCAG AA contrast compliance, and DOM interactive latency `< 100ms`. |
| **2. Back-End Engineer** | Designs around failure modes, concurrency races, and data integrity first. Establishes idempotency keys, transactional boundaries, timeout budgets, and boundary validation before writing handlers. | **Enforces:** Clean layered architecture (transport $\rightarrow$ service $\rightarrow$ repository), structured JSON logs with correlation IDs, parameterized queries, rate limiting.<br>**Bans:** N+1 query loops, swallowed exceptions, unpaginated list endpoints, business logic inside route controllers. | **API Contract & Fuzz Suite:** Validates 100% OpenAPI schema compliance, executes concurrent write-collision tests, fuzzes malformed/boundary inputs, and asserts p95 latency ceilings. |
| **3. Full-Stack Engineer** | Optimizes the **end-to-end data boundary**. Eliminates drift between database schemas, API payloads, and frontend types via a single generated source of truth and end-to-end streaming/optimistic flows. | **Enforces:** Shared end-to-end type generation (Pydantic/Zod/OpenAPI), secure session propagation, atomic feature slices.<br>**Bans:** Manually duplicated client/server DTOs, leaking raw DB column names or stack traces to clients. | **Full-Stack E2E Integration Gate:** Executes real browser user journeys against an ephemeral live backend + database, asserting schema parity and full round-trip state persistence. |
| **4. Mobile Engineer** | Engineers for **hostile real-world environments**: intermittent/offline connectivity, OS background kills, battery drain, thermal throttling, and notch/safe-area geometry. | **Enforces:** Local-first persistence with idempotent sync queues, lifecycle-aware listeners, flat view hierarchies, `< 16ms` main-thread frame budget.<br>**Bans:** Synchronous I/O on UI thread, unthrottled background polling, hardcoded screen dimensions, missing permission-denial fallbacks. | **Mobile Simulator & Lifecycle Gate:** Clean simulator build, cold-start benchmark, simulated offline-to-online sync recovery test, and static main-thread stall / memory-leak lint. |
| **5. Game Developer** | Thinks in **strict frame budgets (`16.6ms` @ 60fps / `8.3ms` @ 120fps)**, decoupled fixed-timestep simulation vs. rendering loops, and cache-friendly data layouts. | **Enforces:** Fixed-timestep physics, object pooling (`0` per-frame heap allocations in hot loops), ECS/decoupled simulation state, input buffering.<br>**Bans:** Frame-rate-dependent physics (`dt` omission), heap allocations inside `tick()`/`update()`, tight coupling of render shaders and game rules. | **Headless Simulation Benchmark:** Runs `10,000` deterministic simulation ticks; verifies `0` GC spikes/allocations in hot paths, deterministic replay parity, and frame-time ceiling compliance. |

### B. Infrastructure, Cloud & Operations

| Role Cartridge | Principal Mental Model & Design Approach | Mandatory Execution Rules & Banned Anti-Patterns | Deterministic Verification Gate |
| :--- | :--- | :--- | :--- |
| **6. DevOps Engineer** | Treats build, test, and release pipelines as **immutable, reproducible, versioned code**. Designs every deployment to be atomic, zero-downtime, and reversible within seconds. | **Enforces:** Multi-stage deterministic container builds, pinned dependency hashes, health/readiness probes, backward-compatible DB migrations.<br>**Bans:** Manual server mutations ("click-ops"), unpinned `:latest` tags, secrets in logs/images, migrations that lock live production tables. | **Hermetic CI & Rollback Gate:** Builds image in isolated runner, verifies deterministic hash, runs CVE scanner (`0` critical vulnerabilities), and executes simulated migration + rollback dry-run. |
| **7. Cloud Engineer** | Architects for **blast-radius isolation, elastic scaling, and strict unit economics**. Segregates compute, state, and networking across least-privilege IAM boundaries with automated failover. | **Enforces:** Infrastructure-as-Code (Terraform/OpenTofu/Pulumi), private subnets for state/DB layers, autoscaling with hard spend caps, encryption at rest/transit.<br>**Bans:** Publicly exposed databases/buckets, wildcard IAM (`*`) policies, single-AZ stateful production tiers, unmonitored egress bottlenecks. | **IaC Policy & FinOps Gate:** Executes `plan` + Policy-as-Code static audit (Checkov/OPA) verifying `0` public ingress violations, least-privilege IAM compliance, and monthly cost ceiling checks. |
| **8. Systems / Embedded Engineer** | Reasons directly about **hardware registers, memory ownership, cache locality, lock-free concurrency, and bounded execution time** without relying on heavy runtime safety nets. | **Enforces:** Explicit memory ownership/lifetimes (Rust/modern C++), statically bounded buffers, deadlock-free synchronization, watchdog fault recovery.<br>**Bans:** Unbounded heap allocation in real-time paths, unchecked pointer arithmetic, busy-wait spinlocks without backoff, silent integer overflow. | **Sanitizer & Footprint Gate:** Compiles with `-Wall -Wextra -Werror` / `clippy::pedantic`, passes AddressSanitizer + ThreadSanitizer with `0` races/leaks, and enforces strict binary/RAM footprint caps. |

### C. Data, AI & Security

| Role Cartridge | Principal Mental Model & Design Approach | Mandatory Execution Rules & Banned Anti-Patterns | Deterministic Verification Gate |
| :--- | :--- | :--- | :--- |
| **9. Data Engineer** | Builds **idempotent, backfill-safe, schema-versioned pipelines**. Assumes upstream sources will arrive late, duplicated, malformed, or out of order, and isolates bad records via dead-letter queues. | **Enforces:** Partitioned incremental transforms, explicit data contracts (schema, nullability, freshness), atomic partition swaps, full data lineage.<br>**Bans:** Non-idempotent `INSERT` jobs that duplicate data on retry, silent schema drift, unbounded analytical scans against live OLTP databases. | **Dirty-Data Idempotency Gate:** Runs pipeline twice against synthetic dirty fixtures (duplicates, nulls, late arrivals); verifies identical output row counts and `0` contract violations. |
| **10. ML / AI Engineer & Researcher** | Separates **offline scientific evaluation rigor from online inference reliability**. Establishes simple baselines before complex models, prevents data leakage, and wraps stochastic models in deterministic guardrails. | **Enforces:** Strict train/val/test split isolation, versioned datasets/prompts/weights, structured schema decoding, p95 latency and VRAM/token budgets.<br>**Bans:** Evaluating on training data, shipping prompt/model changes without beating baseline metrics, trusting unvalidated LLM outputs in control flows. | **Golden Dataset Eval Gate:** Runs automated benchmark suite against held-out golden data; blocks promotion if accuracy/F1 regresses, hallucination rate exceeds ceiling, or latency/cost breaches budget. |
| **11. Security Engineer** | Thinks like a **persistent adversary mapping attack surfaces and trust boundaries**. Assumes every external payload is hostile and every authenticated user will attempt horizontal/vertical privilege escalation. | **Enforces:** Defense-in-depth (AuthN + AuthZ + DB Row-Level Security), cryptographic token binding, strict CSP/CORS headers, parameterized queries, secret rotation.<br>**Bans:** Client-side-only access checks, trusting user-supplied `tenant_id`/`user_id` without token verification, custom cryptography, string-interpolated SQL/shell calls. | **Adversarial Security & IDOR Gate:** Executes automated cross-tenant exploit probes (Tenant A token querying Tenant B IDs must return `403`/`404`), Semgrep SAST scan, secret-leak scan, and auth-bypass fuzzing. |

### D. Quality & Testing

| Role Cartridge | Principal Mental Model & Design Approach | Mandatory Execution Rules & Banned Anti-Patterns | Deterministic Verification Gate |
| :--- | :--- | :--- | :--- |
| **12. QA Engineer / Tester** | Thinks in **equivalence partitions, boundary value analysis, and adversarial user journeys**. Hunts for state corruption, race conditions, and requirement gaps rather than happy-path confirmation. | **Enforces:** Requirement-to-test traceability matrix, negative/boundary/null test cases, cross-viewport and network-degradation testing.<br>**Bans:** Happy-path-only testing, vague bug reports without deterministic reproduction state, signing off on untested error/recovery states. | **Requirement & Boundary Coverage Gate:** Verifies every acceptance criterion and edge-case class in `status.md` maps to a passing, logged test execution record. |
| **13. SDET (Software Dev Engineer in Test)** | Engineers **scalable, deterministic, zero-flake test infrastructure** as production code using hermetic environments, synthetic data factories, and property-based invariant testing. | **Enforces:** Ephemeral containerized test isolation, deterministic clocks/RNG seeds, property-based testing for complex invariants, fast parallel execution.<br>**Bans:** Arbitrary `sleep()` waits, shared mutable state across tests, brittle CSS/XPath selectors, masking flaky tests with blind retries. | **Zero-Flake Parallel Gate:** Executes full test suite `3x` consecutively in parallel; requires `100%` pass rate (`0` flakes), sub-threshold runtime, and verified branch coverage on critical modules. |

---

## 4. Adversarial Cross-Role Synthesis (How Frontier + Harness Beats Solo Frontier)

A solo frontier model suffers from **confirmation bias**—it writes code to satisfy its own mental model of the prompt. Kriya Harness forces **multi-perspective adversarial synthesis** across isolated context windows:

```text
[User Intent]
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PASS 1: ARCHITECTURAL & CONTRACT COUNCIL (Frontier Model)               │
│ Produces: status.md DAG + schema.sql + openapi.yaml + threat_model.json │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PASS 2: SPECIALIST BUILDER PODS (Mid-Tier or Frontier + Role Cartridge) │
│ • Frontend Pod builds UI strictly against openapi.yaml & design_tokens  │
│ • Backend/DB Pod builds services + RLS policies against schema.sql      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PASS 3: ADVERSARIAL CRITIQUE & VERIFICATION PODS (Isolated Contexts)    │
│ • Security Adversary Pod: Attempts IDOR, SQLi, auth bypass on live build│
│ • SDET / QA Pod: Generates boundary/property tests from spec (not code) │
│ • UI/UX Auditor: Inspects rendered DOM, contrast, mobile overflow, CLS  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PASS 4: DETERMINISTIC GATE & SURGICAL PATCH LOOP                        │
│ Any failure emits exact trace -> Builder patches -> Re-verify -> COMMIT │
└─────────────────────────────────────────────────────────────────────────┘
```

Because **Pass 3 (Adversarial Critique)** runs in fresh context windows armed with the *specification* rather than the builder's assumptions, it catches subtle architectural flaws, security holes, and UX edge cases that a single-pass frontier model overlooks.

---

## 5. Self-Evolving Skill & Autonomous R&D Engine

Software engineering standards evolve monthly—new framework patterns, database optimizations, UI interaction paradigms, ML inference techniques, and newly discovered CVE classes emerge continuously. Kriya Harness stays at the Top 1% frontier automatically through a **Sandboxed Skill Evolution Pipeline** with strict **Owner Approval Governance**:

```text
┌───────────────────────────┐     ┌───────────────────────────────────────┐
│ 1. AUTONOMOUS R&D SCOUT   │────▶│ 2. DELTA EXTRACTION & PR DRAFTING     │
│ Scheduled domain monitor  │     │ Translates new SOTA patterns/CVEs into│
│ (Changelogs, RFCs, Papers)│     │ candidate edits to cartridges/*.md    │
└───────────────────────────┘     └───────────────────┬───────────────────┘
                                                      ▼
┌───────────────────────────┐     ┌───────────────────────────────────────┐
│ 4. OWNER APPROVAL DIGEST  │◀────│ 3. HERMETIC SANDBOX A/B BENCHMARK     │
│ Sends diff + citations +  │     │ Runs Golden Tasks: Old Skill vs. New  │
│ benchmark proof to Owner  │     │ Measures Pass Rate, Quality, & Cost   │
└───────────────────────────┘     └───────────────────────────────────────┘
```

1. **Scheduled Domain Scouting:** Background worker monitors authoritative release notes, security advisories, framework RFCs, and SOTA engineering benchmarks across all 13 disciplines.
2. **Candidate Cartridge Drafting:** Extracts concrete, actionable delta rules (e.g., *"New PostgreSQL indexing pattern reduces multi-tenant query latency by 45%"* or *"New React server-action CSRF vector banned"*) and drafts a candidate patch to the relevant cartridge.
3. **Hermetic Sandbox A/B Verification:** Before alerting the owner, the harness runs a standardized **Golden Benchmark Suite** using a mid-tier model equipped with the **Current Cartridge** vs. the **Candidate Cartridge**. It objectively measures:
   * Deterministic verification gate pass rate (`%`)
   * Output quality / rubric score
   * Total token consumption and latency
4. **Owner Diff & Verification Report (`SKILL_UPDATE_PROPOSAL.md`):**
   * The harness **never silently mutates production skills**.
   * When a candidate skill proves statistically superior in sandbox benchmarks, it generates a clean proposal report containing:
     * **Domain & Advancement Summary** (with primary source citations)
     * **Exact Line-by-Line Diff** to the Skill Cartridge
     * **Benchmark Proof Table** (Baseline vs. Upgraded pass rate, quality score, and token cost)
   * The owner reviews and approves with one command, ensuring zero regressions and full visibility into how the workforce is evolving.

---

## 6. Long-Horizon Execution Protocol (`Kriya Loop`)

To execute multi-day, multi-module projects without losing coherence:

1. **Decompose:** Break the project into atomic, verifiable DAG nodes in `status.md`, tagging each node with its `role_cartridge`, `input_contracts`, `target_files`, and `verifier_gate`.
2. **Mount & Prune:** Load *only* the active node's Skill Cartridge, its input contracts, and an AST symbol map of relevant files.
3. **Execute:** Generate code/configs strictly adhering to the cartridge's enforced standards and banned anti-patterns.
4. **Verify:** Execute the deterministic verification gate (`exit code 0` required).
5. **Checkpoint or Escalate:**
   * If `PASS`: Hash artifacts, update `status.md` node to `VERIFIED`, commit atomically, and advance to the next unlocked DAG node.
   * If `FAIL (Attempt 1)`: Feed exact deterministic stderr/trace back to the worker model for self-correction.
   * If `FAIL (Attempt 2)`: Trigger **Frontier Escalation** with full failure trace to patch the root cause, then re-run the gate.

---

## 7. Target Repository Architecture (`Kriya-Tavi`)

```text
Kriya-Tavi/
├── docs/
│   └── kriya-harness/
│       ├── MASTER_INTENT.md           # This architectural North Star specification
│       └── status.md                  # Live DAG execution ledger & verification state
├── kriya_harness/
│   ├── orchestrator/
│   │   ├── dag_planner.py             # Decomposes user intent into multi-role DAG
│   │   ├── model_router.py            # Tiered routing (Mid-tier worker vs. Frontier escalation)
│   │   ├── contract_bus.py            # Typed artifact exchange (OpenAPI, SQL, Tokens, Threats)
│   │   └── kriya_loop.py              # Checkpointed execution engine with rollback support
│   ├── cartridges/                    # 13 Top-1% Role Skill Packs (mounted 1 at a time)
│   │   ├── app_dev/                   # frontend.md, backend.md, fullstack.md, mobile.md, game.md
│   │   ├── infra_ops/                 # devops.md, cloud.md, systems_embedded.md
│   │   ├── data_ai_sec/               # data_eng.md, ml_ai.md, security.md
│   │   └── quality/                   # qa_tester.md, sdet.md
│   ├── verifiers/                     # Non-LLM deterministic gates (exit 0 = PASS)
│   │   ├── frontend_audit.py          # Playwright viewport, a11y, console, layout, CLS checks
│   │   ├── backend_contract.py        # OpenAPI compliance, concurrency race & fuzz checks
│   │   ├── security_idor.py           # Cross-tenant RLS/IDOR probes, SAST, secret scan
│   │   ├── infra_policy.py            # IaC plan audit, CVE scan, FinOps ceiling check
│   │   └── sdet_runner.py             # 3x parallel zero-flake test & coverage runner
│   └── evolution/                     # Self-Evolving Skill Engine
│       ├── domain_scout.py            # Monitors changelogs, CVEs, papers, and SOTA patterns
│       ├── sandbox_ab_bench.py        # Golden task A/B evaluator (Old vs. Candidate Skill)
│       └── proposal_reporter.py       # Generates owner-reviewable SKILL_UPDATE_PROPOSAL.md
```

---

## 8. North Star Success Metrics

| Metric | Target Benchmark |
| :--- | :--- |
| **Mid-Tier Elevation Ratio** | Mid-tier model + Kriya Harness achieves `>= 90%` pass rate on complex multi-file benchmarks where solo frontier models score `65–75%`. |
| **Super-Frontier Ceiling** | Frontier model + Kriya Harness achieves `0` critical security/IDOR leaks, `0` UI layout/a11y regressions, and `100%` contract parity across full-stack builds. |
| **Token Cost Efficiency** | `65–80%` reduction in total API spend per verified feature via Contract Bus pruning, KV-cache prefix pinning, and mid-tier worker routing. |
| **Autonomous Skill Evolution** | Monthly verified skill proposals backed by quantitative sandbox A/B gains with `0` unapproved production regressions. |
