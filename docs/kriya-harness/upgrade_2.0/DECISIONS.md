# Harness 2.0 decisions (WD-01 … WD-16)

All **Proposed** until the owner writes "Approved WD-…" under "Track H
owner approvals" in `status.md`. Phases that depend on a decision don't
start before it (IMPLEMENTATION_PLAN lists each phase's decisions).

| Id | Decision | Alternatives rejected | Why | Phases |
| --- | --- | --- | --- | --- |
| WD-01 | Build only on documented DSH seams: plugins, bundle rows, `spawn` with `agentOptions.model`, the JIT tool mask. No fork | Fork DSH for a native router; a second agent runtime in Python (intent §7) | Track H rule 5; one runtime to secure; `agentOptions` is documented and typed in the pinned package (FORENSIC §1) | all |
| WD-02 | Head and worker are **tier aliases** chosen by the owner (`harness.orchestraHead` default `escalation`, `harness.orchestraWorker` default `budget`); the client never sees model ids | Per-person model choice; client-side model ids | Track H rule 4 (aliases only), owner controls cost; the gateway already accepts any allowed alias per request | W2 |
| WD-03 | Escalation happens inside the existing 4 attempts; default `E = 2` per role; `E` is a `HarnessProfile` field tuned by KRHE | Extra attempts for the frontier model; a learned router | Keeps the spend bound; one integer per role is attributable and gateable with KRHE's sign test (ARCHITECTURE §5) | W2, W10 |
| WD-04 | Gates are fixed client code; cartridges reference them by id; `REQUIRED[role]` lives in code | Model-written verifiers; gates as data scripts | A model writing its own check can write `exit 0` (reward hacking); data can't weaken what code requires | W3–W6 |
| WD-05 | Live checks use a stack the **person** starts and confirms (`kriya stack use`, loopback only); non-loopback DB URL in the project ⇒ stack gates refuse | Harness starts Docker / `supabase start` itself | Docker needs a daemon and network outside the folder sandbox; auto-start could hit a hosted database (operator rule 6 lesson) | W4 |
| WD-06 | Cartridges are `skills-harness/kriya-role-*` manifests (`kriya.json` in the existing strict format) plus a sibling `cartridge.json` validated by `lib/harness/cartridges.ts`, served as their own switched set (`harness.workforce`), the track E pattern | A new file format with YAML; a new route | `buildCatalog`, loaders, ETags, switches and tests already exist; no parser dependency | W1 |
| WD-07 | Every change that comes from the Scout is **E2: the owner's click**, after lint and a benchmark, even if the text alone would be E1 under HD-22 | Auto-promotion of web-derived guidance | Web text is untrusted; a poisoned cartridge would reach every device; the owner explicitly asked to approve | W7–W9 |
| WD-08 | Cartridge benchmarks run only on the owner's computer or a track C sandbox (command, then optional `bench` dispatch to the owner's own device) | Running KriyaBench in `kriya-worker` | KU-ADR-15 (`refuseOnServers`); agent commands never on Kriya's servers | W9, W12 |
| WD-09 | `harness.cartridgeOverlay` defaults **off**: approved versions are stored, and ship through a reviewed commit to `skills-harness/`. With it on, versions are served from the database with canary and one-click rollback | Always serve from the database | Off is the safest path while the pipeline is new; on is the owner's explicit choice once trusted | W11 |
| WD-10 | Fifteen cartridges: the intent's 13 plus database and product designer; the architect's guidance is the head's own | 13 only; one generalist | The owner named database and design; a role per contract owner keeps ownership unambiguous (ORCHESTRA §5) | W1, W5–W6 |
| WD-11 | Intent §8's numbers are **targets** with a measurement protocol, never claims, until EVALUATION_PLAN evidence exists and RG-9 is fresh | Publishing the targets as product claims | Voice rule 6, track-A rule 12 | all |
| WD-12 | Long horizon = a milestone ledger of ≤ 12 bounded plans; `MAX_STEPS = 7` and `MAX_ATTEMPTS = 4` unchanged | Raise MAX_STEPS; one large DAG | Bounds are spend and attention controls; milestones add horizon without weakening them | W10 |
| WD-13 | The critic is advisory: it runs only after hard gates pass, triggers at most one polish attempt, and the polish is kept only if every gate still passes | Critic as a gate; critic scores as pass/fail | Model text is never evidence (track-A rule 7); monotone polish can only improve a correct result | W6 |
| WD-14 | The Scout's monthly cap defaults to ₹0 (fetch-and-diff only, no model call) and its sources list starts empty | A default budget; a built-in source list | Spend and sources are the owner's to choose; the facts commons precedent (`FACT_TARGETS = []`) | W7 |
| WD-15 | Device outcome counts per cartridge version are sent only with the person's HD-24 opt-in, counts only | Always-on telemetry | HD-17/HD-24 consent rules | W11 |
| WD-16 | "Carbon/hydrogen" orchestration is recorded as the owner's reference, unverified; the design rests on the checked advisor/executor and orchestrator/worker sources | Designing to an unverified description | Voice rule 6 | — |

## Second round (2026-11-23): 3D, connectors, delivery, interface

| Id | Decision | Alternatives rejected | Why | Phases |
| --- | --- | --- | --- | --- |
| WD-17 | A sixteenth cartridge, `kriya-role-graphics`, and the gate G-3D whose counts come from init-script–wrapped WebGL contexts, never from the app; frame time reported, never gated | Asking the app to report `renderer.info`; gating frame time | The app could flatter its own numbers; headless Chrome often renders in software, so its frame times don't predict a phone GPU | W13 |
| WD-18 | Explore: up to 3 gated takes **in sequence in one folder**, best kept by the person (or the critic, headless), inside `MAX_ATTEMPTS` | Parallel worktrees per builder | `AgentOptions` has no `cwd`, so builders share the folder; sequential takes reuse v2's snapshots and keep the bound | W14 |
| WD-19 | GitHub/GitLab on the device only through the person's own `gh`/`glab`/git login; typed tools; draft PRs only; never merge, force-push or push a default branch; Kriya never reads a device credential | Sending Kriya's sealed GitHub token to devices; untyped shell only | Invariant 4 and track H rule 6; typed tools are classifiable and easier for cheap models | W16 |
| WD-20 | Version-exact grounding from installed type definitions and changelogs, local and offline; nothing imported or executed | Web documentation search by default | Exact for the installed version, free, deterministic; importing a module runs its code | W15 |
| WD-21 | G-DEPLOYED is the single non-loopback gate: GET/HEAD to the host the person's own deploy printed, ≤ 20 requests, no browser, no probes | No post-deploy check; the agent browser on deployed sites | A release isn't proven until its URL answers; the agent browser's localhost-only rule stays | W17 |
| WD-22 | The harness never runs hosted-database migrations, production env/secret changes, DNS changes or merges; it writes the exact command into the receipt for the person | Adapter support for them | AGENTS.md: never modify production data; irreversible actions stay the person's | W17 |
| WD-23 | Interface: Run strip in `shell.bottom`, four right-column tracks (Live, Proof, Changes, Project), Explore and receipt cards, Mission Control panel; colours, fonts and material unchanged | Restyling DSH's own components through more CSS | Only documented layout seams; DSH's hashed classes already make CSS overrides fragile (`tests/brand.test.js`) | W18 |
| WD-24 | Proof receipts with a hash chain over run records, verified by `kriya receipt verify`, labelled "checked on this computer" | Unchained summaries; receipts as guarantees | Tamper-evident and honest about what was checked | W19 |

## Questions for the owner

1. WD-02: are `escalation` (head) and `budget` (worker) the right defaults
   for your current tier models, and which plans should get both tiers?
2. WD-07 and WD-09: confirm owner-click for every scouted change, and the
   overlay off until you switch it on.
3. WD-14: the monthly scout budget, and the first sources (SELF_EVOLUTION
   §2.2 lists candidates for you to read and choose).
4. WD-19/WD-21: confirm GitHub through the person's own `gh` login on
   devices, and the one non-loopback smoke gate for deployments.
5. WD-23: the interface reorganisation (four tracks replacing six) changes
   where existing people find Overview and Progress; confirm, or keep the old
   tracks behind the switch for one release.
6. The first paid evaluation (EVALUATION_PLAN E-1): which discipline first
   (recommendation: frontend + backend + security, the three with the most
   gates), and its budget.
