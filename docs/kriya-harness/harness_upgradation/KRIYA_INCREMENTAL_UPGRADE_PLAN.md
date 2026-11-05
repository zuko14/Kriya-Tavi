# Kriya Harness: incremental upgrade plan

From `KRIYA_EXISTING_ARCHITECTURE_AUDIT.md` and
`KRIYA_HARNESS_RESEARCH_AND_GAP_ANALYSIS.md`. Phase id **H21** (track HU). Rules:
AGENTS.md track H, `harness_upgradation/CHANGE_IMPACT_AND_SAFETY.md` (§2g lists
every file below).

**Classes.** 1 immediate optimization · 2 extension of a component · 3 missing
capability integrated into the architecture · 4 optional future · 5 unnecessary.

## 1. Ranking

Each item scored 1–5 on gain, reliability and reach, and on complexity and
regression risk (lower is better). The order follows the evidence: defects
reproduced first, hints last.

| # | Improvement | Class | Gain | Reliability | Reach | Complexity | Risk | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Honest verdict: `partial` (HU-F-30) | 1 | 5 | 5 | 5 | 1 | 1 | Build, default on as a correction |
| 2 | Send back an unfinished plan (HU-F-31) | 2 | 5 | 4 | 4 | 2 | 2 | Build, `--loop-guard` |
| 3 | Infrastructure errors aren't attempts (HU-F-34) | 2 | 3 | 5 | 3 | 2 | 2 | Build, `--loop-guard` |
| 4 | Stop builders that can't help (HU-F-32/33) | 2 | 3 | 3 | 4 | 2 | 2 | Build, `--loop-guard` |
| 5 | Failure survives a resume (HU-F-35) | 2 | 3 | 4 | 3 | 2 | 1 | Build, `--loop-guard` |
| 6 | Run evidence into the bench and KRHE (HU-F-36) | 3 | 4 | 3 | 4 | 2 | 1 | Build |
| 7 | `kriya verify status` (HU-F-37) | 3 | 3 | 3 | 4 | 1 | 1 | Build |
| 8 | Gate refuses more false claims | 2 | 3 | 4 | 3 | 1 | 1 | Build |
| 9 | Way of working per intent | 2 | ? | 2 | 4 | 1 | 1 | Build behind `--router` (already off); unmeasured |
| 10 | Three native skills | 2 | ? | 2 | 3 | 1 | 1 | Build behind `harness.defaultSkills` (already off) |

Not built, with the reason in the gap analysis §3:

| Item | Class | Why |
| --- | --- | --- |
| Trajectory-based skill extraction | 4 | Needs real paired trajectories; #6 starts collecting them |
| KRHE-4 guidance as data | 4 | Prompt text edits need the paid probe loop first |
| KRHE-5 one-command probing | 4 | Only useful with paid runs |
| Parallel DAG, beam search, recursion | 4 | Spend and race risk, no evidence of gain |
| Ping-pong detection | 4 | No recorded case; false-positive risk (R-62) |
| New memory or context store, second loop, per-domain runtimes, LLM critic | 5 | Existing components hold, or exit codes are stronger |

## 2. Module map

```mermaid
flowchart LR
  subgraph Client
    V[src/verify.js verdict, status] --> L[src/loop.js runStep]
    L --> P[plugins/loop finishHook]
    I[src/intent.js router]
  end
  subgraph Kriya
    B[lib/harness/bench status, evidence] --> G[evolve gate]
    B --> O[evolve propose]
    S[skills-harness]
  end
  V -- kriya verify status --json --> B
  O -- profile loopGuard --> L
```

## 3. Dependencies and order

1. Verdict and `stepLabel` move (everything reads the verdict).
2. Guard in `verifyStep`, then `runStep`, then the hook and the switch.
3. `trajectory`, `sessionReport`, the CLI.
4. Kriya: profile field, contract, bench, gate, proposer.
5. Router and skills: independent, last.
6. KriyaBench-M arms: before (clean `08f4f66`), off, on.

## 4. Migration and compatibility

| Risk | Handling |
| --- | --- |
| `partial` is a new verdict value | Readers are the Progress tab (label added; unknown values print raw) and tool text. Flows reads step rows, not the verdict |
| Recorded KRHE profile ids and lessons | `loopGuard` is left out of the id when off; test pins B4's `39c148271e98` |
| Stored flow graphs and profiles | Field defaults to false on parse |
| Older daemon, newer server | `KRIYA_LOOP_GUARD` sent only when on; the contract field is optional |
| Older client with bench `--status` | Prints no JSON → `trajectory` null, report unchanged |
| Progress files from older clients | Every new field optional; `trajectory()` treats absence as zero |
| Rollback | Guard: don't pass the flag. Verdict: revert one function. No migration, no setting, no contract break |

## 5. What needs the owner

Default-on for the guard; any paid KriyaBench-R run; commit, push, release.
None is done here.

Proposed paid run, using the existing arms: B4 vs B4 + `--loop-guard`, K = 3 on
the capability and multi sets, interleaved, with `--status`. Estimate by
`KRIYA_LOOP_V2.md` §8's method: ₹130–200.
