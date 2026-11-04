# Harness upgrade: change impact and safe execution

Read before editing any file for this programme. Track H's
`docs/kriya-harness/CHANGE_IMPACT_AND_SAFETY.md` and AGENTS.md apply in full;
this file lists only what the harness upgrade (track HU, a part of track H)
touches. A change not listed here needs the owner's approval and a row here
first.

## 1. Protected (never by this programme)

Everything track H protects (`lib/auth.ts`, `lib/agent/metering.ts`,
`kriya.charges`, `lib/connectors*`, `lib/agent/queue.ts`, `lib/memory/*`,
`lib/agent/policy.ts`), plus: DSH packages (never edited, track H rule 5),
`db/schema.ts` and migrations (U9 needs approval), `lib/models.ts`,
`lib/config.ts` (no new settings without approval), AGENTS.md.

## 2. Changed in U1–U4 (2026-11-04)

### Kriya repository (track H's own files)

| File | Change | Must stay true | Test |
| --- | --- | --- | --- |
| `lib/harness/gateway.ts` | A 400/413 whose body reads as a context overflow → `fail(400, "context_length_exceeded", fixed sentence)`; log adds `overflow: true` | No provider text, prompt or key leaves the server or reaches logs; reservation `failed`; no fallback try; all other paths unchanged | HU-GW-01, HT-GW-08, HT-GW-10 |
| `lib/harness/contract.ts`, `docs/kriya-harness/contract.json` | Error code `context_length_exceeded`; optional `contextWindow`, `maxOutputTokens` on `/models` items | Additive only | HT-API-01 (export matches) |
| `lib/harness/model-limits.ts` (new) | Provider catalogue lookup, cached | Only positive integers; unknown → null; output ≤ `MAX_OUTPUT_TOKENS` | HU-GW-02 |
| `app/api/harness/v1/models/route.ts` | Adds the limits beside the name | Names unchanged | HT-GW-01, HT-GW-09, HU-GW-02 |
| `lib/harness/bench/{run,agent,cli}.ts`, `stats.ts`, `compare.ts` (new) | Optional `costMicroInr`, `--meter`, intervals, comparison | Old reports still load (field optional); unknown cost stays null | HT-BEN-*, HU-BEN-* |
| `tests/harness/gateway.test.ts` | New HU-GW-01/02; fetch stub tolerates GET; HT-GW-09 stubs the catalogue | Existing assertions unchanged | itself |
| `tests/harness/bench-stats.test.ts` (new) | HU-BEN-01…03 | — | itself |
| `lib/harness/bench/seed-cap.ts` (new, U6), `seed.ts`, `task.ts`, `run.ts`, `cli.ts` | 10 capability tasks; level `cap`; optional `exploit`; `capPerMille`; `--level cap` | Existing tasks unchanged (the whole seed's version changes, as with every added task) | HT-BEN-01/02, HU-BEN-04 |
| `tests/harness/bench-cap.test.ts` (new, U6) | HU-BEN-04 | — | itself |
| `lib/harness/bench/seed-cap2.ts` (new, U6), `seed-cap.ts` (`CAP_RETIRED`), `seed.ts` | 4 harder tasks; 7 saturated tasks moved to level `hard`; `cap-date-rules` prompt clarified | Retired tasks keep their ids and content | HT-BEN-02, HU-BEN-04 |
| `lib/harness/bench/{task,run,seed-hard}.ts`, `tests/harness/bench.test.ts`, `docs/kriya-harness/ENGINE_AND_EVOLUTION.md` §4.3 (owner decision 2026-11-04) | Grade on restored originals; `constraints` field (`hard-write-tests`, `probe-add-dependency`); `constraintBroken` in results | A weakened test still can't pass a task; constraint changes still fail | HT-BEN-07 (amended), HT-BEN-02, HT-BEN-08 |

### Client repository (worktree `../kriya-harness-upgrade`, detached at `d474314`)

| File | Change | Must stay true | Test |
| --- | --- | --- | --- |
| `plugins/budget/*` (new) | Turn budget plugin | Only active with `KRIYA_BUDGET=on` | HU-BG-*, HU-M-01/02 |
| `plugins/anchor/*` (new, U7) | Kept request section | Only active with `KRIYA_ANCHOR=on`; only `user`-source messages | HU-AN-01, HU-M-06 |
| `tests/drills-run.test.js`, `tests/anchor.test.js` (new, U7) | HU-M-05…07, HU-AN-01; (U8) HU-M-08 | — | itself |
| `src/verify.js` (U8) | `workTree`, `checkFiles`, `currentVerdict`; `verdict(progress, current)`; runs record `tree`, `touched` | Read-only git only; outside a repo nothing changes; old progress files (no `tree`) are never stale | HU-VF-01/02, existing verify tests |
| `plugins/loop/index.js` (U8) | `recheckHook` on `agent/turn-stopping`; pass text names changed test/check files | Once per turn; only when stale | HU-VF-03, HU-M-08, loop-run tests |
| `tests/verify-tree.test.js` (new, U8) | HU-VF-01…03 | — | itself |
| `scripts/check-seams.js`, `tests/seams.test.js` (new, U5) | Seam canary | Reads `node_modules` only | HU-SEAM-01 |
| `package.json` (U5) | `check:seams` script, run by `check` and `release:check` | Dependencies unchanged | release gate |
| `bundle/cordis.patch.yml` | `kriya-budget` and (U7) `kriya-anchor` rows; (U6) the B0 arm: 11 DSH tool rows and `kriya-tools` off only with `KRIYA_MINIMAL=on` (and, as before, off at the top level of the Web UI's `kriya` profile) (disabled unless on); provider `models` adds limits when given; `compaction-basic.modelPolicies` from limits | No limits → same models and `[]` policies as DSH's default | HU-CL-01, HT-REL-03 |
| `src/profiles.js` | Links `@kriya-ai/harness-budget` | Other links unchanged | profiles tests |
| `src/launch.js` | `modelLimits`, `WORKING_WINDOW`, `KRIYA_MODEL_LIMITS` (never from the shell), `REFUSALS.context_length_exceeded` | Other env unchanged | env tests |
| `bin/kriya.js` | `--budget` and (U7) `--anchor` flags; `kriya usage [--json]`; help text | Other commands unchanged | cli tests |
| `contract/contract.json`, `contract/SOURCE.md` | Copy of Kriya's export, hash `207c3841…` | Matches Kriya | contract test |
| `expected/*.dump.yml` | Re-recorded | Diff reviewed: only the rows above | HT-REL-03 |
| `tests/fake-kriya.js` | `modelLimits` on `/models`; a scripted turn may return an error or (U7) cut the stream mid tool call | Existing behaviour unchanged | all client tests |
| `tests/env.test.js`, `tests/cli.test.js` | `limits` in planTiers; HU-CL-01; `kriya usage` | Existing assertions unchanged except the added field | itself |
| `tests/budget.test.js`, `tests/upgrade-run.test.js` (new) | HU-BG, HU-M | — | itself |
| `README.md` | `--budget`, model limits, `kriya usage` | — | — |

## 2b. Changed in U9 and U10 (2026-11-04, owner-approved in chat)

| Repo | File | Change | Test |
| --- | --- | --- | --- |
| Kriya | `supabase/migrations/20270701000000_model_limits.sql`, `supabase/rollback/…down.sql` (new) | `kriya.models.context_window`, `max_output_tokens` (positive or null) | HU-DB-01 |
| Kriya | `db/schema.ts` | The two columns | typecheck |
| Kriya | `lib/models.ts` | `syncCatalogue` fills them (`positiveInt`) | HU-SYNC-01 |
| Kriya | `lib/config.ts`, `tests/harness/regression.test.ts` | `harness.maxOutputTokens` (default 65536) | HT-REG-01 |
| Kriya | `lib/harness/model-limits.ts`, `gateway.ts`, `metering.ts` | Limits from the table; the gateway's cap from the setting; `MAX_OUTPUT_TOKENS` removed | HU-GW-02, HT-GW-* |
| Client | `src/modes.js` (`switchEnv`), `bin/kriya.js` | Loop and budget on by default; `--no-loop`, `--no-budget`, `--no-anchor`; ACP gets the same defaults | HU-SW-01, all client tests |
| Client | `README.md`, `SAFETY.md`, `package.json`/lock (0.2.0), `.github/workflows/ci.yml` (`dsh-compatibility` job) | Docs, version, CI gate | cli/acp version tests, release gate |
| Client | `tests/{drills,upgrade,loop}-run.test.js` | "Off" arms now pass `KRIYA_*=off` explicitly | themselves |

## 2c. Loop v2 (H14e, 2026-11-04, owner's "Kriya Loop V2" brief in chat; `KRIYA_LOOP_V2.md`)

All behind `--loop-v2` / `KRIYA_LOOP_V2=on`, default off. No Kriya code,
contract, migration or setting changes.

| Repo | File | Change | Must stay true | Test |
| --- | --- | --- | --- | --- |
| Client | `src/failure.js`, `src/rules.js` (new) | Failure classes, excerpts, signatures; proposed/confirmed rules in `~/.kriya/rules/` | No model calls; rules reach prompts only after `kriya rules confirm` | KV2-FC-*, KV2-RL-* |
| Client | `src/loop.js` | `after` (v2 only), `skipped`, attempt snapshots and set-aside restore, rules in builder prompts | v1 plans, prompts and order check unchanged; same attempt and plan bounds | KV2-DAG-*, KV2-BT-01/02, KV2-REG-01, loop tests |
| Client | `src/verify.js` | `onOriginals`; `verifyStep` `v2` option (class, excerpt, originals re-run, rule note) | Without `v2` results and progress records unchanged; git written only on Kriya's own refs (a checkpoint before the swap; no checkpoint, no swap); changed files restored in `finally`; nothing in Read only | KV2-TG-01…04, verify tests |
| Client | `src/checkpoints.js` | `restoreTree`; undo's restore extracted, unchanged | Undo behaviour and the person's HEAD/index/refs unchanged | KV2-BT-03, checkpoints tests |
| Client | `plugins/loop/index.js` | v2 schema/guidance/presentation, snapshot/restore hosts | Off: same tools, schema and guidance | KV2-REG-01, KV2-RUN-02 |
| Client | `src/modes.js`, `bin/kriya.js`, `README.md` | `--loop-v2` switch (default off); `kriya rules [confirm|dismiss|forget]`; help | Other switches and commands unchanged | KV2-REG-01, HU-SW-01, cli tests |
| Client | `tests/loop-v2.test.js`, `tests/loop-v2-run.test.js` (new) | KV2-* | — | themselves |
| Kriya | `docs/kriya-harness/KRIYA_LOOP_V2.md` (new), this file, status files | Docs | — | — |

## 2d. KRHE, Kriya Evolve offline (H16, 2026-11-04, owner's KRHE brief in chat; `RECURSIVE_HARNESS_EVOLUTION.md`)

Offline only: no runtime path, setting, migration, contract or client change.

| File | Change | Must stay true | Test |
| --- | --- | --- | --- |
| `lib/harness/evolve/{profile,gate,propose,compose,library,cli}.ts` (new) | Profiles, gate, proposer, composer, lessons, CLI | No model call; no agent run; writes only the files named; protected controls have no profile field | HU-EV-01…06 |
| `lib/harness/bench/cli.ts` | `--profile`: profile env for the agent, `profile`/`profileId` in the report; refuses switch flags in `--agent` | Without `--profile`, runs and reports unchanged | HU-EV-07, HT-BEN-* |
| `tests/harness/evolve.test.ts` (new) | HU-EV-* | — | itself |
| `docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION{,_RESEARCH}.md`, `krhe/*` (new); `DECISIONS.md` (KU-ADR-19…24); `ENGINE_AND_EVOLUTION.md` §8 (Harness² unknown resolved); status files | Docs and records | — | — |

## 2e. Workspace panel P1, the Overview tab (H19, 2026-11-04, owner in chat; `WORKSPACE_PANEL_SKILLS_PLUGINS.md`)

Client only; read-only; no switch (a new tab, like the Changes tab, changes no agent's prompt or tools).

| File | Change | Must stay true | Test |
| --- | --- | --- | --- |
| `plugins/overview/{index,client}.js`, `package.json`, `src/overview.js` (new) | One GET route and a right-sidebar tab | Reads only; inside Connection's fence; never returns a remote's credentials or the device token; unknown session → 400 | WP-OV-01…04 |
| `src/profiles.js` | Links `@kriya-ai/harness-overview` | Other links unchanged | profiles tests |
| `bundle/cordis.patch.yml`, `expected/*.dump.yml` | `kriya-overview` row; one added row per dump | Nothing else in the dumps changes | HT-REL-03 |
| `plugins/progress/*` (new, P1c) | Progress route and tab | Reads the loop's records only; unknown session → 400 | WP-PG-01/02, WP-TAB-01 |
| `plugins/preview/*` (new, P1c) | Preview tab (browser half only) | Loopback http(s) only, never the Web UI's port | WP-TAB-01/02 |
| `plugins/overview/client.js` (P1c) | "Failed to fetch" shown as a plain sentence | — | — |
| `src/browser.js`, `plugins/browser/*` (new, B2) | The agent's localhost browser and the view's routes | Loopback navigations only, never the Web UI's port; off unless `KRIYA_BROWSER=on`; Read only refuses acting tools | WP-BR-01…04, WP-BR-RUN-01/02 |
| `plugins/preview/client.js` (B2) | "Your app" / "Agent's browser" modes | Frame mode unchanged | WP-TAB-01/02 |
| `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md` (B2) | `playwright-core` 1.64.1 (exact) | Pins and notices gates pass | `check:pins`, `check:notices`, `release:check` |
| `src/modes.js`, `bin/kriya.js`, `README.md` (B2) | `--browser-tools` switch, help, docs | Other switches unchanged | HU-SW-01, cli tests |
| Kriya `docs/kriya-harness/WORKSPACE_PANEL_SKILLS_PLUGINS.md` (new), this file, status files | Docs | — | — |

## 3. Stop conditions

Stop and ask the owner before: editing a protected file; adding a migration
or a setting; any live model call, KriyaBench-R run or device sign-in on
production; a commit, branch, push, merge, publish or deploy; enabling a
switch by default; changing a risk class, approval, cap or price.

## 4. Safe execution rules for agents

1. `git status` first in both repositories; keep the person's changes.
2. Client work happens in a worktree, never in `../kriya-harness` itself:
   the person's `~/.kriya/profiles/*/node_modules` link to that checkout,
   so editing it changes their running agent.
3. Kriya tests with `env -u OPENROUTER_API_KEY`; nothing against `.env` or
   `.env.local` (operator rule 6).
4. Never weaken an assertion to pass; never skip a failing test without
   recording why.
