# Kriya Harness — World-Class Agent Harness Research, Architecture & Execution Programme

> **Document type:** Research-backed engineering mandate, architecture discovery brief, implementation programme and benchmark specification  
> **System:** Kriya Harness (`@kriya-ai/harness`, `kriya` CLI) + Kriya Cloud  
> **Date prepared:** 4 November 2026  
> **Primary audience:** Claude Code operating inside the Kriya Tavi monorepo  
> **Decision authority:** Claude Code acts as principal architect and implementation lead, subject to the safety, product and owner-approval boundaries in this document  
> **North-star:** Build a highly capable, reliable, secure, model-compatible agent harness that competes credibly with leading coding agents such as Claude Code and OpenAI Codex, and materially improves on the current Kriya/DeepSeek Harness baseline through measurable engineering—not branding or unsupported claims.

---

# PART 0 — EXECUTION MANDATE FOR CLAUDE CODE

## 0.1 Mission

You are being assigned the role of **Principal Agent Systems Architect, Staff/Principal Software Engineer, Research Engineer, Reliability Engineer, Security Engineer and Benchmark Lead** for Kriya Harness.

Your mission is to investigate the existing Kriya Harness in depth and turn it into a demonstrably world-class agent harness.

The founder's ambition is for Kriya Harness to become a serious competitor to leading agentic coding products such as Claude Code and OpenAI Codex, while offering distinctive capabilities and a strong model-independent architecture. The present implementation uses DeepSeek Harness (DSH) and its Cordis plugin composition model as an underlying foundation. That is the current starting point—not an instruction to remain limited by the upstream implementation.

**You own the architecture discovery and technical decisions.** The techniques in this document are research leads and hypotheses, not a mandatory shopping list. Research better or newer approaches. Reject any recommendation that does not fit Kriya's measured requirements. Do not add a technology, agent, loop, graph, database, cache, queue, protocol or abstraction merely because it is fashionable.

The deliverable is not another aspirational architecture document. The deliverable is an improved, working, integrated, tested and documented Kriya Harness, with objective evidence of its capabilities and known limitations.

## 0.2 What “world-class” means in this programme

Do not interpret “world's best” as permission to make unprovable claims. Translate the ambition into measurable system properties:

1. **Task completion quality:** higher verified task-success rate than the existing harness baseline under controlled, equivalent conditions.
2. **Model leverage:** a capable model can use its available intelligence more effectively through superior context, tools, state, feedback, planning, verification and recovery.
3. **Model compatibility:** Kriya works reliably across a deliberately supported set of model providers and capability profiles rather than being hard-coded for one model family.
4. **Long-horizon execution:** tasks can run through many steps, interruptions, context changes and recoverable failures without losing the objective or corrupting work.
5. **Excellent computer/engineering interface:** tools are designed for model use, not merely exposed as raw human-oriented commands.
6. **Verification-first completion:** Kriya distinguishes attempted work from verified work and never reports success based only on a model assertion.
7. **Security and user control:** permissions, tenant boundaries, sandboxing, approvals, data handling and auditability are enforced outside model-generated text.
8. **Cost efficiency:** improve verified task completion per unit of model spend, execution time and compute—not merely minimize tokens or maximize the number of tool calls.
9. **Operational reliability:** observable SLOs, bounded retries, crash recovery, safe upgrades, rollback, and reproducible evaluations.
10. **Extensibility:** stable interfaces for tools, skills, protocols, models, execution backends and product clients.

A harness can materially improve the **effective performance of a model on a task** by giving it better information, a better action space, environmental feedback, reliable state, search, test execution and recovery. It cannot create factual knowledge or general reasoning ability that the model does not possess, nor guarantee that a moderate model will outperform every frontier model on every task. The valid objective is to show that **the same model, under the same task and budget, performs better with Kriya's harness than with weaker or less capable harness configurations**.

Never claim “100% reliability.” Establish measurable targets, confidence intervals, test coverage, failure modes and explicit service-level objectives (SLOs).

## 0.3 Read these files before changing code

Locate and read the current canonical versions. The following are expected starting points based on the supplied Kriya architecture reference; verify actual paths and status:

- `AGENTS.md`
- `status.md` and any current status/phase ledger
- `docs/kriya-harness/ARCHITECTURE.md`
- `docs/kriya-harness/IMPLEMENTATION_PLAN.md`
- `docs/kriya-harness/DSH_DISTRIBUTION.md`
- `docs/kriya-harness/TEST_STRATEGY.md`
- `docs/kriya-harness/` and all relevant subdocuments
- `docs/cloud-execution/` including operations, evaluation, provider and security documentation
- existing KriyaBench implementation, seed tasks, run records and reports
- current `package.json`, lockfiles, workspace definitions, build/test/lint/typecheck scripts
- the actual client repository or package source, if included as a submodule, workspace, linked checkout or separate accessible directory
- all runtime plugins, provider adapters, gateway code, agent loop integrations, event/session persistence, tools, skills, approvals, memory, ACP, CLI, relay, handoff, benchmark and security modules
- migrations, database functions, RLS policies, deployment manifests and environment-variable documentation

Read the current upstream DeepSeek Harness architecture and the exact DSH version/commit that Kriya actually installs. Do not assume upstream `master` matches the lockfile or deployed package.

The supplied Kriya architecture reference describes a **composition-over-forking** approach: pinned upstream DeepSeek Harness/Cordis components provide foundational runtime functionality, while Kriya owns its control plane and product-specific extensions. It lists device identity, model gateway and spend ledger, approvals, session mirroring, skills, memory quarantine, handoff, device relay, ACP and Kriya Evolve/Bench. Verify each claim in source before relying on it.

## 0.4 Mandatory first activity: forensic baseline, not immediate rewrite

Before implementation:

1. Inspect the repository tree, runtime entry points, dependency graph, extension/plugin boundaries, data flow and deployment topology.
2. Reconstruct the actual agent turn loop from source code. Identify every transition from user request → context assembly → model request → tool call → tool execution → result → continuation/stop → persistence → user-visible completion.
3. Identify which capabilities are native DSH, which are Kriya extensions, which are external services and which are only documented but not actually implemented.
4. Trace every current model provider and supported model capability.
5. Trace how context is assembled, truncated/compacted, persisted, restored and shared with subagents.
6. Trace how tools are registered, described, validated, authorized, executed, timed out, retried, cancelled and audited.
7. Trace session, thread, turn, step, task, job, subagent and workspace lifecycles. Identify whether each state transition is durable or merely in-memory.
8. Map current security boundaries and the location of actual enforcement. Do not treat prompt instructions as a security boundary.
9. Run existing tests and benchmark tasks as-is. Record baseline results before changing code.
10. Identify current bugs, unsupported claims, dead paths, duplicate implementations, brittle upstream patches, untested modules and external blockers.

Create a **verified current-state architecture map**, a **capability/provenance matrix**, a **gap analysis**, a **risk register**, and an **initial benchmark report**. Cite exact source files, symbols, tests, commits and run IDs for every material claim.

Do not overwrite or silently replace existing architecture documents. Create new decision records and update canonical docs only after verifying their current ownership and purpose.

## 0.5 Research mandate

Conduct a real research phase before final architecture decisions. Research beyond the sources in Part 2. Use primary sources first:

- peer-reviewed papers and arXiv papers (read the full paper when the technique is central)
- official engineering articles and technical documentation from OpenAI, Anthropic, DeepSeek, Google, Microsoft and other relevant providers
- source repositories and release notes for agent systems and tools
- protocol specifications (MCP, ACP, A2A where relevant)
- standards and security guidance (OWASP, NIST, OpenTelemetry, OS/container security docs)
- benchmark definitions, evaluator code and task-dataset quality audits

For each proposed technique, record:

- the underlying problem it is intended to solve
- evidence and applicable research
- expected benefits and the mechanism by which they arise
- compute, latency, token, storage and engineering-cost trade-offs
- failure modes and security implications
- compatibility with Kriya's current architecture and DSH/Cordis
- an experiment that could falsify the recommendation
- adopt / adapt / defer / reject decision with rationale

**Do not cite a paper merely because its title sounds relevant.** Verify what it actually tested, the benchmark and model used, what the results do and do not establish, and whether the result generalizes to Kriya.

## 0.6 Autonomous engineering authority and safety limits

You are expected to make technical decisions without asking the owner to design the solution. However:

- Preserve all uncommitted and untracked user work. Inspect `git status` first.
- Never discard, reset, overwrite or clean user changes without explicit authorization.
- Do not expose secrets, API keys, credentials, private customer data or raw sensitive prompts in reports.
- Do not change live production configuration, database data, billing, domain/DNS, OAuth scopes, package ownership, paid provider plans or external account settings without owner approval.
- Do not publish packages, create releases, merge PRs, deploy production, migrate production databases, incur material third-party spend or send customer notifications without owner approval.
- Staging/local tests and disposable test infrastructure are allowed where credentials and safety boundaries are already provided.
- Do not disable an existing security invariant to make tests pass.
- Do not bypass or weaken test suites, change assertions to hide defects, skip failing tests without an evidenced reason, or substitute mocks for required live integration evidence.
- Do not use unrestricted host execution as a substitute for a real sandbox.
- For external blockers, complete all independent code and test work and list the exact action, account, permission, secret or decision required from the owner.

## 0.7 Work to completion, not just a plan

After the initial audit and architecture decisions, implement the work in vertical slices. Do not stop at a proposal. At the end of each phase:

- make the smallest coherent code change
- add/update tests
- run focused tests
- run relevant regression tests
- run typecheck, lint, format and build checks where applicable
- record evidence and unresolved failures
- update architecture/operations docs
- continue to the next independent phase

If a phase requires an owner-controlled external action, mark only that integration sub-gate BLOCKED and continue with all locally implementable work.

---

# PART 1 — PRODUCT AND SYSTEM THESIS

## 1.1 Kriya Harness is not “a prompt wrapped around a model”

A high-capability harness is an engineered system surrounding the model. It determines what the model can perceive, what actions it can take, how actions are executed, what feedback it receives, how long-running state is retained, how errors are repaired, when to delegate, how success is verified and what safety policy constrains the system.

A leading harness should own these responsibilities:

1. user intent and task contract
2. session/thread lifecycle
3. context acquisition and context-budget management
4. planning, graph construction and task decomposition
5. model capability negotiation and request adaptation
6. tool discovery, tool schemas and tool execution
7. terminal, filesystem, Git and computer interfaces
8. persistent execution and background jobs
9. multi-agent delegation and conflict management
10. checkpointing, resumability and recovery
11. deterministic and independent verification
12. user approvals and policy enforcement
13. durable event history and client protocol
14. memory and learning from verified outcomes
15. observability, evaluation and controlled self-improvement

## 1.2 Kriya's current foundation and the strategic choice

The current documented strategy is to compose Kriya-specific plugins and services around the pinned DeepSeek Harness/Cordis runtime rather than immediately maintaining a full fork. This is strategically sensible if the upstream runtime remains reliable and exposes the extension points Kriya needs.

Claude Code must test this hypothesis—not accept it uncritically.

Evaluate at least these options:

- **Option A — Upstream composition:** retain DSH as the execution kernel and add Kriya plugins, services and policies.
- **Option B — Selective replacement:** keep DSH for the parts where it is valuable, replace only agent-loop, session, tool, context or protocol components where objective evidence shows the upstream abstraction is a bottleneck.
- **Option C — Maintained fork:** fork the upstream runtime only if required for control, performance, stability, security or licensing reasons that cannot be obtained through safe extension points.
- **Option D — Independent Kriya core:** progressively own a stable internal agent runtime while keeping adapters/compatibility with upstream DSH and other agent ecosystems.

Do not choose an option based on ideology. Model maintenance cost, upstream release risk, compatibility burden, testability, performance, API maturity, security and long-term differentiation. Prefer reversible migration paths.

## 1.3 The actual competitive target

Compare Kriya against public, observable capabilities of:

- Anthropic Claude Code and its documented agent/tool/hook/skill/subagent workflows
- OpenAI Codex CLI, IDE, App Server and open Codex harness architecture
- DeepSeek Harness and Cordis plugin composition
- SWE-agent's Agent-Computer Interface (ACI)
- OpenHands / Software Agent SDK and its agent-server/workspace separation
- Aider's code-editing workflows and benchmark methodology
- other current, relevant systems identified during research

Do not reverse engineer private source code, copy proprietary implementation, use competitor trademarks misleadingly or make unsupported statements about private internals. Use public documentation, open-source repositories, papers, product behavior and reproducible tests.

The goal is to build original Kriya engineering and product differentiation—not to clone visual interfaces or claim ownership of techniques that are established in the field.

---

# PART 2 — RESEARCH BASELINE AND ENGINEERING IMPLICATIONS

The sources below are an initial research map. Claude Code must verify their current status, inspect additional primary materials and add findings before final ADR decisions.

## 2.1 DeepSeek Harness and Cordis: plugin-composed runtime

**Primary source:** [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

The upstream architecture describes Cordis as a plugin framework: plugins contribute services, typed events and reversible effects to a shared context. The model adapter, tool registry, session log and agent loop can all be composed through plugins. It describes profiles and ordered bundles, a core session event log, system-prompt assembly, scoped tool registry, agent registry/loop, LLM adapter seam and lifecycle/event hooks.

**Kriya implications:**

- Keep extension points explicit and replaceable.
- Prefer dependency injection and typed service contracts over cross-plugin imports of implementation internals.
- Ensure plugin activation/deactivation is reversible and tested.
- Treat durable session facts differently from transient process-local events.
- Preserve profile/configuration layering and document precedence.
- Avoid forking upstream internals where a stable extension point works.
- Pin the exact upstream version/commit and establish compatibility tests before upgrades.

**Risks to investigate:** API maturity, plugin lifecycle leaks, ordering dependencies, config precedence surprises, duplicate services, event listener failure propagation, unbounded listeners, incompatible persistence changes and transitive dependency drift.

## 2.2 OpenAI Codex harness engineering: repository legibility and feedback loops

**Primary source:** [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) (11 February 2026).

The article describes an agent-first engineering environment in which repository structure, documentation, application state, logs, metrics, architecture rules, automated review and feedback loops are made legible and enforceable for agents. It describes the engineering work shifting toward environment design, clear specifications, automated testing/review, architecture enforcement and management of repository entropy.

**Kriya implications:**

- Make the codebase navigable and understandable to both humans and agents.
- Keep an authoritative architecture map, module ownership, dependency direction, runbooks and test entry points.
- Convert architectural conventions into automated checks instead of relying solely on instructions.
- Make build/test/lint/typecheck/deployment diagnostics directly discoverable by agents.
- Design review and repair loops that continue until objective checks pass or a bounded stopping condition is reached.
- Regularly remove obsolete code, duplicate abstractions, stale docs, unused tools and configuration drift.

Source: https://openai.com/index/harness-engineering/

## 2.3 OpenAI Codex App Server: one harness, multiple clients, persistent threads

**Primary source:** [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/) (4 February 2026).

The article describes an agent runtime exposed through a bidirectional JSON-RPC App Server. It discusses thread lifecycle and persistence, authentication/configuration, sandboxed tool execution and extensions. A thread can be created, resumed, forked and archived; a request can produce many progress events; the server can request client input for approvals and pause execution until the response arrives.

**Kriya implications:**

- Treat the agent runtime as a reusable service, not a CLI-only implementation.
- Separate client transport from agent-loop logic.
- Provide stable, versioned, bidirectional session APIs with structured events.
- Model user input, turn start/end, assistant messages, tool calls/results, artifacts, approvals, errors, checkpoints and task status as explicit protocol events.
- Support create/resume/fork/archive where appropriate.
- Ensure web, CLI, IDE and future clients can share the same core semantics.
- Make reconnect/replay behavior deterministic and testable.

Source: https://openai.com/index/unlocking-the-codex-harness/

## 2.4 Anthropic: start with simple composable patterns; use agents only when justified

**Primary source:** [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (19 December 2024; page notes some tooling has since evolved).

The article distinguishes predefined workflows from agents that dynamically direct their own tool usage. It recommends starting with the simplest system that meets the task, adding complexity when justified. It covers prompt chaining, routing, parallelization, orchestrator-workers and evaluator-optimizer patterns. It highlights the importance of precise tool descriptions and tools designed to make mistakes difficult.

**Kriya implications:**

- Build a workflow engine and an agent engine; do not force every task through a fully autonomous loop.
- Use deterministic workflows for predictable tasks and agentic control where uncertainty/replanning adds value.
- Make tool schemas unambiguous, specific and difficult to misuse.
- Evaluate tool behavior empirically, not just prompt wording.
- Parallelize independent subproblems; do not parallelize conflicting edits or dependent actions.
- Use evaluator/optimizer loops only where evaluation signals are meaningful and the extra cost is justified.

Source: https://www.anthropic.com/research/building-effective-agents

## 2.5 SWE-agent: Agent-Computer Interface (ACI) design matters

**Paper:** [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793) (2024).  
**Implementation notes:** [SWE-agent ACI documentation](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md)

The work studies the interface presented to an LM agent for repository navigation, code editing and test execution. The central insight is that agents are a distinct category of computer user: interfaces should be designed for their strengths and limitations. SWE-agent documents purpose-built file viewing/search/edit tools, concise outputs and edit-time linting/validation.

**Kriya implications:**

- Treat the tool interface as a core part of model performance, not a thin wrapper around shell commands.
- Provide structured repository navigation, symbol search, targeted file views, safe edits, diffs, test discovery and diagnostics.
- Use absolute paths or explicit workspace-relative path contracts consistently; never let current-working-directory ambiguity silently change an action's meaning.
- Return concise, high-signal results with stable IDs, exact paths, line ranges and actionable errors.
- Validate patches before applying when feasible; provide syntax/test feedback promptly.
- Keep the general shell for flexibility, but offer higher-level semantic tools for common software tasks.

Sources:
- https://arxiv.org/abs/2405.15793
- https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md

## 2.6 Agentless: simple deterministic pipelines can beat elaborate agents on some tasks

**Paper:** [Agentless: Demystifying LLM-based Software Engineering Agents](https://arxiv.org/abs/2407.01489) (2024).

The paper explores a comparatively simple localization → repair → validation pipeline and reports strong results on SWE-bench Lite at the time of publication. It also discusses benchmark task-quality problems. The result is not a universal claim that agentless systems are always better; it demonstrates that complexity should earn its place through measured improvement.

**Kriya implications:**

- Build a task router that can choose a deterministic or short workflow when sufficient.
- For known bug-fix patterns, consider localization → candidate patch → validation rather than an open-ended loop.
- Do not spawn subagents or run repeated model calls if a simpler method has equal or better quality at lower cost.
- Compare each advanced technique against a simple baseline.

Source: https://arxiv.org/abs/2407.01489

## 2.7 ReAct: interleave reasoning and action with observations

**Paper:** [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) (2022).

ReAct interleaves reasoning and environment actions. Observations from tools can update the agent's plan, which is more grounded than producing a long unverified plan once and executing it blindly.

**Kriya implications:**

- Implement an explicit observe → decide → act → observe cycle.
- Persist useful state at boundaries.
- Make tool results first-class inputs to the next decision.
- Do not expose hidden model reasoning as a product requirement; persist concise, user-safe rationale, plan state, decisions, tool evidence and task progress instead.

Source: https://arxiv.org/abs/2210.03629

## 2.8 Reflexion: learn from environmental feedback, not empty self-critique

**Paper:** [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) (2023).

Reflexion studies agents that use feedback from prior attempts and maintain linguistic reflections in memory. This suggests a reusable error-learning mechanism, but self-generated reflections can be wrong or overgeneralized.

**Kriya implications:**

- Store concise lessons only when grounded in a verifiable event: a failed test, schema rejection, tool failure, patch conflict, evaluator result or user correction.
- Keep provenance, task scope, confidence and expiry/decay metadata.
- Do not turn one failed attempt into a global rule.
- Retrieve lessons selectively and measure whether they improve success rate or merely increase context cost.

Source: https://arxiv.org/abs/2303.11366

## 2.9 Tree of Thoughts and Graph of Thoughts: search over alternatives selectively

**Papers:**
- [Tree of Thoughts: Deliberate Problem Solving with Large Language Models](https://arxiv.org/abs/2305.10601)
- [Graph of Thoughts: Solving Elaborate Problems with Large Language Models](https://ojs.aaai.org/index.php/AAAI/article/view/29720)

These works explore branching, evaluating and combining intermediate reasoning states. They suggest ways to explore alternatives beyond a single linear chain. They do not prove that graph reasoning should be used on every coding task.

**Kriya implications:**

- Use graph-based planning when tasks have meaningful dependencies, uncertainty, alternatives or parallelizable subproblems.
- Use bounded candidate generation and prune low-value branches early.
- Preserve evidence and dependencies between graph nodes.
- Use deterministic DAG execution for known dependencies; reserve model-directed graph search for uncertain decisions.
- Track the extra token, latency and execution cost of branching.

Sources:
- https://arxiv.org/abs/2305.10601
- https://ojs.aaai.org/index.php/AAAI/article/view/29720

## 2.10 CodeAct: executable actions as a composable action space

**Paper:** [Executable Code Actions Elicit Better LLM Agents](https://proceedings.mlr.press/v235/wang24h.html) (ICML 2024).

CodeAct explores executable code as a flexible way for agents to compose actions, reporting improvements on evaluated agent tasks. This is a capability pattern, not permission to allow unrestricted code execution.

**Kriya implications:**

- Evaluate code composition or scripting for batch operations and tool composition.
- Execute such code only inside a controlled workspace with explicit capabilities, time/memory/process/network limits and audit events.
- Prefer typed semantic tools when they provide safer, clearer contracts.
- Support dry-run/preview for high-impact compound actions.

Source: https://proceedings.mlr.press/v235/wang24h.html

## 2.11 Model–harness synergy is measurable, but benchmark controls matter

**Sources:**
- [Codex as a platform: build on the open agent harness](https://developers.openai.com/blog/codex-as-a-platform) (19 August 2026)
- [How enabling two settings tripled our scores on ARC-AGI-3](https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/)

OpenAI's published Codex material describes how a harness manages context, tools, session state, approvals and long-running work. A separate 2026 report describes a large score increase on a specific ARC-AGI-3 evaluation after enabling retained reasoning and context compaction. This is evidence that harness/API configuration can materially affect measured performance on a benchmark; it does **not** imply the same multiplier applies to coding tasks or every model.

**Kriya implications:**

- Treat model and harness as a coupled system that must be tuned empirically.
- Preserve provider-specific capabilities where they help (e.g. native tool calling, structured outputs, reasoning controls, prompt caching, parallel calls, retained state) instead of flattening every provider into a lowest-common-denominator API.
- Run the same underlying model with different harness configurations to isolate harness value.
- Record every model, model version, provider endpoint, inference setting, tool schema, system policy, context strategy and budget used by an evaluation.

Sources:
- https://developers.openai.com/blog/codex-as-a-platform
- https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/

## 2.12 Agent memory and long-running context

**Research lead:** [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers](https://arxiv.org/abs/2603.07670) (2026).

The survey frames agent memory around write, manage and read processes, including context compression, retrieval stores, reflection, hierarchical context and learned management. It also identifies unresolved problems including contradiction handling, trustworthy reflection and privacy governance.

**Kriya implications:**

- Memory needs an explicit lifecycle and trust model.
- Separate current-turn working context from session history, episodic experience, durable user preferences and verified project knowledge.
- Give every memory source provenance and permission scope.
- Support expiry, correction, deletion, contradiction resolution and user control.
- Never treat arbitrary tool output, repository content or mirrored conversations as trusted system instructions.

Source: https://arxiv.org/abs/2603.07670

## 2.13 Security: agentic systems expand the attack surface

**Sources:**
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [OWASP Top 10 for LLM Applications](https://owasp.github.io/www-project-top-10-for-large-language-model-applications/)

Relevant security areas include prompt injection, insecure output handling, supply-chain compromise, sensitive information disclosure, insecure plugin/tool design, excessive agency, resource abuse and unbounded consumption.

**Kriya implications:**

- The model is not the policy enforcement point.
- Tool permissions must be enforced in deterministic code at execution time.
- Use least privilege, scoped credentials, capability grants, tenant-aware authorization, approval gates, sandbox isolation, egress controls, secret filtering and auditable actions.
- Treat tool outputs, repository text, webpages, terminal output, agent-to-agent messages and memory as untrusted unless explicitly verified and elevated through a controlled process.
- Establish adversarial tests for indirect prompt injection, confused deputy, tool parameter manipulation, token leakage, sandbox escape attempts and cross-tenant access.

Sources:
- https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- https://owasp.github.io/www-project-top-10-for-large-language-model-applications/

## 2.14 Observability: trace the complete agent trajectory

**Primary source:** [OpenTelemetry GenAI agent span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)

The OpenTelemetry GenAI semantic conventions define spans for agent invocation, workflows, tool execution, skills and related operations. Tool arguments/results may contain sensitive data, so recording must be deliberate and privacy-aware.

**Kriya implications:**

- Trace user task → agent turn → model request → tool calls → subagents → workspace actions → verification → completion.
- Correlate traces with tenant, session, turn, task and tool-call identifiers without exposing secrets.
- Measure latency, tokens, costs, retries, errors, cancellation, queue time, context size, tool result size and verification outcome.
- Separate operational metadata from potentially sensitive content; redact or omit raw payloads by default.
- Make a failed task diagnosable from its event history and trace without requiring reproduction by guesswork.

Source: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md

## 2.15 Benchmark validity: use multiple independent measures

**Sources:**
- [SWE-bench Verified](https://www.swebench.com/verified.html)
- [Terminal-Bench 2.0 paper](https://arxiv.org/abs/2601.11868)
- [Aider Polyglot benchmark](https://aider.chat/docs/leaderboards/)
- [Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

SWE-bench Verified contains 500 human-reviewed instances and is useful for comparability, but no single benchmark captures all coding-agent capability. Terminal-Bench 2.0 focuses on realistic command-line tasks. Aider Polyglot tests code-editing tasks across multiple languages. OpenAI's July 2026 audit of SWE-Bench Pro highlights that benchmark datasets can contain flawed, underspecified, misleading or overly strict tasks.

**Kriya implications:**

- Use multiple public benchmarks plus Kriya's own private/held-out evaluation set.
- Inspect benchmark tasks and evaluator code; do not blindly trust leaderboards.
- Report per-task evidence, invalid/ambiguous task handling, confidence intervals and evaluator versions.
- Never tune on the hidden test set or leak answers into prompts/memory.
- Report cost and time alongside success.

Sources:
- https://www.swebench.com/verified.html
- https://arxiv.org/abs/2601.11868
- https://aider.chat/docs/leaderboards/
- https://openai.com/index/separating-signal-from-noise-coding-evaluations/

## 2.16 Competitive product / architecture references

Use these as research targets, not as permission to copy proprietary code:

- [Codex platform / open harness](https://developers.openai.com/blog/codex-as-a-platform)
- [Codex App Server architecture article](https://openai.com/index/unlocking-the-codex-harness/)
- [Claude Code skills, hooks, rules and subagents guidance](https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more)
- [Claude tool-use contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [OpenHands repository](https://github.com/OpenHands/OpenHands)
- [SWE-agent ACI documentation](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md)
- [Aider documentation and benchmark](https://aider.chat/docs/)

For every competitor feature, determine whether it is genuinely relevant to Kriya's target users and whether Kriya can deliver it safely and maintainably.

---

# PART 3 — CORE ARCHITECTURE DISCOVERY AND DESIGN QUESTIONS

Do not assume the following target components must all be separate services. Design boundaries first; deploy as a modular monolith or a small number of services where that is simpler and more reliable. Split services only when independent scaling, isolation, ownership or failure boundaries justify it.

## 3.1 Harness runtime kernel

Investigate the actual DSH/Cordis kernel and identify which parts should remain upstream, be wrapped, be replaced or be owned by Kriya.

Required concerns:

- plugin/service lifecycle and dependency injection
- typed events and waterfall/serial event semantics
- agent/session/turn/step lifecycle
- model adapter contract
- tool registry and scoped tool sets
- prompt/context assembly
- streaming and cancellation
- durable events and persistence
- profile/bundle composition
- plugin version compatibility
- crash and listener lifecycle behavior

Design explicit contracts for every Kriya-owned extension. Avoid relying on undocumented internals without a compatibility test and version pin.

## 3.2 Agent turn state machine

Define a formal state model. Candidate states to evaluate:

- `created`
- `understanding`
- `planning`
- `awaiting_approval`
- `ready`
- `requesting_model`
- `executing_tool`
- `waiting_external`
- `verifying`
- `repairing`
- `checkpointing`
- `paused`
- `completed`
- `failed`
- `cancelled`
- `expired`

The final state model may differ. Define legal transitions, timeout behavior, cancellation semantics, replay rules, idempotency and durable event representation. Prevent invalid transitions and duplicated side effects.

## 3.3 ReAct-style execution loop with deterministic control

Evaluate a bounded loop with the following conceptual stages:

1. **Understand:** derive the user's goal, constraints, environment and completion conditions.
2. **Inspect:** gather only relevant repository, project, tool and session context.
3. **Plan:** form a small actionable plan and explicit dependency graph when appropriate.
4. **Select:** choose a tool, workflow, model route or delegation action.
5. **Authorize:** evaluate deterministic permission policy and request approval where necessary.
6. **Act:** execute through a typed tool or sandboxed command.
7. **Observe:** collect structured outputs, artifacts, logs and external state changes.
8. **Validate:** compare results with explicit acceptance criteria and independent evidence.
9. **Repair/replan:** classify errors and take a bounded corrective action.
10. **Persist:** checkpoint meaningful state and update the event log.
11. **Stop or continue:** terminate only on verified completion, user request, policy limit or explicit failure state.

The model should not be able to loop indefinitely. Define limits for steps, model calls, tokens, wall time, tool execution time, retries, subagent count, workspace resources and budget. Detect repeated actions, unchanged outputs, circular plans and stagnation.

The actual implementation should be compatible with DSH's native loop if it meets requirements. Do not create a second independent loop without a documented reason.

## 3.4 Graph engineering and workflow execution

Investigate and choose the correct graph abstraction(s):

- static DAG for known task dependencies
- dynamic graph for model-directed decomposition/replanning
- finite-state machine for control and safety transitions
- dependency graph for tool/action prerequisites
- execution trace/event graph for provenance and replay
- hierarchical task graph for long-running work and subagents

Do not conflate a reasoning graph with an execution graph. A graph of candidate ideas is not automatically safe to execute. Execution nodes must have typed input/output contracts, dependency checks, idempotency, timeout, permissions and observable terminal states.

Potential node types:

- inspect/search
- plan/decompose
- model inference
- tool call
- shell command
- edit/patch
- delegate
- approval wait
- external wait
- verification
- checkpoint
- merge/reconcile
- complete/fail

Choose algorithms for topological scheduling, bounded parallelism, cancellation propagation, retry policy and dependency invalidation. For file edits, identify and prevent write conflicts. Use separate worktrees or workspace branches for concurrent changes where beneficial.

## 3.5 Loop engineering and error recovery

Design multiple purpose-specific loops instead of one giant retry loop:

- **agent decision loop:** think/act/observe
- **tool repair loop:** repair invalid arguments or recover from transient tool errors
- **code repair loop:** inspect test failure → form hypothesis → minimal patch → rerun targeted tests → regression tests
- **verification loop:** evaluate each acceptance criterion and request missing evidence
- **context loop:** retrieve/compact/refresh context when state changes or budget requires it
- **orchestration loop:** monitor graph progress, unblock dependencies, delegate or cancel work
- **recovery loop:** restore checkpoint and resume safely after process failure
- **learning loop:** extract a grounded lesson and evaluate it offline before promotion

Every loop needs:

- explicit objective and stopping condition
- maximum iteration/time/cost budget
- error taxonomy (transient, permanent, user-correctable, policy-denied, ambiguous, integrity failure)
- retryability classification
- exponential backoff with jitter for retryable external failures
- idempotency and side-effect reconciliation
- progress/stagnation detector
- cancellation and timeout propagation
- durable events and metrics
- no silent success on partial failure

Do not retry authentication, validation, permission or policy failures as if they were transient network failures.

## 3.6 Model compatibility and adaptive model routing

Design Kriya to support different model providers without assuming their semantics are identical.

Build a provider capability registry that captures, where available:

- native tool/function calling
- strict schema / structured output support
- streaming and partial tool-call behavior
- parallel tool-call support
- context window and input/output limits
- reasoning/effort controls
- prompt caching and cache rules
- retained reasoning/state capabilities
- multimodal input support
- cancellation and timeout behavior
- usage accounting/token details
- rate limits and provider errors
- model version and capability changes

Build adapters that normalize common behavior while preserving provider-specific options when they measurably improve output. Do not erase important native capabilities merely for superficial API uniformity.

Model routing should use task characteristics and measured outcomes—not simply a static `cheap`, `balanced`, `powerful` label. Consider:

- task type and difficulty estimate
- required context size
- tool-call reliability
- structured output capability
- need for deep planning or code synthesis
- latency and availability
- budget remaining
- provider rate limits
- past success by task class

Start with transparent, deterministic routing rules. Consider online bandits or learned routing only after high-quality evaluation data, guardrails and rollback are available. Avoid a self-reinforcing router that routes difficult tasks away from strong models without measuring the consequence.

Investigate model-specific prompt adapters only when experiments demonstrate value. Keep core task state independent of provider-specific chat message formats.

### Model–harness synergy experiment

For every supported model, evaluate at least:

- base model / single-turn baseline where task allows
- minimal tool loop
- DSH baseline with default configuration
- current Kriya harness
- proposed Kriya harness
- proposed Kriya harness with selected features ablated

Hold task, model ID/version, temperature/reasoning settings, token budget, tool access, execution environment and wall-time budget constant where possible. Record unavoidable differences.

## 3.7 Context engineering and compaction

Treat context as a managed, budgeted resource—not an ever-growing transcript.

Investigate:

- token-aware context budgets by task phase
- progressive disclosure of tools/skills
- targeted repository retrieval (symbol graph, search, file index, dependency graph)
- relevance + freshness + trust + provenance ranking
- structured state summaries
- compaction at safe boundaries
- preserving the original goal, constraints, decisions, pending tasks, key artifacts and test results
- context rehydration after process restart or model switch
- untrusted-context labeling
- model/provider prompt-cache optimization
- truncation detection and recovery

A compaction operation must not silently delete critical requirements, tool results, open approval requests, security constraints or failure evidence. Test round-trip fidelity: compact a session, resume it, and verify task continuity against the uncompressed control.

Avoid storing private model chain-of-thought as a required memory artifact. Persist concise structured reasoning summaries, decisions, evidence and task state that are appropriate to retain.

## 3.8 Tool architecture and Agent-Computer Interface

Design tools specifically for agent use. A good tool is not just a wrapper around an endpoint.

Every tool should define:

- unique stable name and semantic purpose
- precise input/output schema
- required capability/permission
- risk classification
- timeout and cancellation behavior
- idempotency semantics
- error codes and recovery hints
- bounded output size and pagination
- provenance and audit requirements
- examples and common failure modes
- compatibility/version policy

Investigate a layered tool catalogue:

1. **Core semantic tools:** repository status, file search, symbol lookup, file view, patch, diff, test discovery, diagnostics, Git operations, task state, approvals.
2. **Execution tools:** shell, PTY, process lifecycle, background jobs, workspace operations.
3. **Integration tools:** GitHub, browser/web, database, MCP servers, API connectors.
4. **Composition tools:** safe scripts or code actions that combine approved tools.
5. **Meta tools:** discover tools, inspect schemas, retrieve help and examples.

Potential ACI improvements:

- absolute path contracts or explicit workspace root semantics
- structured search results with path/line/symbol
- focused file views and stable line references
- concise command output and explicit “no output, exit code 0” behavior
- output truncation with a retrieval cursor rather than arbitrary loss
- syntactic validation before accepting edits when available
- patch preview and atomic apply
- tool result IDs so subsequent calls can reference artifacts without repeating huge content
- automatic inclusion of relevant diagnostics after failed builds/tests
- specialized high-signal tools for common workflows

Do not remove shell flexibility. The aim is a hybrid: ergonomic semantic tools for common tasks and a powerful, governed shell for advanced operations.

## 3.9 Multi-agent orchestration and agent teams

Do not equate “more agents” with higher performance. Multi-agent systems can add latency, duplicate work, context overhead, merge conflicts, inconsistent decisions and cost.

Use multi-agent delegation only when:

- subtasks are sufficiently independent
- work can be partitioned cleanly
- required resources are available
- the output can be verified and merged
- expected quality/time gain exceeds coordination cost

Potential roles to investigate:

- planner/architect
- repository explorer
- implementer
- test author / test runner
- security reviewer
- independent code reviewer
- documentation/release agent
- integrator / final verifier

Use bounded fan-out, per-agent budgets, task contracts, explicit output schemas, cancellation, and a coordinator. Prevent agents from editing the same files concurrently unless merge/conflict handling is explicit. Use Git worktrees, branches or separate workspace directories where appropriate.

Do not use majority voting as the sole verifier. Independent agents can share the same blind spots. Prefer objective tests, static analysis, execution evidence and independent review. Model-as-judge may supplement but must not replace deterministic checks where deterministic checks exist.

## 3.10 Verification and completion contract

Kriya must not equate a plausible answer with completed work.

Every task should have an explicit **completion contract** derived from the user request:

- requested outcome
- acceptance criteria
- files/resources allowed to change
- constraints and non-goals
- required tests or evidence
- approval requirements
- budget/deadline

Verification levels should be selected by task risk and type:

- schema/format validation
- syntax/typecheck/lint
- unit tests
- targeted regression tests
- integration tests
- end-to-end tests
- security/static analysis
- runtime/observability evidence
- human review or approval where required

For code modifications, capture:

- base commit and resulting commit/patch hash
- changed file list and diff summary
- commands executed and exit codes
- tests executed and exact result counts
- tests not run and why
- known risks and unresolved requirements
- dependency/security scan result where relevant

A model's self-assessment is not proof. A verifier should check requirements against independent evidence. Completion should use a structured result such as `verified`, `partially_verified`, `needs_user_input`, `blocked`, `failed`—with clear explanations.

## 3.11 Session, thread, event and application-server architecture

Investigate whether Kriya's current APIs provide the same durable semantics across web, CLI and IDE clients. If not, design a stable protocol layer.

Requirements to evaluate:

- create/resume/fork/archive thread/session
- submit user messages and control actions
- turn/step lifecycle
- streaming assistant updates
- tool-call start/progress/result
- file diffs and artifacts
- approval request/response
- pause/resume/cancel
- task/workspace status
- errors and recovery events
- protocol/version negotiation
- reconnect and replay
- authorization and tenant isolation

A bidirectional JSON-RPC protocol is one candidate because it can represent client requests and server events/approval requests. Do not adopt it automatically if an existing protocol is already sound. Evaluate SSE/WebSocket/HTTP streaming and protocol semantics against current needs.

Maintain a clear separation among:

- agent runtime
- application/control plane
- execution environment
- client presentation layer

## 3.12 Memory and project knowledge

Treat memory as a controlled subsystem with typed scopes:

- ephemeral step state
- turn working set
- session history
- task memory/checkpoints
- project/repository knowledge
- user preferences
- verified reusable lessons

Each record needs source, timestamp, owner/tenant, scope, trust level, provenance, sensitivity, optional expiry and deletion/update policy.

Potential memory operations:

- write candidate memory
- validate and classify
- deduplicate and resolve conflicts
- confirm or reject
- retrieve relevant memories
- expire/forget
- audit access

Never allow a memory derived from untrusted repository text, webpage content or raw tool output to become a high-priority instruction. The existing Kriya memory quarantine approach should be preserved or strengthened if verified in source.

## 3.13 Skills, plugins and extension ecosystem

Design a coherent capability ecosystem:

- skills as procedural instructions/resources with explicit metadata and trust/provenance
- plugins as executable services with scoped permissions and lifecycle
- MCP integration for external tools/resources where appropriate
- ACP/editor integration for coding clients where appropriate
- A2A or another agent-to-agent protocol only if Kriya has a real interoperability use case
- capability discovery and compatibility checks
- per-agent/per-tenant allowlists
- version pinning and supply-chain review

Do not expose every installed tool to every agent by default. Use least privilege and progressive disclosure.

## 3.14 Human-in-the-loop and autonomy levels

Create a policy-driven autonomy model. Candidate levels:

- observe/read-only
- workspace write
- execute commands in restricted sandbox
- connect external services
- perform reversible external actions
- perform high-impact/irreversible actions

The actual policy names and transitions should be derived from existing Kriya risk classes and approvals. Enforce permissions at the tool/execution layer—not only in the prompt.

Approvals must bind to the exact action, arguments, target resource, tenant, actor, expiry and policy version. Any material change to the action after approval invalidates the approval. Deny by default on timeout or missing authorization for protected operations.

## 3.15 Observability and cost intelligence

Implement a correlated trace across the full task trajectory. Adopt OpenTelemetry GenAI conventions where useful and verify their status/stability before relying on them.

Minimum metrics:

- task success and partial-success rate
- model request count, input/output/cache tokens and cost
- tool calls per successful task
- tool success/error/retry rate
- planner/delegation overhead
- context tokens before/after compaction
- retrieval precision or usefulness proxies
- queue and workspace latency
- total wall time
- CPU/RAM/disk/network usage for execution jobs
- cancellation and timeout rate
- checkpoint/resume success
- verification pass/fail rate
- user approval/denial and correction rate
- cost per verified successful task

Do not log raw secrets, sensitive prompts, private repository contents or tool outputs by default. Use redaction, sampling, retention controls and secure access.

## 3.16 Kriya Evolve: controlled improvement, not uncontrolled self-modification

Preserve or improve the existing E1/E2/E3 governance concept if it is present in source:

- low-risk prompt/tool-description/ranking guidance changes may be evaluated automatically
- behavior/workflow changes require controlled review or explicit owner approval
- security invariants, tenant isolation, approvals, spend limits and release controls must be immutable to autonomous promotion

Any proposed self-improvement must:

1. derive from verified failures or measured opportunities
2. produce a reviewable candidate change
3. run on held-out offline evaluations
4. compare quality, latency, cost, safety and regression rates
5. use shadow/canary deployment where appropriate
6. have automatic rollback criteria
7. record the exact version and evidence

No self-modification of production safety policy, permissions or security boundaries without owner authorization.

---

# PART 4 — PROPOSED REFERENCE ARCHITECTURE (TO VALIDATE, NOT COPY BLINDLY)

A candidate conceptual topology is:

```text
                 KRIYA CLIENTS
        CLI / Web / IDE(ACP) / API / Future Desktop
                         |
                Stable Client Protocol
          requests / events / approvals / artifacts
                         |
                 KRIYA APPLICATION LAYER
         Auth / tenant scope / config / API gateway
                         |
                 KRIYA HARNESS CORE
     Session manager / turn state / agent controller
     Context manager / tool registry / model gateway
     policy engine / approval manager / verifier
                         |
              TASK & WORKFLOW ORCHESTRATOR
        FSM + task graph + bounded loop controller
                         |
          +--------------+------------------+
          |              |                  |
       Tools         Subagents          Background jobs
          |              |                  |
          +--------------+------------------+
                         |
              EXECUTION ENVIRONMENT ADAPTER
       local / self-hosted / managed sandbox / device
                         |
            ISOLATED EXECUTION WORKSPACE
       filesystem / process / terminal / network policy
                         |
           RESULTS / EVENTS / ARTIFACTS / PROOFS
                         |
      Durable session log + checkpoint + audit + metrics
```

A reference design is not a mandate to create all of these as separate deployable services. Prefer modular boundaries and clear contracts. Deploying a single reliable service is often better than a distributed system with needless failure modes.

## 4.1 Architectural invariants

At minimum, define and enforce:

1. **Identity invariant:** identity and tenant scope come from verified server-side session/device credentials, never client-asserted IDs.
2. **Authorization invariant:** each tool/execution action is authorized at its point of execution.
3. **Isolation invariant:** untrusted tasks cannot access other tenants' files, credentials, database secrets or execution state.
4. **Durability invariant:** acknowledged durable events/checkpoints survive expected process restarts.
5. **Idempotency invariant:** retries cannot silently duplicate protected side effects.
6. **Budget invariant:** tasks cannot bypass token, compute, time, tool-call or financial limits.
7. **Approval invariant:** high-risk actions require approval bound to the exact action and context.
8. **Trust invariant:** external content and tool results are data, not system instructions.
9. **Verification invariant:** task completion requires evidence appropriate to its risk and requested outcome.
10. **Compatibility invariant:** changes to public APIs, persisted event formats and package distributions are versioned and migrated safely.
11. **Observability invariant:** material model/tool/execution actions have traceable IDs and outcomes without leaking sensitive payloads.
12. **Stop invariant:** every autonomous loop has bounded resource and termination conditions.

Claude Code must refine these invariants based on actual implementation, threat modeling and product requirements.

---

# PART 5 — BENCHMARK AND EVIDENCE PROGRAMME

## 5.1 Establish a baseline before optimizing

Run the same KriyaBench seed set against the current system and preserve immutable baseline records.

Record:

- Kriya commit and client package commit
- upstream DSH package version/commit
- model provider and exact model ID/version
- inference parameters/reasoning mode
- tool and skill versions/configuration
- system prompts/profile/config hash
- dataset version and individual task IDs
- execution image/environment version
- time/token/compute/financial budget
- result, test evidence, cost and latency

Do not compare today's result to an old result if the model version, benchmark tasks, system prompt or budget changed without clearly reporting those differences.

## 5.2 Required benchmark matrix

Build an evaluation matrix with at least these arms:

| Arm | Configuration | Purpose |
|---|---|---|
| B0 | Base model / minimal direct prompt where applicable | Approximate bare-model baseline |
| B1 | Minimal ReAct tool loop | Measure value of elementary tool use |
| B2 | Pinned upstream DSH baseline | Measure upstream harness value |
| B3 | Current Kriya Harness | Measure current Kriya additions |
| B4 | Proposed improved Kriya Harness | Measure candidate architecture |
| B5+ | Feature ablations | Identify which innovations actually help |

Run across several model classes where accessible:

- strong frontier model
- moderate/efficient model
- budget model
- models from more than one provider

Use the same model version and comparable budgets within each head-to-head comparison. Where providers expose different capabilities, report both (a) a normalized common-capability comparison and (b) a native-capability best-use comparison. Do not pretend these answer the same question.

## 5.3 Evaluation suites

Use a combination of:

- existing KriyaBench easy/hard suites
- held-out Kriya internal tasks
- SWE-bench Verified where license and execution requirements permit
- SWE-bench Pro only after evaluating task quality and known data-quality issues
- Terminal-Bench 2.0
- Aider Polyglot
- focused custom tasks for Kriya's actual user workflows

Do not rely on one public leaderboard. Add task groups for:

- repository understanding and navigation
- bug localization and repair
- feature implementation
- refactoring and API migration
- test writing and debugging
- command-line and environment operations
- multi-file changes
- long-running tasks and continuation
- Git workflows and pull-request preparation
- dependency/configuration troubleshooting
- use of browser/API/MCP integrations where supported
- safe handling of prompt injection and untrusted files
- recovery after model, worker, network or process failures

## 5.4 Internal KriyaBench design

Create or evolve a benchmark with:

- clearly written task statements
- reproducible repository snapshots
- deterministic setup scripts
- objective tests and acceptance criteria
- independent review for ambiguous/invalid cases
- hidden/held-out tasks
- task difficulty strata
- multiple languages and repo sizes
- adversarial and failure-injection cases
- non-coding tasks if Kriya claims broader agent capabilities
- benchmark versioning and contamination controls

A 200-task seed suite is a useful initial target if it can be curated properly; count alone is not quality. Grow the suite over time and keep a sealed holdout set.

## 5.5 Metrics

Primary metric:

**Verified Success per Unit Cost**

Define a composite only after reporting each primitive separately. Do not hide trade-offs inside one score.

Required reporting:

- verified task success rate
- first-attempt success rate
- partial completion rate
- regression rate
- human intervention/approval frequency
- cost per verified success
- median and p95 end-to-end latency
- model tokens and model spend per task
- tool calls per task
- repeated/failed tool calls
- execution compute per task
- context compaction count and recovery correctness
- crash/resume success
- security test pass rate
- rate of false success claims
- benchmark task invalidation rate

Use confidence intervals and repeated runs for stochastic tasks. Report task-level outcomes, not only averages.

## 5.6 Ablation programme

For every nontrivial system feature, test whether it helps:

- advanced planner vs simple planner
- DAG/graph planning vs linear plan
- subagents vs single agent
- independent reviewer vs no reviewer
- reflection memory vs no reflection memory
- context compaction vs no compaction
- semantic tools vs shell-only
- retrieval vs no retrieval
- model router vs fixed model
- native provider options vs normalized mode
- best-of-N / candidate ranking vs one candidate
- verification loop depth 1/2/3 or bounded adaptive depth

Measure quality, cost, latency, safety and complexity. Retain an advanced technique only when its gains justify its overhead.

## 5.7 Benchmark honesty

- Do not compare Kriya's tuned configuration to a deliberately weak competitor baseline.
- Do not compare different models and attribute the whole difference to harness quality.
- Do not tune on held-out tasks.
- Do not use a model judge as the only ground truth when executable tests or deterministic checks exist.
- Publish exact settings, model versions, budgets and known limitations.
- Investigate unusual score jumps and dataset leakage.
- Treat a benchmark win as evidence for that tested distribution, not proof of universal superiority.

---

# PART 6 — TECHNIQUE CANDIDATE MATRIX

The following are candidates for research and experiments. Claude Code must add, replace or reject them based on the current research landscape and Kriya evidence.

| Area | Candidate techniques | Potential benefit | Main risk / cost | Decision evidence required |
|---|---|---|---|---|
| Control flow | ReAct, bounded state machines, workflow graphs | Grounded multi-step action | Looping and complexity | Task success, loops, latency |
| Planning | Hierarchical planning, DAG scheduling, dynamic replanning | Dependency management and parallelism | Planning overhead | Ablation vs linear plan |
| Search | ToT/GoT, beam search, best-of-N | Alternative exploration | Token cost, false confidence | Quality gain per dollar |
| Workflow selection | deterministic pipeline, router, agentic workflow | Use simplest adequate path | Misclassification | Route accuracy and task success |
| Tool interface | ACI, semantic tools, validated patches | Better tool use and fewer errors | Tool maintenance | Tool error rate and task success |
| Action composition | CodeAct / sandboxed scripts | Flexible action composition | Arbitrary code risk | Task benefit and security probes |
| Error correction | bounded repair loop, error taxonomy, targeted retry | Recovery from tool/model errors | Retry storms | Recovery rate and duplicate side effects |
| Feedback learning | Reflexion-style grounded lessons | Avoid repeated failure | Poisoned memory | Held-out performance and memory precision |
| Context | retrieval, compaction, hierarchical memory | Long-horizon continuity | Lost requirements / privacy | Resume fidelity and task success |
| Multi-agent | orchestrator-workers, independent reviewer | Parallel work and diverse review | Coordination and conflict | Net gain after overhead |
| Verification | test-based, static analysis, independent verifier | More trustworthy completion | Extra compute | False positive rate / defect escape |
| Model routing | capability registry, task routing, adaptive selection | Cost/quality trade-offs | Routing bias and complexity | Success/cost by task class |
| Observability | OpenTelemetry GenAI traces | Diagnosis and optimization | Data exposure and storage | Coverage with privacy tests |
| Protocol | versioned JSON-RPC, MCP, ACP, A2A | Interoperability | Protocol sprawl | Real client/provider need |
| Continuous improvement | offline eval, shadow, canary, rollback | Controlled compounding gains | Uncontrolled drift | Regression and rollback evidence |

---

# PART 7 — IMPLEMENTATION ROADMAP

Claude Code may reorder phases based on dependencies discovered in the repository. Preserve the gate logic and prove each slice before advancing.

## Phase 0 — Baseline and forensic architecture

**Tasks**

- inspect all relevant repositories and docs
- map actual source-to-runtime architecture
- trace DSH/Cordis integration and exact versions
- identify current agent loop and session persistence
- inventory tools/skills/models/protocols/approvals/memory
- run baseline CI and KriyaBench
- research competitor public architecture and papers
- create architecture gap analysis and ADR backlog

**Exit evidence**

- source-linked architecture map
- verified provenance matrix
- baseline benchmark artifacts
- full list of open issues and risks
- agreed architecture decision record(s)

## Phase 1 — Stable harness core and lifecycle

**Tasks**

- formalize turn/step/task/thread state transitions
- strengthen durable events and replay semantics where needed
- define clean module/service boundaries
- stabilize client protocol and event model
- improve cancellation, timeouts and resumability
- add compatibility tests for DSH extension seams

**Exit evidence**

- state-machine transition tests
- process restart/replay tests
- protocol contract tests
- plugin load/unload/lifecycle tests
- no regression in current user workflows

## Phase 2 — Model adapter and capability layer

**Tasks**

- inventory all model providers currently supported
- implement capability metadata and model-profile negotiation
- improve structured tool-call parsing/validation
- handle partial streaming tool calls correctly
- support cancellation, timeouts and provider errors
- add provider-specific configuration without leaking it into core task state
- improve usage/cost accounting and reconciliation

**Exit evidence**

- multi-provider contract suite
- malformed/partial tool-call tests
- timeout/retry/idempotency tests
- correct cost accounting under stream interruption
- model compatibility matrix

## Phase 3 — Agent-computer interface and tool quality

**Tasks**

- audit current tools for ambiguity, overlap, large outputs and weak schemas
- design or improve repository, file, search, diff and test tools
- add structured errors, output limits and pagination
- validate edits and patches safely
- ensure shell and semantic tools share workspace/permission context
- add tool discovery and progressive disclosure
- measure tool-level success and failure patterns

**Exit evidence**

- tool schema tests
- malformed input tests
- path traversal and workspace boundary tests
- output truncation/retrieval tests
- ACI benchmark improvements against baseline

## Phase 4 — Planning, graph and workflow orchestration

**Tasks**

- implement or improve deterministic workflow path
- evaluate hierarchical task planner
- model dependencies explicitly
- support bounded dynamic replanning
- implement cancellation and failure propagation through graph
- control parallelism and file conflict handling
- introduce subagents only where benchmarked benefit exists

**Exit evidence**

- graph correctness tests
- dependency and cycle detection
- parallel task conflict tests
- deterministic workflow vs agentic planner ablation
- successful cancel/replan/failure recovery

## Phase 5 — Context, compaction and memory

**Tasks**

- instrument context size and token cost
- implement or improve retrieval and progressive loading
- add safe compaction at explicit boundaries
- preserve required task constraints and evidence
- create typed memory lifecycle and trust labels
- handle contradiction, expiry, deletion and provenance
- test interruption and context rehydration

**Exit evidence**

- context fidelity tests
- compaction vs non-compaction benchmark
- memory retrieval precision tests
- prompt injection/memory poisoning tests
- privacy/retention tests

## Phase 6 — Verification and repair engine

**Tasks**

- define task completion contract
- classify errors and retryability
- add bounded tool repair and code repair loops
- run targeted tests before broad tests where efficient
- add independent verification for critical changes
- bind evidence to workspace/revision/diff hashes
- prevent false success on missing/failed tests

**Exit evidence**

- test failure repair benchmarks
- stale-evidence tests
- false-success probes
- retry storm and duplicate side-effect tests
- verified completion report tests

## Phase 7 — Multi-agent orchestration

**Tasks**

- measure current subagent behavior and overhead
- introduce bounded fan-out and role/task contracts
- isolate concurrent edits
- build integrator/reconciler and independent review flow
- add agent budgets and resource quotas
- detect redundant agents and stop low-value branches

**Exit evidence**

- single-agent vs multi-agent comparison
- no unhandled write conflicts
- correct cancellation/cleanup
- bounded cost and subagent counts
- improved verified success or time-to-success for selected task classes

## Phase 8 — Client and protocol excellence

**Tasks**

- inspect CLI, web UI, ACP, relay and other clients
- ensure consistent thread/task semantics
- improve live progress and artifact reporting
- support reconnect/replay
- keep JSON-RPC/ACP/MCP/A2A boundaries versioned and explicit
- add protocol conformance tests

**Exit evidence**

- client contract tests
- disconnect/reconnect tests
- approval round-trip tests
- long-running session UI consistency
- no protocol stdout pollution for stdio-based ACP

## Phase 9 — Kriya Evolve and benchmark automation

**Tasks**

- automate benchmark runs and result storage
- group failures by root cause
- propose changes from verified evidence
- evaluate changes offline on held-out tasks
- add shadow/canary and rollback where applicable
- preserve immutable security invariants

**Exit evidence**

- reproducible benchmark run
- candidate promotion/rejection audit trail
- automatic regression blocking
- rollback drill
- no hidden-test leakage

## Phase 10 — Release hardening and controlled pilot

**Tasks**

- close high/critical security findings
- verify dependency provenance/licenses/SBOM
- conduct load and soak testing
- test graceful degradation under provider failure
- test DB migrations and rollback
- validate budget limits and tenant isolation
- complete package distribution and upgrade guides
- conduct controlled pilot with named users and incident tracking

**Exit evidence**

- release candidate report
- complete test/benchmark summary
- security review and threat model
- rollback and incident runbooks
- monitoring and alert validation
- pilot exit decision

---

# PART 8 — RELEASE GATES AND QUALITY BAR

Do not move the release stage from Beta to GA merely because the code compiles or the feature list looks complete.

Establish quantitative thresholds from the baseline and product SLO requirements. The following are gate categories; exact numerical values must be proposed by Claude Code with rationale and owner review.

| Gate | Required evidence |
|---|---|
| Functional correctness | all critical flows pass; no known release-blocking defects |
| Harness benchmark | controlled improvement over current Kriya baseline on target task classes |
| Model compatibility | all officially supported model/provider profiles pass contract tests |
| Long-horizon reliability | tasks resume after process/network/provider interruption without corrupting state |
| Tool reliability | bounded failures, structured recovery and no duplicate protected side effects |
| Verification quality | measurable false-success rate and evidence completeness within agreed limits |
| Security | no unresolved critical/high findings; tenant and permission probes pass |
| Resource safety | bounded CPU/RAM/disk/process/network/token/time usage |
| Protocol compatibility | versioned client protocol and upgrade tests pass |
| Observability | correlated traces/metrics; no secret leakage in logs |
| Cost efficiency | cost per verified success measured and within product budget |
| Distribution | clean installation, upgrade, rollback and license/provenance verification |
| Pilot | controlled pilot reaches agreed stability and user outcome thresholds |

Define SLOs for availability, task completion, latency, recovery, data durability and support response. Distinguish service availability from task success; a model can be wrong even when infrastructure is healthy.

---

# PART 9 — REQUIRED ARCHITECTURAL DECISION RECORDS

Create ADRs for at least the following decisions, or explain why an item is already settled by a verified existing design:

1. DSH composition vs selective replacement vs fork strategy
2. ownership boundary for agent loop and session manager
3. durable session event model and persistence semantics
4. task/turn state machine
5. workflow graph vs dynamic planner responsibilities
6. context compaction and rehydration strategy
7. memory schema, trust and lifecycle
8. tool/ACI interface design
9. model capability registry and routing policy
10. multi-agent orchestration and isolation
11. verification and completion contract
12. protocol choices for clients and external agents
13. plugin/skill supply-chain and trust model
14. observability/privacy data model
15. self-hosted/managed execution provider boundaries
16. Kriya Evolve promotion governance
17. benchmark methodology and release thresholds
18. package versioning and upgrade compatibility

Every ADR must include:

- problem/context
- verified current behavior
- options considered
- research/evidence
- chosen option
- rejected alternatives and why
- security/performance/cost trade-offs
- migration plan and reversibility
- tests required
- status and decision date

---

# PART 10 — EXPECTED DELIVERABLES

Claude Code must deliver, update or explicitly mark blocked:

## Research and architecture

- `docs/kriya-harness/research/` source matrix and research notes
- verified current architecture map
- capability/provenance matrix (DSH vs Kriya vs external vs missing)
- architecture gap analysis
- threat model and risk register
- ADRs for major decisions
- updated architecture diagrams

## Implementation

- stable and tested runtime/plugin integration
- improved model adapters/capability profiles
- improved ACI/tool interfaces
- deterministic workflow and graph orchestration where justified
- context and memory improvements
- verification/repair engine
- bounded multi-agent coordination where justified
- protocol/session/client improvements
- observability and cost reporting
- safe Evolve/benchmark automation

## Quality and operations

- unit/integration/contract/e2e/security/failure tests
- reproducible benchmark scripts and result artifacts
- load/soak and fault-injection test reports
- dependency provenance and SBOM/license reports
- release and upgrade guides
- operational runbooks
- rollback and incident procedures
- status ledger updated with evidence

## Final report

The final report must clearly state:

- what existed before
- what was added, replaced or removed
- why each architectural choice was made
- exact commits/branches/PRs if any
- tests executed and counts
- tests skipped and reasons
- benchmarks before/after with model and budget controls
- cost/latency changes
- security findings and remediation
- known limitations and technical debt
- external owner actions required
- whether Beta → GA gates are met, and which are not

Never label a phase COMPLETE without supporting evidence.

---

# PART 11 — EXACT INSTRUCTIONS TO BEGIN EXECUTION

Claude Code: follow this sequence.

### Step 1 — Protect the repository

- Run `git status --short` and inspect all local changes.
- Identify the active branch and current commit.
- Do not reset, clean or overwrite local work.
- Identify all repositories/workspaces involved, including the Harness client repo if separate.

### Step 2 — Read and map

- Read `AGENTS.md` and this entire document.
- Read the current Kriya Harness architecture, implementation plan, test strategy and distribution docs.
- Read cloud execution architecture and relevant security/operations docs.
- Inspect the actual source and tests, not only documentation.
- Verify the DSH version, package provenance, license and extension APIs.

### Step 3 — Run the baseline

- Run current tests/checks and save exact output.
- Run current KriyaBench baseline where safe.
- Record model IDs, configs, budget, environment and dataset versions.
- Do not modify code before preserving baseline artifacts.

### Step 4 — Research and challenge assumptions

- Use independent research tasks/subagents for focused topics where useful: agent loops, tool/ACI design, graph planning, memory/context, verification, model routing, security and benchmarks.
- Ask subagents for evidence, not generic recommendations.
- Consolidate results and detect conflicting claims.
- Search for better approaches published after the sources listed above.
- Verify citations, repository maturity, licenses and compatibility.

### Step 5 — Make architecture decisions

- Compare alternatives.
- Write ADRs.
- Design migration compatibility.
- Identify critical path and independent workstreams.
- Define measurable acceptance tests before implementation.

### Step 6 — Implement incrementally

- Start with the highest-leverage, lowest-risk vertical slice.
- Reuse existing Kriya modules and DSH extension points where appropriate.
- Avoid duplicate state machines, queues, session stores, agent loops or tool registries.
- Add tests with each change.
- Run checks after each phase.
- Keep interfaces backwards-compatible or provide a migration path.

### Step 7 — Benchmark, harden and report

- Run baseline and candidate under controlled conditions.
- Perform ablation studies.
- Run adversarial security, failure-injection and recovery tests.
- Fix regressions.
- Update docs and status with evidence.
- Report any work that requires owner approval separately.

**Do not stop after the audit, research notes or ADRs. Continue into implementation until all safe and locally executable work has been completed.**

---

# PART 12 — SPECIAL NOTES AND NON-ASSUMPTIONS

## 12.1 “DeepSeek Flash 1047” reference

The request mentioned a social-media example phrased as “DeepSeek Flash 1047” and a claim that DeepSeek Harness with that model outperformed using a model in OpenCode or another less specialized harness.

The exact model/product identifier and the original evidence were not verified in this research pass. Do not assume the string identifies a real model release or benchmark configuration. Ask the owner for the source link if this specific claim is important. Independently verify:

- exact model ID and provider endpoint
- harness version and configuration
- OpenCode/other baseline version
- task set and evaluation method
- whether the model was identical in both tests
- tool access and environment parity
- token, time and spend budgets
- whether results were independently reproduced

Do not repeat the social-media claim as fact until verified.

## 12.2 Do not confuse harness uplift with model capability

A strong harness can improve effective task performance by letting the model inspect, act, observe, test, recover, delegate and retain context. It cannot guarantee that a moderate model becomes universally more intelligent than a stronger model. Use controlled same-model comparisons to measure harness uplift and cross-model comparisons to assess compatibility and product positioning.

## 12.3 Do not equate more complexity with innovation

The following are not automatically improvements:

- more subagents
- more reasoning calls
- more complex graphs
- longer prompts
- more memory
- repeated self-critique
- multiple model judges
- more microservices
- more databases/queues
- speculative RL/self-improvement

Each must earn adoption through repeatable evidence of better verified outcomes, lower cost, better latency or safer operation.

## 12.4 Do not let cost optimization break safety

A low-cost environment is not an acceptable trade if it permits cross-tenant access, secret exfiltration, unbounded execution, confused-deputy attacks or unrecoverable data loss. Use an explicit risk-based policy for local, self-hosted and managed sandbox environments.

## 12.5 Do not break Kriya's existing product identity and controls

Preserve and verify existing capabilities such as device identity, spend reservation/settlement, remote approvals, session mirroring/redaction, skill aggregation, memory quarantine, cloud handoff, device-world relay, ACP and KriyaBench where present. Improve them through measured changes; do not remove them merely to simplify the rewrite.

---

# PART 13 — STARTING RESEARCH REFERENCES

These are initial primary references. Confirm URLs and current revisions before citing them in ADRs.

1. DeepSeek, **DeepSeek Harness Architecture** — https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
2. DeepSeek, **DeepSeek Harness public product overview** — https://www.deepseek.com/harness/en/
3. OpenAI, **Harness engineering: leveraging Codex in an agent-first world** (11 Feb 2026) — https://openai.com/index/harness-engineering/
4. OpenAI, **Unlocking the Codex harness: how we built the App Server** (4 Feb 2026) — https://openai.com/index/unlocking-the-codex-harness/
5. OpenAI, **Codex as a platform: build on the open agent harness** (19 Aug 2026) — https://developers.openai.com/blog/codex-as-a-platform
6. OpenAI, **How enabling two settings tripled our scores on ARC-AGI-3** — https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/
7. Anthropic, **Building effective agents** — https://www.anthropic.com/research/building-effective-agents
8. Anthropic, **Claude Code skills, hooks, rules, subagents and more** — https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more
9. Anthropic, **How tool use works** — https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
10. Yang et al., **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** — https://arxiv.org/abs/2405.15793
11. SWE-agent, **ACI documentation** — https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md
12. Xia et al., **Agentless: Demystifying LLM-based Software Engineering Agents** — https://arxiv.org/abs/2407.01489
13. Yao et al., **ReAct: Synergizing Reasoning and Acting in Language Models** — https://arxiv.org/abs/2210.03629
14. Shinn et al., **Reflexion: Language Agents with Verbal Reinforcement Learning** — https://arxiv.org/abs/2303.11366
15. Yao et al., **Tree of Thoughts: Deliberate Problem Solving with Large Language Models** — https://arxiv.org/abs/2305.10601
16. Besta et al., **Graph of Thoughts: Solving Elaborate Problems with Large Language Models** — https://ojs.aaai.org/index.php/AAAI/article/view/29720
17. Wang et al., **Executable Code Actions Elicit Better LLM Agents (CodeAct)** — https://proceedings.mlr.press/v235/wang24h.html
18. Du, **Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers** (2026) — https://arxiv.org/abs/2603.07670
19. OWASP, **Top 10 for Agentic Applications 2026** — https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
20. OpenTelemetry, **GenAI agent span semantic conventions** — https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
21. SWE-bench, **SWE-bench Verified** — https://www.swebench.com/verified.html
22. Merrill et al., **Terminal-Bench 2.0** — https://arxiv.org/abs/2601.11868
23. Aider, **Polyglot benchmark and leaderboard documentation** — https://aider.chat/docs/leaderboards/
24. OpenAI, **Separating signal from noise in coding evaluations** (8 Jul 2026) — https://openai.com/index/separating-signal-from-noise-coding-evaluations/
25. OpenHands, **OpenHands repository and architecture** — https://github.com/OpenHands/OpenHands

---

# FINAL DIRECTIVE

Build Kriya Harness as a first-class, model-compatible agent system—not merely a branded wrapper around DeepSeek Harness.

Use the existing DSH/Cordis foundation intelligently where it provides leverage. Own the differentiating architecture where Kriya needs greater control, reliability, safety, performance or product capability. Research beyond this document. Challenge every assumption. Make the strongest technical decisions you can justify. Implement them carefully. Measure the result against rigorous baselines. Preserve security and user trust.

The intended outcome is a harness that makes supported models significantly more effective at completing real tasks through superior engineering: better context, better tools, better orchestration, better feedback, better memory, better verification, better recovery and better user control.

**Your success is measured by verified user outcomes, not by the number of architectural buzzwords, modules, agents or lines of code introduced.**
