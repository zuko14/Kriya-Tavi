# Harness 2.0: forensic audit of the starting point

Verified on 2026-11-23 against `Kriya-Tavi@b0ed4c2` and `kriya-harness@217ccda`
(client 0.2.5, DSH pinned `0.2.1-rc.5`), by reading source, not docs. Every
row names the file that proves it. This audit decides what Harness 2.0 builds
and, as important, what it must **not** rebuild.

## 1. What already exists and is reused, not duplicated

| Capability the intent asks for | Already built | Proof (file) | Harness 2.0 reuse |
| --- | --- | --- | --- |
| Plan → build → verify loop, code decides pass | Kriya loop v1 + v2 | `kriya-harness/src/loop.js` (`runStep`, `MAX_STEPS = 7`), `src/verify.js` (`MAX_ATTEMPTS = 4`, exit codes) | The execution engine. Harness 2.0 adds fields to plan steps, never a second loop |
| DAG of steps, blocked/skipped propagation | Loop v2 `after` edges, `planStatus` | `src/loop.js` `dependencies()` rejects d ≥ n | Role cartridges ride on steps of this DAG |
| Fresh isolated context per step | Builders are DSH `spawn` subagents, depth 1 | `plugins/loop/index.js` `spawn()` → `subagents.startActivation({provider:"spawn"})` | Head/worker split uses the same call with `agentOptions.model` |
| Per-child model override | DSH `AgentOptions { provider, model, reasoningEffort, maxTokens }`, accepted by `spawn` only | `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:21`, `dsh-subagent-spawn-in-process/README.md` ("unless `request.agentOptions` overrides them") | The orchestration seam. No DSH fork (track H rule 5) |
| Failure classes, best-attempt restore, test-tamper re-run | Loop v2 KV2-2…4 | `src/failure.js`, `src/checkpoints.js` `restoreTree`, `src/verify.js` `onOriginals` | Escalation is keyed on these classes |
| Task contract (kind, invariants, acceptance), pre-mortem | Strict loop / defensive engine | `plugins/loop/index.js` `CONTRACT`, `PREMORTEM` | The Contract Bus extends this, it does not replace it |
| Skills catalogue for devices, BM25 routing | H7 + intent router | `lib/harness/skills.ts`, `skills-harness/index.ts`, `kriya-harness/src/intent.js` `rankSkills` | Cartridges are served as a new, switched manifest set, the track E pattern (`HARNESS_EDIT_SKILL_MANIFESTS`) |
| Localhost agent browser | `plugins/browser` | `src/browser.js`, switch `KRIYA_BROWSER` | The UI gate drives it; no second browser |
| Self-improvement with a code gate | KRHE (Kriya Evolve offline) | `lib/harness/evolve/{profile,gate,propose,compose,library}.ts` | Orchestration knobs become `HarnessProfile` fields; cartridge proposals are gated by the same `gate()` |
| Evaluation with hidden graders, restored originals, safety probes | KriyaBench | `lib/harness/bench/*` | The A/B bench for cartridges is a KriyaBench seed set per discipline |
| Tier aliases, owner-chosen models, SQL spend reservation | Gateway | `lib/harness/gateway.ts` (`isTier`, `plan.allowedTiers`, `reserve`), `lib/tiers.ts` (`budget`, `balanced`, `escalation`) | Head and worker are tier aliases; the server already accepts every allowed alias per request |
| Cached-token accounting | Gateway usage parse | `lib/harness/metering.ts:102` (`prompt_tokens_details.cached_tokens`) | Measures KV-prefix hit rate without new code paths |
| Owner-only scheduled reads of allow-listed sources | Fact job | `lib/facts.ts` (`FACT_TARGETS`, two agreeing fetches), `worker/index.ts` `schedulerLoop` | The Scout copies this pattern: owner-listed sources, verbatim quotes, scheduler step behind a switch |
| Governed improvement with canary and rollback | A12 | `lib/improve.ts` (strict bundle schema, shadow, canary, `guardCanary`) | Same lifecycle words and rules for cartridge versions |

**Conclusion.** About 60% of the intent's machinery already exists in a
stricter form. Harness 2.0 is four additions on top of it: (1) discipline
cartridges with executable rubrics, (2) a gate catalogue, (3) head/worker
orchestration with a contract bus, (4) a scheduled R&D scout feeding the
existing evolution gate with owner approval.

## 2. Where `intent.md` cannot be taken literally (and what replaces it)

| # | Intent says | Reality | Harness 2.0 decision |
| --- | --- | --- | --- |
| F-01 | Python package `kriya_harness/` with `dag_planner.py`, `kriya_loop.py` … (§7) | The client is JavaScript on DSH plugins in the `kriya-harness` repository; server code is TypeScript in `lib/harness/`. A Python tree would be a second runtime | Every intent component is mapped to a real seam (ARCHITECTURE §3). No Python |
| F-02 | `status.md` is the live DAG ledger (§2 Pillar 5) | Root `status.md` is the human coordination board for every track. The loop's ledger is `~/.kriya/progress/<project>/<session>.json`, outside the folder so the agent can't forge it (`src/verify.js:392`) | The run ledger stays in `~/.kriya/progress`; a milestone ledger is added beside it. `status.md` is never written at run time |
| F-03 | Multi-day projects as one DAG | `MAX_STEPS = 7` per plan and `MAX_PLANS` per session are deliberate spend bounds | A **milestone** layer: a bounded sequence of ≤ 7-step plans (ORCHESTRA §4). Bounds stay, nothing is raised silently |
| F-04 | Escalate to the frontier "after FAIL twice", extra attempts | `MAX_ATTEMPTS = 4` bounds builders per step | Escalation happens **inside** the 4 attempts (attempts 3–4 on the head tier by default). Spend bound unchanged |
| F-05 | Cartridges as `SKILL.md + rubric.json + anti_patterns.yaml` | Skills are `SKILL.md + kriya.json`, validated by `buildCatalog` | `kriya.json` stays exactly as `manifestSchema` (a `z.strictObject`) requires; the cartridge block is a sibling `cartridge.json` (CARTRIDGES §2). No YAML parser added; `lib/skill-library.ts` unchanged |
| F-06 | Verifiers written per project by the harness | A model writing gate commands could write `exit 0` (reward hacking). Today the check is confirmed by the person (`kriya verify use`) | Gates are a fixed catalogue **in client code**, configured by typed data. A model never writes a gate, its arguments or its pass condition (GATES §1) |
| F-07 | "Cuts 70–85% tokens", "≥ 90% vs 65–75%", "80% cache hits" | None measured. Track-A rule 12 / RG-9 forbid comparative claims; voice rule 6 forbids invented numbers | Kept only as **targets** with a measurement protocol (EVALUATION_PLAN). No document or screen states them as facts |
| F-08 | Scout auto-drafts and benchmarks skills | KriyaBench must never run on Kriya's servers (KU-ADR-15, `refuseOnServers`) | The scout (fetch + distil) runs in `kriya-worker`; the A/B bench runs only on the owner's machine or a track C sandbox, dispatched or by command (SELF_EVOLUTION §5) |
| F-09 | Owner approves "with one command" | Skill text is E1 in `ENGINE_AND_EVOLUTION.md` §4.2 (auto-promotable) | Scout-originated changes come from untrusted web text, so they are **E2: always the owner's click** (WD-07), stricter than E1 |
| F-10 | "Google's carbon / hydrogen orchestration" | No primary source found (searched 2026-11-23). The closest real, checked pattern is the advisor/executor split (RESEARCH R-01) | Recorded as the owner's reference, unverified. The design rests on checked sources only |
| F-11 | "Live Supabase opened locally" for backend checks | `.env`/`.env.local` point at the **live** Kriya database (operator rule 6). In a person's project we can't know which URL is live | The live-stack gate starts `supabase start` only in the person's project and **refuses** any non-loopback database URL (GATES G-STACK) |
| F-12 | UI audit "DOM interactive latency < 100 ms" | Headless timing on a laptop is noisy; a hard threshold would flake (the intent's own SDET rule bans flakes) | Latency is measured 5× and gated on the median with a stated margin; otherwise reported, not gated (GATES G-UI) |
| F-13 | Security gate runs "auth-bypass fuzzing" | A fuzzer pointed at a non-local host is an attack | Every probe targets loopback only; the gate refuses anything else, the same egress rule as `kriya-browser` |
| F-14 | 13 disciplines | The owner also named database and design in chat | 15 cartridges (CARTRIDGES §3): the 13 plus **Database** and **Product Designer**. New ones are data, not code. Second round: a 16th, **graphics** (3D/WebGL), WD-17 |

## 3. Risks found in the existing code that Harness 2.0 must not worsen

| # | Finding | Where | Consequence for the design |
| --- | --- | --- | --- |
| R-01 | Strict-loop `acceptance` takes up to 3 **model-written** commands | `plugins/loop/index.js` `CONTRACT.acceptance` | Gates never read `acceptance`. A cartridge gate is chosen by role, configured by the cartridge file, never by the plan |
| R-02 | Router and JIT briefing are hints a model may ignore | `plugins/router`, `briefing()` | Cartridge rules that matter are enforced by gates and detectors, not by hoping the prompt is read |
| R-03 | The builder prompt is assembled per attempt | `src/loop.js` `builderPrompt` | Cartridge text must be placed **first and byte-stable** for prefix caching (ORCHESTRA §6); a timestamp or attempt number before it would defeat the cache |
| R-04 | Skills reach devices only when they need no Kriya tool (`s.tools.all.length === 0`) | `lib/harness/skills.ts` `usable()` | Cartridges declare no Kriya tools. Gates are client code, not tools that skills request |
| R-05 | DSH is an unaudited developer preview | `ENGINE_AND_EVOLUTION.md` §2 | Nothing here relies on undocumented DSH behaviour; `agentOptions` and `spawn` are documented in the pinned package |
| R-06 | `agentOptions` is honoured by `spawn` only; fork and out-of-process backends reject it | `dsh-subagent/lib/types/index.js:444` | The orchestra uses `spawn` only (already the loop's provider). A profile without `spawn` falls back to one tier, logged |

## 4. Baseline that every Harness 2.0 phase must keep

- `env -u OPENROUTER_API_KEY npm run check` in Kriya-Tavi: re-run in W0 and
  recorded in `status.md` (the last recorded counts there are the baseline).
- `npm test` in `kriya-harness`: re-run in W0, recorded.
- Off (every new switch at its default), the builder prompt, plan schema,
  tool list, `kriya_verify` output, `/models` body and skills catalogue are
  **byte-identical** to 0.2.5 (WT-REG-01, WT-REG-02).
