# Evaluation plan (track C)

What is measured, on which workloads, with which pass thresholds, and how
the laptop-off proof is run. Every paid run (provider, model, GitHub on a
real repository) needs the owner's go-ahead in the session (voice rule 5
applied to this track). Results go into `status.md` with real numbers.

## 1. Metrics

| Id | Metric | Source |
| --- | --- | --- |
| M1 | Cold start: `workspace_open` call → runner healthy (no import) | `TaskWorkspace` timings logged per call |
| M2 | Resume: paused → runner healthy | same |
| M3 | Runner round trip from the worker region (p50, p95) for `read` | same |
| M4 | Import time and bytes; restore time; checkpoint bytes and time | same |
| M5 | Model tokens and charge per task | `usage_events`, `charges` |
| M6 | Compute seconds per task; CPU and RAM peak/average | `workspace_sessions`; provider metrics |
| M7 | Tool calls and retries per task; repeat-command notes fired | `tool_executions` |
| M8 | Worker slot time per task | task `started_at` → `finished_at` |
| M9 | Outcome: target test passes in the workspace (from the final `workspace_run` exit code, checked by a script, not the model's words) | `tool_executions` |
| M10 | Human correction time (minutes the owner spends fixing the result) | Owner's note per run |
| M11 | Cost per successful task in INR (PROVIDERS_AND_COST §4) | Derived |

## 2. Workloads

| Id | Repository | Ask | Success |
| --- | --- | --- | --- |
| W1 | The fixture Node repository pushed to an owner-controlled test repository (one failing unit test) | "Fix the failing test in <repo> and show me the test output." | Target test passes; no other test broken |
| W2 | An owner-chosen public JavaScript/TypeScript repository of a few thousand files with `npm install` | "Add a `--version` flag to the CLI with a test." | New test passes; existing suite passes |
| W3 | An owner-chosen small Python repository with `pip install` and `pytest` | "Fix the bug in <function> described in <issue text>, add a test." | New and existing tests pass |

The owner picks W2 and W3 repositories (public, permissive licence) and
writes them into `status.md` before C8 runs; they don't change between
providers.

## 3. Bake-off protocol (C8)

1. Staging only (never production), dedicated plan with
   `workspace_minutes` set and a small `max_task_cost_micro_usd`.
2. Same model and tier for all runs (owner picks, CD-24); same prompts.
3. Per provider: 10 runs of each workload (30), sequential; then 5
   concurrent W1 runs for M1/M2 under load.
4. Kill drill on 3 runs per provider: destroy the sandbox mid-task through
   the provider console; the next workspace call must restore (CT-WS-07 live).
5. Record M1–M11 per run in a table in `status.md`; raw timings stay in the
   logs.

## 4. Thresholds for choosing the provider

| Criterion | Threshold |
| --- | --- |
| M1–M10 must-haves (PROVIDERS_AND_COST §1) | All met from documentation and CT-ISO on a test sandbox |
| M1 cold start p50 | ≤ 10 s |
| M2 resume p50 | ≤ 5 s |
| M3 round trip p50 / p95 | ≤ 150 ms / ≤ 400 ms |
| M9 success rate on W1 | ≥ 9/10 (the model's ability is shared, so a gap points at the provider) |
| Kill drill | 3/3 restored, no corrupted task state, no duplicate side effect |
| Cost | Lowest M11 among candidates meeting everything above |

## 5. Laptop-off proof (C10, CR-4, CT-E2E-01)

1. Staging deployment with the chosen provider; the owner's phone (mobile
   Chrome) and a laptop.
2. On the phone: start W1 in a new thread; watch the first command card.
3. Close the browser on the phone and shut the laptop.
4. Wait for the plan's deadline window. Check from a different device:
   the thread shows the final reply, the command cards, the change set and
   the publish approval in the Inbox.
5. Evidence recorded: task row (`started_at`, `finished_at`, `status`),
   `workspace_sessions` rows, `tool_executions` count, screenshots of the
   thread on the second device. No claim without these.
6. Approve the publish on the phone; the draft PR exists on GitHub (read
   back) and the task that published isn't retried.
7. Cross-tenant check on staging: a second test account opens a workspace;
   neither account's thread, strip, owner rows or sandbox reaches the
   other's (CT-ISO-02 live, CT-WS-08 live).
8. Failure drill: kill the worker during step 4 of a second run; the task
   resumes on the new worker and finishes or fails cleanly with no
   duplicate publish (CR-5).

## 6. What isn't measured yet (recorded unknowns)

- Real-world success rate on owners' own repositories (pilot, C11).
- Behaviour on monorepos above `cloud.maxImportMb` (refused in v1).
- Long tasks across several turns (CD-17); measured in the pilot.
