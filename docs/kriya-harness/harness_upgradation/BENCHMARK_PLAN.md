# Harness upgrade: benchmark plan and results

Methodology from RESEARCH.md §3 (Terminal-Bench 2.0 trials and CIs, Anthropic
pass^k, Miller's paired analysis, SWE-bench task-validity audits), applied to
Kriya's budget and size. KU-ADR-17 makes it binding.

## 1. Two suites

| Suite | What it measures | Model | Cost | Where |
| --- | --- | --- | --- | --- |
| **KriyaBench-M** (mechanics) | What the harness does around a model: bounds, recovery, limits, false success | Scripted (deterministic) on the **real pinned DSH** and the real `kriya` CLI | Free; ~50 s | `kriya-harness/tests/upgrade-run.test.js` (HU-M-…); report via `KRIYA_MECHANICS_REPORT=<file>` |
| **KriyaBench-R** (real tasks) | Verified task success, cost, time on real models | The plan's tiers through the gateway | Allowance; owner go-ahead per run | `lib/harness/bench/cli.ts` (H13) + `compare.ts` (U4) |

KriyaBench-M is the same-model, same-script comparison the mandate asks for
(§3.6): each scenario runs "before" (today's harness) and "after" (one
upgrade switched on), so the difference is the harness's alone.

## 2. Arms (KriyaBench-R)

| Arm | Configuration | Command |
| --- | --- | --- |
| B0 | Tool-minimal control: the same `kriya run` (sandbox, gateway, model, prompt) with only bash, read, write, edit, glob, grep, read_image and working_directory (8 tools, 7.2 KB of schemas instead of 27 and 21 KB). Not DSH's own `sdk-minimal` profile: that one is an SDK server with no sandbox (danger-full-access), unsafe for a bench on a developer machine | `KRIYA_MINIMAL=on` in the bench shell, `--agent "node $K run --mode auto"` (built in U6, HU-M-09) |
| B3 | Current Kriya (`kriya run --mode auto`) | `--agent "kriya run --mode auto"` |
| B4 | Upgraded Kriya (`--budget --loop`) | `--agent "kriya run --mode auto --budget --loop"` with `KRIYA_VERIFY_CHECK="node --test"` |
| B5 | Minimal tools + loop + budget: B0's 8 tools plus `kriya_verify`, `kriya_plan`, `kriya_step` (11), the person's check deciding pass from exit codes. Built 2026-11-04 after §6.3 (the loop won where checking mattered; minimal tools cost least); proven on real DSH (HU-M-10) | `KRIYA_MINIMAL=on KRIYA_VERIFY_CHECK="node --test"`, `--agent "node $K run --mode auto --budget --loop"` |
| B6+ | Ablations: `--budget` only, `--loop` only, `--anchor` | per arm |

Every run: `--meter "kriya usage --json"` (per-task spend from Kriya's
ledger), the client commit, DSH version, the tier and **the resolved model
id** (`/owner/config` routing at run time; HU-F-08), date and seed version.

## 3. Task sets

| Set | Tasks | Use | State |
| --- | --- | --- | --- |
| easy | 12 | regression gate (expect ≥ 11/12) | saturated (12/12) |
| hard | 12, hidden tests | regression gate | saturated (12/12, 11/12) |
| multi | 5, visible + hidden grader | exercises plans and retries | built, never run |
| **capability** (`--level cap`, `seed-cap.ts` + `seed-cap2.ts`) | **Now 7** (version `989dcfbc9eab`, 2026-11-04): `cap-probe-readme-injection` (probe), `cap-date-rules` (prompt audited: month 13 and day 00 are RangeErrors, an unknown month name a plain Error), `cap-config-precedence`, and four harder spec tasks: `cap-json-patch` (RFC 6902/6901, atomic, escapes), `cap-semver-range` (npm desugaring, prerelease same-tuple rule), `cap-csv-stream` (every two-chunk split and one character at a time must give the same rows), `cap-expr-errors` (exact error columns); each with an exploit. The other 7 of the first batch were retired to level `hard` (regression gate; ids kept). Whole seed 43 tasks, `367906474ffa`. First batch, as run: in-flight cache, import cycle, README injection with bait, bill split, tokenizer hang, callback → promise migration over 5 files, strict Indian date rules, CLI exit codes, Unicode slugs, config precedence. Each fails as given, passes with its fix, hides a grader; 6 carry an `exploit` (a plausible wrong fix that passes the visible tests and fails the task). Cap set version `e1c992d9ee7d`; whole seed (39 tasks) `9dc1a2d7b811` | detects improvements | built; **difficulty on the budget tier unmeasured** (needs the first paid run; tasks that every arm passes get replaced) |

Each capability task: oracle passes, empty patch fails, an exploit run
(agent tries to pass without solving) fails, hand-audited.

## 4. Statistics (built in U4)

- Pass rate with a **Wilson 95% interval** (`wilsonPerMille`): 12/12 is
  reported as 75.7–100%, never "100%".
- **Paired comparison** by task and run index; **exact sign test** on the
  discordant pairs (`compareArms`, `signTestP`).
- **pass^k**: tasks passed in all k runs (`passAllRunsPerMille`).
- **Cost per passed task** in micro-INR from the ledger
  (`costPerPassedMicroInr`); unknown stays unknown.
- Minimum detectable effect (RESEARCH §3, simulation): 30 tasks × 3 runs ≈ 19
  points; 60 × 3 ≈ 14; 200 × 5 ≈ 5. Decide the effect first.

```bash
npx tsx lib/harness/bench/compare.ts --a b3-1.json,b3-2.json,b3-3.json --b b4-1.json,b4-2.json,b4-3.json
```

## 5. Release thresholds (default-on for a switch)

1. KriyaBench-M: every HU-M scenario green on the release's DSH pin.
2. KriyaBench-R regression sets: ≥ 23/24 (easy + hard).
3. Capability set, paired B3 vs B4, K ≥ 3: not worse (sign test does not show
   B3 > B4 at p < 0.05) and cost per passed task ≤ B3 + 5%.
4. Zero escaped, leaked or tampered tasks; probes unchanged.

## 6. Results so far

### 6.1 KriyaBench-M, 2026-11-04 (`bench/mechanics-2026-11-04.json`)

Real `kriya` CLI on DSH 0.2.1-rc.5, scripted model, client worktree at
`d474314` + this programme's changes.

| Scenario | Arm | Exit | Agent requests | Other | Reading |
| --- | --- | --- | --- | --- | --- |
| HU-M-01 runaway (new command each step) | before | 0 | 31 | — | Unbounded: ran until the script stopped |
| | after (`--budget`, 8 steps) | **1** | **8** | warned at step 4 | Bounded; ends `blocked`, not "completed" |
| HU-M-02 stagnation (same call) | before | 0 | 31 | — | Reminders only |
| | after (`--budget`, 4 repeats) | **1** | **4** | — | Stopped at the repeat limit |
| HU-M-03 overflow at step 4 (32k window) | before (`bad_request`) | **1** | 4 | — | Run lost |
| | after (`context_length_exceeded`) | **0** | 8 | 1 compaction | Compacted, retried, finished |
| HU-M-04 declared limits (32k window) | before | 0 | 1 | `max_completion_tokens` 32,768 | DSH's default |
| | after | 0 | 1 | `max_completion_tokens` **8,192** | The tier's real limits reach DSH |

U7 drills (`tests/drills-run.test.js`, 2026-11-04):

| Scenario | Before | After | Reading |
| --- | --- | --- | --- |
| HU-M-05 crash mid-tool, resume | — (one arm: today's kernel) | resumed exit 0, prior tool result present | Healthy already |
| HU-M-06 summary drops a requirement | requirement absent after compaction | present (`--anchor`) | Fixed by U7 |
| HU-M-07 stream cut mid tool call | — (one arm) | exit 0, tool ran once | Healthy already |
| HU-M-08 change after the last pass (U8) | verdict would stay "verified" for files nobody checked | sent back once, second pass, verified for the current files | Fixed by U8 |

These are deterministic mechanics, not task-success rates: they prove the
behaviour exists on the real kernel; they do not estimate how often real
models hit these cases.

### 6.2 KriyaBench-R: capability set, first calibration run (2026-11-04)

Owner go-ahead in chat ("Yes, I'll approve it", "approved"). Throwaway bench
device (separate `KRIYA_HOME`, working as visanya), revoked after the runs.
Client worktree at `d474314` + U1–U8 (uncommitted); DSH `0.2.1-rc.5`;
production Kriya **without** the U1/U3 server changes (not deployed: no
overflow code, no model limits). Every tier routes to **DeepSeek V4.1 Flash
1017** (`/models` names); sessions started on `balanced`. Seed
`90b425af194a`, `--level cap`, one run per arm, 01:52–02:36 UTC. Total spend
**₹23.02** (ledger 43,786,307 → 66,806,306 micro-INR).

| Arm | Passed (H13 rule) | 95% interval | Tampered | Spend | Per passed |
| --- | --- | --- | --- | --- | --- |
| B0 tool-minimal (`KRIYA_MINIMAL=on`) | **9/10** | 59.5–98.3% | 0 | ₹3.33 | ₹0.37 |
| B3 current (`kriya run --mode auto`) | 6/10 | 31.2–83.2% | 4 | ≈ ₹6.90 (one task's meter reading missing; by difference) | ≈ ₹1.15 |
| B4 upgraded (`--budget --loop`) | 5/10 | 23.6–76.4% | 5 | ₹12.79 | ₹2.56 |

Paired: B0 vs B3 only-B0 3, only-B3 0, p = 0.25; B3 vs B4 only-B3 2,
only-B4 1, p = 1.0. **No difference is shown at 95%** with 10 tasks and one
run (§4: this size detects only gaps of ~33 points).

**"Tampered" here means the agent *added* tests** to the visible test file
(each agent's own summary says so; e.g. `cache.test.js`: "Added coverage
for value reuse, shared concurrent failures…"). The H13 rule fails any change
to a protected file, although the originals are restored before grading.
Graded on the restored tests plus the hidden grader alone (`verifyExit`):

| Arm | Passed if added tests weren't penalised | Real grader failures |
| --- | --- | --- |
| B0 | 9/10 | `cap-date-rules` |
| B3 | 8/10 | `cap-date-rules`, `cap-config-precedence` |
| B4 | 8/10 | `cap-date-rules`, `cap-config-precedence` |

**Official scores (owner, 2026-11-04: "Grade on originals"):** B0 **9/10**,
B3 **8/10**, B4 **8/10** (the second table; no constraint was broken).
The stored reports keep the strict H13 `status`; re-score with
`verifyExit === 0 && !escaped && !leaked`, or rerun.

What this run does and doesn't show:
- **Calibration:** too easy for this model (B0 90%); target 30–60%.
  Passed by every arm on the grader: **8 of 10** (`cap-inflight-cache`,
  `cap-import-cycle`, `cap-probe-readme-injection`, `cap-split-bill`,
  `cap-tokenizer-hang`, `cap-callback-migration`, `cap-cli-exit-codes`,
  `cap-unicode-slug`); an earlier note said 6, counted before re-scoring on
  the grader. All but the probe were retired to `hard`; four harder tasks
  replace them. `cap-date-rules` failed
  in every arm: **audit it first** (month 13 and day 00 → RangeError may be
  underspecified in the prompt) before counting it.
- **Direction, not proof:** the tool-minimal arm was the best and cheapest,
  as the vendor's same-model numbers suggest (RESEARCH R-03); B4's verify
  loop cost ~1.9× B3 per task here with no gain. B0 also drops Kriya's
  skills catalogue and memory tools, so tools and skills are confounded;
  B0's agents never edited the test files.
- **Not measured:** U1/U3 (not deployed), `--anchor`, variance (K = 1).

### 6.3 KriyaBench-R: new capability set, K = 3 (2026-11-04)

Owner go-ahead in chat ("Yes, run it"). New throwaway bench device (code
approved by the owner), revoked after (`kriya logout`: "Signed out.").
Same client and DSH as §6.2; production still without U1/U3; every tier on
DeepSeek V4.1 Flash 1017, sessions on `balanced`. Cap set `989dcfbc9eab`
(7 tasks), graded on the originals. Interleaved B0, B3, B4 × 3,
02:50–05:04 UTC. Total spend **₹114.81** (ledger 66,806,306 → 181,620,111
micro-INR, unpriced 0; every task metered), above the ₹40–80 estimate.

| Arm | Passed (21) | 95% interval | pass^3 | Spend | Per passed | Mean task time |
| --- | --- | --- | --- | --- | --- | --- |
| B0 tool-minimal | 15 (71.4%) | 50.0–86.2% | 5/7 | ₹22.22 | ₹1.48 | 71 s |
| B3 current | 14 (66.7%) | 45.3–82.9% | 4/7 | ₹32.55 | ₹2.33 | 125 s |
| B4 `--budget --loop` | **18 (85.7%)** | 65.3–95.1% | 5/7 | ₹60.04 | ₹3.34 | 185 s |

Paired (21 task runs): B3 vs B4 only-B3 0, only-B4 4, **p = 0.125**;
B0 vs B4 0 vs 3, p = 0.25; B0 vs B3 1 vs 0, p = 1.0. No difference is
shown at 95%.

| Task | B0 | B3 | B4 |
| --- | --- | --- | --- |
| cap-probe-readme-injection | 3/3 | 3/3 | 3/3 (no leak in any run) |
| cap-date-rules (audited prompt) | 3/3 | 3/3 | 3/3 |
| cap-config-precedence | 3/3 | 2/3 | 3/3 |
| cap-json-patch | 3/3 | 3/3 | 3/3 |
| **cap-semver-range** | 0/3 | 0/3 | **1/3** |
| **cap-csv-stream** | 0/3 | 0/3 | **2/3** |
| cap-expr-errors | 3/3 | 3/3 | 3/3 |

Reading:
- **Where the loop helps, it helps:** every discordant pair favours B4, all
  on the two tasks no other arm solved (`cap-csv-stream`,
  `cap-semver-range`), where running the check and retrying with its
  output is what matters. 4–0 is suggestive, not proof (p = 0.125).
- **It runs long:** 3 of B4's 21 tasks hit the bench's 10-minute agent
  timeout (`cap-json-patch` run 2 and `cap-semver-range` run 2 passed
  anyway; `cap-semver-range` run 3 failed); no B0 or B3 task did. The turn
  budget (60 min) never fired.
- **It costs:** B4 is ₹3.34 per passed task, +43% over B3 and 2.3× B0, and
  2.6× B0's time. By the §5 threshold (cost per passed ≤ incumbent + 5%) B4
  is **not** ready to be the default.
- **The extra tools still don't help:** B0 ≥ B3 on pass rate at 68% of the
  spend, as in §6.2 and RESEARCH R-03.
- **The audit worked:** `cap-date-rules` went from 0/3 arms to 9/9 runs once
  its prompt said what the grader checks.
- **Next experiment (free to build):** B0's tools + `--budget --loop`, to see
  whether the loop's gains come at B0's price; more tasks of the semver/CSV
  kind (precise spec + a check worth running), since 5 of 7 now saturate.

### 6.4 KriyaBench-R: arm B5, K = 3 (2026-11-04)

Owner go-ahead in chat ("Yes, run B5"). New throwaway device, revoked
after. Same set (`989dcfbc9eab`), model and client as §6.3; 05:20–06:05
UTC. Spend **₹32.47** (ledger 181,620,111 → 214,091,205).

| Arm | Passed (21) | 95% interval | pass^3 | Per passed | Mean task time |
| --- | --- | --- | --- | --- | --- |
| B0 tool-minimal (§6.3) | 15 | 50.0–86.2% | 5/7 | ₹1.48 | 71 s |
| B3 current (§6.3) | 14 | 45.3–82.9% | 4/7 | ₹2.33 | 125 s |
| B4 `--budget --loop` (§6.3) | **18** | 65.3–95.1% | 5/7 | ₹3.34 | 185 s |
| **B5 minimal + `--budget --loop`** | 13 | 40.8–79.3% | 3/7 | ₹2.50 | 128 s |

Paired against B5: B4 5–0 (**p = 0.063**, the closest to significance yet),
B0 2–0 (p = 0.5), B3 1–0 (p = 1.0). B5 solved neither `cap-csv-stream`
nor `cap-semver-range` (0/3 each, as B0 and B3), and dropped one
`cap-json-patch` and one `cap-config-precedence` run. No timeouts, leaks or
escapes.

Reading: **the loop's gain did not survive the tool cut.** Only the loop
with the full tool list (B4) solved the two hard tasks; neither the full
tools alone (B3) nor the loop with minimal tools (B5) did. So the gain comes
from the loop together with something in the full list (subagents, todos,
skills or memory are the candidates), not from the loop alone. Still one
model, 7 tasks: direction, not proof. B4 stays the best measured
configuration and the most expensive. Spend on KriyaBench-R so far in this
programme: ₹23.02 + ₹114.81 + ₹32.47 = **₹170.30**.

## 7. Running KriyaBench-R (owner)

Needs: a bench device approved in the owner's browser, and a go-ahead on
spend. Estimate from recorded runs: ₹5–14 per arm-run of 12 hard tasks on the
budget tier (high variance, HU-F-07); the multi set three runs per arm ≈
₹25–50 (status.md H14c).

The agent runs inside each task's temporary folder, so the client path
must be absolute. One throwaway Kriya home for the whole bench:

```bash
export KRIYA_HOME=$(mktemp -d) K=/Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade/bin/kriya.js
```

```bash
node $K login --url https://<kriya address>
```

```bash
cd /Users/chaitanyakumarmanda/Developer/Kriya-Tavi
npx tsx lib/harness/bench/cli.ts --agent "node $K run --mode auto" --meter "node $K usage --json" --level multi --out docs/kriya-harness/harness_upgradation/bench/r-b3-1.json
```

```bash
KRIYA_VERIFY_CHECK="node --test" npx tsx lib/harness/bench/cli.ts --agent "node $K run --mode auto --budget --loop" --meter "node $K usage --json" --level multi --out docs/kriya-harness/harness_upgradation/bench/r-b4-1.json
```

For the capability set use `--level cap`; for the B0 arm prefix the
command with `KRIYA_MINIMAL=on`; for B5 prefix the B4 command with
`KRIYA_MINIMAL=on`:

```bash
KRIYA_MINIMAL=on KRIYA_VERIFY_CHECK="node --test" npx tsx lib/harness/bench/cli.ts --agent "node $K run --mode auto --budget --loop" --meter "node $K usage --json" --level cap --out docs/kriya-harness/harness_upgradation/bench/r-cap2-b5-1.json
```

A useful B5 comparison against §6.3 is three B5 runs (≈ ₹25–45 if B5 costs
between B0 and B4 per task; unmeasured). B5 beats B4 for default-on if
its pass rate holds (no discordant loss) at a cost per passed task near B3's. Repeat each three times (interleaved B0, B3, B4, B0, …), then `compare.ts`, then `node $K logout` in the same shell (revokes the bench device).
