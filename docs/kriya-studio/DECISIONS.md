# Decisions (track S)

The owner handed these decisions over in the brief (§12.1) and in chat
(2026-11-05: "You own the final architecture and design decisions"). Each
gives the problem, the options, the evidence, the choice and what follows.
Status **Decided** means the agent decided under that mandate; the owner can
overturn any of them. Items that need the owner are in §3.

## 1. Product

### SD-01 Name and place: "Flows"

- **Problem.** The brief proposes "Kriya Studio". `Skill Studio` already
  exists at `/agents/skills`, with a `studio` feature flag.
- **Options.** (a) "Studio": collides. (b) "Graphs": an engineer's word. (c)
  "Workflows": long, and `workflowId` already means a role-pack workflow in
  `TaskInput`. (d) "Flows": one plain noun, like Goals, Jobs, Rooms.
- **Decided: (d).** One sidebar entry, **Flows**, in the Tools section. Track
  name "Studio (track S)" and `docs/kriya-studio/` stay as the engineering
  name. Code uses `flow`.
- **Follows.** The brief's eight sub-products collapse into one list and one
  editor with tabs; no extra navigation items.

### SD-02 One graph format, one editor, two places a flow runs

- **Problem.** Tavi and Harness are different runtimes. Shared, duplicated or
  coordinated?
- **Evidence.** Harness's Web UI is DSH's, extended by plain-React plugins
  with no bundler (`plugins/progress/client.js`), on 127.0.0.1, per session.
  Its authoring surface would be a second editor. The Control Center already
  runs a typed `run` action on the person's computer from `/harness`.
- **Options.** (a) One UI embedded in both. (b) Two editors. (c) One editor in
  Tavi with a `target`, and a small read-only view in Harness.
- **Decided: (c).** A flow's `target` is `cloud` (agents as Kriya tasks) or
  `device` (a Loop v2 plan and harness profile on the person's computer).
  Authoring and history live in Tavi. Harness gets a **Graph** tab that draws
  the session's real plan from the loop's records, offline, without React Flow.
- **Follows.** Harness users design in the browser and watch on the machine.
  Editing in the local UI is not offered.

### SD-03 Modes are disclosure, not a switch

- **Problem.** Guided, builder and engineering modes (brief §3.2).
- **Decided.** No mode switch. One editor; complexity appears as you ask for
  it: describe → the graph appears → the inspector shows essentials, with
  **Limits and recovery** folded. Phones get Outline and Runs, no canvas
  editing (SD-16).

## 2. Architecture

### SD-04 No new runtime: nodes are ordinary tasks

- **Problem.** The brief asks whether to compile to a plan, a state machine,
  an adapter or an engine, and forbids a second runtime without proof.
- **Evidence.** `lib/operator/crews.ts` already runs a dependency DAG durably:
  each part is an ordinary task in its own thread (because of
  `tasks_one_active_per_thread`), started through `enqueuePart`, followed by a
  no-model pass in the worker. So leases, heartbeats, retries, budgets, no
  retry after side effects, approvals, Inbox, episodes, receipts and metering
  all apply unchanged. Track C rule 3: "One orchestrator: the Postgres queue".
- **Options.** (a) Temporal, Restate or DBOS: new infrastructure, and each
  would still have to call `runTask`. (b) LangGraph: Python, and its own
  state. (c) A new engine in `runTask`: protected file, and it would duplicate
  the model loop. (d) **Compile to a plan and advance it with a pure function
  in a worker pass, using `enqueuePart`.**
- **Decided: (d).** `lib/agent/queue.ts`, `run-task.ts` and `metering.ts` do
  not change. An agent node is `enqueuePart` with `channel: "crew"`.
- **Follows.** A node inherits the crew channel's handling: it can't pick
  skills from its brief, and its brief is shown as a part. Per-node model tier
  isn't available: a node runs at its agent's tier, so choose the agent
  (changing it would need `queue.ts`). Latency between nodes is the pass
  interval, 2 s (SD-08).

### SD-05 Structured graphs: a DAG plus loop regions

- **Problem.** Arbitrary back edges make termination and worst-case cost
  undecidable from the shape, and "loop return" becomes an overloaded edge.
- **Options.** (a) Free cycles with a counter (common in canvas tools). (b)
  **Structured regions**, like `while` versus `goto`.
- **Decided: (b).** The top level and every loop body are DAGs. The only
  repetition is a `loop` region with a maximum, a verifier and a no-progress
  stop. Depth at most 2.
- **The model.** A graph G = (V, E, I) where V's parent relation is a forest
  of loops and E joins only siblings. For loop ℓ: state s = (i, last check,
  last output hash), transition = run the body, guard = i < max ∧ spend
  remains ∧ output changed, verifier = the `until` check.
  Worst case W(G) = Σ_{v agent} Π_{ℓ ∋ v} max(ℓ) × (1 + retries(v)).
  Termination: every node runs at most Π max times and the DAG is finite. The
  validator refuses W(G) > `studio.maxNodeRuns`.
- **Follows.** "At most N agent runs" is shown before running, and is exact.
  A failed review that should go back to an earlier stage is a loop region,
  not a back edge.

### SD-06 Edges are control; data is named

- **Problem.** The brief warns against overloading one edge.
- **Decided.** An edge is always control: "after this outcome, go here". Its
  meaning comes from its source port: `out`, `pass`/`fail`,
  `approved`/`declined`, `done`/`exhausted`, `error`. Data moves only through
  named references (`{{input.x}}`, `{{node}}`), validated against what runs
  before. Selecting a node draws its data sources as a dashed overlay.
- **Rejected.** Data ports with typed wires: a wire per value turns a
  four-node flow into a bus diagram, and agent output is text anyway.
- **Join semantics.** Dead-path elimination: a node runs when every incoming
  edge is resolved and at least one was taken; if none, it is skipped and that
  propagates.

### SD-07 Seven node types

`start`, `agent`, `check`, `approval`, `merge`, `loop`, `end`; and `step` for
device flows, whose Loop v2 plan has its own bounds. Branching is a `check`:
one predicate language, code-evaluated, no second "if" node.

Not in release 1: a direct tool node (invariant 5: agents act through tools,
and the policy lives on that path), code nodes (no sandbox on this path),
sub-flows, triggers other than Run. None appears in the UI as a dead control.

### SD-08 Pure core, thin database shell

- **Decided.** `lib/flows/engine.ts` is pure: `decide(plan, rows, now)` returns
  decisions. `lib/flows/run.ts` applies them. A dedicated worker loop every 2 s
  behind `studio.flows`, leased per run, idempotent through
  `unique (run, node, scope, attempt)` and `enqueuePart`'s key.
- **Why.** It can be tested with no database, including random graphs for
  termination, and the worker can die between any two statements.

### SD-09 Checkpoints are node runs; re-entry reuses, never replays

- **Problem.** Time travel that re-executes side effects is dangerous.
- **Decided.** Each settled node row is a checkpoint. **Retry** adds an attempt
  for the failed node. **Re-run from here** makes a new run that copies settled
  rows not downstream of the node, without executing them, and first lists any
  downstream node that performed a side effect in the source run. Automatic
  retry happens only when the failed node recorded no side effect (track N
  rule 9).
- **Replay boundary.** Outputs of copied nodes are recorded data. Everything
  downstream runs again, with a real model, so its output may differ.

### SD-10 Versions are immutable; running pins one

- **Decided.** A draft autosaves with an optimistic revision. Saving a version
  or pressing Run on changed work appends to `flow_versions` (immutable by
  trigger). Runs pin a version. Rollback appends a copy of an old version.
  `source` is `person`, `copilot`, `improve` or `rollback`. In-flight runs
  never change.

### SD-11 Taint crosses node boundaries explicitly

- **Problem.** `privateContentSeen` looks only at tool calls in the current
  thread. A node that reads mail and passes its output to a node with web
  access would drop the guard: an exfiltration path around `guardWeb`.
- **Decided.** Each node run records `tainted` (it, or anything it read from,
  used a private-read or MCP tool). Briefs carrying upstream output get
  `FLOW_CONTEXT`; tainted ones also `FLOW_PRIVATE`. `privateContentSeen` and
  `untrustedSeen` in `lib/agent/tools.ts` learn the markers, the same pattern
  as `ROOM_CONTEXT` and `MIRROR_CONTEXT`, stricter only. The markers are
  inert outside flows.
- **Finding.** Crew reports have this same gap today (`reviewRun` passes
  reports to dependent parts with no marker). Out of this track's scope;
  reported to the owner, not fixed here.

### SD-12 Graph copilot: model drafts, code validates, person applies

- **Decided.** One capped model call, the Skill Studio pattern, returns a
  `FlowGraph` as JSON; it passes the same validator as a person's graph, with
  one repair attempt. The result is a preview with a diff; **Apply** writes the
  draft. The copilot has no tool, never saves, publishes or runs.
- **Rejected.** A chat agent with graph-editing tools: a new tool class, and
  it would act where a proposal is enough.

### SD-13 Improve: evidence moves by code, the gate by code

- **Decided.** KRHE's split, for flows. `proposeFlow` makes one-factor moves
  from a flow's own runs and shape (no model, no randomness): add a check, run
  independent agents in parallel, raise or lower a loop's maximum, retry,
  remove what does nothing. **Compare** runs two versions on the same saved
  cases, K ≥ 3, paired, and `gate()` from `lib/harness/evolve/gate.ts` gives
  adopt, canary, hold or reject. Adoption is the person's click.
- **Why not a scored model judge.** KRHE §2: code over recorded outcomes
  closes the reward-hacking route. A run "passes" only when it completes and
  every check that ran passed.
- **Can't change.** No move touches a guard, approval or limit: no field
  exists for them (E3).
- **Limit.** With fewer than 10 pairs the gate says `hold`. Most comparisons
  people can afford will read `hold`, and the screen says why.

### SD-14 Device flows: a plan and a profile, through the Control Center

- **Decided.** A device flow compiles to a Loop v2 plan (at most 7 steps,
  `after` pointing back) and a `HarnessProfile`, and is sent as the existing
  `run` action. New optional fields carry the plan and profile. The client
  saves the person's plan as written, so the model can't rewrite it. The daemon
  reports step status, which becomes node rows. The prompt still states the
  plan, so an older client degrades to asking the model to follow it.
- **Follows.** Checks are still the project's confirmed check; a graph can't
  name a command (CC-D1). Modes and approvals are unchanged.
- **Loop v2 and KRHE stay authoritative.** Studio edits their inputs; it adds
  no second loop. See `KRIYA_LOOP_V2.md`, `RECURSIVE_HARNESS_EVOLUTION.md`.

### SD-15 Canvas: React Flow with ELK, fixed node sizes

- **Decided.** `@xyflow/react` for interaction; `elkjs` for layered layout
  with port order and orthogonal routes, loaded only on Flows pages. Nodes have
  fixed sizes, so layout needs no DOM measuring and is deterministic. Positions
  are stored, so manual and automatic layout coexist: **Tidy** replaces
  positions in one undoable step. Moved nodes route by a local orthogonal path
  until the next Tidy.
- **Evidence.** `COMPETITIVE_RESEARCH.md` §5.

- **Changed after seeing it (2026-11-05).** The first build ran left to right.
  In the column between the sidebar and the inspector (about 630 px at 1280),
  a six-step flow zoomed out until no card could be read. Layout is now **top
  to bottom**: flows are mostly chains and that column is tall. The good path
  leaves a card from its centre, so a chain is one straight line; the other way
  out sits to the right. Automatic fit stops at 55 % and pans beyond that.

### SD-16 Phones inspect and approve; desktops author

- **Decided.** Below 768 px the editor is an Outline; runs are a vertical
  timeline with the approval buttons at the top; the graph opens read-only.
  Dragging wires on 360 px isn't useful authoring. A phone can still describe a
  flow with the copilot and run it.

### SD-17 Limits live on existing rails, plus three settings

- **Decided.** Every agent node goes through `prepare()`: plan, daily tasks,
  per-task cap. New: `studio.maxNodeRuns`, `studio.maxConcurrentNodes`,
  `studio.dailyRuns`. A run's own ₹ cap shares what's left across open nodes
  (the crew pattern). No new plan column yet: Flows runs on any plan, and the
  plan's existing limits bound it.

## 3. For the owner

| Id | Question | Default until answered |
| --- | --- | --- |
| SO-01 | Turn `studio.flows` on in production? | Off |
| SO-02 | Should Flows be limited by plan? | Plan's task limits apply; no flow-specific plan field |
| SO-03 | Apply the migration to production | Not applied |
| SO-04 | Approve the `lib/agent/tools.ts` marker change (SD-11), stricter only, protected by track A | Approved by the owner; merged in PR #12 |
| SO-05 | Fix the crew report taint gap (SD-11 finding) | Fixed in PR #15 and the same-turn follow-up |
| SO-06 | Release the client with the Graph tab and seeded plans | Not published |
| SO-07 | Accept `elkjs` under EPL-2.0 (unmodified, its notice in `NOTICE.md`) | In the working tree |
| SO-08 | First paid Compare run to validate the loop on a real model | Not run |
| SO-09 | Each flow step raises the "finished" notification, so a long flow is noisy. The fix is one filter in `app/api/events/route.ts`, protected by track A | Left as it is |
