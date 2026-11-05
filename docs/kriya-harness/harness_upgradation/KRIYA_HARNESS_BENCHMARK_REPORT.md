# Kriya Harness benchmark report (H21)

> [!IMPORTANT]
> These are **mechanics on a scripted model**, not capability. The real pinned
> DSH, real git repositories and real check commands ran; the model was a script
> that behaves the same in every arm. They show what the harness does with a given
> behaviour. They say nothing about how often a real model behaves that way, so
> they do not show a real-model pass-rate gain.

## 1. Setup

| Item | Value |
| --- | --- |
| Before | Clean checkout of client `08f4f66` (worktree `../kriya-harness-base`), `--loop` |
| After, off | Upgraded client, `--loop` |
| After, on | Upgraded client, `--loop --loop-guard` |
| Model | Scripted (`tests/guard-scenarios.js`), same in every arm |
| Runs | K = 3, interleaved before, off, on; every arm identical across runs |
| Spend | ₹0, no model called |
| Raw reports | `bench/guard-m1-{before,off,on}-{1,2,3}.json` |
| Command | `node scripts/bench-guard.js [--client <checkout>] [--guard] --out-prefix <path>` |

## 2. Results

Median of three; every value below was the same in all three runs except
durations.

| Scenario | Arm | Task done | Session says | Builders | Model requests | Prompt chars |
| --- | --- | --- | --- | --- | --- | --- |
| premature-stop | before | 0/3 | **verified** (false) | 1 | 5 | 42k |
| | off | 0/3 | partial | 1 | 5 | 42k |
| | on | **3/3** | verified | 3 | 13 | 115k |
| no-change | before, off | 0/3 | blocked | 4 | 7 | 64k |
| | on | 0/3 | blocked | **2** | **5** | **42k** |
| env-missing | before, off | 0/3 | blocked | 4 | 11 | 98k |
| | on | 0/3 | blocked | **2** | **7** | **61k** |
| provider-error | before, off | 0/3 | blocked | 4 | 7 | 63k |
| | on | **3/3** | verified | 5 | 11 | 98k |
| crash-resume | before, off | 3/3 | verified | 4 | 11 | 97k |
| | on | 3/3 | verified | **3** | **9** | **79k** |

| Total over 15 runs | Before | Off | On |
| --- | --- | --- | --- |
| Tasks done | 3 | 3 | **9** |
| False "verified" | **3** | 0 | 0 |
| Plans left unfinished | 3 | 3 | **0** |
| Builders | 51 | 51 | 45 |
| Check runs | 48 | 48 | 36 |
| Model requests | 123 | 123 | 135 |
| Prompt chars | 1,090k | 1,090k | 1,181k |
| Requests per task done | 41 | 41 | 15 |
| Wall time of all runs | 28.9 s | 28.7 s | 30.7 s |

Reading it straight:

- **Off equals before** in builders and requests in every scenario, and in prompt size but for the corrected verdict word.
  The only difference is the corrected verdict, 3 false claims → 0.
- **On costs more in total, and that is the point.** +10% requests, because six
  tasks that were abandoned or blocked now get finished. On the two scenarios that
  can never pass, requests fall 29% and 36%.
- Paired on done tasks: only-before 0, only-on 6, p = 0.031. That p-value is about
  a script and is **not** real-model evidence.
- Fault-free runs were not separately measured beyond these; the guard's fixed
  cost is one checkpoint per builder, about 92 ms on a 1,644-file clone (first one
  140 ms). That also closes the audit's open timing question.

## 3. Scenario 7: KRHE on recorded trajectories

Run on the reports above, with no model. Nothing was written to `krhe/lessons.json`.

```text
$ propose --reports <before ×3>
Incumbent 505293a6e9bc; failure signals {"failed":12,...,"unfinished":3,"blocked":9,"falseVerified":3}
dec29070675e (loop-guard-on, signal 36): loopGuard false → true
7edcb0e0b889 (loop-v2-on, signal 24): loopV2 false → true
$ evaluate --incumbent <before ×3> --candidate <on ×3>
CANARY: dec29070675e against 505293a6e9bc
  - cost per passed task unknown in one arm (unmetered runs)
  - gain shown: only-candidate 6 vs 0, p = 0.031
```

The loop works end to end: records → proposal → paired gate. It read `canary`, not
`adopt`, because no spend was metered: the gate refused to promote without cost
evidence, as designed.

## 4. Coverage of the brief's eight scenarios

| # | Scenario | Measured here | What's missing |
| --- | --- | --- | --- |
| 1 | Visual design | **No** | A rendering grader and a paid run; `kriya-visual` is untested on a model |
| 2 | Full-stack | No new run | KriyaBench `multi` exists; needs a paid run |
| 3 | Complex debugging | No new run | `hard`, `cap` exist; last measured 2026-11-04 (B4 18/21) |
| 4 | Long horizon | Mechanics: premature-stop; HU-M-11 still passes | Paid long-horizon arms |
| 5 | Research | **No** | No grader exists; `kriya-research` is untested on a model |
| 6 | Browser automation | Existing WP-BR-RUN only, unchanged | Multi-stage real-model run |
| 7 | Self-improvement | **Yes**, §3, scripted evidence | Real-model evidence; capability extraction not built |
| 8 | Recovery | **Yes**, mechanics: crash-resume, provider-error; HU-M-05/07 still pass | Real outage |

Task success, verified success and recovery are measured above for the scripted
model only. Tokens, API cost and human intervention were **not** measured: there
is no real model, and prompt characters are only a proxy.

## 5. Regression

| Check | Before | After |
| --- | --- | --- |
| Client `npm run check` | 300/300, exit 0 | **323/323, exit 0** (seams 10/10, pins, notices, brand) |
| Client `npm run release:check` | not run | ok |
| Kriya `npm run check` | 3093 passed, 63 skipped, exit 0 | **3102 passed, 63 skipped, exit 0** |
| Lint | 0 errors, 8 warnings | 0 errors, 8 warnings |
| `npm run build` (`verify:guard` OK) | not run | Compiled, exit 0 |
| Real-model benchmark | B4 18/21 (2026-11-04) | **Not re-run** |

## 6. The run that would answer the question

B4 against B4 + `--loop-guard`, same seed, same model, K = 3 interleaved, cap and
multi sets, with `--meter` and `--status`. Estimated ₹130–200 by the method in
`KRIYA_LOOP_V2.md` §8. It needs the owner's go-ahead and a bench device.
