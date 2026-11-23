# Harness 2.0: change impact and safe execution

Read **before editing any existing file**, in either repository. Track H's
`CHANGE_IMPACT_AND_SAFETY.md`, the harness upgrade's, track E's and every
other track's protections still apply; where a file is listed by several
tracks, all rules hold and it is held on the shared board in `status.md`.
A change not listed here needs the owner's approval and a row first.

## 1. Protected (no Harness 2.0 exception)

`lib/auth.ts`, `lib/agent/policy.ts`, `lib/agent/tools.ts`,
`lib/agent/metering.ts`, `lib/agent/queue.ts`, `lib/agent/run-task.ts`,
`lib/connectors.ts`, `lib/connectors/*`, `lib/memory/*`,
`lib/skill-library.ts`, `lib/skill-engine.ts`, `lib/harness/gateway.ts`,
`lib/harness/metering.ts`, `kriya.charges`, `kriya.usage_events`,
`lib/harness/evolve/gate.ts` (reused as is), the browser service and its
egress guard. Client: `src/modes.js` `MODES`, approvals, sandbox rows in
`bundle/cordis.patch.yml`, `src/checkpoints.js`, `src/verify.js`
`MAX_ATTEMPTS`, `src/loop.js` `MAX_STEPS`. DSH itself (never edited).

## 2. Kriya-Tavi: existing files that change

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `skills-harness/index.ts` | W1 | New export `HARNESS_ROLE_SKILL_MANIFESTS` (15 cartridges in W1; `kriya-role-graphics` joins in W13) | `HARNESS_SKILL_MANIFESTS`, `HARNESS_EDIT_SKILL_MANIFESTS` unchanged | WT-SK-01; ET-SK-02 |
| `lib/harness/default-skills.ts` | W1 | `HARNESS_ROLE_DEFAULTS` built together with the existing sets (no id twice); `defaultSkillSet()` adds them only with `harness.workforce` on | Off → exactly today's set (`HARNESS_DEFAULTS` or with edit skills) | WT-SK-02; ET-SK-02 |
| `lib/harness/skills.ts` | W1, W11 | W1: cartridge items get `cartridge` and `invocation` fields with the switch on. W11: overlay versions with `harness.cartridgeOverlay` on | Off → same response and ETag as today | WT-SK-03, WT-OV-01 |
| `lib/harness/contract.ts` | W1, W2, W11 | Optional fields of DATA_MODEL §4 on `ModelsResponse`, `SkillsResponse` items, `TurnRequest` | Every existing field and strictness unchanged | WT-CT-01; HT-API-* |
| `scripts/harness-contract.ts`, `docs/kriya-harness/contract.json` | W1, W2, W11 | Export the new optional fields and the cartridge id lists | Existing exported schemas unchanged | Regenerated file diff reviewed; client `check:seams` |
| `app/api/harness/v1/models/route.ts` | W2 | The `orchestra` and `workforce` advertisement | Off → byte-identical body | WT-ORC-03 |
| `app/api/harness/v1/sessions/[id]/turns/route.ts`, `lib/harness/mirror.ts` | W11 | Write `cartridgeOutcomes` counts via `withUser(device.id)` when all of DATA_MODEL §4's conditions hold | Turn handling and idempotency by `seq` unchanged | WT-OV-03; existing mirror tests |
| `lib/config.ts` | W1, W2, W7 | The eight keys of DATA_MODEL §3 in the Kriya Harness block | Existing keys and defaults unchanged | HT-REG-01 (updated list) |
| `tests/harness/regression.test.ts` | W1, W2, W7 | HT-REG-01's key list gains the eight keys with their defaults | Existing assertions unchanged | Itself |
| `db/schema.ts` | W7 | Mirrors of the new tables; `'scout_model'` in `resourceUsage.kind` | Existing definitions unchanged | Typecheck; WT-DB-01 |
| `tests/db/migrations.test.ts` | W7 | Down/up case for `20271201000000` | Existing cases unchanged | Itself |
| `worker/index.ts` | W7 | One `schedulerLoop` statement after the fact job, behind `harness.scout`, errors caught; one `janitor()` statement deleting snapshots older than 30 days | Other steps unchanged; a scout failure never stops the loop | WT-SC-07 |
| `lib/harness/evolve/profile-schema.ts`, `lib/harness/evolve/profile.ts` | W10 | Fields `cartridges`, `orchestra`, `gates`, `critic`, `milestones` (boolean, default false, left out of the id when false) and `escalateAfter` (0–4, left out when 2) | Every existing profile id unchanged (HU-EV-01's recorded ids) | HU-EV-01, WT-EV-01 |
| `lib/harness/evolve/propose.ts` | W10 | The new fields as one-factor moves | Same candidates for profiles without them (HU-EV-03) | HU-EV-03, WT-EV-02 |
| `lib/config.ts`, `tests/harness/regression.test.ts` | W16 | `harness.mcp` (off; needs `next.mcp`) and its HT-REG-01 entries. Owner approval 2026-11-23 (W16 instructions: "MCP P3a: delivery of registry servers") | Existing keys and defaults unchanged | HT-REG-01 |
| `lib/harness/contract.ts`, `docs/kriya-harness/contract.json` | W16 | `McpServersResponse` and the `GET /mcp` route entry, regenerated | Every existing schema and route unchanged | WT-MCP-01; HT-API-01 |
| `lib/harness/bench/cli.ts`, `lib/harness/bench/seed.ts` | W8, W9 | `--level role-<role>`; `--cartridge-candidate <file>` sets `KRIYA_BENCH=on` and `KRIYA_CARTRIDGE_FILE` | Existing levels, flags, seeds and their hashes unchanged | HT-BEN-*, WT-BEN-01 |
| `components/owner/nav.tsx` | W7 | One link "Evolve" → `/owner/harness` (a static list like every other section; the page says when the Scout is off, RA-62) | Other links unchanged | Browser check (owed, OR-19) |
| `AGENTS.md` | W0 | A short "Harness 2.0" paragraph under track H pointing here; the owner applies it | Other text unchanged | — |
| `status.md` | every phase | Own rows under track H | Others untouched | — |

**New files (no row needed):** `docs/kriya-harness/upgrade_2.0/**`,
`skills-harness/kriya-role-*/**`, `lib/harness/cartridges.ts`,
`lib/harness/cartridge-ids.ts`,
`lib/harness/scout/**`, `app/owner/harness/**`, `actions/harness-evolve.ts`,
`queries/harness-evolve.ts`, `components/owner/harness-evolve/**`,
`lib/harness/bench/seed-role-*.ts`, `lib/harness/mcp.ts`, `app/api/harness/v1/mcp/route.ts` (W16), `tests/harness/workforce/**`,
`tests/db/harness-workforce-rls.test.ts`,
`supabase/migrations/20271201000000_harness_workforce.sql`.

## 3. kriya-harness (client): existing files that change

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `src/modes.js` | W1–W10 | `SWITCHES` gains `cartridges`, `orchestra`, `gates`, `critic`, `milestones`, all default **false**, each needing the loop | Existing switches, defaults and `MODES` unchanged | WT-REG-01; existing modes tests |
| `src/launch.js` | W2 | Read `orchestra` from `GET /models` into `KRIYA_ORCHESTRA_HEAD` / `KRIYA_ORCHESTRA_WORKER` (aliases only, checked against `allowed`) | Absent field → env unchanged | WT-ORC-04 |
| `plugins/loop/index.js` | W1–W10 | With each switch on only: `role`/`contracts`/`spec_tests` on plan steps (`PLAN_STEP_W`); `agentOptions.model` in `spawn`; `kriya_advise` for builders; gates in `verify`; critic after pass; `kriya_milestones` | Off → tool schemas, guidance and spawn request byte/structurally identical | WT-REG-02, WT-ORC-01; every existing loop test |
| `src/loop.js` | W1, W2, W6 | `builderPrompt` section order of ORCHESTRA §6 **only** with cartridges on; `runStep` gains optional `tierFor` and `afterPass` inputs; with `tierFor` given, an `untouched` stall yields one head-tier attempt first (ARCHITECTURE §5) | Off → v1/v2 prompts byte-identical; the loop guard's stall rule unchanged; attempt and plan bounds unchanged | KV2-REG-01; WT-REG-02 |
| `src/verify.js` | W3, W5 | `verifyStep` calls `runGates` when given; class `contract changed` recorded; `expect: "red"` for spec-test steps reusing the existing red-phase code (`onOriginals`) | Without gates or `expect` → identical results; `MAX_ATTEMPTS` unchanged; the surgical-bugfix red proof unchanged | Existing verify tests; WT-GATE-00; WT-PLAN-05 |
| `src/failure.js` | W3 | Class `contract changed` (rank 3) | Existing classes, ranks and signatures unchanged | KV2 failure tests |
| `plugins/kriya-tools/index.js` (`kriyaSkills`) | W1 | `candidate()` hard-codes `invocation: { modelInvocable: true, userInvocable: true }` (found in W0 S4); with `harness.workforce` items carrying `invocation`, use `modelInvocable: skill.invocation?.modelInvocable !== false`. The loop loads cartridge bodies through this provider's own `get`, not DSH's skill tool, because DSH keeps `modelInvocable: false` skills out of model-facing catalogues (`dsh-skill` README) | Items without `invocation` map exactly as today | WT-SK-04 |
| `plugins/browser/*` / `src/browser.js` | W4 | Export the existing localhost guard for gates; add a headless page-report function used by G-UI | Browser tools, Preview and their guard unchanged | Existing browser tests; WT-GATE-UI-* |
| `bin/kriya.js` | W4, W5, W11, W17, W19 | `kriya stack use|show|forget`, `kriya eval baseline confirm`, `kriya share on|off|status` (W11, default off), `kriya receipt make|verify` (W19, on request only), `kriya release use`, `kriya doctor --gates`, `kriya report` (W17) | Existing commands unchanged | WT-CLI-01 |
| `contract/contract.json`, `contract/SOURCE.md` | W1+ | A fresh copy of Kriya's export (now with `cartridgeIds`) and its sha256 in `SOURCE.md`, in the same change | Existing routes and schemas unchanged | `tests/contract.test.js` (the recorded-copy hash) |
| `src/cartridges.js` (`cartridgeSource`) | W9 | With `process.env.KRIYA_BENCH === "on"` and `KRIYA_CARTRIDGE_FILE` set (only the bench runner sets them, after checking the file's sha256), `body(c)` returns the candidate file's `body` for the cartridge whose id matches `cartridgeId` (sha256 checked again); every other cartridge is fetched as before. Owner approval 2026-11-23 (OR-20) | Without `KRIYA_BENCH=on`, `KRIYA_CARTRIDGE_FILE` is never read; normal builder prompts unchanged | WT-CAR-10 in `tests/workforce-cartridges.test.js` (WT-CAR-06 was already the glob test) |
| `plugins/loop/index.js` (`kriya_step`) | W11 | With cartridges on, after a step: `recordOutcome(builder's cartridge@version, status)`; a no-op unless the person ran `kriya share on`. Owner approval 2026-11-23 ("Approve, start W11") | The step's result, its rendering and every other tool unchanged | WT-OV-C2 |
| `plugins/mirror/index.js` | W11 | Asks `GET /models` once; only with its `workforce: 1` and the share opt-in, a turn carries `cartridgeOutcomes` (counts only); counts not stored go back for a later turn. Owner approval 2026-11-23 | Turns without counts are byte-identical; queueing, retry and drop unchanged | WT-OV-C3; existing mirror tests |
| `scripts/check-seams.js` | W16 | A 16th seam: `createMcpToolDefinition` exported by `dsh-mcp-client` (used by `plugins/mcp`) | The other seams unchanged | `check:seams` |
| `plugins/repo/*` (`pr_create`) | W19 | The draft pull request's body starts with the session's proof receipt (DIFFERENTIATORS D1), then the branch section and the agent's notes | Only with repository tools on; every other repository rule unchanged | WT-RCP-06; WT-REPO-14 |
| `scripts/check-seams.js` | W17 | A 17th seam: `tools.guard` (a synchronous guard's reason denies a call), used by `plugins/deploy` for WD-22's refusals | The other seams unchanged | `check:seams` |
| `contract/schemas/` | W3 | JSON Schemas for contracts (GATES §4) | — | `check:seams` |

| `src/modes.js` | W13–W19 | `SWITCHES` gains `explore`, `grounding`, `repo-tools`, `mcp`, `deploy`, `runstrip` (all default false) | Existing switches unchanged | WT-REG-01 |
| `src/verify.js` | W16 | `onOriginals` and the strict-loop helpers' `HEAD:` reads in the same file (`src/verify.js` ~l.300–342; `src/strict.js` has none) take an optional `base` (default `"HEAD"`); `kriya_plan` records `base` in the ledger | Without repository tools every call passes `"HEAD"`: identical behaviour | KV2 originals tests; strict tests; WT-REPO-15 (a committed weakened test still fails against `base`) |
| `src/browser.js` | W4, W13 | **As built in W4: unchanged.** Gates import its exported `localUrl` and `browserTarget` and launch their own browser (`src/gates/page.js`, RA-47) | The agent's browser, its tools and the localhost guard unchanged | Existing browser tests; WT-GATE-UI-* | Agent browser tools and their localhost guard unchanged; the hook never runs on the agent's own pages | WT-GATE-3D-00; existing browser tests |
| `plugins/overview/*`, `plugins/progress/*`, `plugins/preview/*`, `plugins/changes/*` | W18 | Become the Project, Proof, Live, Changes tracks with the switch on; old ids aliased for one release | Off → today's tracks unchanged | WT-UX-*; existing tab tests |
| `src/doctor.js` | W17 | Gate self-tests and the capability matrix | Existing doctor checks unchanged | WT-DOC-01 |
| `src/gates/{index,detectors,page}.js`, `src/contracts.js`, `src/doctor.js`, `contract/schemas/scene_direction.json` | W13 | G-3D in `BUILT` and the runner; five detectors (GX-COLOR, GX-ALLOC-LOOP, GX-NO-DISPOSE, GX-DPR, FE-ASSET-LICENCE) and the asset licence list from `scene_direction.json`; `withGateBrowser` also passes its browser to the callback; the `scene_direction` contract; a G-3D matrix row. Owner approval 2026-11-23 (WD-17) | Existing gates, detectors, contracts and matrix rows unchanged; the extra callback argument is ignored by existing callers | WT-GATE-3D-00…10; WT-GX-01…07; WT-DET-01; WT-DOC-02 |
| `src/loop.js` (`validatePlan`, `runStep`), `plugins/loop/index.js` | W14 | `explore` on plan steps (2–3, roles frontend/designer/graphics) only with the option; `runStep`'s optional `explore` input runs `exploreTakes` for such a step; the plan tool's `explore` field, the explore host and `askTake` only with `KRIYA_EXPLORE=on` and cartridges on. Owner approval 2026-11-23 (WD-18) | Off: plan validation, tool schemas, `runStep` and step results unchanged; attempt bound unchanged | WT-EXP-01…07; every existing loop test |
| `src/profiles.js` (the package map) | W13–W19 | One line per new plugin, mapping its `@kriya-ai/harness-<name>` to `plugins/<name>`: the bundle row's companion, without which the row can't load (found in W15) | Existing entries unchanged | `check:seams`; HT-REL-03 dumps |
| `bundle/cordis.patch.yml`, `expected/*.dump.yml` | W13–W19 | One row per new plugin, behind its switch; MCP client row (P3a) | Existing rows unchanged; dumps reviewed | `check:seams` |

| `tests/fake-kriya.js` | W2 | `/models` returns `orchestra` when a test passes `script.orchestra` | Every existing test's fake behaviour unchanged | The full client suite |
| `src/launch.js` | W2 | `planTiers` reads `orchestra`; `launchEnv` gains an optional ninth argument and never takes the levels from the shell; `runDsh` starts on the head with `--orchestra` and the advert | Without the advert or the switch, env and start tier as before | WT-ORC-04; existing launch tests |

**New client files:** `src/orchestra.js`, `src/contracts.js`,
`src/milestones.js`, `src/outcomes.js`, `src/critic.js`, `src/gates/**`, `src/stack.js`,
`src/explore.js`, `src/receipts.js`, `src/release.js`, `plugins/repo/**`,
`plugins/grounding/**`, `plugins/mcp/**`, `src/mcp.js`, `plugins/deploy/**`, `plugins/runstrip/**`,
`plugins/missions/**`,
`tests/workforce/**`, `tests/fixtures/gates/**`.

## 4. Stop conditions

Stop and ask the owner when a change would: touch a §1 file; raise
`MAX_STEPS`, `MAX_ATTEMPTS`, a cap or a price; let any gate run against a
non-loopback address; let a model write a command a gate runs; serve a
scouted change without the owner's approval; run KriyaBench or any agent
command on Kriya's servers; make a real paid model call or benchmark
without the owner's go-ahead; run anything locally against the live
database (`.env`, `.env.local`); need a secret; or need a DSH change.
