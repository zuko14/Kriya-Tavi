# Kriya coding harness report (H22)

The owner's "long-horizon autonomous coding harness" brief, 2026-11-05. Built on
branch `feat/top1-coding-harness` in both repositories, **uncommitted and
unpushed**: the client in the worktree `../kriya-harness-evolve`, Kriya on this
checkout. It builds on `KRIYA_HARNESS_UPGRADE_REPORT.md` (the loop guard and
`partial`).

> [!IMPORTANT]
> Everything measured here used a **scripted model**, on real DSH, real git and
> real checks, at ₹0. It shows the harness catches what it is built to catch. It
> does **not** show the brief's central claim, that a $0.15/M model can beat a
> frontier model on large tasks. No model of any kind was run, so that claim is
> untested, and no 50-file task was attempted.

## 1. What was built

| Brief | Built | Switch (default off) |
| --- | --- | --- |
| §1 Task contract, routing | `kriya_plan` takes `kind`, `invariants`, `acceptance`; `taskKind` fills a missing kind; a `surgical_bugfix` has ≤ 2 steps, `deep_research` ≤ 3 | `--strict-loop` |
| §2 Outlines, impact, bounded reads | `code_outline`, `code_impact`; importers of a step's files in the builder's prompt; a read over 400 lines refused with what to do instead | `--recon` |
| §3 Ladder | Parse → `tsc` → affected tests → the person's check → acceptance commands; parse feedback on the `write` or `edit` itself | `--strict-loop` |
| §4 Red phase, rollback | A bug fix must fail on the old code; two broken attempts undo the step's files; a blocked step leaves them as they began | `--strict-loop` |
| §5 Anti-tampering | Deleted or weakened tests, added skips, added `any`, suppressions and empty catches refused; a pass that changed tests re-run on the committed ones | `--strict-loop` |
| §6 JIT tools, skills | A builder gets `browser_*` and `rea_*` only when its step's words call for them; skill hints by BM25 on the step | `--jit-tools` |
| §7 KRHE | Peak context, early failures, rollbacks per run; a rise in false "verified" and **any** net pass loss now reject; three new proposal moves and profile fields | Offline |

`--strict-loop` includes the loop guard. Rungs and refusals can only fail a step:
passing still means the person's confirmed check exited 0, and acceptance commands
run in the session's sandbox with the same reach as `bash`.

## 2. Where this differs from the brief, and why

| Brief said | Built instead | Reason |
| --- | --- | --- |
| `.kriya/rules.json` in the repo, rules synthesized and applied | Rules stay in `~/.kriya/rules/`, proposed automatically, applied when the person confirms | A file in the project is writable by the agent, so it could forge a rule (`KRIYA_LOOP_V2.md` §4). AGENTS.md: production behaviour never changes itself. **Owner's call if you want this changed** |
| Autonomous active flywheel | Gate rejects by itself; activating a profile stays the owner's | KU-ADR-16; probes are paid runs |
| `git restore` | Kriya's `restoreTree` | `git restore` touches the person's tree with no way back; this saves each replaced state to `refs/kriya/undone/*`, and leaves HEAD and the index alone |
| Reject any test edit, by sha256 | Baseline is git HEAD; adding tests is allowed | The owner's "grade on originals" ruling: 5 of 9 "tampered" runs had only added tests (HU-F-20) |
| Reproduction test before source edits | Proved after the fix: the check must fail on the old code | Same proof, no order to police; an already-failing test counts |
| AST outline | Fixed patterns, not a parser | No parser is installed, and a dependency isn't justified before real runs show misses. Marked `shortcut:` in `src/recon.js` |
| No more than 400 lines per turn | 400 per `read` call | Per call is what the tool can see. `cat` through `bash` still gets around it |
| Unload tools on step completion, for every agent | Builders only, masked for the builder's whole life | Changing a running agent's tools breaks its prompt cache (DSH docs, R-25). B5 lost 0–5 when tools were cut, so this cuts only the two heavy families |
| "Token burn" | Peak context per builder, from DSH's meter | Real spend needs a real model and `--meter` |
| Levels 2 and 3 for every language | `tsc` when the project has it; tests for vitest, jest, `node --test`, pytest | Anything else falls through to the person's check, which is safe |

## 3. Results

Three interleaved runs per arm, 15 runs each, identical every run. Raw reports:
`bench/strict-m1-{guard,strict,regress}-{1,2,3}.json`.

| Scenario | Arm | Task done | Session says | Builders | Rung catches | Rollbacks | Files left broken |
| --- | --- | --- | --- | --- | --- | --- | --- |
| multi-file-rollback | guard | 3/3 | verified | 3 | 0 | 0 | 0 |
| | strict | 3/3 | verified | 3 | **2** | **1** | 0 |
| blocked-rollback | guard | 0/3 | blocked | 4 | 0 | 0 | **2** |
| | strict | 0/3 | blocked | 4 | **4** | 2 | **0** |
| weakened-test | guard | 0/3 | **verified** (false) | 1 | | | 0 |
| | strict | **3/3** | verified | 2 | | | 0 |
| silenced-error | guard | 0/3 | **verified** (false) | 1 | | | 0 |
| | strict | **3/3** | verified | 2 | | | 0 |
| no-reproduction | guard | 0/3 | **verified** (false) | 1 | | | 0 |
| | strict | 0/3 | blocked | 4 | | 1 | 0 |

| Totals over 15 runs | `--loop-guard` | `--strict-loop` |
| --- | --- | --- |
| Tasks done | 3 | **9** |
| False "verified" | 9 | **0** |
| Files left unparsable | 6 | **0** |
| Builders | 30 | 45 |
| Model requests | 105 | 135 |
| Prompt chars | 924k | 1,257k |

Strict costs more here because it refuses what the guard lets through: +29%
requests, +36% prompt characters. A rung catch replaces a full check run, which
only saves real time on a slow suite; these fixtures have none.

Regression arm: the five guard scenarios under `--strict-loop` match the guard's
results (9 of 15 done, 0 false verified, same builders and requests). Prompts are a
little longer, from the extra guidance.

`--jit-tools` took a builder's tool schemas from 27,508 to 24,249 characters
(−12%) in ST-RUN-06, and left the parent's tools alone.

KRHE on these reports, no model, nothing written to `krhe/lessons.json`:

```text
$ evaluate --incumbent <guard ×3> --candidate <strict ×3>
CANARY: 6c60bf5ab9a2 against dec29070675e
  - cost per passed task unknown in one arm (unmetered runs)
  - gain shown: only-candidate 6 vs 0, p = 0.031
$ evaluate --incumbent <strict ×3> --candidate <guard ×3>
REJECT: dec29070675e against 6c60bf5ab9a2
  - worse on false "verified" (9 vs 0)
```

## 4. Checks

| Check | Result (real output) |
| --- | --- |
| Client `npm run check` | **346/346, exit 0** (was 323); pins, 12 seams, notices, brand ok |
| Client `npm run release:check` | exit 0 |
| Kriya `env -u OPENROUTER_API_KEY npm run check` | **Test Files 263 passed, 5 skipped; Tests 3104 passed, 63 skipped; exit 0** (was 3102); lint 0 errors, 8 warnings |
| Kriya `npm run build` (`verify:guard` OK) | Compiled, exit 0 |

**Backward compatibility, stated plainly.** With every new switch off, prompts,
tools and builders are as before. Two things changed for everyone:

- KRHE's gate now rejects any net pass loss, and Flows' Compare reuses that gate,
  so a flow version that used to read `hold` on a small loss now reads `reject`.
- Two existing tests changed to match: HU-EV-06 (B5 vs B4 was `hold`, now `reject`,
  the owner's rule) and HU-EV-03 (more moves than the cap, so "nothing left" became
  "nothing repeated").

## 5. Limits

- Needs git: outside a repository the ladder, tamper checks and red proof do nothing, and those folders are common for this client.
- Baseline is HEAD: the person's uncommitted test edits count as the agent's, so commit first.
- `any` and suppressions are refused even where legitimate, and an intended test rewrite with fewer assertions fails until the person commits it.
- `tsc` is run on the whole project, which is slow on big ones; a type error is only held against this work if the output names a changed file.
- Red proof costs one more check run per passing bug-fix step.
- `surgical_bugfix` comes from the model or from fixed words in the goal, and can be wrong.
- `bash` can still write a file with no parse feedback; the ladder catches it at the next check.
- `--recon`'s impact misses path aliases and run-time imports.
- Not browser-checked: no screen changed in this phase beyond H21's label.

## 6. Next

1. Owner: review, then say whether to commit.
2. Paid run, the only way to test the brief's claim: B4 vs B4 + `--strict-loop --recon --jit-tools` on the cap and multi sets, K = 3, with `--meter` and `--status`. Run each switch alone too, since three at once can't say which helped. Estimate ₹130–200 per arm-pair.
3. A frontier comparison needs a second model on the same set, and tasks of 50+ files, which KriyaBench doesn't have yet.
