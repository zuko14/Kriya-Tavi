# Harness upgrade: tests (HU-…)

No test calls a real model, a real Kriya deployment or the live database.
Server tests use PGlite and a stubbed `fetch` (fake OpenRouter); client
tests use `tests/fake-kriya.js` and the real pinned DSH.

| Id | What it proves | File | Phase | Status |
| --- | --- | --- | --- | --- |
| HU-GW-01 | A provider overflow 400 → `context_length_exceeded`, no provider text or prompt in the answer, reservation `failed`, no fallback try; other 400s stay `bad_request` | Kriya `tests/harness/gateway.test.ts` | U1 | pass |
| HU-GW-02 | `/models` adds `contextWindow` and `maxOutputTokens` (≤ 16,384) from the catalogue; unknown model → none; one catalogue request per hour | same | U3 | pass |
| HT-GW-09 (amended) | Names still correct when the catalogue is unreachable (stub added, assertions unchanged) | same | U3 | pass |
| HU-CL-01 | `modelLimits`: quarter-window output and headroom, 262,144 working cap, never from the shell; the bundle rows' expressions give DSH the limits, and nothing without them | client `tests/env.test.js` | U3 | pass |
| HU-BG-01 | Budget limits from the launch env; unusable values never lift a limit | client `tests/budget.test.js` | U2 | pass |
| HU-BG-02 | One warning 5 steps before the limit; reject at the limit; time limit with warning at 90%; new turn fresh; an earlier reject stays a reject | same | U2 | pass |
| HU-BG-03 | Identical calls (any key order) counted per agent; a different call resets; another agent not counted | same | U2 | pass |
| HU-M-01 | Real DSH, runaway model: before 31 steps exit 0; after 8 steps exit 1, warned at step 4 | client `tests/upgrade-run.test.js` | U2 | pass |
| HU-M-02 | Real DSH, same call forever: before 31; after 4, exit 1 | same | U2 | pass |
| HU-M-03 | Real DSH, overflow at step 4 on a 32k tier: `bad_request` exit 1; `context_length_exceeded` → one compaction → retried request carries DSH's checkpoint → exit 0 | same | U1 + U3 | pass |
| HU-M-04 | Real DSH: a 32k tier's request carries `max_completion_tokens` 8,192 (before: 32,768) | same | U3 | pass |
| HU-BEN-01 | Wilson intervals (12/12 → 75.7–100%) and the exact sign test | Kriya `tests/harness/bench-stats.test.ts` | U4 | pass |
| HU-BEN-02 | Arm summary over runs (pooled rate, pass^k, spend per passed, unknown stays unknown, mixed seeds refused); paired comparison | same | U4 | pass |
| HU-BEN-03 | The spend meter: ledger difference; a failed meter → unknown; no meter → unknown | same | U4 | pass |
| CLI (amended) | `kriya usage --json` prints the ledger line; plain form in ₹ | client `tests/cli.test.js` | U4 | pass |
| HT-REL-03 (re-recorded) | Profile dumps match `expected/*.dump.yml` (new rows: `kriya-budget` disabled unless `KRIYA_BUDGET=on`; provider `models` and `compaction-basic.modelPolicies` expressions) | client `tests/profiles.test.js` | U2, U3 | pass |
| HT-REG-01 | Off means today: without `--budget` the budget row is disabled; without limits the rows evaluate to DSH's defaults (HU-CL-01 asserts both) | client | U2, U3 | pass |

| HU-M-05 | Real DSH: SIGKILL of the process group during a tool call, then `kriya run --session-id`: exit 0, the finished tool result is in the resumed request, the interrupted call is closed | client `tests/drills-run.test.js` | U7 | pass |
| HU-M-06 | Real DSH: overflow compaction with a summary that drops a requirement: without `--anchor` the retried request lacks it, with `--anchor` it has it; the summariser saw it in both | same | U7 | pass |
| HU-M-07 | Real DSH: the stream breaks mid tool call: retried, the tool runs exactly once, exit 0 | same | U7 | pass |
| HU-VF-01 | Tree fingerprint follows content, untracked files and HEAD; writes no git objects; none outside a repo | client `tests/verify-tree.test.js` | U8 | pass |
| HU-VF-02 | Verified only for the files it ran on (change after → "not checked", stale); checked again → verified; changed test/check files named | same | U8 | pass |
| HU-VF-03 | Turn-end hook: a stale pass is sent back once per turn, a fresh one never | same | U8 | pass |
| HU-M-08 | Real DSH, `--loop`: pass, change a file, try to finish → sent back once → second pass → verdict verified for the current files | client `tests/drills-run.test.js` | U8 | pass |
| HU-SEAM-01 | The 10 DSH seams Kriya depends on are present in the pinned DSH; a renamed hook, a missing file or an overflow pattern that no longer matches `context_length_exceeded` is reported by name with the Kriya code that uses it | client `tests/seams.test.js`, `scripts/check-seams.js` | U5 | pass |
| HU-BEN-04 | The capability set: ≥ 7 `cap-` tasks in the seed, each with a hidden grader or a bait; retired ones in the seed at level `hard`; every `exploit` passes the visible tests and fails the task | Kriya `tests/harness/bench-cap.test.ts` (+ HT-BEN-02 over all 39 tasks) | U6 | pass |
| HU-M-09 | Real DSH: `KRIYA_MINIMAL=on` offers exactly bash, edit, glob, grep, read, read_image, working_directory, write; off, the full list (27) | client `tests/upgrade-run.test.js` | U6 | pass |
| HT-BEN-07 (amended, owner 2026-11-04) | A weakened test is put back and the task fails; a fix plus an edited test **passes** on the originals, reported `tampered`; changing a `constraints` file fails even with the fix | Kriya `tests/harness/bench.test.ts` | U6 | pass |
| HU-M-10 | Real DSH, arm B5 (`KRIYA_MINIMAL=on --loop --budget`): exactly 11 tools (the 8 minimal + `kriya_plan`, `kriya_step`, `kriya_verify`); a verify fail → bash fix → verify pass cycle; exit 0 | client `tests/upgrade-run.test.js` | U6 | pass |
| HU-AN-01 | Kept-request text: word for word, numbered, first message always kept, oldest later ones dropped over 8,000 chars | client `tests/anchor.test.js` | U7 | pass |

## Planned

| Id | What | Phase |
| --- | --- | --- |

## Commands

```bash
cd /Users/chaitanyakumarmanda/Developer/Kriya-Tavi && env -u OPENROUTER_API_KEY npx vitest run tests/harness tests/db/harness-rls.test.ts
```

```bash
cd /Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade && npm run check
```

```bash
cd /Users/chaitanyakumarmanda/Developer/kriya-harness-upgrade && KRIYA_MECHANICS_REPORT=/tmp/mechanics.json node --test tests/upgrade-run.test.js
```
