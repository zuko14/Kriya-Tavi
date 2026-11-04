# CLAUDE CODE COMPANION MISSION: KRIYA RECURSIVE HARNESS EVOLUTION ENGINE (KRHE)

**Companion to:** `MISSION BRIEF: KRIYA LOOP V2 ARCHITECTURE & PRODUCTION IMPLEMENTATION`  
**Target system:** Kriya Harness / Kriya Self-Verifying Loop V2  
**Research reference:** Harness² — *Recursive Agent Harnessing for an Open World*  
**Primary outcome:** Design, specify, implement, and validate a secure, evidence-driven recursive harness optimization subsystem that improves the effectiveness of Kriya's existing agent runtime without changing the underlying model weights.

---

## 0. HOW THIS PROMPT RELATES TO THE LOOP V2 MISSION

This is an **additive companion mission**, not a replacement for the existing Kriya Loop V2 mission brief.

Execute both missions as one coordinated engineering programme:

- **Kriya Loop V2 is the task-execution control plane.** It decomposes and executes a user's task, maintains the execution DAG, manages checkpoints and branches, routes tools, processes failures, verifies results, and produces a task outcome.
- **Kriya Recursive Harness Evolution Engine (KRHE) is the meta-optimization plane.** It observes completed or safely isolated task executions, proposes alternative harness configurations, evaluates those alternatives against controlled evidence, adopts only verified improvements, and preserves scoped lessons for future tasks.
- **The loop supplies evidence to the evolution engine.** KRHE can in turn provide approved, versioned strategy/configuration profiles to future loop executions.
- **Neither subsystem may bypass Kriya's mandatory security, spend, approval, tenancy, sandbox, or audit controls.**

Do not create two competing loop implementations. Do not duplicate the task scheduler, checkpoint manager, model gateway, policy engine, or verification framework if Loop V2 already provides suitable primitives. Reuse stable interfaces and introduce explicit adapters where necessary.

The combined architecture should form a controlled feedback cycle:

```text
User task
   |
   v
Kriya Loop V2
  - task/DAG planning
  - tool and model execution
  - checkpoints and recovery
  - verification
  - structured execution evidence
   |
   v
KRHE evidence intake
   |
   v
Propose -> Probe -> Compose
   |
   v
Independent evaluation and policy gates
   |
   +---- rejected candidate -> retain evidence; do not activate
   |
   v
Versioned improvement library
   |
   v
Approved harness profile for a future eligible task
   |
   +-------------------------------> Kriya Loop V2
```

The objective is to make the **same available model** complete more tasks correctly, safely, efficiently, and verifiably through better orchestration and tool-use design. A harness can improve effective task performance; it cannot guarantee that a moderate model becomes universally equivalent to a stronger model, nor can it guarantee perfect reliability.

---

## 1. EXECUTION MANDATE

Act as the Principal Agent Systems Architect, Recursive Optimization Research Engineer, and Production Reliability Lead for Kriya Harness.

Do not merely write a conceptual proposal. Inspect the actual repositories and current Loop V2 implementation, research the primary sources, design the architecture around the real codebase, write the architectural specification and ADRs, implement the subsystem incrementally, add tests, run the relevant suites, and report verifiable results.

You are authorized to make engineering decisions within the existing repository and product invariants. You are **not** authorized to:

- Modify or delete the protected main checkout or the user's active `~/.kriya` symlinks.
- Deploy to production, run migrations against production, change production configuration, or activate a new production optimizer without explicit owner approval.
- Start unmetered, high-cost, or paid model benchmark runs without explicit owner approval.
- Weaken safety policy, approvals, tenant isolation, secret handling, spend reservation, sandbox isolation, or auditability to improve benchmark scores.
- Allow an agent or optimizer to grant itself permissions, increase its own budget, disable its own limits, approve its own changes, or modify its protected implementation.
- claim benchmark gains, test passes, compatibility, or production readiness without recorded evidence.

When facts in this prompt conflict with the actual codebase, current `AGENTS.md`, or the existing Loop V2 mission, stop and reconcile them through an ADR. Do not silently assume that a reported version, test count, migration state, flag, file, or branch is still current.

---

## 2. PREFLIGHT: REPOSITORY AND SYSTEM RECONNAISSANCE

Use the exact repository and worktree constraints from the Loop V2 mission brief:

- Server repository: `/Users/chaitanyakumarmanda/Developer/Kriya-Tavi` on the intended feature branch.
- Client worktree: `/Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade` on the intended feature branch. Continue client work there.
- The user's main checkout `../kriya-harness` must remain untouched. Do not reset, clean, delete, repoint, or rewrite its active symlinks in `~/.kriya`.

Before editing anything:

1. Print and verify `pwd`, repository root, branch, upstream, worktree status, untracked files, and recent commits in both intended work areas.
2. Confirm the client and server worktrees are the expected repositories. Do not infer repository identity from directory names alone.
3. Identify all existing local modifications and user-owned work. Preserve them. Never use destructive cleanup commands (`git reset --hard`, `git clean -fdx`, forced checkout, or equivalent) to obtain a clean tree.
4. Confirm which files belong to the client repository and which belong to the server repository. Keep the implementation in the correct worktree.
5. Read the current `AGENTS.md` and all canonical Loop V2 documents named in the original mission, including the current status and release notes.
6. Inspect the existing H14 / Track HU implementation and its actual interfaces. Search for any existing loop, optimizer, evaluator, benchmark, memory, rules, checkpoint, shadow-Git, feature-flag, approval, and model-gateway components before proposing new abstractions.
7. Capture a baseline: current test commands, pass/fail counts, current loop benchmark results, relevant feature flags, package versions, and known failures. Run only safe local tests initially.
8. Check the state of the client and server test suites independently. Do not repeat stale counts from the prompt as if they were current.

Create a reconnaissance report before implementation. If a repository path, branch, or expected document is absent, report it and find the correct current location without touching protected worktrees.

---

## 3. RESEARCH BASELINE: HARNESS² AND RELATED WORK

### 3.1 Primary research to inspect

Read the paper and repository directly. Inspect the code, not just the README or social-media summaries.

- Paper: [Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224)
- Source repository: [google-research/harness2](https://github.com/google-research/harness2)
- Repository README: [Harness² README](https://github.com/google-research/harness2/blob/main/README.md)

Study the implementation of:

- Task-level recursive harness refinement.
- The Propose–Probe–Compose cycle.
- Parallel and sequential recursion modes.
- General and task/domain-specific candidate generation.
- How execution traces and behavioral contrasts are represented.
- How an adopted harness is selected when no ground-truth task verifier is available.
- Harnessing-level recursion and the persistent improvement harness.
- Evidence-supported lesson extraction, storage, retrieval, and reuse.
- Executor adapters and the supported OpenCode/Codex substrates.
- Benchmark orchestration, repeatability, task selection, reporting, and cost controls.

Verify paper claims against the paper's tables, appendices, experimental configuration, and repository implementation. Record what has actually been reproduced by the authors, what is only described conceptually, what is supported in the public code, and what would require new Kriya engineering.

### 3.2 Important research limitations and safety observations

The public Harness² README states that executor network access is unrestricted and that its Codex executor runs with sandboxing disabled. It also warns about benchmark rubric/answer leakage. **Do not reproduce those settings in Kriya.** Treat network access, benchmark isolation, and sandbox behavior as explicit security design requirements.

The repository states that it is not an officially supported Google product. The main repository license is Apache-2.0, but the README says third-party code, benchmarks, and datasets retain their upstream licenses. Before copying, vendoring, adapting, or importing code, inspect the exact license and notices for each component. Prefer implementing compatible ideas behind Kriya-native interfaces unless a concrete dependency is justified.

Do not assume that the Python Harness² package can be plugged directly into the TypeScript DSH/Cordis runtime. Determine whether a process boundary, event protocol, or native TypeScript adapter is more suitable. Do not introduce a second runtime merely because the research implementation uses Python.

### 3.3 Broader research directions

Research and compare the relevant primary sources and current implementations, including:

- ReAct: reasoning and acting through interleaved tool use.
- Reflexion: verbal feedback and episodic learning from attempts.
- Tree of Thoughts and Graph of Thoughts: structured exploration and combination of candidate reasoning paths.
- SWE-agent and its Agent-Computer Interface: tool/interface design as a determinant of agent effectiveness.
- Agentless: evidence that a simpler, deliberately structured workflow can outperform more elaborate agent loops on some coding tasks.
- CodeAct and executable action representations.
- OpenAI Codex harness engineering and Codex App Server architecture.
- Anthropic's guidance on effective agents, tool use, subagents, skills, hooks, and context management.
- Relevant work on agent memory, evaluation reliability, context engineering, and agentic security.

Use primary papers, official documentation, code repositories, and reproducible experiments as preferred evidence. For every technique, record its intended benefit, assumptions, overhead, failure modes, model dependence, security implications, and evidence quality. Avoid technique collecting for its own sake.

---

## 4. ARCHITECTURAL BOUNDARY: LOOP V2 VS KRHE

Formalize this separation in `docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION.md` and in code interfaces.

| Concern | Kriya Loop V2 | KRHE |
|---|---|---|
| User-task execution | Owns | Observes through events/evidence |
| Task DAG and dependency scheduling | Owns | May propose validated planning-policy changes |
| Tool invocation and runtime state | Owns | Measures and proposes allowed tool-guidance changes |
| Checkpoints, branches, rollback | Owns | Uses their evidence; must not corrupt them |
| Verification and task acceptance | Owns | Evaluates optimizer candidates using independent evidence |
| Candidate harness configurations | Consumes approved profiles | Proposes and evaluates |
| Persistent optimization lessons | Supplies execution evidence | Owns scoped, provenance-backed records |
| Mandatory security controls | Enforces | Cannot weaken, bypass, or edit |
| Model gateway and spend ledger | Owns authoritative enforcement | Uses metered access through the gateway |
| Production rollout | Existing release process | Supplies versioned candidate; cannot self-deploy |

Use stable, versioned contracts. A loop execution should produce a structured, redacted evidence bundle. KRHE should return a configuration/profile reference and rationale, not mutate an active execution's hidden state.

Do not make KRHE a second agent runtime. It is an optimizer and evidence-learning service that can invoke controlled evaluation executions through the existing runtime.

---

## 5. KRHE FUNCTIONAL DESIGN

Design the subsystem as a sequence of explicit, auditable stages.

### 5.1 Evidence intake and normalization

Build a typed evidence contract for a loop execution. Depending on what the current system can safely capture, it should include:

- Task ID and execution ID, with tenant-safe pseudonymous references where appropriate.
- Task category and difficulty/scope descriptors, avoiding unnecessary sensitive task content.
- Model provider, model identifier, model version if available, decoding settings, and context/output limits.
- Harness profile ID and immutable version/hash.
- Tool availability and versions, sandbox/runtime profile, and relevant environment metadata.
- DAG structure, step transitions, branch/retry counts, and checkpoint references.
- Tool-call summaries, failures, verification outcomes, and recovery actions.
- Final artifact references and independent verifier results.
- Token usage, spend, wall-clock latency, compute utilization, and queueing time where available.
- Human intervention and approval events.
- Safety/policy denials and security events, recorded without exposing secrets.
- Trace provenance, timestamps, and schema version.

Evidence must be redacted before storage. Never collect raw secrets, access tokens, private keys, unrestricted environment dumps, or unnecessary patient/customer content. Respect tenant isolation, data retention, and user/organization consent requirements.

A failed task is not automatically a bad harness. Distinguish model limitations, incorrect task understanding, tool/environment failures, external service failures, bad harness instructions, verification defects, insufficient budget, and inherently ambiguous tasks. KRHE must not learn a false rule from an incorrectly attributed failure.

### 5.2 Candidate harness representation

Define an immutable, schema-validated `HarnessProfile` (or equivalent) with component-level versioning. Inspect the real Kriya runtime first, but evaluate at least these candidate dimensions:

- Task-specific system/task instructions that are permitted to vary.
- Planning and DAG decomposition policies, including atomicity and decomposition thresholds.
- Model/tool selection and routing preferences within allowed model-gateway policy.
- Tool descriptions, usage guidance, and action ordering.
- Context assembly, retrieval, and compaction strategies.
- Skill selection and skill composition.
- Subagent/delegation topology and role instructions.
- Retry, recovery, and branch-selection strategies.
- Verification-plan selection and evidence collection strategy.
- Memory retrieval and lesson applicability rules.

Every editable surface must have an explicit schema, validation rules, size bounds, owner, version, and allowlist. Reject unknown fields and unsafe references by default.

**Never put protected controls inside the optimizer's editable surface.** Protected controls include authentication, permissions, tenant/RLS enforcement, sandbox isolation, secret redaction, approval policy, tool risk classes R0–R5, spend reservation and hard budgets, audit integrity, data retention obligations, and deployment authorization.

Treat code changes, dependency changes, privileged scripts, executable plugins, and security-policy changes as a separate human-reviewed software engineering process—not as ordinary harness-profile edits.

### 5.3 Propose stage

Generate a deliberately small set of candidate profiles from:

1. The current baseline profile.
2. A general candidate derived from broadly supported lessons.
3. A task/domain-specific candidate derived from the current task's requirements and prior scoped evidence.
4. Optionally, a composed candidate combining independently supported changes.

The proposer must state, for every candidate:

- The exact configuration diff.
- The problem or failure mode it targets.
- The hypothesis for why it should help.
- Which task/model/domain slices it is expected to affect.
- What evidence would support or falsify the hypothesis.
- Expected token, latency, tool-call, and compute overhead.
- Potential regressions, safety implications, and rollback plan.

Keep candidate count and recursion depth bounded by policy. Use a deterministic seed or record the source of stochasticity where possible. Avoid generating many near-duplicate candidates that consume budget without testing distinct hypotheses.

### 5.4 Probe stage

Evaluate candidates in isolated, reproducible, budget-controlled executions.

- Use the same underlying model and version for paired comparisons whenever possible.
- Hold task input, tools, environment, context limits, and spend/latency budget constant unless the experiment explicitly tests one of those variables.
- Use baseline and candidate runs on the same tasks; randomize run order where appropriate to reduce ordering effects.
- Run repeated trials for stochastic tasks and report variation rather than relying on one lucky completion.
- Prevent candidates from reading hidden benchmark answers, rubrics, expected patches, or judge-only data.
- Keep network access and filesystem scope restricted according to the task's trust level.
- Ensure every model call, tool invocation, and subprocess is metered by existing Kriya controls.
- Save sufficient traces and artifacts to reproduce the outcome without storing secrets or unnecessary user data.

Support both:

- **Parallel exploration:** candidates branch from the same immutable baseline/checkpoint and are evaluated independently. This explores alternatives but consumes more resources.
- **Sequential refinement:** each accepted experimental refinement seeds the next bounded probe. This can refine more deeply but risks compounding a mistaken early change.

Choose the mode based on the task, evidence quality, available budget, and latency requirements. Do not assume parallel or sequential is universally superior.

Probe runs must not share mutable worktrees, unisolated process state, credentials, or writable filesystem state. Reuse safe immutable caches only when cache provenance and isolation are clear.

### 5.5 Compose stage

Compare execution evidence and create a composed profile from the candidate changes that have demonstrated benefit.

Composition rules:

- Preserve the baseline by default.
- Include only changes whose effects can be attributed with reasonable confidence.
- Do not merge conflicting instructions or policies without an explicit resolution strategy.
- Do not select candidates based only on self-reported model confidence, a persuasive explanation, or raw token efficiency.
- Do not use a candidate's own verifier as the sole authority for its success.
- Keep a human-readable, machine-readable, and content-hashed diff.
- Record rejected alternatives and why they were rejected.

When evidence is inconclusive, compose no change. “No change” is a valid and often correct outcome.

### 5.6 Independent evaluation and adoption gate

Use an evaluation path that is logically independent from the candidate proposer and composer. Where feasible, combine deterministic tests, artifact checks, held-out task evaluations, and independent model or human review.

A candidate may be adopted only when all hard constraints pass and the evidence supports the intended improvement. Define explicit acceptance criteria in an ADR based on the measured baseline; do not invent arbitrary statistical thresholds or claim significance from insufficient samples.

Adoption should consider a vector of outcomes, not one opaque score:

- Verified task completion rate.
- Correctness and artifact quality.
- Regression rate and severity.
- Safety/policy violations (hard zero-tolerance gate for prohibited behavior).
- Tool-call success and avoidable tool errors.
- Recovery effectiveness and wasted retries.
- Token consumption and monetary cost per verified task.
- End-to-end latency and tail latency.
- Context efficiency and relevant-information recall.
- Human intervention rate.
- Performance by model, task category, difficulty, and environment.

Use a constrained multi-objective decision approach. Security and policy invariants are **hard constraints**, not tradeable reward terms. Consider Pareto comparisons or an explicitly justified utility function for non-safety metrics. Report each metric separately so an apparent aggregate improvement cannot hide a meaningful regression.

The acceptance gate should be able to say:

- Adopt: improvement is supported and no forbidden regression occurred.
- Canary: promising but still requires limited rollout evidence.
- Hold: evidence is insufficient or noisy.
- Reject: regressed, unsafe, invalid, or too costly.

### 5.7 Harnessing-level learning and memory

Create a persistent improvement library for evidence-backed lessons. Do not treat it as a free-form scratchpad or a global instruction file that every agent blindly trusts.

Each lesson should contain:

- Unique immutable lesson ID and version.
- Concise statement of the observed lesson.
- Provenance: execution IDs, profile versions, evidence/artifact hashes, and evaluator version.
- Applicability scope: task type, model family/version, tools, runtime, repository/domain, and relevant conditions.
- Supporting and contradicting observations.
- Confidence/uncertainty and sample count.
- Measured benefit, regressions, and cost effects.
- Creation time, last validation time, expiry/revalidation policy, and status.
- Approval source and lifecycle state.

Use lifecycle states such as `proposed`, `validated`, `approved`, `deprecated`, and `rejected`. Keep tenant-specific lessons isolated. Cross-tenant aggregation, if ever considered, must be privacy-reviewed, explicitly authorized, and designed to prevent leakage of customer content or proprietary task details.

Retrieve lessons by scope and evidence, not merely semantic similarity. A lesson validated for one model, repository, tool version, or task category must not be assumed to generalize universally. Include negative lessons and known exceptions. Support invalidation when later evidence contradicts an earlier rule.

Do not automatically append optimizer-generated rules to a globally active `.kriya/rules.md`. Follow the existing owner-confirmation requirement from Loop V2. If useful, stage proposals in a separate versioned store or review file, then require approval before activation.

### 5.8 Model compatibility and moderate-model uplift

The architecture must be model-provider and model-family agnostic. It should work through Kriya's existing model gateway and support models with different context limits, tool-call formats, instruction-following ability, reasoning budgets, and latency/cost profiles.

Do not bake a capability assumption into the architecture. Discover actual model metadata from the current catalogue and runtime. The optimizer must degrade gracefully when a model lacks structured tool calling, reliable JSON, parallel tool calls, or long-context support.

Evaluate whether KRHE meaningfully improves **moderate and above-moderate models** relative to their own fixed-harness baselines. Do not compare different model families and attribute the entire difference to the harness. Use within-model paired comparisons first, then report cross-model findings separately.

Model routing itself may be a candidate dimension only within the existing model gateway's allowed policies and spend limits. KRHE cannot bypass provider allowlists, model limits, cost reservations, or routing policy.

### 5.9 Failure attribution and learning from unsuccessful tasks

Connect KRHE to Loop V2's structured failure taxonomy. At minimum, distinguish:

- Planning/decomposition failure.
- Context omission or retrieval failure.
- Tool-selection or tool-guidance failure.
- Invalid tool arguments or protocol failure.
- Model capability or instruction-following limitation.
- Verification-plan omission or verifier defect.
- Code/artifact regression.
- Environment, dependency, network, or timeout failure.
- Budget exhaustion or routing failure.
- Permission/policy denial.
- Ambiguous or underspecified user request.

Only learn a harness lesson when the cause is sufficiently attributable. Environment failures should not automatically produce prompt changes. A verifier defect should produce a verifier-quality issue, not be “fixed” by changing the agent's behavior to satisfy the defective verifier.

### 5.10 Safety, privacy, and adversarial resilience

Treat all task data, tool output, repository content, web content, benchmark content, memory entries, and candidate-generated text as untrusted data unless independently validated.

Required protections:

- Preserve Kriya's R0–R5 tool-risk classification and approval gates.
- Preserve tenant isolation, database RLS, and ownership boundaries.
- Preserve model gateway spend reservation, hard caps, and billing ledger integrity.
- Use short-lived, least-privilege credentials and never expose them to candidate editors.
- Keep candidate executions isolated from production systems and unrelated user workspaces.
- Do not let task content or tool output rewrite optimizer policies or privileged memory.
- Defend against prompt injection, memory poisoning, benchmark leakage, reward hacking, test weakening, fabricated evidence, and candidate/verifier collusion.
- Treat optimizer-generated code, scripts, plugins, and tool definitions as untrusted until reviewed and tested.
- Produce immutable audit events for proposal, probe, evaluation, approval, activation, rollback, and rejection.
- Support immediate disablement and rollback to the previous known-good profile.

An optimizer may recommend a policy change, but must never approve or activate a change to its own protected permissions or policy.

---

## 6. MATHEMATICAL FORMULATION AND DECISION LOGIC

Do not add equations merely for appearance. Formalize the system with explicit variables, assumptions, and limits, and map each formula to implementable code and tests.

At minimum define:

- `x`: task and permitted task context.
- `m`: fixed model/provider/version and inference configuration for a controlled comparison.
- `e`: execution environment, tools, and sandbox profile.
- `b`: resource budget (tokens, money, wall-clock time, tool calls, concurrency).
- `h`: immutable harness profile.
- `tau`: observed execution trajectory and artifacts.
- `D`: evaluation dataset or task cohort.
- `M`: vector of quality, safety, cost, latency, and reliability metrics.

A useful conceptual decomposition is:

```text
Baseline:  tau_0 ~ Execute(x, m, e, b, h_0)
Candidate: tau_i ~ Execute(x, m, e, b, h_i)
Evidence:  z_i = Evaluate(tau_0, tau_i, verifier_set, policy)
Compose:   h*  = Compose(h_0, {h_i}, {z_i})
Adopt:     h_next = Gate(h*, evidence, hard_constraints, owner_policy)
```

For each candidate, model the observed outcome as stochastic when the underlying model, tools, or environment are stochastic. Specify how repeated trials, task-paired comparisons, confidence intervals or other uncertainty estimates are used. Select statistical techniques appropriate to the sample size and metric; do not claim statistical significance when the data cannot support it.

Define a constrained optimization problem in which safety invariants, permissions, tenant isolation, and budget ceilings are feasibility constraints. Optimize non-safety objectives only within the feasible set. If a scalar utility is used, justify its normalization and weights, publish the full metric vector, and run sensitivity analysis so that arbitrary weights cannot conceal regressions.

Specify the conditions under which a lesson generalizes from an observed execution to a future task. Similarity alone is not proof. Include applicability scope, evidence quantity/quality, contradictory evidence, uncertainty, and expiry/revalidation.

For every mathematical construct, provide:

1. Formal definition and notation.
2. Assumptions and preconditions.
3. Runtime algorithm or pseudocode.
4. Complexity and resource cost where relevant.
5. Failure modes and counterexamples.
6. A measurable acceptance test.

---

## 7. INTEGRATION WITH KRIYA LOOP V2

The two missions must converge on one coherent architecture.

### 7.1 Evidence contract from Loop V2

Define a versioned event/evidence interface that Loop V2 can emit without coupling its execution kernel to optimizer internals. Prefer append-only structured events and immutable execution summaries. Use the existing telemetry/event infrastructure if it meets the requirements.

Loop V2 should continue to own:

- DAG planning, task execution state, and scheduling.
- Checkpoint creation and rollback.
- Tool and subagent execution.
- Error classification and directed feedback.
- Verification and final task acceptance.
- Existing result/memory and owner-confirmation flows.

KRHE should consume only the evidence it is authorized to see. It must not re-open, rewrite, or mutate the original task execution's workspace when performing candidate probes.

### 7.2 Profile selection before execution

For a new task, Loop V2 may request a compatible approved harness profile from KRHE. Selection must be:

- Read-only and fast on the critical path.
- Bounded by a latency budget.
- Scoped to model, tool versions, task category, tenant, and environment.
- Safe to fall back to the baseline profile when KRHE is unavailable.
- Recorded in the execution metadata so results can be attributed to a precise profile version.

Do not require an online Propose–Probe–Compose cycle for every user task. That would add avoidable cost and latency. Use precomputed profiles by default; consider live task-specific adaptation only for explicitly eligible tasks and bounded budgets.

### 7.3 Controlled asynchronous refinement

Run offline or background refinement only through existing approved infrastructure and scheduling controls. Do not create an untracked daemon, bypass Render/Supabase architecture constraints, or introduce a persistent worker without understanding deployment and failure semantics.

If a safe background job cannot be implemented within current infrastructure, begin with an explicit local/offline CLI command or administrative job. It must be observable, resumable, cancellable, and metered.

### 7.4 Rollback and profile pinning

Every execution pins a specific profile version. A later profile update must not silently change an in-progress task. Provide immutable profile history and a rollback action that restores a previously approved version. Record who or what approved activation.

---

## 8. BENCHMARK AND EXPERIMENT PROGRAMME

Create a benchmark plan that tests whether KRHE actually improves Kriya, rather than merely producing elaborate explanations or additional tool calls.

### 8.1 Required experiment arms

Use a matched set of tasks and the same model for each arm:

- **A — Current baseline:** existing Kriya runtime and current harness profile.
- **B — Loop V2 only:** improved execution loop without KRHE adaptation.
- **C — Loop V2 + task-level KRHE:** candidate Propose–Probe–Compose refinement, with no cross-task lesson reuse.
- **D — Loop V2 + harnessing-level memory:** approved evidence-backed lessons reused across future tasks, without live candidate probing.
- **E — Loop V2 + full KRHE:** bounded task-level refinement plus scoped harnessing-level learning.
- **F — Ablations:** remove one KRHE component at a time (candidate diversity, probing, composition, memory, independent gate, etc.) to understand which components produce measurable benefit.

Where feasible, also compare a simple/manual optimized profile. This helps determine whether the gains come from useful harness changes or merely from spending more inference budget.

### 8.2 Task cohorts

Build a representative, versioned suite covering:

- Repository exploration and code understanding.
- Multi-file implementation and refactoring.
- Bug diagnosis, repair, and regression prevention.
- Tests, type checking, build failures, and verification.
- Complex DAG planning and dependency-aware execution.
- Tool selection, command execution, and environment recovery.
- Long-running tasks requiring checkpoints and recovery.
- Research and evidence synthesis where supported by Kriya.
- Tasks requiring moderate models to use tools and context efficiently.
- Adversarial tasks designed to detect security regressions, prompt injection, test weakening, and reward hacking.

Keep a held-out set for final evaluation. Do not tune against every benchmark task and then present the same tasks as independent validation.

### 8.3 Metrics and reporting

Report at least:

- Verified completion rate and partial-completion rate.
- Independent artifact correctness/quality.
- Regression and harmful-change rate.
- Security-policy violations and permission boundary failures.
- Cost per verified task and tokens per verified task.
- Median and p95 latency.
- Tool calls, failed tool calls, retries, and branch count.
- Recovery success after injected or natural failures.
- Human approval/intervention frequency.
- Candidate acceptance/rejection rate and reasons.
- Lesson reuse rate, measured benefit, stale-lesson rate, and negative-transfer rate.

Show metrics by model and task category. Report sample counts, variance, confidence/uncertainty, evaluation method, evaluator version, and budget. Never report only a composite score.

### 8.4 Reproducibility

For each experiment, record:

- Exact code commit and dirty-worktree status.
- Harness profile hashes and versions.
- Model/provider/version and inference parameters.
- Task IDs, dataset version, and task selection seed.
- Executor/runtime/container/sandbox image and tool versions.
- Budget and concurrency settings.
- Candidate generation settings and recursion depth.
- Verifier/evaluator versions and rubric provenance.
- All results and failures, including invalid/incomplete runs.

A model-backed or paid benchmark run requires explicit owner approval unless it is already within a clearly approved budget. Start with deterministic local fixtures and the smallest safe evaluation slice. Ask for approval before expanding to paid or large-scale runs.

---

## 9. IMPLEMENTATION SEQUENCE

Use the following sequence unless reconnaissance proves a dependency requires a different order. Document any deviation.

### Phase KRHE-0 — Reconnaissance and research dossier

- Audit Loop V2/H14 and current components.
- Inspect Harness² paper and source implementation.
- Map reusable Kriya primitives and missing capabilities.
- Produce a component map, threat model, and integration diagram.
- Capture baseline tests and benchmark data.

### Phase KRHE-1 — Architecture and contracts

- Write `docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION.md`.
- Define Loop-to-KRHE evidence contract.
- Define harness profile schema, immutable versioning, and editable/protected surfaces.
- Define proposal, probe, composition, evaluation, approval, and rollback state machines.
- Write ADRs for persistence, execution adapter, storage, scheduling, and policy gates.

### Phase KRHE-2 — Offline deterministic skeleton

- Implement the profile schema/validator and content hashing.
- Implement a local evidence store or adapt the existing store.
- Implement deterministic candidate fixtures and an offline Propose–Probe–Compose pipeline.
- Add audit records, cancellation, resumability, and idempotency.
- No production activation and no paid model calls.

### Phase KRHE-3 — Loop V2 adapter and evidence capture

- Emit structured, redacted execution evidence from Loop V2.
- Connect KRHE through a versioned interface.
- Add trace correlation and profile pinning.
- Verify that failure attribution maps correctly to Loop V2's taxonomy.

### Phase KRHE-4 — Controlled candidate probing

- Add isolated candidate execution through the existing DSH/Cordis kernel and approved sandbox path.
- Add metering, budgets, timeouts, cancellation, resource caps, and concurrency controls.
- Add baseline/candidate paired comparison and immutable artifact capture.
- Ensure no candidate can access hidden benchmark data or unrelated sessions.

### Phase KRHE-5 — Compose, evaluate, and adoption gate

- Implement evidence-based composition.
- Add deterministic and independent evaluators.
- Implement adopt/canary/hold/reject decisions.
- Add regression checks and rollback.
- Keep owner approval for activation until the security and reliability gates are demonstrated.

### Phase KRHE-6 — Harnessing-level improvement library

- Add scoped lesson schema and lifecycle.
- Add provenance, evidence links, confidence/uncertainty, contradiction handling, expiration, and revalidation.
- Add retrieval based on explicit applicability filters plus semantic retrieval where useful.
- Preserve tenant isolation and owner confirmation.

### Phase KRHE-7 — Model compatibility and benchmark evaluation

- Test across the actual supported model catalogue, starting with approved models and low-cost/local tests.
- Measure within-model uplift against each model's own baseline.
- Run ablations and held-out evaluation.
- Report cost/latency trade-offs and negative results honestly.

### Phase KRHE-8 — Limited canary and operational readiness

- Only after explicit owner approval, deploy a disabled-by-default or canary-gated version.
- Expose profile version, evidence lineage, cost, status, and rollback controls to authorized operators.
- Verify observability, alerting, failure recovery, rate limiting, and data-retention behavior.
- Do not claim production readiness until release gates pass.

---

## 10. REQUIRED DOCUMENTS AND DELIVERABLES

Create or update the following in the correct repository after checking existing naming conventions:

1. `docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION.md` — full architecture specification, mathematical formulation, component boundaries, state machines, data contracts, security model, benchmark methodology, rollout plan, and unresolved questions.
2. `docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION_RESEARCH.md` — annotated research dossier with paper/repository references, implementation findings, license notes, evidence quality, limitations, and Kriya-specific applicability.
3. ADRs covering:
   - KRHE versus Loop V2 ownership boundaries.
   - Harness profile schema and immutable versioning.
   - Evidence storage, privacy, and retention.
   - Candidate executor/sandbox adapter.
   - Evaluation and adoption policy.
   - Lesson memory scope, approval, and invalidation.
4. `docs/kriya-harness/krhe/` or the project's established equivalent for benchmark task definitions, experiment records, reproducibility metadata, and result reports.
5. Implementation with unit, property-based, integration, and end-to-end tests consistent with the actual stack.
6. Operator documentation for feature flags, disablement, profile approval, audit review, canary operation, and rollback.
7. A final implementation report showing exact files changed, commands run, test counts, benchmark evidence, known gaps, and next release gates.

Do not create duplicate or conflicting documentation if equivalent files already exist. Extend the canonical document and link to the existing records.

---

## 11. FEATURE FLAGS AND SAFE DEFAULTS

Follow the existing feature-flag conventions. Propose names only after inspecting the current configuration system. The design should support independent controls equivalent to:

- KRHE entirely disabled.
- Evidence capture enabled, optimization disabled.
- Offline/local deterministic evolution enabled.
- Candidate probing enabled for approved tasks and budgets.
- Lesson retrieval enabled for validated/approved lessons.
- Canary profile activation enabled only after owner approval.

Safe defaults:

- Existing Kriya behavior remains the fallback.
- No live task should depend on KRHE availability.
- No candidate is adopted without independent evaluation and required approval.
- No security-sensitive setting is editable by KRHE.
- No paid model execution or scale-up occurs without the required approval.
- No lesson crosses tenant or organizational boundaries by default.
- No optimizer-generated rule silently becomes active in `.kriya/rules.md`.

---

## 12. PRODUCTION ACCEPTANCE GATES

KRHE is not production-ready merely because its pipeline runs or a demonstration improves one score.

At minimum, require evidence for:

1. **Architecture:** clear separation between task execution and meta-optimization, stable contracts, no duplicate runtime ownership.
2. **Correctness:** profile validation, deterministic state transitions, idempotency, replayability, and no mutation of baseline artifacts.
3. **Security:** threat model tested; isolation and policy boundaries preserved; adversarial prompt injection and memory poisoning tests pass.
4. **Privacy:** evidence is redacted, tenant-scoped, retention-governed, and free of accidental secret leakage.
5. **Cost:** all model/tool/subprocess work is metered and bounded; runaway recursion and concurrency are impossible under configured limits.
6. **Reliability:** cancellation, timeout, crash recovery, retries, stale jobs, and partial results behave correctly.
7. **Evaluation:** paired baseline comparisons, repeated trials where needed, held-out tasks, ablations, uncertainty reporting, and independent verification.
8. **Model compatibility:** no dependence on one model's proprietary response format or reasoning behavior.
9. **Operations:** observable lifecycle, audit trail, disable switch, immutable profile history, canary and rollback.
10. **Release:** all relevant client/server checks pass; no protected worktree is modified; no unapproved production side effect occurs.

Keep the feature experimental or beta until the gates are satisfied. Do not change release-stage claims based on design completion alone.

---

## 13. REQUIRED ENGINEERING QUESTIONS — ANSWER WITH EVIDENCE

Before finalizing the design, explicitly answer:

1. Which existing Kriya Loop V2 components already provide candidate generation, branching, evidence capture, memory, evaluation, or rules synthesis? What must be reused versus added?
2. What is the minimum stable interface between Loop V2 and KRHE?
3. Should KRHE run in-process, as a separate worker, or as a controlled CLI/job? Compare reliability, deployment, latency, security, and operating cost using the actual Kriya architecture.
4. Which harness dimensions can be safely modified as data, and which require human-reviewed code changes?
5. How do we prevent the optimizer from selecting a candidate that only exploits a flawed verifier?
6. How do we distinguish harness-caused failures from model, environment, task, and verifier failures?
7. What statistical evidence is sufficient for adoption on small and noisy task cohorts?
8. How should KRHE manage candidate diversity without wasting model calls?
9. When is parallel probing worth its cost, and when should sequential refinement be used?
10. How do we prevent negative transfer across model families, repositories, tools, tasks, and tenants?
11. How do we detect stale, poisoned, contradictory, or over-generalized lessons?
12. How do we guarantee recursion, concurrency, spend, latency, and storage are hard-bounded?
13. What happens when KRHE, its worker, or its storage is unavailable? Prove the baseline loop still operates.
14. How does KRHE integrate with the existing owner approval and `.kriya/rules.md` confirmation flow?
15. What evidence would demonstrate a meaningful improvement for moderate models without hiding cost or latency regressions?

For each answer, cite inspected files, tests, paper sections, or benchmark results. Mark unresolved questions explicitly.

---

## 14. DEFINITION OF SUCCESS

Success is not “the optimizer rewrites itself” or “the architecture contains recursive loops.” Success means:

- Kriya Loop V2 remains the single authoritative task-execution engine.
- KRHE can construct and evaluate alternative allowed harness profiles through Kriya's existing runtime and security controls.
- The system can demonstrate, on repeatable paired evaluations, that approved profiles improve verified task outcomes for at least some supported model/task cohorts.
- Results include cost, latency, quality, reliability, and safety—not only completion rate.
- Evidence-backed lessons can improve later tasks without causing material negative transfer or tenant leakage.
- All changes are versioned, attributable, auditable, reversible, and bounded by policy.
- When there is no reliable evidence of improvement, KRHE correctly keeps the baseline.

Do not claim “world's best,” “beats Claude Code,” “beats Codex,” or “surpasses all competing harnesses” unless Kriya has been evaluated under fair, reproducible, independently reviewed comparisons that support that exact claim. The engineering ambition can be frontier-level; public performance claims must remain evidence-based.

---

## 15. START EXECUTION NOW

Follow this order:

1. Acknowledge that this is the KRHE companion mission to the Kriya Loop V2 mission, not a replacement.
2. Complete repository/worktree reconnaissance and preserve every existing user change.
3. Read the original Loop V2 documents and inspect the actual H14/Track HU implementation.
4. Read the Harness² paper and inspect the public repository's actual source, executor adapters, experiment logic, README warnings, and license notices.
5. Produce the baseline report and a concrete Loop V2 ↔ KRHE component/interface map.
6. Write the architecture specification, research dossier, threat model, and initial ADRs.
7. Identify the smallest safe end-to-end vertical slice. Implement that slice in the correct worktrees with tests before expanding scope.
8. Run deterministic local tests first. Do not start paid or production experiments without explicit approval.
9. Continue through the implementation phases that can be safely completed in the current environment. Do not stop after writing a plan if implementation is possible.
10. At the end, report exact test commands and results, exact changed paths, benchmark evidence, security checks, unresolved risks, and what remains blocked by required owner approval.

**Final instruction:** Build KRHE as a Kriya-native, evidence-driven recursive harness evolution subsystem integrated with the existing Kriya Self-Verifying Loop V2. Learn from Harness², but do not copy its unsafe execution defaults or assume its benchmark results automatically transfer to Kriya. Preserve Kriya's runtime and product invariants. Prefer measured simplicity over unnecessary complexity. Implement, test, measure, and retain only improvements that survive independent verification.
