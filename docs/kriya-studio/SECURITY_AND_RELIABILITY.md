# Security and reliability (track S: Flows)

The frontend is never the boundary: a graph is untrusted input, and everything
below is enforced on the server or in SQL.

## 1. Invariants kept

| Invariant | How |
| --- | --- |
| 1 Tenant isolation | Person's reads and draft writes through `withUser`; `kriya.flow*` have RLS; worker writes are privileged and scoped by user id |
| 2 Kriya schema, RLS, tests | New tables in `kriya`, one migration, `tests/db/flows-rls.test.ts` |
| 3 Identity from the session | `requireUser` in every action and route; the run's owner never comes from the browser |
| 4 Secrets | A graph holds none; no field for one; connected accounts stay in `lib/connectors.ts` through the agent's tools |
| 5 Agents act through tools | Nodes run `runTask`; no tool node; no side effect on the web server |
| 6 Money integers | Micro-INR in `bigint`, conversion through `capToProviderMicroUsd` |
| 7 Limits on the server | `prepare()`, `studio.*`, SQL size checks |
| Track A 3 | Risk classes unchanged; no flow field reaches them; a flow has no grants |
| Track A 7 | "What I did" still from tool executions; check `tool_ran` reads the same rows |
| Track A 11 | Answering a gate is the person's alone: no agent tool, session only |
| Track O 5, N 3 | A flow's verdict is computed by code from rows, never model text |
| Track N 9 | Automatic retry only with no side effect recorded |
| Track C 3 | One orchestrator: the Postgres queue and `runTask` |

## 2. Threats

| # | Threat | Control | Test |
| --- | --- | --- | --- |
| S1 | Tampered or huge graph | Strict zod, 60 nodes, 120 edges, 4,000-char fields, SQL size check | ST-G |
| S2 | Infinite loop, runaway spend | Structured regions, W(G) cap, no-progress stop, run deadline, per-task and ₹ caps | ST-E |
| S3 | Someone else's agent, run or flow id | Agents checked as the person; `enqueuePart`'s `prepare` reads through RLS; run ids resolve under RLS | ST-RLS, ST-RUN |
| S4 | Private content leaving through a downstream node | `FLOW_PRIVATE` marker (SD-11) | ST-TAINT |
| S5 | Prompt injection through upstream output | `FOREIGN` notice, `FLOW_CONTEXT`, memory unconfirmed, briefs can't pick skills (crew channel) | ST-TAINT |
| S6 | Injected text drives a branch | Checks are code over values; a branch can move control only along paths the person drew; nothing escalates | Reasoned |
| S7 | Approval bypass | Tool approvals are unchanged per call; gates need a session; expiry is decline; an agent can't answer | ST-GATE |
| S8 | Hanging the worker with a pattern | No regular expressions in rules | ST-G |
| S9 | Re-running real actions by accident | Automatic retry refuses after side effects; Re-run lists them first | ST-RETRY |
| S10 | Model output in copilot | Same validator; agent ids must be the person's; preview only | ST-COP |
| S11 | Copilot cost | Rate limit, daily cap, usage recorded in `resource_usage` | ST-COP |
| S12 | Device flow runs a command | The graph has no command field; the check stays the project's confirmed check (CC-D1); folders are offered by the computer (CC-D2); Full access stays `--allow-full-access` (CC-D3) | ST-DEV |
| S13 | Profile escalation | `HarnessProfile` is strict, and has no protected field (E3) | HU-EV-01 |
| S14 | SSRF | No node takes a URL; web access only through agent tools and their guards | Reasoned |
| S15 | Version tampering | `flow_versions` immutable by trigger; no update or delete policy | ST-RLS |

## 3. Reliability

| Need | Design | Test |
| --- | --- | --- |
| Crash recovery | State in rows; passes idempotent; lease expires | ST-RUN |
| Duplicate work | Unique node-run key; `enqueuePart` key per attempt | ST-RUN |
| Two workers | Lease on `flow_runs` | ST-RUN |
| Cancel | Run canceled; each active task through `cancelThreadTask`; pending approvals expire | ST-RUN |
| Timeout | Run deadline 48 h; task deadlines unchanged | ST-RUN |
| Retry classes | Infra retries stay in the queue; node retry needs no side effect | ST-RETRY |
| In-flight version | Pinned version row, immutable | ST-RUN |
| Backpressure | At most `studio.maxConcurrentNodes` per run; 50 runs a pass, oldest first; `studio.dailyRuns` per person | ST-RUN |
| Worker down | `prepare()` refuses to start; run shows the failure | ST-RUN |
| Feature off mid-run | The loop stops advancing; rows wait; nothing is lost | Reasoned |
| Retention | Rows stay with the account; deleted with it by foreign key. No separate retention yet (open) | — |

## 4. Rollback

Turn `studio.flows` off: the nav, routes and loop stop; existing behaviour is
unchanged (ST-REG). `supabase/rollback/20270901000000_flows.down.sql` removes the
tables; threads and tasks made by flows stay with the person.
