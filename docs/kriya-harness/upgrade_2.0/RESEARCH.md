# Harness 2.0: research basis and technique decisions

Honesty markers: **[S]** seen in this session (2026-11-23) through a web
search result or page; **[K]** known from prior reading, **not re-read in
this session**: verify before quoting a number from it; **[R]** in this
repository. No number below is a Kriya measurement.

## 1. Sources

| Id | Source | What it supports here | Marker |
| --- | --- | --- | --- |
| R-01 | Anthropic, "The advisor strategy" (claude.com/blog/the-advisor-strategy) and the "optimizing for cost and intelligence" docs page | A cheaper executor runs the task; a stronger advisor is consulted at hard points, calls no tools, produces no user-facing output; it pays off only when the consult rate is low enough | [S] (search snippets; vendor-reported figures not used) |
| R-02 | Arize, "How cheap models changed multi-agent economics" (arize.com/blog/how-cheap-models-changed-multi-agent-economics) | Orchestrator–executor: expensive model plans and checks, cheap models execute; a cited Writer test found delegation reliable only with the strongest orchestrators | [S] (snippet) |
| R-03 | Chen, Zaharia, Zou, "FrugalGPT" (2023) | Cascades: try cheap first, escalate on a scorer's signal | [K] |
| R-04 | Ong et al., "RouteLLM" (2024) | Learned routers between a strong and a weak model need preference data; why WD-03 starts with a threshold | [K] |
| R-05 | Panickssery et al., "LLM Evaluators Recognize and Favor Their Own Generations" (2024) | Self-preference bias: why the critic gets a fresh context and the spec, and never decides pass | [K] |
| R-06 | Shinn et al., "Reflexion" (2023); Madaan et al., "Self-Refine" (2023) | Feedback-driven retries help when feedback is grounded; why feedback here is gate output, not self-critique | [K] |
| R-07 | Wang et al., "Voyager" (2023) | A growing skill library verified by execution; precedent for cartridges evolving only after verification | [K] |
| R-08 | Apple Human Interface Guidelines, Materials (developer.apple.com/design/human-interface-guidelines/materials) and "Adopting Liquid Glass" | Glass for controls/navigation, not content; variants change with Reduce Transparency and Increase Contrast; custom elements need their own fallbacks | [S] (snippets) |
| R-09 | W3C WCAG 2.2 | Contrast 4.5:1 text, 3:1 large text and UI components; target size minimum 24 × 24 CSS px (2.5.8) | [K] |
| R-10 | web.dev Core Web Vitals | CLS "good" ≤ 0.1 | [K] |
| R-11 | W3C Design Tokens Community Group format | `design_tokens.json` structure | [K] |
| R-12 | Xu et al., Harness², arXiv:2610.14224 | Recursive harness evolution; Kriya's gate is code over outcomes instead of a model's judgement | [R] `RECURSIVE_HARNESS_EVOLUTION_RESEARCH.md` |
| R-13 | Google DeepMind, AlphaEvolve (2025); Zhang et al., Darwin Gödel Machine (2025); Hu, Lu, Clune, ADAS (2024) | Evolution of programs/agents scored by automatic evaluators; the evaluator must be out of the candidate's reach | [K] (AlphaEvolve also [R] in ENGINE_AND_EVOLUTION) |
| R-14 | Xia et al., "Agentless" (2024); Yang et al., "SWE-agent" (2024) | Simple, structured pipelines and good tool interfaces matter as much as model choice | [K] |
| R-16 | Li et al., AlphaCode (2022); sampling-and-selection results in later coding-agent work | Many samples filtered by execution, then a selector, beat a single sample of the same model; why Explore gates every take before anyone chooses | [K] |
| R-17 | dsh-client-ui-layout README (pinned 0.2.1-rc.5) | AppFrame columns, `main`, `shell.bottom`, `shell.overlay`, `openRightbar` | [R] read 2026-11-23 |
| R-15 | Owner reference "Google carbon/hydrogen orchestration" | Not found in a search on 2026-11-23 | Unverified (WD-16) |

## 2. Technique decisions (each with the experiment that would overturn it)

| Id | Decision | Overturned if |
| --- | --- | --- |
| T-01 | Head decomposes and writes contracts; worker builds (R-02) | E-2 shows A3 no better than A1 at equal cost: the head's plans don't help the worker |
| T-02 | Advisor calls bounded at 2 per builder (R-01) | Ledger shows advisor-assisted attempts pass no more often than unassisted ones on the same failure classes |
| T-03 | Escalation by threshold `E(role)`, tuned by KRHE, not a learned router (R-03, R-04) | After ≥ 300 recorded attempts per role, a per-class threshold beats the per-role one in a KRHE probe |
| T-04 | Gates over prompts (ARCHITECTURE §1) | E-1 shows cartridges alone (gates off) match cartridges + gates |
| T-05 | Critic advisory and monotone (R-05, R-06) | E-5 shows no pass change and no owner preference: drop the critic |
| T-06 | One cartridge per builder (intent Pillar 1) | A two-cartridge arm beats one on cross-cutting tasks in a KRHE probe |
| T-07 | Byte-stable prompt prefix (ORCHESTRA §6) | Gateway `cached_tokens` stay ~0 on the providers used: the ordering costs nothing but gains nothing; keep it, stop claiming it |
| T-08 | Scout changes owner-approved, linted, benched (R-07, R-13) | Never: this is a safety rule, not a performance bet |
| T-09 | Spec tests written before code by the QA role | WT and bench show spec tests miss defects implementation-aware tests catch, at equal cost |
