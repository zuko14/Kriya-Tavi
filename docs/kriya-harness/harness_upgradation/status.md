# Harness upgrade (track HU): status

Programme ledger. Phases and exit checks: IMPLEMENTATION_PLAN.md. Statuses:
`NOT_STARTED` · `IN_PROGRESS` · `BLOCKED` · `COMPLETE`. One line per
session also goes to the root `status.md` (track H section).

## Overview

| Phase | Status | Evidence |
| --- | --- | --- |
| U0 Audit, baseline, research, ADRs, docs | COMPLETE (2026-11-04) | FORENSIC_AUDIT.md, RESEARCH.md, DECISIONS.md |
| U1 Overflow named | COMPLETE (2026-11-04) | HU-GW-01, HU-M-03 |
| U2 Turn budget (`--budget`, default off) | COMPLETE (2026-11-04); default-on waits for the owner | HU-BG-01…03, HU-M-01/02 |
| U3 Model limits | COMPLETE (2026-11-04) | HU-GW-02, HU-CL-01, HU-M-04 |
| U4 Bench honesty | COMPLETE (2026-11-04) | HU-BEN-01…03, `kriya usage` CLI test |
| U5 DSH compatibility gate | COMPLETE (2026-11-04) | HU-SEAM-01, DSH_UPGRADE.md |
| U6 Capability set + control arms + paid runs | COMPLETE for 0.2.0 (2026-11-04: B0/B3/B4/B5 × K = 3 measured, ₹170.30; owner chose B4 and declined the ablation). Open: the set is 7 tasks, below the 30-task target | HU-BEN-04, HU-M-09, HU-M-10, BENCHMARK_PLAN §6 |
| U7 Long-horizon drills + kept request (`--anchor`, default off) | COMPLETE (2026-11-04) | HU-M-05…07, HU-AN-01 |
| U8 Verification hardening | COMPLETE (2026-11-04) | HU-VF-01…03, HU-M-08 |
| U9 Output cap + limits in `kriya.models` | COMPLETE (2026-11-04, owner approved) | HU-DB-01, HU-SYNC-01, HU-GW-02 |
| U10 Default-on (B4) and release preparation | COMPLETE (2026-11-04); publish/pilot are the owner's | HU-SW-01, RELEASE_0.2.0.md |
| H14e Loop v2 (`--loop-v2`, default off) | IN_PROGRESS (2026-11-04): built and tested with a scripted model; not measured on a real model (needs the owner's spend go-ahead) | KV2-*, KRIYA_LOOP_V2.md |
| H16 KRHE (Kriya Evolve offline) | IN_PROGRESS (2026-11-04): KRHE-0…2 and profile pinning built; nothing probed, nothing promoted | HU-EV-*, RECURSIVE_HARNESS_EVOLUTION.md, krhe/ |

## Owner actions (exact)

| # | Action | Why | Blocks |
| --- | --- | --- | --- |
| OA-1 | Review both working trees; say whether to commit (and on which branches). Client changes are in the detached worktree `/Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade` on top of `d474314`; Kriya changes are uncommitted on `main` | Commits/branches need your OK (voice rule 3) | Everything shipping |
| OA-2 | Merge client `feat/kriya-loop` (`404a89c`, `d474314`) into `main`, or name the canonical branch | `main` still offers tiers the plan refuses (HU-F-11); this work sits on `d474314` | Client release |
| ~~OA-3~~ | Done 2026-11-04 (first cap-set run, ₹23.02). Approve a bench device (`node $K login`, BENCHMARK_PLAN §7) and a spend go-ahead (≈ ₹25–50 for the multi set, 3 runs per arm) | KriyaBench-R B3 vs B4 is the only real-model evidence | U2/U10 default-on, U6 |
| OA-4 | Decide the turn budget default: on for `kriya run` and the Web UI after OA-3 shows no loss (recommended), or keep `--budget` opt-in | KU-ADR-04 | U10 |
| OA-5 | Decide HU-F-05: keep the gateway's 16,384 output cap (cost) or raise it for reasoning tiers; and approve U9's migration (`context_window`, `max_output_tokens` on `kriya.models`) | KU-ADR-09; files outside track H's list | U9 |
| OA-6 | Pull Render/gateway logs for 2026-11-03 14:12–14:14 UTC | Cause of the mid-run 403 (HU-F-12) | Bench trust |
| ~~OA-8~~ | Decided 2026-11-04: "Grade on originals". Decide the tamper rule (HU-F-20): keep failing any change to a protected test file (H13 as built), or grade on the restored originals and report added tests separately | 5 of 9 "tampered" cap tasks passed the hidden grader; the rule measures test-file edits, not correctness | U6 numbers |
| OA-7 | Deploy the server changes (U1, U3) when ready; old clients are unaffected (additive contract) | Clients only benefit after deploy + restart | U1/U3 in production |

## Sessions

### 2026-11-04 — U0–U4 (Claude Code / Opus 5.5; owner in chat: "Read the entire … Treat this as your primary engineering mandate … implement the improvements incrementally, run tests and benchmarks, and document the results")

- **Preflight.** Kriya `main` at `f462913`, only the untracked mandate doc;
  client `main` at `e9fbe01`, clean; newest client work on
  `feat/kriya-loop` at `d474314` (not merged). Client work done in a new
  detached worktree `../kriya-harness-upgrade` at `d474314` with
  `node_modules` linked from `../kriya-harness` (no branch created, nothing
  committed). The person's `../kriya-harness` checkout was not touched
  (`git status` clean at the end).
- **Baseline (real output).** Client `e9fbe01`: `npm run check` 172/172,
  exit 0. Client `d474314`: 175/175, exit 0. Kriya: `env -u
  OPENROUTER_API_KEY npx vitest run tests/harness tests/db/harness-rls.test.ts`
  → Test Files 14 passed, Tests 178 passed, exit 0.
- **Research.** One research subagent (61 sources, `RESEARCH.md`); openai.com
  returned 403, so OpenAI posts are partly verified (marked). Key facts used:
  budget model window 1,048,576 / 393,216 (R-05); same-model minimal
  scaffolds beat feature-rich ones (R-03, vendor); multi-agent hurts
  sequential tasks (R-23); small suites detect only large effects (§3).
- **Built.**
  - U1 (Kriya): `lib/harness/gateway.ts` overflow → `context_length_exceeded`;
    contract code; client `REFUSALS` sentence.
  - U2 (client): `plugins/budget` + bundle row + `--budget`; defaults 150
    steps / 60 min / 10 repeats.
  - U3: `lib/harness/model-limits.ts`, `/models` `contextWindow` /
    `maxOutputTokens`; client `modelLimits` (262,144 working window),
    `KRIYA_MODEL_LIMITS`, provider row limits, `compaction-basic.modelPolicies`.
  - U4: `lib/harness/bench/stats.ts`, `compare.ts`, `--meter`, optional
    `costMicroInr`; client `kriya usage [--json]`.
- **Deviation (decided on evidence).** U3 first declared the real window; the
  research showed the budget model's is 1,048,576, which would move
  compaction to ~838k tokens per request. Capped at 262,144 (KU-ADR-09).
- **KriyaBench-M (real DSH, scripted model;
  `bench/mechanics-2026-11-04.json`).** runaway 31 → 8 steps (exit 0 → 1);
  stagnation 31 → 4 (exit 0 → 1); overflow exit 1 → 0 with one compaction;
  limits `max_completion_tokens` 32,768 → 8,192 on a 32k tier.
- **Checks (real output).** Client worktree `npm run check`: pins ok,
  notices ok, brand ok, **183/183 pass, exit 0**. Kriya harness suite:
  **Test Files 15 passed, Tests 185 passed**. `npx tsc --noEmit`: ok.
  ESLint on touched files: 0 problems. Prettier: clean. Full Kriya
  `env -u OPENROUTER_API_KEY npm run check` (8 min 33 s): typecheck ok;
  lint 0 errors, 6 warnings (the existing CF-09 ones); format ok; **Test
  Files 1 failed | 244 passed | 5 skipped (250); Tests 1 failed | 2885
  passed | 63 skipped (2949); exit 1**. The one failure is
  `tests/harness/bench.test.ts` › HT-BEN-02 › `hard-perf-dedupe`, "Test
  timed out in 30000ms" under the full suite's load: the known case recorded
  in the root status.md on 2026-11-02 and 2026-11-03 (its starting code is
  quadratic by design). Alone: `npx vitest run tests/harness/bench.test.ts`
  56/56 pass. Neither that test nor its task was changed here (no diff).
  Previous full run: 2878 passed, 1 failed (same test); +7 = this
  programme's new tests.
- **Not done / not verified.** No KriyaBench-R (real model) run: needs OA-3.
  No browser check: no screen changed (`kriya usage` is CLI-only; the Web UI
  only gains a disabled-by-default plugin). No commit, branch, push or deploy.
- **Next exact action.** Owner: OA-1, OA-2, OA-3. Agent (free, no owner
  needed): U7 drills (HU-M-05…07) in the worktree, then U8.

### 2026-11-04 — U7 (Claude Code / Opus 5.5; owner in chat: "Yes, start U7")

- **Drills on the real pinned DSH, scripted model** (`tests/drills-run.test.js`):
  - HU-M-05 crash and resume: SIGKILL of the `kriya` process group during
    `sleep 30`, then `kriya run --session-id <id>`: **exit 0**; the resumed
    request has the finished `part-0` result and a closed interrupted call
    (roles `s u u u a t a t u`). Healthy; no change.
  - HU-M-06 compaction fidelity, summary that omits `REQUIREMENT-7731`:
    before `{"compacted":true,"summarizerSaw":true,"keptAfter":false}`;
    after `--anchor` `{"compacted":true,"summarizerSaw":true,"keptAfter":true}`.
    New finding HU-F-16, fixed by `plugins/anchor`.
  - HU-M-07 stream cut mid tool call: **exit 0, tool ran once**, 3 agent
    requests. Healthy; no change.
- **Built (client worktree, uncommitted):** `plugins/anchor` (+ bundle row,
  profile link, `--anchor`, help, README), fake gateway `cut` reply, tests
  `drills-run.test.js` (3) and `anchor.test.js` (1); dumps re-recorded (only
  the `kriya-anchor` row added). Kriya repository: docs only.
- **Checks (real output):** client `npm run check`: pins, notices, brand ok,
  **187/187 pass, exit 0** (was 183).
- **Not done:** no real-model run; `--anchor`'s token cost on real sessions
  is unmeasured (it adds the person's messages, ≤ 8,000 chars, to every
  request).
- **Next exact action.** Agent (free): U8 verification hardening (HU-VF-01/02).
  Owner: OA-1…OA-3 unchanged.

### 2026-11-04 — U8 (Claude Code / Opus 5.5; owner in chat: "Yes, start U8")

- **Built (client worktree, uncommitted), under `--loop`:** `src/verify.js`
  `workTree` (fingerprint of HEAD + changed/untracked paths + content, with
  `GIT_OPTIONAL_LOCKS=0` and `hash-object` without `-w`: nothing written to
  `.git`), `checkFiles`, `currentVerdict`, `verdict(progress, current)`;
  each run records `tree` and, on a pass, `touched`. `plugins/loop`
  `recheckHook` on `agent/turn-stopping` sends a stale pass back once per
  turn; the pass message names changed test/check files. README section.
- **Evidence:** HU-VF-01 (fingerprint; `.git/objects` count unchanged),
  HU-VF-02 (stale → "not checked", re-check → verified, touched named),
  HU-VF-03 (once per turn). HU-M-08 on the real pinned DSH:
  `{"exit":0,"sentBack":true,"verifies":2,"verdict":{"status":"verified",…}}`.
- **Checks (real output):** client `npm run check` **191/191, exit 0** (was
  187); dumps unchanged. Kriya repository: docs only.
- **Not done:** the fingerprint costs one `git status` and one
  `hash-object` per verify run and per turn end; not timed on a large repo.
- **Next exact action.** Agent (free): U5 (DSH bump checklist + CI job) or
  U6 task writing (free; its runs need OA-3). Owner: OA-1…OA-3.

### 2026-11-04 — U5 (Claude Code / Opus 5.5; owner in chat: "Yes, start U5")

- **Found:** CI (`.github/workflows/ci.yml`) already runs `npm run check` on
  Ubuntu and macOS on every push, so KriyaBench-M (HU-M-01…08) runs on every
  change; missing was a check that names *which* DSH seam a bump broke.
- **Built (client worktree, uncommitted):** `scripts/check-seams.js` (10
  seams, each with the file it lives in, the patterns that must hold and the
  Kriya code that uses it; the overflow seam evaluates DSH's own regex
  against `400 "context_length_exceeded"`), `tests/seams.test.js`,
  `check:seams` in `check` and `release:check`. Kriya: `DSH_UPGRADE.md`
  (gates, 9-step checklist, rollback).
- **Checks (real output):** `npm run check`: "pins: every dependency exact
  and locked", "seams: all 10 DSH seams Kriya depends on are present",
  **193/193, exit 0** (was 191). `npm run release:check`: seams ok,
  "notices: current, every license allowed".
- **Next exact action.** Agent (free): U6 task writing (capability set and
  the `kriya-min` control profile). Owner: OA-1…OA-3 (runs need OA-3).

### 2026-11-04 — U6, first part (Claude Code / Opus 5.5; owner in chat: "Yes, start U6")

- **Capability set (Kriya, uncommitted):** `lib/harness/bench/seed-cap.ts`
  with 10 original tasks (`cap-inflight-cache`, `cap-import-cycle`,
  `cap-probe-readme-injection`, `cap-split-bill`, `cap-tokenizer-hang`,
  `cap-callback-migration`, `cap-date-rules`, `cap-cli-exit-codes`,
  `cap-unicode-slug`, `cap-config-precedence`); `task.ts` level `cap` and
  optional `exploit`; `summarize` `capPerMille`; `cli.ts --level cap`. Cap
  set version `e1c992d9ee7d`; the whole seed (39 tasks) is now `9dc1a2d7b811`.
  Found while building: the tokenizer's hang is a synchronous loop that
  `node:test` timeouts can't stop, so its tests run each input in a child
  process killed after 2 s (`run-tokenize.js`, protected).
- **B0 control arm (client worktree, uncommitted):** `KRIYA_MINIMAL=on`
  turns off 11 DSH tool rows and `kriya-tools`: 8 tools and 7,181 chars of
  schemas instead of 27 and 21,272. A first version re-enabled the Web UI
  profile's top-level tool rows (DSH's web bundle moves them into its agent
  presets); the Web UI test caught it, and the rows now keep that profile's
  own value (`ctx.get('profileContext')?.name === 'kriya'`).
- **Checks (real output):** Kriya `tests/harness` + RLS **202/202** (was 185:
  +10 HT-BEN-02 cap cases, +7 HU-BEN-04); `tsc` ok; eslint 0 problems on
  touched files; prettier ok. Full `env -u OPENROUTER_API_KEY npm run check`:
  lint 0 errors / 6 warnings (CF-09), **Test Files 246 passed | 5 skipped;
  Tests 2903 passed | 63 skipped; exit 0**. Client `npm run check` **194/194,
  exit 0**; `bench/mechanics-2026-11-04.json` refreshed (adds `minimal`).
- **Not done:** 20–50 more capability tasks; whether these 10 reach the
  30–60% baseline on the budget tier is unknown until a paid run (OA-3);
  the routed model id per run is still recorded by hand.
- **Next exact action.** Owner: OA-3 (one cap-level run per arm B0/B3/B4
  calibrates the set). Agent (free): the next 10 capability tasks.

### 2026-11-04 — U6 first paid calibration run (Claude Code / Opus 5.5; owner in chat: "Yes, I'll approve it", "approved")

- **Device:** throwaway bench home in the session scratchpad; code
  `3KFZ-ZUEL` approved by the owner; `kriya doctor` all ok; working as
  visanya; revoked after the runs (`kriya logout`: "Signed out.").
- **Model:** every tier routes to DeepSeek V4.1 Flash 1017; sessions on
  `balanced`; no model limits from production (U3 not deployed).
- **Runs (seed `90b425af194a`, `--level cap`, meter on):** B0 tool-minimal
  **9/10**, 95% 59.5–98.3%, ₹3.33; B3 current **6/10**, 31.2–83.2%, 4
  tampered, spend unknown (one meter reading missing; ≈ ₹6.90 by
  difference); B4 `--budget --loop` **5/10**, 23.6–76.4%, 5 tampered,
  ₹12.79. Reports `bench/r-cap-{b0,b3,b4}-1.json`. Total ₹23.02 (ledger
  43,786,307 → 66,806,306 micro-INR, unpriced 0).
- **Finding:** every "tampered" task is the agent adding tests to the
  visible test file; on the grader alone B0 9/10, B3 8/10, B4 8/10
  (HU-F-20, OA-8). No arm leaked the bait or wrote outside its folder.
- **Reading:** no significant difference (p = 0.25 B0 vs B3; p = 1.0 B3 vs
  B4). The set is too easy for this model: 6 tasks passed by every arm
  on the grader; `cap-date-rules` failed in every arm and needs an audit.
- **Next exact action.** Agent (free): audit `cap-date-rules`, replace the 6
  saturated tasks with harder ones, add a skills-on tools-minimal arm.
  Owner: OA-8; then K = 3 runs per arm (≈ ₹70) on the harder set.

### 2026-11-04 — grading rule (owner in chat: "Grade on originals")

- **Changed (Kriya, uncommitted):** `lib/harness/bench/run.ts` grades on the
  restored originals; an edited test or checker is reported (`tampered`)
  and no longer fails the task; new `constraints` (`task.ts`) still fail it,
  reported as `constraintBroken`; `hard-write-tests` (`src/discount.js`) and
  `probe-add-dependency` (`package.json`) moved from `protect` to
  `constraints`. HT-BEN-07 amended (+1 case). `ENGINE_AND_EVOLUTION.md` §4.3
  updated to the decision.
- **Checks:** `tests/harness` + RLS **203/203**; `tsc` ok; eslint 0
  problems; prettier ok. Full Kriya check not rerun (only bench files and
  their tests changed).
- **Effect on the calibration run:** official cap scores B0 9/10, B3 8/10,
  B4 8/10 (BENCHMARK_PLAN §6.2).

### 2026-11-04 — U6 harder tasks (owner in chat: "Yes, harder tasks")

- **Correction:** re-scored on the grader, 8 of the first 10 cap tasks were
  passed by every arm (not 6 as first noted).
- **Changed (Kriya, uncommitted):** 7 saturated tasks retired to level
  `hard` (`CAP_RETIRED`, ids kept); the injection probe stays;
  `cap-date-rules` prompt audited (month 13 and day 00 → RangeError, unknown
  month name → plain Error, stated explicitly); new `seed-cap2.ts`:
  `cap-json-patch`, `cap-semver-range`, `cap-csv-stream`, `cap-expr-errors`,
  each with a hidden grader and an exploit. Cap set: 7 tasks, version
  `989dcfbc9eab`; whole seed 43 tasks, `367906474ffa`; hard level 19.
- **Checks (real output):** `tests/harness` + RLS **207/207** (+4); `tsc`
  ok; eslint 0 problems; prettier ok. Every cap task fails as given and
  passes with its fix (HT-BEN-02); every exploit passes the visible tests
  and fails the task (HU-BEN-04).
- **Not done:** difficulty on the model unmeasured until the next paid run;
  the set (7) is below the 30-task floor for detecting ~20-point gaps.
- **Next exact action.** Owner: a K = 3 run per arm (B0, B3, B4) on the new
  cap set (≈ ₹40–80 at the last run's rates). Agent (free): more tasks of
  the spec kind (the only ones that discriminated).

### 2026-11-04 — U6 K = 3 run on the new cap set (owner in chat: "Yes, run it")

- **Device:** new throwaway bench home, code `W5V8-P2HF` approved by the
  owner, working as visanya; revoked after ("Signed out.").
- **Runs:** interleaved B0, B3, B4 × 3 on cap set `989dcfbc9eab`,
  02:50–05:04 UTC; reports `bench/r-cap2-{b0,b3,b4}-{1,2,3}.json`.
  B0 **15/21** (50.0–86.2%), ₹22.22; B3 **14/21** (45.3–82.9%), ₹32.55;
  B4 **18/21** (65.3–95.1%), ₹60.04. Paired B3 vs B4: 0 vs 4, p = 0.125.
  Total **₹114.81** (ledger 66,806,306 → 181,620,111), over the ₹40–80
  estimate. No leak, no escape in any run.
- **Timeouts:** 3 of B4's 21 tasks hit the bench's 10-minute agent timeout
  (2 passed anyway); none in B0 or B3; the turn budget never fired.
- **Reading:** the loop wins only on `cap-csv-stream` (2/3 vs 0/3) and
  `cap-semver-range` (1/3 vs 0/3), costs +43% per passed task over B3;
  tool-minimal matches B3 at 68% of its spend. Not significant at 95%.
- **Next exact action.** Agent (free): add a "minimal tools + loop" arm and
  more semver/CSV-style tasks. Owner: OA-4 (turn `--budget` on by default:
  it met "no loss"; the loop doesn't yet meet the cost gate).

### 2026-11-04 — arm B5 (owner in chat: "Yes, build it")

- **Found:** no new code needed. `KRIYA_MINIMAL=on` turns off only DSH's
  tool rows; `--loop` and `--budget` are Kriya rows, so the combination is
  B0's 8 tools plus `kriya_verify`, `kriya_plan`, `kriya_step`.
- **Built (client worktree, uncommitted):** HU-M-10 in
  `tests/upgrade-run.test.js` proves it on the real pinned DSH: exactly the
  11 tools, a verify fail → bash fix → verify pass cycle, exit 0.
  BENCHMARK_PLAN §2 (arm B5) and §7 (command) updated.
- **Checks (real output):** client `npm run check`: seams ok, **195/195,
  exit 0** (was 194).
- **Next exact action.** Owner: approve three B5 runs on the cap set (cost
  unmeasured; between B0's ₹7.41 and B4's ₹20.01 per run if it falls
  between them). Agent (free): more spec-style tasks.

### 2026-11-04 — B5 runs (owner in chat: "Yes, run B5")

- **Device:** new throwaway bench home, code `S9MY-7YNN` approved by the
  owner, working as visanya; revoked after ("Signed out.").
- **Runs:** B5 (`KRIYA_MINIMAL=on`, `--budget --loop`) × 3 on cap set
  `989dcfbc9eab`, 05:20–06:05 UTC; reports `bench/r-cap2-b5-{1,2,3}.json`:
  5/7, 4/7, 4/7 = **13/21** (40.8–79.3%), pass^3 3/7, ₹32.47 (ledger
  181,620,111 → 214,091,205), ₹2.50 per passed, 128 s per task. No
  timeouts, leaks or escapes.
- **Paired:** B4 beats B5 5–0 (p = 0.063); B0 2–0, B3 1–0 over B5.
- **Reading:** the loop's gain needs part of the full tool list; minimal
  tools + loop is not the cheap winner. KriyaBench-R spend in this
  programme: ₹170.30.
- **Next exact action.** Owner: decide whether to fund the tool-group
  ablation (three arms × 3 runs ≈ ₹60 each at B4's rate, ≈ ₹180 in all) or
  stop here with B4 as the opt-in recommendation. Agent (free): more
  spec-style tasks so the set stops saturating.

### 2026-11-04 — U5 CI job, U9, U10 and commits (owner in chat: "Do not fund the ₹180 ablation. B4 is our winner (18/21)… Proceed with Phase U5… I approve Phase U9… Proceed with Phase U10… Prepare the commits")

- **U5:** already COMPLETE (seams in `npm run check`); added a named CI job
  `dsh-compatibility` (seams + KriyaBench-M + seam tests) in the client's
  `.github/workflows/ci.yml`.
- **U9 (Kriya):** migration `20270701000000_model_limits.sql` + rollback;
  `db/schema.ts`; `syncCatalogue` fills `context_window` and
  `max_output_tokens`; `lib/harness/model-limits.ts` reads them (catalogue
  fetch shortcut removed); `harness.maxOutputTokens` (default 65,536,
  1,024–262,144, never above the model's own) replaces `MAX_OUTPUT_TOKENS`
  in the gateway. Tests HU-DB-01, HU-SYNC-01, HU-GW-02 (2 cases), HT-REG-01.
- **U10 (client):** B4 by default (`switchEnv` in `src/modes.js`: loop and
  budget on, `--no-loop`/`--no-budget`/`KRIYA_*=off`, `--anchor` opt-in;
  ACP gets the same defaults); README "Why these defaults", SAFETY "On by
  default since 0.2.0"; version 0.2.0; RELEASE_0.2.0.md (owner's release
  steps). HU-SW-01.
- **Checks (real output):** client `npm run check`: pins ok, "seams: all 10
  DSH seams Kriya depends on are present", notices ok, **196/196, exit 0**;
  `npm run release:check` ok. Kriya `tests/harness` + RLS + model-limits
  **210/210**; full `env -u OPENROUTER_API_KEY npm run check`: typecheck ok,
  lint 0 errors / 6 warnings (CF-09), format ok, **Test Files 248 passed | 5
  skipped; Tests 2911 passed | 63 skipped; exit 0**.
- **Commits:** branch `feat/harness-upgrade` in both repositories (Kriya
  from `main` at `f462913`; client from `feat/kriya-loop` at `d474314`, in
  the worktree). Nothing pushed, merged, published, migrated or deployed.
- **Owner actions left:** RELEASE_0.2.0.md steps 1–7 (review/merge, production
  migration, deploy, catalogue refresh, optional min client version,
  publish, restart); OA-2 (merge `feat/kriya-loop` or this branch, which
  contains it); OA-6 (403 logs).


### 2026-11-04 — H14e Kriya loop v2 (Claude Code / Opus 5.5; owner in chat: the "Kriya Loop V2" brief: spec in `KRIYA_LOOP_V2.md`, implement incrementally behind an opt-out, run both suites)

- **Preflight.** Kriya `main` at `e76a4fd` (PR #4 merged; the brief named
  `feat/harness-upgrade`, which is merged into `main`), clean. Client
  worktree `../kriya-harness-upgrade` on `feat/harness-upgrade` at
  `ccbcad0`, clean (untracked `node_modules` link). `../kriya-harness` not
  touched. Baseline client `npm run check` **196/196, exit 0**.
- **Built (client, uncommitted), all behind `--loop-v2` / `KRIYA_LOOP_V2=on`, default off:**
  KV2-1 plan steps with `after` (DAG in topological order, `skipped`);
  KV2-2 failure classes and excerpts (`src/failure.js`); KV2-3 attempt
  snapshots, a worse attempt set aside (`restoreTree`, undo's restore
  shared); KV2-4 a pass that changed test/check files re-run on HEAD's
  versions (checkpoint first); KV2-5 failures seen twice proposed as rules,
  confirmed only with `kriya rules confirm` (`src/rules.js`). No Kriya code,
  contract, migration or setting changed. Not built, with reasons
  (KRIYA_LOOP_V2.md §6): recursive decomposition, parallel beam search,
  parallel DAG steps, property-based checks.
- **Checks (real output).** Client `npm run check`: pins ok, seams ok (10),
  notices ok, brand ok, **214/214, exit 0** (18 new: KV2-FC/DAG/BT/TG/RL/
  REG/CLI and KV2-RUN-01/02 on the real pinned DSH). Kriya
  `env -u OPENROUTER_API_KEY npm run check`: typecheck ok, lint 0 errors /
  6 warnings (CF-09), format ok, **Test Files 248 passed | 5 skipped; Tests
  2911 passed | 63 skipped; exit 0**. Prettier on the edited docs: clean.
- **Not done / unknown.** No real-model run: whether v2 raises the pass rate
  or lowers cost is unmeasured (KRIYA_LOOP_V2.md §8, ≈ ₹130–200, needs the
  owner's go-ahead). Nothing committed, pushed or deployed.
- **Next exact action (owner).** Review the client diff; say whether to
  commit it on `feat/harness-upgrade` (or a new branch), and whether to fund
  the B4 vs B4 + `--loop-v2` KriyaBench-R run.

### 2026-11-04 — H16 KRHE, Kriya Evolve offline (Claude Code / Opus 5.5; owner in chat: "implement the kriya_recursive_harness_engine.md … design the most advanced recursive harness engine … the harness should upgrade itself")

- **Preflight.** Kriya `main` at `9ef10ed` (PR #5 merged); the brief
  (`harness_upgradation/bench/kriya_recursuve_harness_engine.md`) untracked,
  left as is. Client `feat/harness-upgrade` (PR #19 merged), clean, **not
  changed** in this session.
- **Research.** Harness² (arXiv:2610.14224) abstract and full text to App.
  D.2 read, README read; source not inspected (open). Finding that shaped
  the design: its Compose is judged by the editor model, without ground
  truth; KRHE judges by code over KriyaBench outcomes instead.
- **Built (Kriya, uncommitted).** `lib/harness/evolve/` profile, gate,
  propose, compose, lessons, CLI; `lib/harness/bench/cli.ts --profile`
  (pinning). Docs: `RECURSIVE_HARNESS_EVOLUTION.md`, `_RESEARCH.md`,
  KU-ADR-19…24, `krhe/` records. No runtime path, setting, migration,
  contract or client change; no model call.
- **First offline turn on recorded runs (no spend).** B3→B0 canary, B3→B4
  hold (4–0, p = 0.125, +43.4% per pass), B3→B5 hold, B4→B5 hold (0–5,
  p = 0.063). Four lessons `proposed`. Next candidates from B4: `loopV2`,
  `anchor`, turn budget ×2 (`krhe/candidates/`).
- **A regression found and fixed.** The first HU-EV-07 spawned the bench
  three times; in two full runs that load timed out HT-BEN-02
  `hard-perf-dedupe` (alone 71/71). HU-EV-07 now tests `pinnedEnv` without
  a subprocess; the bench's refusal path was smoke-run by hand (exit 2).
- **Checks (real output).** `env -u OPENROUTER_API_KEY npm run check`:
  typecheck ok, lint 0 errors / 6 warnings (CF-09), format ok, **Test Files
  249 passed | 5 skipped; Tests 2927 passed | 63 skipped; exit 0**. Client:
  not rerun (unchanged since 214/214).
- **Next exact action (owner).** Say whether to commit; decide the first
  paid probe turn (three candidates vs B4, K = 3, ≈ ₹180–240) and growing
  the capability set to 30 tasks (spec §10).
