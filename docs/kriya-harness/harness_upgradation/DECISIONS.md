# Harness upgrade: architecture decision records (KU-ADR-01…18)

Decided 2026-11-04 by Claude Code as the programme's architect, inside the
limits of AGENTS.md (track H rules, invariants 1–7). Evidence ids: `HU-F-…`
(FORENSIC_AUDIT.md), `R-…` (RESEARCH.md), `HU-M-…` (KriyaBench-M runs,
`bench/mechanics-2026-11-04.json`). Status: **Accepted** (in force),
**Accepted, built** (code exists), **Proposed** (needs the owner), **Deferred**.

Each record: context · current behaviour · options · evidence · decision ·
rejected · trade-offs · migration/reversibility · tests.

---

## KU-ADR-01 Composition, selective replacement or fork

- **Context.** The mandate asks whether DSH should stay the kernel (options
  A–D, mandate §1.2).
- **Current.** Option A: DSH 0.2.1-rc.5 pinned, Kriya adds bundle rows and
  plugins (track H rule 5, HD-02). Every gap found in this audit (HU-F-01…05)
  was fixable through a documented seam (`agent/pre-step`,
  `tools/post-execute`, provider `models`, `compaction-basic.modelPolicies`,
  the gateway).
- **Options.** A composition · B selective replacement · C fork · D own core.
- **Evidence.** DSH's loop already has durable events, crash repair,
  cancellation, parallel tool scheduling, compaction with overflow recovery,
  spill/prune, subagents, ACP and a JSON-RPC SDK server (§3 matrix). Same-
  model results put DSH scaffolds at or near the top (R-03: DSH Minimal 72.6
  vs OpenCode 65.5 on DeepSWE, vendor, no CIs).
- **Decision.** **A, with a Kriya control layer** (Option A+): Kriya owns
  policy (budget, limits, verification, approvals, spend, evaluation); DSH
  stays the execution kernel. Replace a DSH part only when a measured
  benchmark shows it is the bottleneck *and* no seam fixes it.
- **Rejected.** C/D: high maintenance (≈ 300 packages), no evidence of a
  bottleneck the seams can't reach, and track H rule 5 forbids editing DSH.
  B: no component currently fails that test.
- **Trade-offs.** Upstream release risk (rc line) stays; mitigated by exact
  pins and the compatibility suite (KU-ADR-18).
- **Reversible.** Yes: every Kriya part is a plugin or row.
- **Tests.** HT-REL-03 dumps; HU-M-01…04 on every DSH bump.
- **Status.** Accepted.

## KU-ADR-02 Ownership of the agent loop and session manager

- **Current.** DSH's `ReactLoopAgent` and session log; Kriya's loop plugin
  (`kriya_plan`/`kriya_step`) runs *inside* it as tools and subagents.
- **Decision.** One loop (DSH's). Kriya never starts a second agent loop or
  session store on the client; Kriya's control logic is listeners and tools.
  On the server, `runTask` stays the one orchestrator (track C rule 3).
- **Rejected.** A Kriya-owned loop: duplicates state machines, breaks ACP/Web
  UI semantics, and the mandate itself says "do not create a second loop
  without a documented reason".
- **Tests.** Plugins only through `ctx.on` / `ctx.tools.register` (code review
  rule); KriyaBench-M arms.
- **Status.** Accepted.

## KU-ADR-03 Durable session events and persistence

- **Current.** DSH JSONL log with sequence numbers, crash repair by
  `interruptedTurnClosers`; Kriya keeps loop progress and checkpoints outside
  the project (`~/.kriya/progress`, `refs/kriya/checkpoints/*`); the mirror
  sends summaries to Kriya idempotently by sequence (H6).
- **Decision.** Keep. Kriya adds no event store. Known DSH gap (final
  `turn/end` may be lost on root shutdown) is recorded as a resume test
  target, not patched.
- **Tests.** U7 restart/resume drill (planned).
- **Status.** Accepted.

## KU-ADR-04 Turn state machine and the stop invariant

- **Context.** HU-F-01/02: no bound inside a turn.
- **Current (DSH).** Turn states: open → steps → `turn/end {completed |
  blocked | aborted | error | max-tokens}`; a pre-step listener may reject a
  step (→ `blocked`).
- **Options.** (a) cancel the agent from outside; (b) reject in
  `agent/pre-step`; (c) a wind-down step then let the turn close; (d) rely on
  the monthly cap.
- **Evidence.** R-42 (OpenHands: iteration cap + stuck patterns), R-03
  (vendor evals cap 500 steps), R-01 (seam named by DSH). Measured: HU-M-01
  31 → 8 steps, HU-M-02 31 → 4 calls.
- **Decision.** **(b) with one early warning**: `plugins/budget` counts steps
  and wall time per agent per turn and identical consecutive tool calls; five
  steps before the step limit (or at 90% of the time) it appends one notice
  to wrap up; at a limit it rejects the next step, so the turn ends
  `blocked` and `kriya run` exits 1. Defaults 150 steps / 60 min / 10
  repeats, set by `KRIYA_MAX_STEPS`, `KRIYA_TURN_MINUTES`,
  `KRIYA_MAX_REPEATS`.
- **Rejected.** (c) a wind-down step lets a stopped turn end `completed`
  (exit 0): a false success. (a) loses the durable reason. (d) is not a stop
  condition.
- **Trade-offs.** A cap too low cuts real work; 150 steps is above every
  recorded KriyaBench run. Falsifier: replay with caps {50, 100, 200, ∞}
  (RESEARCH #1).
- **Reversible.** `--no-budget` / `KRIYA_BUDGET=off` gives the pre-0.2.0
  agent. **Default on since 0.2.0** (owner, 2026-11-04: "B4 is our winner"),
  with the loop (U10, HU-SW-01).
- **Proposed to owner.** Turn it on by default for `kriya run` and the Web
  UI once one real-model KriyaBench arm shows no pass-rate loss.
- **Evidence so far (BENCHMARK_PLAN §6.3).** `--budget --loop` lost no task
  pair to today's harness (4–0 in its favour, p = 0.125) but cost +43% per
  passed task. The budget never stopped a turn, but 3 of B4's 21 tasks ran
  into the bench's 10-minute timeout (2 had already passed), so the cost is
  the loop's, and a 60-minute turn budget is longer than any bench task gets. Budget alone can be default-on by the "no loss" rule; the loop
  waits for a cheaper configuration.
- **B5 (§6.4).** The cheaper configuration (minimal tools + loop) lost the
  gain (0–5 vs B4, p = 0.063), so the loop stays opt-in; the next cheaper
  candidate is B4 minus one tool group at a time.
- **Tests.** HU-BG-01…03 (unit), HU-M-01/02 (real DSH).
- **Status.** Accepted, built (default off).

## KU-ADR-05 Workflow graph vs dynamic planner

- **Current.** DSH plan mode, todos, workflows/PTC; Kriya `kriya_plan` (≤ 7
  ordered steps) and `kriya_step` (fresh builder, ≤ 4 attempts).
- **Evidence.** R-23 (decomposition hurts sequential tasks), R-03 (minimal
  scaffolds win), R-29/R-13 (workflows for well-defined tasks); HU-F-09 (no
  real-model plan yet).
- **Decision.** No new graph engine. The ordered plan is the only execution
  graph; it stays behind `--loop` until a paired A/B (single loop +
  compaction vs plan → builders, K ≥ 3) decides. Reasoning graphs
  (ToT/GoT) are rejected (RESEARCH #12).
- **Rejected.** A DAG scheduler with parallel nodes: no decomposable task
  class identified; write conflicts; cost.
- **Status.** Accepted.

## KU-ADR-06 Context compaction and rehydration

- **Current.** DSH compaction (structured checkpoint, pruner, spill); before
  U1/U3 it ran on a window Kriya never declared and its overflow recovery
  could not fire (HU-F-03/04).
- **Decision.** Use DSH's compaction; make it see the truth: U1 (recognisable
  overflow) and U3 (declared limits, per-tier headroom). The threshold
  experiment (128k / 164k / 400k) is U6.
- **Rejected.** A Kriya summariser: duplicate of a working seam.
- **Rehydration (U7).** DSH condenses every message after the system prompt,
  including the person's request (HU-F-16). `plugins/anchor` (`--anchor`)
  keeps the person's messages (source `user` only; ≤ 8,000 chars, the first
  always kept) word for word in a system-prompt section at order 10300, after
  DSH's own sections so their cached prefix is unchanged. Cost: the request
  is sent twice in early steps, and the prompt changes once per user message.
  Rejected: re-injecting the request as a user message after each compaction
  (no seam tells a listener a compaction happened without reading the log).
- **Tests.** HU-M-03 (overflow → one compaction → retry → exit 0), HU-CL-01,
  HU-M-06 (requirement kept only with `--anchor`), HU-AN-01, HU-M-05 (resume).
- **Status.** Accepted, built (`--anchor` default off).

## KU-ADR-07 Memory schema, trust and lifecycle

- **Current.** Kriya memory with quarantine (track-A rule 8): notes saved from
  a device are unconfirmed until the person confirms them (H7).
- **Decision.** Keep; within a task, the failing verify output is the only
  "lesson" (already fed to the next attempt). Cross-task lessons (Reflexion)
  are deferred until a month of real tasks can measure them (RESEARCH #11).
- **Status.** Accepted.

## KU-ADR-08 Tool / agent-computer interface

- **Current.** DSH tools (bash, fs read/write/edit, fs-search, str-replace
  editor, spill at 12,500 tokens, pruner at 8,192 chars, timeouts) plus Kriya
  tools (verify, plan, step, memory, skills).
- **Evidence.** R-27 (concise viewers and summarised search help), R-28
  (bash-only > 74% Verified), R-03 (shell-only minimal near the top).
- **Decision.** No new semantic tools now. Keep the hybrid; measure the
  minimal arm (KU-ADR-17) before adding any. Tool-result truncation stays
  DSH's (spill + pruner).
- **Rejected.** Repo map (deferred, RESEARCH #9); CodeAct in the coding loop
  (PTC scored lowest of DSH modes, R-03; per-call approvals become hard).
- **Proposed.** Ablation arm with DSH's `workflow`/`run_code` tools removed
  (fewer tools, smaller prompt): adopt if pass rate holds.
- **Status.** Accepted.

## KU-ADR-09 Model capability registry and routing policy

- **Context.** HU-F-04/05: tiers declare no limits; output cap mismatch.
- **Options.** (a) columns on `kriya.models` filled by `syncCatalogue`;
  (b) the gateway reads the provider's public catalogue, cached; (c) the
  person sets limits by hand.
- **Decision.** **(b) now, (a) later.** `lib/harness/model-limits.ts` reads
  `${OPENROUTER_BASE_URL}/models` (cached an hour, 5 min on failure);
  `GET /models` adds optional `contextWindow` and `maxOutputTokens`
  (= min(catalogue, 16,384)); the client declares `contextWindow =
  min(real, 262,144)` (`WORKING_WINDOW`), `maxTokens = min(cap, W/4)` and a
  compaction headroom of min(65,536, W/4) per tier. Unknown limits → DSH's
  defaults, exactly as before.
- **Why the 262,144 cap.** The budget tier holds 1,048,576 (R-05); declaring
  it would move compaction to ~838k tokens per request: cost grows with every
  re-sent token and quality falls on long contexts (R-26/R-14). Raise it only
  when KriyaBench shows it pays.
- **Routing.** Tiers stay the plan's aliases (track H rule 4). No learned
  router (RESEARCH #15, R-57 cost attacks). A rule-based escalation (after two
  verify failures) is the only routing experiment allowed.
- **Built (U9, owner approved 2026-11-04).** (a) is in: `kriya.models`
  `context_window`, `max_output_tokens` (migration `20270701000000`), filled
  by `syncCatalogue`; the catalogue fetch shortcut is gone. HU-F-05: the
  fixed 16,384 is now `harness.maxOutputTokens`, default 65,536, kept within
  1,024–262,144 and never above the model's own cap; each request still
  reserves its upper cost at that cap.
- **Proposed to owner (done above).** (1) Approve (a) — a migration adding
  `context_window` and `max_output_tokens` to `kriya.models` (CHANGE_IMPACT
  row needed); (2) HU-F-05: raise `MAX_OUTPUT_TOKENS` for reasoning tiers or
  keep 16,384 for cost (needs a bench arm counting `finish_reason: length`).
- **Tests.** HU-GW-02, HU-CL-01, HU-M-04.
- **Status.** Accepted, built.

## KU-ADR-10 Multi-agent orchestration and isolation

- **Evidence.** R-17 (15× tokens; coding a poor fit), R-23 (−39 to −70% on
  sequential tasks), R-22.
- **Decision.** **Reject crews for coding.** Keep one level of builders
  (sequential, awaited, own budget). Revisit only for a task class shown to
  be parallel and independently verifiable.
- **Status.** Accepted.

## KU-ADR-11 Verification and the completion contract

- **Current.** `kriya_verify` (no command parameter; person-confirmed check;
  verdict from exit codes), KriyaBench tamper checks; server "delivered" from
  verified tool runs (track N).
- **Decision.** Keep and harden: (1) a budget-stopped or blocked turn never
  reads "completed" (U2); (2) each verify run records the working tree's
  fingerprint (HEAD + changed/untracked paths + content hashes, read-only
  git: `GIT_OPTIONAL_LOCKS=0`, `hash-object` without `-w`, so Read only
  writes nothing), and "verified" holds only for that fingerprint; a later
  change reads "not checked" (stale) and, at `agent/turn-stopping`, the agent
  is sent back once per turn to check again (U8); (3) a pass names the test
  and check-config files its work changed versus HEAD, as information, not a
  failure (a person may have edited them).
- **Rejected (U8).** Failing a pass that touched tests: the person's own
  uncommitted test edits would fail every run; reusing `snapshot()` from
  checkpoints: it writes objects into `.git`, which Read only forbids.
- **Rejected.** Model-as-judge as a completion gate (R-38).
- **Tests.** HU-VF-01…03, HU-M-08.
- **Status.** Accepted, built (1–3).

## KU-ADR-12 Client and agent protocols

- **Current.** CLI/headless, Web UI, ACP (stdio) and an unused DSH SDK
  JSON-RPC server; Kriya API is HTTPS + device token, versioned by the
  contract (`docs/kriya-harness/contract.json`).
- **Decision.** No new protocol. Use DSH's ACP and SDK servers; additive
  contract changes only (U1/U3 added an error code and two optional fields;
  old clients ignore them). No A2A (no interoperability need).
- **Status.** Accepted.

## KU-ADR-13 Plugin and skill supply chain

- **Current.** Exact DSH pins (`check:pins`), notices (`check:notices`),
  skills are guidance only and never add tools (H7), MCP only from the owner
  registry (track N).
- **Decision.** Keep. New Kriya plugins have no dependencies of their own
  (`plugins/budget` imports only DSH's `dsh-llm`).
- **Status.** Accepted.

## KU-ADR-14 Observability and privacy

- **Current.** Telemetry rows off (HD-17); gateway logs ids/status only
  (HT-GW-10).
- **Decision.** Deferred: OpenTelemetry GenAI spans are still *Development*
  status (R-55). When built: metadata only (ids, tokens, latency, outcome),
  never content, behind a `harness.*` switch, reconciled against
  `harness_usage` within 1%.
- **Status.** Deferred.

## KU-ADR-15 Execution provider boundaries

- **Decision.** Unchanged: local runs under DSH's sandbox and Kriya modes;
  cloud code only in track C sandboxes; KriyaBench never on Kriya's servers
  (`refuseOnServers`).
- **Status.** Accepted.

## KU-ADR-16 Kriya Evolve promotion governance

- **Current.** Designed (E1/E2/E3, HD-22), not built (HU-F-10).
- **Decision.** Nothing self-promotes until KriyaBench can detect a change:
  the capability set (U6) and the stats (U4) come first. E3 (policy, limits,
  approvals, sandbox, prices) stays immutable to any automated change;
  budget defaults and model limits are E2 (owner click).
- **Status.** Accepted (Evolve itself deferred).

## KU-ADR-17 Benchmark methodology and release thresholds

- **Decision.** BENCHMARK_PLAN.md: two suites (KriyaBench-M mechanics on real
  DSH with scripted models, free; KriyaBench-R real models, paid); paired arms,
  K ≥ 3, Wilson 95% intervals, exact sign test, pass^k, cost per passed task
  from Kriya's ledger, a DSH minimal control arm, model id pinned per run.
  A change ships default-on only if: no KriyaBench-M regression; on
  KriyaBench-R the paired sign test shows no loss (p ≥ 0.05 for A > B) and
  cost per passed task ≤ incumbent + 5%.
- **B0 arm (U6).** DSH's `sdk-minimal` profile runs with no sandbox and is an
  SDK server, not a headless runner, so the control arm is Kriya's own
  headless run with only the shell and file/search tools (`KRIYA_MINIMAL=on`):
  same sandbox, gateway, model and prompt, so the only variable is the tool
  list. The first build re-enabled the Web UI's top-level tool rows (caught by
  the Web UI test); the rows now keep the Web UI profile's own value.
- **Grading rule (owner, 2026-11-04: "Grade on originals").** Tests and
  checkers are restored and the task is graded on the originals; an edit to
  them is reported (`tampered`), not failed: agents that add test cases were
  being failed for good practice (HU-F-20). Files the task forbids changing
  are `constraints` and still fail it.
- **Status.** Accepted (stats built in U4; capability set and B0 started in U6).

## KU-ADR-18 Package versioning and upgrade compatibility

- **Built (U5).** `scripts/check-seams.js` names 10 seams (hooks, types,
  exports, the overflow pattern, compaction policies, pi-ai defaults, and
  the README line that DSH has no turn budget) and runs in `npm run check`
  and the release gate; checklist in DSH_UPGRADE.md.
- **Decision.** DSH bumps only with: `check:seams` green, dump diff reviewed (HT-REL-03),
  KriyaBench-M green (HU-M-01…04 exercise `agent/pre-step`,
  `tools/post-execute`, overflow regexes, `modelPolicies`), and the client
  check green. Contract changes additive; the client tolerates missing
  fields. Prompt-injection policy ("Rule of Two", R-53) becomes an audit of
  `lib/agent/policy.ts` when track-A work next touches it.
- **Status.** Accepted.

## KU-ADR-19 KRHE is Kriya Evolve, beside the loop

- **Decision.** The recursive harness evolution engine (KRHE,
  `RECURSIVE_HARNESS_EVOLUTION.md`) is H16 "Kriya Evolve offline", not a
  second system. The loop (client) executes; KRHE (`lib/harness/evolve/`)
  proposes and judges configurations from KriyaBench reports. The interface
  is a profile in (the client's env) and a report out. No shared state.
- **Status.** Accepted (2026-11-04, owner's KRHE brief in chat).

## KU-ADR-20 The harness profile and its versioning

- **Decision.** `HarnessProfile`: the client's existing switches and turn
  limits only (eight fields, zod strict, bounded); content-hash id. Protected
  controls have no field. Text (guidance, tool descriptions) joins only
  through a client seam behind a switch (KRHE-4).
- **Status.** Accepted.

## KU-ADR-21 Evidence storage

- **Decision.** Evidence is KriyaBench reports (synthetic tasks, no personal
  data), pinned with `--profile`, kept as files beside the bench results;
  lessons in `docs/kriya-harness/krhe/lessons.json`, citing reports by
  content hash. No database table, so no migration. Device-session evidence
  waits for HD-24 (opt-in, 30 days) and KRHE-6.
- **Status.** Accepted.

## KU-ADR-22 Probing

- **Decision.** A probe is an ordinary KriyaBench run with `--profile`, on
  the bench device, metered by the gateway: same sandbox, modes and spend
  reservation as any run. Never on Kriya's servers (KU-ADR-15). Paid probes
  only with the owner's go-ahead.
- **Status.** Accepted.

## KU-ADR-23 The adoption gate

- **Decision.** Lexicographic, by code: safety (escaped, leaked,
  constraintBroken) never worse → K ≥ 3 and ≥ 10 pairs → exact sign test →
  cost per pass ≤ +5%. Verdicts adopt / canary / hold / reject, with every
  metric shown; no scalar utility. A verdict is a recommendation; profile
  defaults are E2 (KU-ADR-16), so the owner activates.
- **Status.** Accepted.

## KU-ADR-24 Lessons

- **Decision.** Written by code from gate results only. Keyed by model,
  seed, incumbent and change. Proposed → validated on two independent
  cohorts → approved by the owner; deprecated on a later significant
  contradiction; rejected on a safety failure. Retrieved for the same model
  id only. Separate from Loop v2's project rules (`kriya rules`), which stay
  person-confirmed per project.
- **Status.** Accepted.
