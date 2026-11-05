# Competitive research (track S)

Research date: **2026-11-05**. Scope: products and frameworks named in the
owner's brief, plus any found while checking them. Method: primary pages read
on that date. Where only a secondary source or a search summary was available,
the row says so. Nothing here was used hands-on: no account was opened and no
competitor was run, so UX notes are documented behaviour, not observed
behaviour.

Confidence: **H** primary page read today, **M** primary page partly confirms
it, **L** secondary source only.

## 1. Corrections to the brief

| Brief says | Found | Effect |
| --- | --- | --- |
| Harness² is `arxiv.org/abs/2610.08123` | That id is an autonomous-driving paper ("Beyond Waypoint Regression…", cs.RO). The repo's own research (`docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION_RESEARCH.md` §1) cites the right one, **arXiv:2610.14224** | Use 2610.14224; the link in the brief is wrong |
| OpenAI's entry covers only the Agents SDK and Codex | OpenAI shipped a visual **Agent Builder** in 2025 and is **shutting it down, with Evals, on 2026-11-30** (notice 2026-06-03; migration to the Agents SDK or ChatGPT Workspace Agents; [deprecations page](https://developers.openai.com/api/docs/deprecations)) | The strongest lesson in this research; see §4 |
| LangGraph Studio (name) | The doc page is now titled **LangSmith Studio** | Naming only |
| Google ADK template workflow agents | The ADK page says template workflows are superseded from ADK 2.0 (Python, Go) by graph-based and dynamic workflows | ADK moved toward graphs |

## 2. Categories

1. **Workflow builders:** author and run business automations visually.
2. **Agent builders:** configure an agent's identity, model, tools, knowledge.
3. **Agent runtimes and frameworks:** code-first or graph-first execution.
4. **Harness engineering and observability:** configure, govern, evaluate,
   trace and improve how agents run.

## 3. Capability matrix

| Product | Category | Canvas authoring | Loops | Human gate | Replay / debugging | Versions | Evals | Licence / reuse | Conf. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [n8n](https://n8n.io/features/) | 1, some 2 | Yes | Yes (general nodes) | Yes: approvals and decision points | [Debug in editor](https://docs.n8n.io/workflows/executions/debug/) copies a past execution's data and pins it to the first node, all Cloud plans | Compare and roll back; [full history is Enterprise](https://docs.n8n.io/workflows/history/), 24 h for everyone else | [Light and metric-based](https://docs.n8n.io/advanced-ai/evaluations/overview/), datasets | [Sustainable Use](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md): no paid hosting for others, so **not reusable** | H |
| [Dify](https://docs.dify.ai/en/use-dify/nodes/loop) | 1, 2 | Yes | [Loop node](https://docs.dify.ai/en/use-dify/nodes/loop): condition, max count, exit node, loop variables; [iteration](https://docs.dify.ai/en/use-dify/nodes/iteration): up to 10 parallel | [Human Input node](https://docs.dify.ai/en/use-dify/nodes/human-input) since v1.13.0; each decision routes; loop-back pattern | Not checked | Not checked | Not checked | [Modified Apache](https://raw.githubusercontent.com/langgenius/dify/main/LICENSE): **no multi-tenant use** without permission, logo stays: **not reusable** | H |
| [LangSmith Studio / LangGraph](https://docs.langchain.com/langgraph-platform/langgraph-studio) | 3, 4 | **No:** visualises graphs defined in code | In code | Interrupts | [Time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel): nodes before a checkpoint are saved; nodes after it **re-execute, including LLM calls and API requests**; fork through `update_state` | Through code | Experiments over datasets | Framework open source; Studio is LangSmith | H |
| [Langflow](https://www.langflow.org/) | 1, 2 | Yes | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Weak per secondary sources | MIT (secondary) | L |
| [Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-overview) | 1, 2 | Yes: agent flows on a canvas; a newer workflows format with node-level testing (third-party) | Refinement loops (third-party) | Yes: approvals | Not confirmed | Not confirmed | Not confirmed | Proprietary. Status of the new format not stated on the page read | M |
| [Google ADK](https://adk.dev/agents/workflow-agents/) | 3 | The site lists a Visual Builder page (not read) | LoopAgent with a termination condition; graph workflows since 2.0 | Not checked | Not checked | Code | Built in (`adk eval`, secondary) | Open source | M |
| [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | 2, 3 | Console agent builder [walks through each field](https://platform.claude.com/docs/en/managed-agents/onboarding); no node canvas described; **beta** | Dynamic workflows: programs an agent writes | Not checked | Session viewer (secondary) | Not checked | Not checked | Proprietary | H |
| [OpenAI Agent Builder](https://developers.openai.com/api/docs/deprecations) | 1, 2 | Was a canvas (launch page refused automated reads; features from a search summary) | — | — | — | Versioning claimed at launch | Evals platform also ending | **Shuts down 2026-11-30** | H for shutdown, L for features |
| [Relevance AI](https://relevanceai.com/) | 2 | Not on the home page | — | — | — | "Version control" | "Eval pass rate" | Proprietary | M |
| [Gumloop](https://www.gumloop.com/) | 1, 2 | Not on the home page | — | — | — | — | — | Proprietary | M |
| [StackAI](https://www.stackai.com/) | 1, 2 | "Drag-and-drop no-code" | — | — | — | — | — | Proprietary | M |
| [Voiceflow](https://www.voiceflow.com/) | 2 (CX) | Yes, with branching | — | — | — | Environments, branches, merges | Tests, simulations | Proprietary | M |
| [Agent Flow](https://marketplace.visualstudio.com/items?itemName=simon-p.agent-flow), [Claude Code Graph](https://marketplace.visualstudio.com/items?itemName=IdleVillager.claude-code-graph) | 4 | **No:** live view of existing sessions; 3,759 and 712 installs | — | — | Read-only | — | — | Apache 2.0, MIT | H |

"—" and "Not checked" mean not looked up or not on the page read, never
"absent". Rivet, Flowise and Vellum: only comparison blogs that disagree with
each other, so left out.

## 4. What this says

**A canvas is table stakes, and is not a moat.** Five products ship one. The
clearest evidence is OpenAI: a well-resourced vendor launched a canvas with
versioning and evals and is closing it about a year later, sending people to
code or to its own workspace agents. The notice gives no reason, so this is
inference: a canvas alone didn't hold. The brief's last line ("not the largest
graph editor") looks right.

**Table stakes for a first release:** canvas, branches, parallel with join,
bounded loop, human gate, run history with inputs and outputs per node,
versions with rollback, retry from failure, natural-language start, templates.

**Weakly served, on this evidence:**

| Need | What's documented elsewhere | Kriya's position |
| --- | --- | --- |
| Debugging that doesn't repeat real actions | LangGraph replay re-executes everything after the checkpoint, API calls included. n8n's is pinned data on the first node | Kriya already records every tool execution with a side-effect flag, so a fork can reuse recorded results and name what would run again (SD-09) |
| A statically known worst case | Dify and ADK bound a loop by a maximum count. A whole-graph worst case before running wasn't found documented | Structured loops make it computable: "at most N agent runs" before the first run (SD-05) |
| "Done" that a model can't claim | Evals are mostly datasets and metrics after the fact; where runs are concerned, a model's text often is the result | Kriya's rule already: only verified tool runs count (track-A rule 7, track N rule 3). A check node can require them |
| Whether a change was better | n8n and LangSmith run evals; a paired test with an adopt/hold gate wasn't found documented | KRHE's gate exists and is code (`lib/harness/evolve/gate.ts`) |
| Authoring what a coding agent does on your own machine | The two VS Code extensions only watch; Studio only shows code | A graph that compiles to a Loop v2 plan and harness profile, run on the person's computer, is rarer on this evidence |
| One account across cloud agents and a local agent | Not found documented | Unusual because Kriya happens to have both |

**Do not claim:** that graph visualisation, visual agent building, loops, human
approval, versioning or evals are new. Do not claim the above needs are
unserved anywhere: this pass read about fifteen products' pages, and "not
found" is not "absent" (track-A rule 12, RG-9). No Kriya advantage here has
been measured or put in front of a customer.

**The honest answer to the brief's question.** Merely table stakes: canvas,
nodes, branches, loops, approvals, versions, copilot. Materially more
integrated, if it ships as designed: agent nodes that run on the same governed
runtime as every other Kriya task (approvals, receipts, metering, memory
quarantine) rather than a parallel automation layer; runs that can be
re-entered without repeating side effects; a worst-case bound before spending;
adoption decided by a paired code gate; and one graph format that also drives
the local harness. It is a hypothesis about buyers until tested with people.

## 5. Canvas technology

| Option | Licence | Fits | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| [`@xyflow/react`](https://reactflow.dev/) 12.12.1 | [MIT](https://raw.githubusercontent.com/xyflow/xyflow/main/LICENSE) | Peer `react >=17` (app is 19.3); custom nodes and edges; handles; sub-flows; minimap; [keyboard](https://reactflow.dev/learn/advanced-use/accessibility) with `ariaLabelConfig`; touch | Published 2026-11-04, active | **Chosen** |
| Custom SVG/Canvas | Own | Everything, at the cost of building and keeping pan, zoom, selection, focus, touch and hit testing | — | Rejected: months of work for no product gain |
| `elkjs` 0.12.1 | [EPL-2.0 OR GPL-3.0-or-later](https://www.npmjs.com/package/elkjs) | [Layered with port constraints and orthogonal routing](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html); React Flow's guide lists it as the one that handles sub-flows and routing | 8.2 MB unpacked; loaded only on the Flows pages | **Chosen for layout**, used unmodified under EPL-2.0 |
| `@dagrejs/dagre` 3.1.3 | MIT | Simple, small | React Flow's guide: an open issue prevents laying out sub-flows connected to outside nodes. Loops are sub-flows here | Rejected |
| `libavoid-js` | LGPL-2.1, beta | Obstacle-avoiding routing | Beta | Rejected |

No Svelte in this codebase, so Svelte Flow doesn't apply.

## 6. Protocols and runtimes considered

| Item | Finding | Decision |
| --- | --- | --- |
| [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans) | `invoke_agent` and `execute_tool` defined, status Development | Keep node runs and tool executions mappable; no exporter yet |
| [MCP](https://modelcontextprotocol.io/) | Kriya has an owner-reviewed registry (track N) | Agent nodes use it through the agent's belt; nothing new |
| [A2A](https://a2a-protocol.org/) | Not read in depth | No customer need yet |
| Temporal, Restate, DBOS | Comparison pages are vendor-written; DBOS is an embedded Postgres-backed library, Temporal an external server | Rejected for now: the queue, leases and recovery already exist in Postgres, and track C rule 3 says one orchestrator (SD-03) |
| Papers (ReAct, Reflexion, ToT, GoT, SWE-agent, Agentless) | Not reread; patterns taken as commonly known | Only ideas used: bounded reflection with a verifier, and "a simple fixed pipeline can beat an agent" (a reason for the simplicity moves in SD-13). No claim rests on them |

## 7. Open questions

| Question | How to settle it | Confidence now |
| --- | --- | --- |
| Do customers want graphs, or just results? | Five people, journeys 1 and 2, watched | Unknown |
| Why did OpenAI close Agent Builder? | No stated reason found. The migration guide wasn't read | Low |
| Is the new Copilot Studio format GA? | The page read doesn't say | Low |
| What did Agent Builder's canvas do well? | Its docs refused automated reads | Low |
