# Kriya Harness upgrade report (H21)

What was built on 2026-11-05 from the owner's "existing architecture
intelligence" brief, and what was found while building it. Evidence is in
`KRIYA_HARNESS_BENCHMARK_REPORT.md`; defects are numbered in
`KRIYA_EXISTING_ARCHITECTURE_AUDIT.md` §5.

**Nothing here is committed, pushed, released or deployed. No model was called
and no money was spent.** Client changes sit uncommitted in the detached worktree
`../kriya-harness-evolve` (at `08f4f66`); Kriya changes sit uncommitted on `main`.

## 1. What changed

| Change | Closes | Default | Where |
| --- | --- | --- | --- |
| Verdict counts the plan; new status `partial` | HU-F-30 | **On, for everyone** | `src/verify.js` `verdict` |
| Unfinished plan sent back at turn end | HU-F-31 | Off, `--loop-guard` | `plugins/loop` `finishHook`, `src/loop.js` `nextStep` |
| Same failure, no file changed: stop | HU-F-32 | Off, `--loop-guard` | `src/loop.js` `runStep`, `markStalled` |
| Check can't run (exit 126/127) twice: stop | HU-F-33 | Off, `--loop-guard` | same |
| Builder error before any change isn't an attempt | HU-F-34 | Off, `--loop-guard` | same, `MAX_INTERRUPTIONS` = 2 per step |
| Failure text survives a resume | HU-F-35 | Off, `--loop-guard` | `verifyStep` keeps ≤ 2,500 chars; `runStep` seeds the builder |
| "Same failure again" note to the next builder | HU-F-32 | Off, `--loop-guard` | `runStep` |
| `kriya verify status [--session] [--json]` | HU-F-37 | Always there | `bin/kriya.js`, `sessionReport` |
| Run numbers in the session record | HU-F-36 | Always recorded, never shown to a model | `progress.builders`, `trajectory()` |
| Bench `--status`, `evidence` per arm | HU-F-36 | Opt-in flag | `lib/harness/bench/*` |
| Gate: more false "verified" claims can't be adopted | R-63 | Applies when reports carry records | `lib/harness/evolve/gate.ts` |
| Proposer reads records; move `loop-guard-on` | HU-F-36 | Offline tool | `lib/harness/evolve/propose.ts` |
| `loopGuard` profile field | | Default false | `profile-schema.ts`, `profile.ts`, `contract.ts`, `src/daemon.js` |
| Way of working per intent; research and data intents; small-change hint | Brief §4.1, 4.3 | Off, `--router` | `src/intent.js` |
| Skills `kriya-visual`, `kriya-research`, `kriya-migrate` | Brief §6 | Off, `harness.defaultSkills` | `skills-harness/` |

## 2. The one default-on change

The owner's rules say new capability ships behind a switch that defaults off.
`partial` does not, and that was a deliberate call: it is a correction, not a
capability. Before it, `kriya_step` told the model "Session verdict so far:
verified" after step 1 of 3, and an existing test pinned that. It adds no prompt,
tool or model call; it changes one word in a tool result and in the Progress tab
when a multi-step plan is unfinished. If the owner prefers it behind the switch,
`verdict()` is one condition.

## 3. Design decisions

| Decision | Why |
| --- | --- |
| One switch for the guard's parts | KRHE moves are one factor; each part alone is too small to measure on a 7-task set |
| Guard includes failure classes and excerpts from loop v2 | The stall test needs a signature; reusing `failure.js` beat a second classifier. Without v2's originals re-run, set-aside or rules |
| "Can't run" means exit 126/127 only | First version used the `environment` class, but that includes ENOENT and missing modules, which can be the code's own bug. Found in self-review; LG-ST-05 pins it |
| Snapshot through `checkpoint`, not `workTree` | Works outside git (the shadow store), and sees untracked files |
| A builder error never counts as stalled | An outage says nothing about the code; attempts simply run out |
| Finish notice once per step reached | Bounded by the plan (≤ 7 per turn), yet a lazy model that stops again after making progress is still caught |
| `kriya_verify` labelled `all` doesn't cover a plan | One pass of a project-wide check after step 1 would otherwise read verified. Cost: work done outside `kriya_step` under a plan reads `partial` |
| `loopGuard` left out of the profile id when off | Keeps B4's `39c148271e98` and every lesson valid; tested against the stored `b4.json` |
| Sent to the daemon only when on | An older daemon refuses names it doesn't know |
| Scripted evidence kept out of `krhe/lessons.json` | Lessons are for real-model evidence |

## 4. Preserved unchanged

The Kriya loop's shape and bounds (7 steps, 4 attempts, 3 plans), the graph and
Flows engines, the provider abstraction and gateway, DSH (no edit, same pin, 10
seams pass), tools and their schemas, guidance text, memory, risk classes,
approvals, modes, sandbox, spend reservation, `lib/improve.ts`, every setting,
every migration. With the guard off, a run spends exactly the same builders,
requests as `08f4f66` in all five scenarios.

## 5. Tests

| Id | What | File |
| --- | --- | --- |
| LG-VD-01 | A pass doesn't verify an open plan | client `tests/loop-guard.test.js` |
| LG-ST-01…05 | Stall rules, and what must not stall | same |
| LG-IN-01/02 | Interruptions and their limit | same |
| LG-RS-01/02 | Resume; nothing stored when off | same |
| LG-FN-01/02 | `nextStep`, the finish hook's bounds | same |
| LG-TR-01/02, LG-SW-01, LG-PR-01 | Records, switch, prompt unchanged | same |
| LG-RUN-01…05 | The five scenarios, off and on, on real pinned DSH | client `tests/loop-guard-run.test.js` |
| IR-06/07 | Way of working, small-change hint | client `tests/intent.test.js` |
| WP-PG-01 (changed) | It asserted the defect; now partial, then verified | client `tests/progress.test.js` |
| HU-EV-08 | Ids stable, contract, proposer, gate honesty | `tests/harness/evolve.test.ts` |
| HU-BEN-05 | Status parsing, reader, `falseVerified` | `tests/harness/bench-stats.test.ts` |
| HT-DS-01 (changed) | Ten skills → thirteen | `tests/harness/default-skills.test.ts` |

## 6. Mistakes made and fixed along the way

- The first stall rule used the `environment` class (see §3).
- The interruption counter kept counting past its limit (LG-RUN-04 caught it).
- `bench-guard.js` passed a relative client path, so the first "before" arm
  failed in 27 ms per scenario. Those numbers were thrown away.
- Blocked scenarios were first reported as "not checked" by the bench script.
- The three new `kriya.json` files failed `format:check` on the first full run.
- Two arms were discarded and every number was re-recorded on the final code.

## 7. Limits

- **Real-model gain is unknown.** Everything measured is mechanics.
- The Progress tab's `partial` was confirmed through the running Web UI's route
  (HTTP 200, `{"status":"partial"}`). The tab itself wasn't seen rendered: a
  headless session isn't listed in the sidebar. So the 360 px, light and dark
  screen check for this one label is still owed.
- Flows' inspector doesn't offer the guard; a flow can't turn it on from the UI.
- A check that writes files between attempts can hide a no-change attempt (it
  fails safe: more builders, as before).
- `kriya run`'s exit code is still DSH's; use `kriya verify status` for the verdict.
- Skill extraction from trajectories, KRHE-4…7 and parallel steps are not built.

## 8. Next, in order

1. Owner review; say whether to commit (branch names are the owner's).
2. Paid run: B4 vs B4 + `--loop-guard`, K = 3, cap and multi sets, with `--status` (₹130–200 estimated).
3. On that evidence, the owner decides default-on.
4. Grow the capability set toward 30 tasks; it is still 7.
5. With real trajectories, start skill proposals (contrastive pairs, R-68) through the same gate.
