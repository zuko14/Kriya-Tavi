# Kriya Harness: research and gap analysis

Builds on `RESEARCH.md` (61 sources, R-01…R-61) and
`RECURSIVE_HARNESS_EVOLUTION_RESEARCH.md`, which already cover OpenAI's harness
engineering, Anthropic's agent, context and long-running harness posts,
SWE-agent, Reflexion, Agentless, OpenHands, Harness² and evaluation method.
Those are not repeated. This pass searched only for what the audit's gaps need
(2026-11-05).

**Evidence grades.** `read` = the page was read. `search` = seen through a search
result summary only, not read in full, so treat its numbers as leads. `recorded`
= measured in this repository.

## 1. New sources

| Id | Source | Finding used | Grade |
| --- | --- | --- | --- |
| R-62 | OpenHands SDK [stuck detector guide](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) and [issue #762](https://github.com/OpenHands/software-agent-sdk/issues/762) | Rule-based detection: same action and observation ≥ 4 times, 3 identical erroring actions, ping-pong ≥ 6 cycles. Hard-coded thresholds gave false positives on legitimate polling, so they became configurable | search |
| R-63 | "False success" paper, [arXiv:2606.09863](https://arxiv.org/html/2606.09863) | Claim-vs-state mismatch is 75.8% of failures among AppWorld architectures with explicit completion signals; per-model rates 13–89%; LLM judges detect it poorly. One v1 preprint, not SWE-style tasks | search |
| R-64 | AgentLens, [arXiv:2605.12925](https://arxiv.org/html/2605.12925) | A passing patch can hide a poor process ("lucky pass"); binary pass signals dominate SWE evaluation | search |
| R-65 | HarnessFix, [arXiv:2606.06324](https://arxiv.org/html/2606.06324) | Attributes failures to trajectory steps and harness layers, applies scoped repairs, with regression-aware acceptance | search |
| R-66 | HarnessEvolve, [arXiv:2609.00829](https://huggingface.co/papers/2609.00829) | Two gates: quality (leakage, prompt bloat) and performance (no degradation on recent batches) | search |
| R-67 | Agentic Harness Engineering, [arXiv:2604.25850](https://arxiv.org/html/2604.25850v2) | Evolves all harness components; Terminal-Bench 2 pass@1 69.7% → 77.0%; reports "regression blindness": most negative impacts were not foreseen | search |
| R-68 | SkillCAT (arXiv:2606.13317, [summary](https://letsdatascience.com/news/skillcat-introduces-topology-aware-skill-self-evolution-for-1596dfbe)) | Skills from contrastive success/failure pairs on the same task, filtered by replay | search |
| R-69 | Bayesian-Agent, [arXiv:2606.08348](https://arxiv.org/html/2606.08348) | Posterior per skill from verified evidence; patch, split, compress, retire | search |

Anthropic's "Effective harnesses for long-running agents" (R-15) did not appear
directly in this pass, but it was read in U0: premature "done" is its first
named failure, and completion belongs in an artifact rather than the transcript.
That matches HU-F-30/31 exactly. Darwin Gödel Machine and the original ACE paper
were not found in this search and are not relied on.

## 2. Gap analysis

Each row answers the brief's ten questions in compressed form.

| Capability | Problem it solves | Elsewhere | Kriya today | Precise gap | Smallest safe change | Owner component | Test | Expected benefit | Runtime cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Completion from state, not claims | False success (R-63, R-15) | Feature list with pass flags | Verdict from exit codes | Ignores unrun plan steps (HU-F-30) | Verdict counts the plan; new `partial` | `verdict()` | LG-VD-01 | No false verified on open plans | None |
| Premature-stop control | Agents stop early (R-15) | Stop hooks, Ralph-style drivers | `recheckHook` for stale only | Unfinished plans not sent back (HU-F-31) | Same hook seam, from records, once per step reached | `plugins/loop` | LG-FN-*, LG-RUN-01 | Plans finish | ≤ 1 notice per step; more builders when it works, which is the point |
| No-progress stop | Stuck loops (R-62) | OpenHands rules | Budget: identical calls | Nothing between attempts (HU-F-32/33) | Same failure twice and no file changed, or check cannot run | `runStep` | LG-ST-*, LG-RUN-02/03 | Up to 2 builders saved per dead step | One checkpoint per builder |
| Infrastructure vs code failures | Retrying the wrong thing (`KRIYA_LOOP_V2.md` W1) | Error taxonomies | `dsh-llm-retry`, then ignored | Outage burns attempts (HU-F-34) | Error before any change is no attempt, ≤ 2 per step | `runStep` | LG-IN-*, LG-RUN-04 | Outage can't block healthy steps | None |
| Durable failure memory | Long-horizon recovery (R-15) | Progress files | Plan and runs persisted | Failure text not persisted (HU-F-35) | Keep excerpt on the run, seed the next builder | `verifyStep`, `runStep` | LG-RS-*, LG-RUN-05 | One builder saved per crash, better first retry | ≤ 2.5 KB per failed run, local |
| Trajectory evidence | Lucky passes, regression blindness (R-64, R-67) | AgentLens, HarnessFix | Pass, cost, time | KRHE blind inside runs (HU-F-36) | `kriya verify status --json` → bench → gate and proposer | `verify.js`, `lib/harness/bench`, `evolve` | LG-TR-*, HU-BEN-05, HU-EV-08 | Gate sees false claims and recovery | One short command per task |
| Honesty as a gate rule | LLM judges miss false success (R-63) | Code checks | Hard constraints: safety | False "verified" not gated | `falseVerified` blocks `adopt` | `gate()` | HU-EV-08 | Can't promote a harness that lies more | None |
| Feedback loop per task type | One loop shape for all work (brief 4.3) | Anthropic patterns R-13 | Router names tools | No way-of-working hint | One sentence per intent; research and data intents; "don't plan a small change" | `src/intent.js` | IR-* | Unmeasured; a hint | ≤ 200 prompt chars, router only |
| Native capabilities | Fundamental procedures shouldn't need installs | Agent Skills R-19 | 10 default skills | No visual, research or data-change procedure | 3 skills, same format, with activation, verification and failure sections | `skills-harness/` | HT-DS-* | Coverage of domains B, D, F | Listed only when relevant; off by default |

## 3. Considered and rejected

| Idea | Why not |
| --- | --- |
| Separate execution engine or per-domain runtime | Forbidden by the brief and by track C rule 3; the router's sentence gives the same policy for one line of code |
| Parallel DAG, beam search | `KRIYA_LOOP_V2.md` §6 stands: racing builders in one tree, k× spend, R-23 |
| Ping-pong detection now | R-62 shows false-positive risk; no recorded Kriya run needs it |
| LLM critic or evaluator-optimizer in the loop | Exit codes are stronger where they exist (R-32, R-63); a model judge adds cost and a reward-hacking route |
| Skill extraction from trajectories now | SkillCAT needs contrastive pairs on the same task; Kriya has 21-run samples and no saved transcripts in reports. Mining them would produce fiction. The evidence channel is now in place (HU-F-36); extraction follows real runs |
| Hiding tools from the model | B5 lost 0–5 to B4 (p = 0.063), recorded |
| Merging `lib/improve.ts` and KRHE gates | Different statistics, different owners, no conflict |
| New context or memory store | HU-M-05/06/11 show continuation and compaction hold; the only gap found was HU-F-35 |

## 4. What remains unknown

Whether any of this raises the pass rate on a real model. Every number this
programme can produce for free is mechanics on a scripted model. Only a paid
KriyaBench-R run can answer that, and that needs the owner's go-ahead.
