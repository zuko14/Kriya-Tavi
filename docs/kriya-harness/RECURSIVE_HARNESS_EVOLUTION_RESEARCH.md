# KRHE research dossier

For `RECURSIVE_HARNESS_EVOLUTION.md`. Read on 2026-11-04. "Read" means the
page was fetched in this session; anything not read is marked. Broader
agent research (ReAct, Reflexion, SWE-agent, Agentless, CodeAct, vendor
guidance) is already collected in `harness_upgradation/RESEARCH.md` (61
sources, U0); it is not repeated here.

## 1. Harness² (the brief's primary reference)

- **Paper:** Xu, Chen, CuiZhu, Dalvi Mishra, Ming, Yu, Han, Lee, Pfister,
  "Harness²: Recursive Agent Harnessing for an Open World",
  [arXiv:2610.14224](https://arxiv.org/abs/2610.14224), submitted
  2026-10-09. Read: abstract page and the HTML full text up to Appendix
  D.2 (the rest, including Appendix F "Limitations", was not read).
- **Repository:** [google-research/harness2](https://github.com/google-research/harness2).
  Read: README only. **Source not inspected**: the brief asks for the
  executor adapters and experiment code; that is still open.

### What it does (paper §2)

| Part | As described |
| --- | --- |
| Reference execution | The current harness runs the task once; this shows behaviour, not correctness |
| Propose | Two candidates by editing component files: an *invariant* one (planning, tool use, context, delegation) and a *domain-specific* one (domain knowledge, procedures) |
| Probe | Each candidate runs on the same task, same model and environment; its trajectory is contrasted with the reference (fixed, unchanged, regressed) |
| Compose | An editor model reads the contrasts and diffs and merges, revises, adopts one candidate, or keeps the current harness |
| Recursion | Parallel: k candidates per scope and k compositions, then a selector picks one deliverable. Sequential: k chained steps |
| Harnessing level | After each task, lessons supported by contrasts go into a library: executable harness plus `EXPERIENCE.md` (situation, lessons, evidence); retrieved on demand, reused through Propose, not inherited |
| Editable components | System prompt, guardrails, memory, tool guidance, subagents, skills, scripts, plugins (README) |

### Evidence quality

- **Setup:** executors Gemini 3.5 Flash and GLM-5 under OpenCode and Codex.
  Editor Claude Opus 4.8. Benchmarks WorkBuddy-Bench (100 tasks), JobBench
  (34), LAB (100). Three runs, mean ± sd.
- **Results (k = 1):** up to +11.5 (WorkBuddy), +4.5 (JobBench), +11.8 points
  (LAB partial). k = 5 parallel adds 2.6 to 6.7 more.
- **Ablations (Gemini, OpenCode, WorkBuddy / JobBench):** full 77.5 / 36.0,
  no library 74.4 / 34.2, no scoped editors 74.6 / 32.3, no composition
  75.9 / 34.1.
- **Not found in what was read:** dollar costs (tokens and steps are reported),
  significance tests, and any defence against reward hacking.
- **Self-judged.** Compose uses no ground truth: the editor model judges the
  contrasts. Benchmark judges are used only for evaluation.
- **Unsafe defaults (README):** executor network access is unrestricted;
  the Codex executor runs with its sandbox disabled; public rubrics may
  leak. Kriya keeps none of these (§3).
- **License:** Apache-2.0; `third_party/`, benchmarks and datasets keep
  their own licences; "not an officially supported Google product". No
  code was copied into Kriya.

### What Kriya takes, and what it doesn't

| Idea | In KRHE | Why |
| --- | --- | --- |
| Two recursion levels | Yes (§1 of the spec) | Matches Kriya Evolve's design |
| Invariant vs domain candidates | Partly: invariant moves only (one-factor profile changes); domain candidates need KRHE-4's text surface | The profile has no domain text yet |
| Contrast with a reference run | Yes, as paired runs (b, c) | Kriya has ground truth, so contrast is counted, not read |
| Editor-model Compose | **No**: code composes from gate verdicts | Self-judgment is open to reward hacking; Kriya has verifiers |
| Lessons with evidence | Yes, written by code from gate results, report hashes as provenance | Model-written lessons could be poisoned |
| Editable plugins and scripts | **No** (E3: code is human-reviewed) | KU-ADR-16 |
| Unrestricted network, no sandbox | **No** | Kriya modes, sandbox and egress unchanged |

## 2. Prior art already in Kriya's design

`ENGINE_AND_EVOLUTION.md` §4.1 cites the Darwin Gödel Machine (Sakana AI),
"A Self-Improving Coding Agent" (Robeyns et al., 2025), AlphaEvolve (Google
DeepMind) and GEPA-style reflective prompt evolution. These were not re-read
here. §8 of that document listed "Harness²" as unchecked; it is now checked
(this file).

## 3. Kriya-specific findings (from the code, not papers)

- KriyaBench reports did not record the harness configuration: B0 and B3
  differ only by `KRIYA_MINIMAL` in the shell, so a report alone couldn't
  say which arm produced it. Fixed by `--profile` (HU-EV-07).
- The client's switches and limits already form a bounded, tested
  configuration space (eight fields); the arms B0–B5 were hand-picked
  points in it. KRHE makes the search over it explicit.
- With 21 pairs, the exact sign test needs a 6–0 split to reach p < 0.05.
  The recorded B4-vs-B3 result (4–0) is p = 0.125.

## 4. Open

- Inspect Harness²'s source (executor adapters, compose prompts, experiment
  scripts) before KRHE-4 borrows anything from its text-edit proposers.
- Read Appendix F (limitations) of the paper.
- Licences of any benchmark considered for a held-out set.
