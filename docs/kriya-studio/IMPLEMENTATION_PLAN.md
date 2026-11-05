# Implementation plan (track S: Flows)

Order differs from the brief's: the runtime comes before the editor, so the first
screen shows real runs. Progress and results live in the root `status.md`.

| Phase | Content | Exit check |
| --- | --- | --- |
| S0 | Recon, research, decisions, these documents | Reviewed by the owner |
| S1 | `graph.ts`, `compile.ts`, `engine.ts`, tests | ST-G, ST-E pass; random-graph termination |
| S2 | Migration, RLS, schema, settings, actions, queries | ST-RLS; down/up |
| S3 | `run.ts`, worker loop, taint marker | ST-RUN, ST-TAINT, ST-GATE, ST-RETRY on PGlite with the scripted model |
| S4 | Editor, canvas, layout, inspector, run page, Inbox | Browser check on the verify stack |
| S5 | Copilot | ST-COP; stub-model browser run |
| S6 | Device flows, client Graph tab | ST-DEV; client `npm run check` |
| S7 | Improve, Compare | ST-IMP; gate on recorded runs |
| S8 | Benchmarks, regressions, status | §Benchmarks below; `npm run check`, build |

## Release gates

| Stage | Needs |
| --- | --- |
| Off (shipped dark) | `npm run check`, build, ST-REG green; migration applied by the owner |
| Beta for the owner's account | Stub run on the verify stack; one real-model run with the owner's go-ahead; SO-04 |
| Beta for customers | Five watched sessions on journeys 1, 2, 5; external review of S4 and S12 |
| GA | Retention decided; SLO data from beta (below) |

Measured criteria for GA, not promises: run completes or fails with a stated
reason in ≥ 99 % of runs, no duplicate side effects, node start within 5 s p95.

## Benchmarks

`tests/flows/bench.test.ts` on PGlite with a scripted task finisher: sequential,
branch, parallel, loop, failure and repair, gate, resume after a lost worker, and
a high-concurrency case. Baseline: the same work as one crew dispatch, where
comparable. Model cost and quality need real models, so those stay open (SO-08).

## After release 1

Triggers (schedule first, through `lib/schedules.ts`), shared templates, import
and export, sub-flows, per-node model tier (a `queue.ts` change), OTel export,
retention, plan fields.
