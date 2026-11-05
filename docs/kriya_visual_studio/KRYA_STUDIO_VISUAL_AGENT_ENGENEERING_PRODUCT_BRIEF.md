# Kriya Studio — Visual Agent Engineering & Orchestration

## Product Intent, Research Brief, Architecture Exploration and Claude Code Execution Mission

**Document type:** Product intent + research brief + architecture exploration + implementation mandate  
**Status:** Proposal for repository investigation and design; not a pre-approved technical specification  
**Primary audience:** Claude Code acting as principal product architect, UX architect, agent-systems architect, staff engineer, security reviewer and implementation lead  
**Product surfaces:** Kriya Tavi and Kriya Harness  
**Core principle:** The ideas in this document communicate the owner's intent and possible directions. They are hypotheses and suggestions, not instructions to copy a particular architecture. Claude Code must inspect the actual products, research current alternatives, challenge assumptions, make evidence-backed decisions, and design the best solution for the existing codebase.

---

# 0. EXECUTIVE INTENT — READ THIS FIRST

I want Kriya to provide users with a powerful way to **create, visually design, execute, inspect, debug, reuse and continuously improve their own AI workflows, agent graphs, harnesses and loops**.

This should not become just another drag-and-drop automation canvas. The ambition is to make Kriya a visual agent-engineering environment that can serve different levels of users:

- A non-technical user who describes a business outcome and receives a usable workflow.
- A developer who designs multi-agent workflows, tool chains, branches, state, retries and verification.
- An advanced AI engineer who designs custom agent harnesses, nested loops, dynamic task graphs, evaluators, model-routing strategies and execution policies.
- A Kriya Harness user who wants to understand and visually design how an agent works internally, rather than only seeing a chat interface or a command-line interaction.

The experience should make sophisticated agent engineering accessible without hiding the underlying control from advanced users.

## 0.1 The product vision in one sentence

**Kriya Studio should let a user describe an outcome, generate or manually design its execution architecture, run it with trustworthy controls, inspect every meaningful step, and improve the design using measurable evidence.**

## 0.2 Where it must exist

This is not only a Kriya Tavi feature. The capability must be considered across both products:

1. **Kriya Tavi:** a clear, discoverable sidebar destination where customers can create and manage workflows/agents appropriate to their role and plan.
2. **Kriya Harness:** a first-class visual engineering experience for designing and inspecting agent execution graphs, loops, tool orchestration, verification and harness behaviour. It should integrate with the existing harness rather than become a disconnected demo or second runtime.

Claude Code must inspect the actual product structure and decide whether these are two entry points into one shared studio, two coordinated surfaces, or another architecture that best fits the repository. Do not assume the same UI should be duplicated in both products.

## 0.3 Visual and UX intent — non-negotiable quality bar

The existing Kriya Tavi and Kriya Harness interfaces already have an established visual language. **Preserve and extend it. Do not redesign the whole product.**

The new graph experience must feel native to the existing product:

- Reuse the existing color system, typography, spacing scale, border treatments, surfaces, shadows, radii, icons, interaction patterns and responsive behaviour after auditing them.
- Maintain the current visual identity. Do not introduce a generic neon AI dashboard, random gradients, excessive glassmorphism, childish illustrations, bulky cards, or a cluttered low-quality node editor.
- Graphs must look extraordinary through precision, hierarchy, alignment, restrained motion, clear node/edge semantics and excellent interaction—not decorative effects.
- Nodes must align cleanly, have consistent sizing and spacing, and remain readable at different zoom levels.
- Edges must connect to the correct ports, route cleanly, avoid unnecessary crossings, communicate direction and type, and remain visually legible in dense graphs.
- The canvas must feel calm, spacious, professional, premium and technically sophisticated.
- The sidebar, top bar, inspector, minimap, toolbar, contextual menus and node panels must follow the existing UX conventions.
- Responsive layouts must be intentionally designed. Do not merely shrink a desktop canvas onto a phone. Determine which authoring capabilities are appropriate on mobile and provide a useful mobile inspection/run experience.
- Accessibility, keyboard navigation, focus states, reduced-motion preferences, contrast and screen-reader semantics must be considered.

**The design must be judged against the existing product, not against a generic UI kit.** Inspect the actual components and screenshots before making design decisions.

## 0.4 Production intent

I want this to be a real, end-to-end production capability—not a static prototype, mocked canvas, decorative graph, or frontend-only interaction.

A user must be able to create or generate a graph, configure it, validate it, save it, reopen it, version it, execute it through the real Kriya runtime, inspect execution, recover from failures where supported, and safely publish or share it according to permissions.

Do not claim end-to-end completion if any of those paths are still mocked, disconnected, or unimplemented. If a capability must be phased, clearly mark it as unavailable or beta rather than presenting a fake working control.

## 0.5 Architecture ownership

The architecture suggestions later in this document are **starting hypotheses only**. Claude Code owns the final design.

You must:

- Inspect the current Kriya Tavi and Kriya Harness repositories and identify what already exists.
- Read the product invariants, architecture docs, status files, release notes, loop specifications and relevant implementation plans.
- Research current competing products, frameworks, protocols, papers and design patterns.
- Identify overlaps, gaps, risks, implementation costs and opportunities.
- Challenge or replace any proposal in this document if the evidence supports a better solution.
- Prefer reuse and coherent integration over unnecessary rewrites.
- Make architecture decisions explicit in ADRs and explain rejected alternatives.
- Do not assume the proposed labels, layers, node types or screen structure are final.

---

# 1. THE PROBLEM WE WANT TO SOLVE

Today, many AI products expose one or more of the following:

- A chat interface for interacting with an agent.
- A workflow canvas for connecting tasks and integrations.
- A code-first framework for defining agents and state transitions.
- An agent builder for configuring instructions, tools and knowledge.
- A runtime debugger that visualizes what an agent did.

These capabilities are useful, but they are often separated. A user may create a workflow in one product, debug it in another, and configure the underlying agent harness somewhere else. Some tools expose workflow structure but not the full internal execution policy; others expose code-level control but are difficult for non-specialists to use.

Kriya's opportunity is to investigate whether it can bring together, in one coherent product experience:

1. Outcome-driven creation.
2. Visual graph authoring.
3. Agent and tool configuration.
4. Explicit loop and iteration design.
5. Harness-level configuration and controls.
6. Real execution and state inspection.
7. Debugging, replay, checkpointing and versioning.
8. Evaluation and quality measurement.
9. Evidence-backed optimization and evolution.
10. Reusable templates and sharing.

This combination is a **product hypothesis**, not a proven market gap. Research must test it honestly.

# 2. RESEARCH BASELINE AND COMPETITIVE LANDSCAPE

## 2.1 Important research conclusion

Do not claim that no platform offers visual AI graph building, agent orchestration, loops, debugging or workflow deployment. That claim would be inaccurate.

There are established products with substantial overlap:

| Product / project | Publicly documented strengths | Questions Kriya should investigate |
|---|---|---|
| n8n | Visual workflow canvas, AI agents, integrations, human approval, execution inspection, replay and version management | How can Kriya go deeper into agent-harness configuration, recursive loop engineering and evidence-based graph optimization? |
| Dify | Visual LLM application/workflow building, agent nodes, retrieval, branching, tools and human input patterns | How should Kriya distinguish agent workflow authoring from internal harness engineering? |
| LangGraph / LangGraph Studio | Stateful graph-based agent runtime, graph visualization, state inspection and debugging | Which explicit state-machine and durable-execution ideas should Kriya adopt or adapt? |
| Langflow | Visual construction of LLM applications and component graphs | What can Kriya offer beyond component wiring? |
| Microsoft Copilot Studio | Visual agent authoring and orchestration within Microsoft's ecosystem | What enterprise governance and authoring patterns are relevant? |
| Google / Vertex AI agent tooling | Agent development, orchestration and evaluation capabilities across Google's ecosystem | Which interoperability, evaluation and deployment concepts matter? |
| Anthropic Console agent builder / agent platform capabilities | Visual agent configuration, testing and multi-agent orchestration capabilities documented by Anthropic | Which concepts overlap with Kriya's proposed authoring experience? |
| OpenAI Agents SDK / Codex | Agent orchestration, tools, handoffs, tracing and code-oriented agent execution; not the same product category as a general customer-facing visual graph studio | Where does Kriya's customer-facing visual graph experience differ from code-first execution and developer tooling? |
| Relevance AI, Gumloop, Stack AI, Voiceflow and others | Visual or low-code agent/workflow construction for business and operational use cases | Which customer segments, templates and deployment models are already served? |
| Claude Code / Codex graph visualizer extensions | Third-party tools can visualize agent sessions, tool calls, subagents and execution traces | Kriya Harness should distinguish authoring an executable harness from merely visualizing an existing session. |

The research should distinguish at least four categories:

1. **Workflow builders:** visual authoring and execution of business workflows.
2. **Agent builders:** configuring agent identities, models, tools, knowledge and multi-agent collaboration.
3. **Agent runtimes/frameworks:** code-first or graph-first execution systems.
4. **Harness engineering and observability tools:** configuring, governing, evaluating, tracing and improving how agents execute.

A competitor may span several categories. Avoid simplistic one-line comparisons.

## 2.2 Potential differentiation to investigate

The strongest possible Kriya differentiation is not the canvas alone. It may be the integration of:

- User-authored graphs that compile into the native Kriya runtime.
- Explicit, composable loop engineering, including bounded nested loops.
- Harness-level configuration for context, tools, memory, permissions, budgets, model routing and verification.
- Live execution visualization tied to real runtime events.
- Checkpoints, replay, debugging, version comparison and regression testing.
- A graph copilot that explains architecture trade-offs.
- Recursive Harness Evolution Engine (KRHE) that proposes evidence-backed improvements to graphs, loops and harness configurations.
- Multi-model execution and reproducible comparisons.
- Product-grade safety, governance and tenant isolation.

Claude Code must verify which of these are already offered by competitors, which are partial, and which—if any—are meaningfully differentiated as an integrated experience. Do not claim uniqueness without evidence.

## 2.3 Research sources to start from

Use primary documentation and repositories first; use independent reviews and comparison articles as secondary evidence. Verify that links and product capabilities are current at research time.

- n8n features: https://n8n.io/features/
- Dify workflows: https://www.dify.ai/workflows
- LangGraph Studio documentation: https://docs.langchain.com/langgraph-platform/langgraph-studio
- LangGraph documentation: https://docs.langchain.com/oss/python/langgraph/overview
- Anthropic platform overview: https://platform.claude.com/docs/en/build-with-claude/overview
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- Google Agent Development Kit: https://google.github.io/adk-docs/
- Microsoft Copilot Studio: https://learn.microsoft.com/en-us/microsoft-copilot-studio/
- Relevance AI: https://relevanceai.com/
- Gumloop: https://www.gumloop.com/
- Stack AI: https://www.stack-ai.com/
- Voiceflow: https://www.voiceflow.com/
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Model Context Protocol: https://modelcontextprotocol.io/
- Agent2Agent protocol: https://a2a-protocol.org/

Potential research literature and engineering patterns to assess:

- ReAct: https://arxiv.org/abs/2210.03629
- Reflexion: https://arxiv.org/abs/2303.11366
- Tree of Thoughts: https://arxiv.org/abs/2305.10601
- Graph of Thoughts: https://ojs.aaai.org/index.php/AAAI/article/view/29720
- SWE-agent / Agent-Computer Interface: https://arxiv.org/abs/2405.15793
- Agentless: https://arxiv.org/abs/2407.01489
- Harness² research (if relevant to current KRHE work): https://arxiv.org/abs/2610.08123 — verify the exact paper version, authors, claims, source repository, license and reproducibility before relying on it.

Do not treat a paper, benchmark, social-media post, product marketing page or GitHub README as independent proof. Separate author-reported results from independently reproduced evidence.

## 2.4 Research deliverable

Create `docs/kriya-studio/COMPETITIVE_RESEARCH.md` with:

- Research date and scope.
- Product categories and definitions.
- Competitor capability matrix with primary-source links.
- Screenshots or documented UX observations where permitted.
- Existing capabilities that directly overlap with the proposal.
- Missing or weakly served user needs supported by evidence.
- Kriya differentiation hypotheses.
- Features that would be table stakes versus genuinely differentiated.
- Licensing and dependency implications if considering reuse.
- Open questions and confidence levels.

The research must explicitly answer: **What does Kriya provide that is materially better or more integrated than the existing options, and what is merely table stakes?**

---

# 3. USER EXPERIENCE AND PRODUCT DESIGN EXPLORATION

These are possible experience patterns, not a mandated screen design.

## 3.1 Potential product structure

Investigate a product area called **Kriya Studio** or a better name if research and existing navigation suggest one.

Possible capabilities:

- Workflow Studio — create business and agent workflows.
- Graph Studio — author, inspect and validate graph structures.
- Loop Studio — design bounded iterative behaviours.
- Harness Studio — configure the internal agent execution environment.
- Run Inspector — inspect live and historical executions.
- Evaluation Lab — compare quality, reliability, cost and latency.
- Graph Copilot — describe, generate, explain and optimize graph designs.
- Template Library — discover, duplicate and publish reusable architectures.

Do not automatically create eight separate navigation items. Decide the smallest coherent information architecture that avoids sidebar clutter and cognitive overload.

## 3.2 Progressive disclosure

Consider at least three user modes:

**Guided mode:**
- Start from a natural-language goal or template.
- Kriya generates an initial workflow.
- Users configure a small number of meaningful options.
- Advanced graph details remain accessible but do not overwhelm beginners.

**Builder mode:**
- Visual node-and-edge editor.
- Typed ports, branches, data flow, conditions, tools, agent nodes and loop nodes.
- Node configuration inspector.
- Test and validation actions.

**Engineering mode:**
- Full state and schema inspection.
- Custom node definitions or supported code components.
- Advanced loop and graph configuration.
- Model routing, context policies, memory, budgets and permissions.
- Execution traces, checkpoints, replay, evaluation and version diffs.

Claude Code should decide whether these are modes, permission-based capabilities, progressive disclosure levels or another structure.

## 3.3 Canvas quality requirements

Research and select the best canvas technology based on the actual stack and requirements. Possible candidates include React Flow / XYFlow, Svelte Flow, custom SVG/Canvas/WebGL rendering, or an existing internal component. Do not choose a library merely because it is popular.

Evaluate:

- Large graph performance.
- Custom node and edge rendering.
- Port/handle semantics.
- Nested graphs and subgraphs.
- Selection, multi-selection, grouping and alignment.
- Auto-layout and manual positioning coexistence.
- Edge routing and crossing minimization.
- Zoom, pan, minimap and viewport persistence.
- Accessibility and keyboard interactions.
- Mobile and touch support.
- Serialization and schema compatibility.
- License and long-term maintenance.
- Compatibility with the current React/Next.js version and existing styling system.

Visual quality should include:

- Consistent node dimensions and clear hierarchy.
- Distinct but restrained node category indicators.
- Edge styles that encode control flow, data flow, delegation, retry, error recovery and loop return paths where appropriate.
- Clear selected, active, completed, failed, skipped, waiting and disabled states.
- Minimal overlapping labels and ports.
- Smart auto-layout with deterministic output where possible.
- Smooth but restrained transitions; no motion that harms readability.
- Empty states and useful examples.
- A polished inspector panel with predictable alignment and typography.

Do not make the canvas visually impressive at the expense of usability, performance, accessibility or correctness.

## 3.4 User journey to design and test

At minimum, prototype and test these journeys:

1. A beginner describes a goal and creates a simple workflow.
2. A business user creates an approval-based process with external integrations.
3. A developer creates a multi-agent research graph with parallel branches and a merge.
4. An advanced user builds a custom coding/research harness with nested loops and verification.
5. A user opens a failed run, identifies the failing node, inspects its inputs/outputs and retries safely.
6. A user compares two graph versions and rolls back.
7. A user asks the Graph Copilot to optimize a graph for latency, cost or quality.
8. A user opens Kriya Harness and visually inspects the underlying agent execution graph.
9. A user on a phone inspects a running workflow and handles an approval without needing the full desktop editor.

---

# 4. ARCHITECTURE HYPOTHESES — INVESTIGATE, DO NOT BLINDLY IMPLEMENT

The following architecture is a discussion aid. Claude Code must validate, adapt or replace it after repository reconnaissance.

## 4.1 Possible conceptual architecture

1. **Studio UI:** graph canvas, inspector, copilot, templates, run inspector and version history.
2. **Graph Definition Model:** canonical typed representation of nodes, ports, edges, schemas, policies, subgraphs and metadata.
3. **Graph Validator / Compiler:** validates graph structure and converts it into an executable plan understood by the runtime.
4. **Graph Execution Engine:** schedules nodes, manages state, branches, concurrency, retries, checkpoints and event emission.
5. **Kriya Loop V2:** handles bounded iterative execution, verification, recovery and termination inside applicable agent nodes.
6. **Existing DSH/Cordis runtime:** supplies the existing agent execution kernel and tools where appropriate.
7. **Policy and Governance Layer:** enforces permissions, tenant boundaries, approval requirements, budget limits and tool risk classes independently of user-authored graphs.
8. **Observability and Evaluation:** records structured traces, events, metrics, artifacts and evaluation outcomes.
9. **KRHE:** analyzes evidence and proposes improvements to graph designs, loop configurations and harness settings.

Do not create duplicate runtimes if the existing Kriya architecture already provides equivalent capabilities. The goal is coherent composition and clear ownership.

## 4.2 Graph definition model

A possible abstract representation:

`Graph = (V, E, Inputs, Outputs, StateSchema, Policies, Metadata)`

Where:

- `V`: typed nodes.
- `E`: typed directed connections.
- `Inputs` and `Outputs`: graph-level typed interfaces.
- `StateSchema`: explicitly defined state and data contracts.
- `Policies`: execution and governance constraints.
- `Metadata`: graph ID, version, author, timestamps and compatibility information.

Each node may define:

- Stable ID and type.
- Versioned implementation reference.
- Typed input/output ports.
- Configuration schema.
- Retry/timeout policy where allowed.
- Resource requirements.
- Permission requirements.
- Observability metadata.
- Error semantics.

Each edge may represent one or more explicitly defined semantics:

- Control-flow dependency.
- Data-flow binding.
- Conditional branch.
- Agent delegation/handoff.
- Loop continuation/return.
- Error/recovery route.

Do not overload a single edge type with ambiguous meaning. Validate cycles, types, missing required inputs, unreachable nodes, invalid branches and impossible termination paths.

## 4.3 Graph compilation and execution

Investigate whether Kriya should compile graph definitions into:

- A native internal execution plan.
- A durable workflow/state-machine representation.
- A graph interpreted directly by the runtime.
- An adapter over an existing engine.
- A hybrid design.

The selected design must address:

- Durable execution and crash recovery.
- Idempotency and duplicate event delivery.
- Concurrency limits and fairness.
- Cancellation and timeouts.
- Checkpoint persistence.
- Human approval pauses/resumption.
- Secret and credential resolution.
- Model/tool spend reservation.
- Node-level and graph-level budgets.
- Partial failure and compensation where relevant.
- Version compatibility for in-flight runs.
- Deterministic replay boundaries.

A graph must not become a way to bypass the existing tool gateway, model gateway, spend ledger, risk controls, approvals or audit trail.

## 4.4 Loop engineering

Potential loop patterns to investigate:

- ReAct (reason/act/observe).
- Plan → execute → review.
- Verifier → repair.
- Research → evidence → evaluate.
- Reflection with bounded iteration.
- Retry with classified errors and changed hypotheses.
- Hypothesis → experiment → evaluate.
- Nested loops within graph nodes.
- Dynamic decomposition and re-planning.

Each loop must have explicit state, transition rules, stopping conditions and resource bounds. Avoid uncontrolled recursion and infinite cycles.

Potential formalization:

`Loop = (State, Transition, Guard, Verifier, Budget, TerminationPolicy)`

The system should detect no-progress loops, repeated identical tool calls, repeated failed hypotheses, budget exhaustion and unsafe transitions. The mathematical model should be selected by Claude Code based on the actual implementation—not included as decorative documentation.

## 4.5 Dynamic task graphs

Consider a runtime planner that decomposes a task into a DAG, identifies independent work, executes parallelizable nodes, and merges results. But do not assume every task benefits from multi-agent execution.

The system should compare the expected quality, latency, cost and risk of:

- A single agent with tools.
- A sequential workflow.
- A parallel DAG.
- A multi-agent graph.
- A graph with nested loops.

The planner should choose the simplest architecture that meets the task requirements and quality threshold.

---

# 5. GRAPH COPILOT AND NATURAL-LANGUAGE AUTHORING

Investigate a copilot that helps users create and improve graphs.

Possible capabilities:

- Generate a graph from a natural-language goal.
- Explain each node and edge.
- Suggest missing verification, error handling or approval steps.
- Detect unnecessary sequential dependencies and propose safe parallelism.
- Identify duplicated work or redundant model calls.
- Recommend a simpler graph when the current design is over-engineered.
- Suggest model/tool choices based on task requirements, not vendor favoritism.
- Estimate cost and latency ranges with uncertainty clearly shown.
- Generate test cases and evaluation criteria.
- Convert an existing workflow or supported agent configuration into a visual graph.
- Explain why a proposed change is beneficial and what trade-offs it introduces.

The copilot must not silently modify or publish a user's graph. Use previewable diffs, explicit confirmation and version history for consequential changes.

---

# 6. KRHE INTEGRATION — RECURSIVE HARNESS EVOLUTION

Kriya already has a proposed Recursive Harness Evolution Engine (KRHE). Claude Code must investigate how this new Studio capability should connect to it.

The intended relationship is:

- Studio lets a user author and configure graphs, loops and harnesses.
- The runtime executes them and emits evidence.
- The evaluation layer measures outcomes.
- KRHE may propose candidate improvements based on evidence.
- The user or authorized policy approves adoption.

Potential KRHE targets include:

- Graph topology and dependency ordering.
- Node selection and routing.
- Loop structure and termination criteria.
- Verification strategy.
- Tool instructions and agent configuration.
- Context and memory retrieval policies.
- Model selection and fallback policies.
- Parallelism and resource budgets.

KRHE should not autonomously modify mandatory security policies, tenant isolation, permissions, secret handling, spend controls or audit integrity.

A possible cycle to evaluate:

`Baseline → Propose → Probe → Evaluate → Compose → Validate → Approve → Canary → Monitor → Rollback/Adopt`

The optimizer must compare candidates under controlled conditions, track uncertainty, prevent data leakage between tenants and retain provenance for every accepted change.

Users should be able to distinguish:

- Their original graph.
- An AI-generated proposal.
- A tested candidate.
- An adopted version.
- A rolled-back version.

Do not make claims that the system improves itself unless the evidence, benchmark design and change history support that claim.

---

# 7. PRODUCTION, SECURITY AND RELIABILITY REQUIREMENTS

These are product safety constraints, not optional design preferences.

## 7.1 Preserve existing Kriya invariants

Claude Code must discover the authoritative invariants in `AGENTS.md` and the current security/architecture docs. At minimum, investigate and preserve:

- Tenant isolation and Supabase RLS.
- Authentication and authorization boundaries.
- Model gateway and spend reservation/ledger.
- Secret redaction and credential isolation.
- Tool risk classes and approval gates.
- Sandbox boundaries and execution isolation.
- Audit logs and trace integrity.
- Data retention and privacy requirements.
- Existing release-stage and feature-flag controls.

The exact controls must be derived from the repository, not assumed from this brief.

## 7.2 Graph security

Treat user-authored graphs as untrusted input. Validate and authorize every node, edge, tool, model and integration server-side.

Address:

- Graph schema validation and version migration.
- SSRF and unsafe URL access.
- Command execution and code-node sandboxing.
- Prompt injection through graph data, tool output and retrieved content.
- Secret references and least-privilege credential access.
- Cross-tenant graph/run/artifact access.
- Malicious or excessive graph size/depth/concurrency.
- Infinite loops and runaway spending.
- Unsafe plugin/MCP integrations.
- Approval bypass and privilege escalation.
- Export/import tampering.

The frontend must never be the security boundary.

## 7.3 Reliability

Consider:

- Durable run state.
- Idempotent node execution where possible.
- At-least-once event delivery handling.
- Checkpoint/resume semantics.
- Retry classification and backoff.
- Cancellation propagation.
- Dead-letter and failure inspection.
- Schema evolution.
- Concurrency and queue limits.
- Run retention and artifact lifecycle.
- Backpressure and graceful degradation.

## 7.4 Cost and performance

Track graph-level and node-level:

- Model tokens and spend.
- Tool calls.
- Wall-clock and queue time.
- Retry count.
- Concurrency.
- Cache hit rate.
- Resource usage.
- Verification outcomes.

Do not claim a cost or latency improvement without measurement. Do not parallelize merely to make the graph appear sophisticated.

---

# 8. EVALUATION AND ACCEPTANCE

Claude Code must define a test strategy before claiming production readiness.

## 8.1 Functional acceptance

At minimum, test:

1. Create a graph manually.
2. Generate a graph from a natural-language description.
3. Edit node configuration and connections.
4. Validate schemas and graph topology.
5. Save, reopen and version a graph.
6. Execute a real graph through the Kriya runtime.
7. Display live run state and node events.
8. Inspect inputs/outputs subject to redaction policy.
9. Handle branches, parallel execution and merge.
10. Execute a bounded loop and terminate correctly.
11. Pause for human approval and resume.
12. Recover or clearly fail on timeout, cancellation and node error.
13. Compare graph versions and roll back.
14. Enforce tenant boundaries and permissions.
15. Verify mobile inspection/approval flows.
16. Ensure Kriya Harness can inspect and use the graph capability coherently.

## 8.2 Visual acceptance

- Compare the new experience with the current Kriya design system.
- Test graph readability at small, medium and large graph sizes.
- Test zoom, pan, selection, alignment, edge routing and node inspector.
- Test empty, loading, running, success, failure and partial states.
- Test desktop, tablet and mobile.
- Test keyboard and accessibility flows.
- Check that no existing navigation or layout is degraded.

## 8.3 Regression acceptance

Run the existing test suites and relevant integration/e2e tests. Record exact commands, pass/fail counts and any pre-existing failures. Do not silently modify unrelated tests to make the feature pass.

## 8.4 Benchmark acceptance

Create a representative graph benchmark suite:

- Simple sequential workflows.
- Conditional branches.
- Parallel DAGs.
- Multi-agent delegation.
- Bounded loops.
- Tool failure and repair.
- Human approval.
- Long-running/resumable tasks.
- High-volume and high-concurrency graphs.

Measure correctness, task completion, reliability, cost, latency, resource usage and recovery. Include baseline comparisons against the existing Kriya workflow/runtime path.

---

# 9. IMPLEMENTATION APPROACH — CLAUDE CODE DECIDES THE PLAN

Do not begin by coding a large graph editor. First understand the system and determine the safest implementation sequence.

A possible sequence to evaluate:

1. Repository reconnaissance and current-state map.
2. Product and competitor research.
3. User journeys and information architecture.
4. UX prototypes/design-system audit.
5. Runtime and data-model architecture.
6. ADRs and migration plan.
7. Minimal vertical slice using a real runtime path.
8. Typed graph schema, validation and persistence.
9. Execution, events and inspector.
10. Loop nodes and advanced graph features.
11. Kriya Harness integration.
12. Graph Copilot and KRHE integration.
13. Security, performance and regression testing.
14. Release staging, documentation and status update.

This is not a fixed roadmap. Claude Code may reorder, combine or replace phases with reasons.

Use feature flags and backward-compatible migrations. Keep unfinished capabilities hidden or explicitly marked beta. Do not remove existing workflows or replace existing navigation without a migration and regression plan.

---

# 10. REQUIRED REPOSITORY RECONNAISSANCE

Before changing code, identify the actual repositories, branches, worktrees and active user changes. Do not assume paths from stale prompts.

The previous project context mentioned:

- Server repository: `/Users/chaitanyakumarmanda/Developer/Kriya-Tavi`
- Client worktree: `/Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade`
- User's main checkout: `../kriya-harness`

These are **historical hints only**. Verify that they still exist and correspond to the intended project. Do not switch branches, reset, clean, delete, overwrite or modify the main checkout. Preserve active symlinks and user changes.

Inspect at minimum:

- `AGENTS.md` and all applicable nested agent instructions.
- Kriya Tavi sidebar/navigation and current design system.
- Kriya Harness UI and runtime architecture.
- Existing graph, workflow, loop, agent, tool and session code.
- Kriya Loop V2 documents and current status.
- KRHE proposal and implementation status.
- Existing API routes, DB schema, Supabase RLS policies and migrations.
- Existing model/tool gateways, approval systems and spend controls.
- Existing event/trace formats and observability.
- Existing tests, CI and release process.
- `status.md` files relevant to Kriya Studio, Kriya Harness, Loop V2 and KRHE.

Use exact file paths found in the current repository. Do not invent documents or assume a status file's location.

---

# 11. REQUIRED DELIVERABLES

Create or update documentation in the repository using the project's existing documentation conventions. Suggested deliverables (adjust paths if the repository uses a different canonical structure):

1. `docs/kriya-studio/PRODUCT_INTENT.md` — owner intent, user segments, jobs-to-be-done and product principles.
2. `docs/kriya-studio/COMPETITIVE_RESEARCH.md` — current landscape, verified capabilities, overlap and differentiation.
3. `docs/kriya-studio/UX_AND_INTERACTION_SPEC.md` — navigation, journeys, canvas, node/edge design, responsive and accessibility decisions.
4. `docs/kriya-studio/ARCHITECTURE.md` — selected architecture, runtime integration, graph schema, compiler/interpreter decision and data flow.
5. `docs/kriya-studio/SECURITY_AND_RELIABILITY.md` — threats, invariants and operational requirements.
6. `docs/kriya-studio/IMPLEMENTATION_PLAN.md` — phased work, dependencies, migrations and release gates.
7. ADRs for material architecture decisions.
8. Tests and implementation artifacts.
9. Update the authoritative `status.md` with what was actually designed, implemented, tested, deferred and blocked.
10. Update any relevant Loop V2 and KRHE status documents so the architecture does not diverge.

Do not create redundant documentation if equivalent canonical documents already exist. Update existing files where appropriate.

---

# 12. EXECUTION RULES FOR CLAUDE CODE

You are not being asked merely to write a proposal. You are being asked to own the full engineering process: investigate, research, design, implement, validate and document.

However, **do not confuse end-to-end ownership with permission to make unsafe or unreviewed production changes.**

1. Start with reconnaissance; report verified repository and worktree state.
2. Preserve all user changes and existing product functionality.
3. Do not reset, clean, force-push, delete worktrees or alter the protected main checkout.
4. Do not run destructive database migrations or change production data without explicit authorization.
5. Do not run unmetered or unapproved paid model benchmarks.
6. Do not weaken security controls to make graph execution easier.
7. Do not ship mock execution paths disguised as real functionality.
8. Do not leave inert UI controls or fake success states.
9. Do not introduce a second execution runtime without demonstrating why the current runtime cannot satisfy the requirements.
10. Do not claim uniqueness, superiority or production readiness without evidence.
11. Keep changes incremental, reviewable and covered by tests.
12. If blocked by missing credentials, infrastructure or approvals, complete all safe work and document the exact blocker and required owner action.
13. Do not stop after architecture documents if implementation can safely proceed. Implement a complete vertical slice and continue through the approved scope.
14. Do not claim 100% reliability. Define measurable release criteria and report observed results.

## 12.1 Design ownership and decision quality

Claude Code must independently decide:

- Whether Kriya Studio is one shared product surface or coordinated surfaces in Tavi and Harness.
- The best navigation and information architecture.
- Which user modes and progressive disclosure model are appropriate.
- The best graph data model and execution representation.
- Whether to use an existing graph library, extend an internal canvas or build custom rendering.
- Which node/edge types are actually needed for the first release.
- How graph authoring maps to Kriya Loop V2 and DSH/Cordis.
- How KRHE can propose and validate graph/loop improvements.
- What should be built first and what should be deferred.

For each major decision, document the problem, options, evidence, trade-offs, selected option and consequences.

## 12.2 Definition of done

A phase is complete only when:

- Its design is documented.
- Its implementation is integrated into the real product.
- Its UI follows the existing design system.
- Its APIs and runtime paths are real and validated.
- Its security and tenant boundaries are tested.
- Its tests pass, with exact results recorded.
- Its documentation and status are updated.
- Any known limitations are clearly identified.

---

# 13. FINAL CLAUDE CODE MISSION

Read this entire document and treat it as the owner's product intent and research brief—not as a rigid implementation specification.

Your first responsibility is to understand the actual Kriya Tavi and Kriya Harness products as they exist today. Then conduct current primary-source research, inspect the code and design system, map the existing architecture, identify what is already available, and determine the best way to deliver this vision without damaging existing functionality.

The intended outcome is a premium, production-grade Kriya visual agent-engineering experience in both Kriya Tavi and Kriya Harness. Users should be able to create and operate useful workflows, design graphs and loops at the level they need, inspect and debug real executions, and progressively access more advanced harness engineering capabilities. Kriya should connect this experience to its existing loop, runtime, verification, governance and recursive evolution work wherever that is architecturally sound.

The graph visualization must be exceptional: precise node alignment, beautiful and understandable edge connectivity, clear hierarchy, readable dense graphs, smooth interactions and a polished inspector—all consistent with the existing Kriya visual identity. The result must look like a deliberate extension of the current product, not a generic workflow-builder template.

Do not implement the suggestions blindly. Research what already exists, identify what customers actually need, challenge the proposed structure, and design something more useful if the evidence points elsewhere. You own the technical and UX design decisions. Explain them and record them.

Then implement the approved, safe scope end-to-end, test it against real Kriya runtime paths, protect existing workflows, update the relevant `status.md` and canonical documentation, and report exact evidence: files changed, migrations, tests, benchmark results, security checks, limitations and next steps.

**Build the most useful and trustworthy product—not the largest graph editor.**

---

# APPENDIX A — RESEARCH NOTES AND CURRENTNESS

The following observations were gathered as an initial research snapshot on 2026-11-05. Claude Code must revisit the official documentation and current product status before making decisions.

- n8n publicly describes AI workflow authoring, visual editing, agent integration, human-in-the-loop controls, live execution inspection, trace/replay, deployment controls and versioning. This is strong overlap with basic workflow studio capabilities.
- Dify provides a visual AI workflow/application-building experience. Its current feature set and licensing should be verified from official documentation and repository sources.
- LangGraph Studio is a graph-oriented development and debugging environment for stateful agent applications. It is relevant to graph state, inspection and execution design.
- Anthropic's current platform overview documents a Console agent builder, managed/cloud sandbox capabilities, memory stores and multi-agent orchestration/dynamic workflows. Verify which capabilities are generally available and their exact boundaries.
- Third-party Visual Studio Code extensions advertise live graph visualization of Claude Code and Codex sessions. These are not equivalent to a first-party customer-facing workflow/harness authoring product, but they mean Kriya must not claim that graph visualization of agent activity is unprecedented.
- A broad market category of visual AI agent builders already exists. Therefore, Kriya's differentiation must be based on the depth and integration of harness design, loop engineering, runtime execution, verification, evolution and product UX—not the existence of a canvas.

Initial web references:

1. n8n feature overview: https://n8n.io/features/
2. Dify workflow overview: https://www.dify.ai/workflows
3. LangGraph Studio documentation: https://docs.langchain.com/langgraph-platform/langgraph-studio
4. Anthropic platform overview: https://platform.claude.com/docs/en/build-with-claude/overview
5. Agent Flow visualization extension: https://marketplace.visualstudio.com/items?itemName=simon-p.agent-flow
6. Claude Code Graph extension: https://marketplace.visualstudio.com/items?itemName=IdleVillager.claude-code-graph
7. Microsoft Copilot Studio documentation: https://learn.microsoft.com/en-us/microsoft-copilot-studio/
8. Google ADK documentation: https://google.github.io/adk-docs/
9. OpenAI Agents SDK: https://openai.github.io/openai-agents-python/

These references are starting points, not an exhaustive competitive audit. Prefer official product documentation, source repositories, release notes and hands-on verification. Cite the source for each factual competitor claim in `COMPETITIVE_RESEARCH.md`.
