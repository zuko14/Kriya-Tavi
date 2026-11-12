# Change impact and safe execution (track E)

What track E may touch, how, and the regression test for each. **Read before
editing any existing file**, in either repository. A change not listed in §3 or §4
needs the owner's approval and a row here first. Where another track also lists a
file, all rules apply; hold it on the shared board.

Verified line by line against Kriya `d46bb0c` and client `0ebfd0c` on 2026-11-07
(FORENSIC_AUDIT.md). The first version of this document had errors that would have
broken CI and live workflows; those are recorded there.

## 1. Protected

Everything protected by tracks A, O, N, voice, C, H, R and S, plus:

| Path | Track E's only exception |
| --- | --- |
| `lib/agent/tools.ts` | **ED14, owner-approved EDD-28:** re-export `createEditTools`; two names in `SIDE_EFFECT_TOOLS` |
| `lib/agent/policy.ts` | **ED14, owner-approved EDD-30:** rows in `TOOL_CLASSES`, `TOOL_WRITES` |
| `lib/agent/capabilities.ts` | **ED14:** `System` value `device`; `FACTS` rows with no pins |
| `lib/agent/run-task.ts` | **ED14, owner-approved EDD-28:** one spread on the belt, behind `editing.tavi`. `TOOL_APPROVALS` isn't edited: it derives from `TOOL_CLASSES` |
| `lib/agent/queue.ts`, `lib/agent/instructions.ts` | None |
| `lib/agent/metering.ts`, `kriya.charges`, `kriya.usage_events` | None |
| `lib/connectors.ts`, `lib/connectors/*` | None |
| `lib/auth.ts` | None |
| `lib/memory/*` | None |
| `lib/files.ts`, `lib/templates.ts`, `skills/index.ts` | None (EH-11, EH-12, EH-24) |
| `lib/harness/gateway.ts`, `lib/harness/metering.ts`, `lib/harness/route.ts` | None: the Director is an ordinary client |
| `actions/harness-control.ts` | None: `queue()` refuses the kind instead |
| `information.md` | None: the owner's brief stays as written |
| Client: `src/loop.js`, `src/verify.js`, `src/checkpoints.js`, `src/failure.js`, `src/world.js`, `src/gateway-proxy.js` | None. The Edit Host starts its own relay with the exported `startGatewayProxy`, unchanged |
| DeepSeek Harness packages | None, ever (track H rule 5) |

## 2. Prerequisites

| Id | Change | Test |
| --- | --- | --- |
| EDP-1 | Re-run `env -u OPENROUTER_API_KEY npm run check` here and `npm run check` in the client; record counts | Exit 0, counts ≥ baseline |

## 3. Existing files that change: this repository

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `AGENTS.md` | ED0 | The "Editing Studio (track E)" section | Other text unchanged | — |
| `status.md` | every phase | Own row, own section, board row | Others untouched | — |
| `lib/config.ts` | ED2, ED7, ED13, ED14, ED15 | The `editing.*` block (§8) | Existing keys untouched | Readiness test; ET-REG-01 |
| `app/owner/config/page.tsx` | ED2 | One `GROUPS` entry "Editing Studio" | Existing groups unchanged | Existing tests |
| `lib/harness/contract.ts` | ED2, ED14, ED15 | Routes in `ROUTES`; `edit` in `DispatchKind`, `DispatchPayloads`; `edit` **optional** in `DaemonCapabilities` | Existing shapes unchanged | HT-API-01; ET-API-01 |
| `docs/kriya-harness/contract.json` | ED2, ED14, ED15 | Regenerated | Existing entries stable | HT-API-01 |
| `lib/harness/control.ts` | ED14, ED15 | `Capabilities` gains `edit`; `queue()` refuses the kind; new `queueEdit()`, with an `also` step in its transaction (ED15: a sent note or a tapped card moves with the job, so a double tap starts one); `DeviceUser` a local type, so the worker's import graph doesn't reach `lib/auth` (T-IMP-01) | Every other kind's path unchanged | ET-TV-01; existing control tests |
| `components/harness/control-center.tsx` | ED14 | One `KIND_LABEL` entry | Nothing else | Typecheck |
| `db/schema.ts` | ED14, ED15 | `HARNESS_DISPATCH_KINDS` gains `edit`; `editJobs`, `editDeliverables`, `editQuestions`, `editNotes`; `plans.editingPreviewBytes`; `edit_preview_bytes` in `resourceUsage.kind` | Existing definitions unchanged | Typecheck; ET-REG-01 |
| `tests/db/migrations.test.ts` | ED14, ED15 | Down and up cases; older cases roll track E back first | Existing assertions unchanged | Itself |
| `tests/db/harness-control.test.ts` | ED14, ED15 | Its rollback case rolls track E back first | Other assertions unchanged | Itself |
| `tests/operator/capabilities.test.ts` | ED14 | `createEditTools` in `everyTool()` | Other assertions unchanged | Itself |
| `worker/index.ts` | ED14 | Imports of `reviewEdits` and `previewJanitor`, `void editLoop()` behind `editing.tavi`, one `janitor()` statement | Other loops unchanged; errors caught | ET-TV-02, -05 |
| `components/thread/tool-call.tsx`, `components/workbench/activity.tsx` | ED14 | Entries for the four tools | Other entries unchanged | ET-UI-06 |
| `queries/features.ts` | ED14 | `editing: boolean` from `editing.tavi` | Others unchanged | ET-REG-01 |
| `components/workspace/places.ts` | ED15 | An Edits place behind `features.editing` | Off → no entry | ET-REG-01 |
| `components/dialogs/agent-dialog.tsx` | ED14 | A Video editor preset when `features.editing` is true | Off → same dialog | ET-REG-01 |
| `proxy.ts` | ED15 | `"/edits"` in `PROTECTED` | Every other path unchanged | Existing proxy tests |
| `queries/inbox.ts`, `app/(workspace)/inbox/page.tsx` | ED15 | Decision cards with `editing.review` on | Off → identical | ET-UI-06 |
| `app/(workspace)/harness/page.tsx` | ED14 | An Edits list with `editing.tavi` on | Off → same page | ET-UI-06 |
| `actions/owner.ts`, `components/owner/forms.tsx` | ED14 | Plan field in MiB | Other fields unchanged | Existing owner tests |
| `skills-harness/index.ts`, `skills-harness/NOTICES.md` | ED13 | The `kriya-edit-*` manifests in a **separate export** | Existing set unchanged | ET-SK-02; HT-DS-01/02 |
| `lib/harness/default-skills.ts` | ED13 | Adds the set only with `editing.skills` on | Off → identical | ET-SK-02 |
| `lib/harness/skills.ts` | ED13, **owner-approved 2026-11-08 in chat** | `deviceSkills()` takes its default set from `defaultSkillSet()` instead of the `HARNESS_DEFAULTS` constant (two lines) | Off → the same object, the same list | ET-SK-02; HT-DS-02 |
| `lib/config.ts`, `lib/harness/contract.ts`, `docs/kriya-harness/contract.json` | EV1, **owner-approved 2026-11-09 in chat** | `editing.visuals`, `editing.playbooks`, `editing.mediaSearch`, off; routes `GET /editing/features`, `POST /editing/media`, `POST /editing/define`; regenerated | Existing keys and shapes unchanged | ET-VS-REG-01; HT-API-01 |
| `lib/config.ts`, `lib/harness/contract.ts`, `docs/kriya-harness/contract.json`, `app/api/harness/v1/editing/features/route.ts`, `tests/editing/features.test.ts` | MG1, **owner-approved 2026-11-10 in chat** | `editing.motion`, off; `motion` and `customMotion` added to the features answer; regenerated | Existing keys unchanged; an older client ignores the two fields | ET-MG-REG-01; HT-API-01 |
| `lib/config.ts`, `lib/harness/contract.ts`, `docs/kriya-harness/contract.json`, `app/api/harness/v1/editing/features/route.ts`, `tests/editing/features.test.ts` | TP1, TP3…TP8. **`editing.assembly` (TP1): owner-approved 2026-11-10 in chat, with EDD-59, -60, -62; built. `editing.livePreview` (TP3): owner-approved 2026-11-11 in chat, with EDD-63; built. `editing.intent` (TP4): owner-approved 2026-11-11 in chat, with EDD-61; built. `editing.craft` (TP5): owner-approved 2026-11-11 in chat, with EDD-64; built for TP5. `editing.typeKit` (TP7): owner-approved 2026-11-11 in chat, with EDD-67; built. `editing.referenceIntent` (TP6): owner-approved 2026-11-11 in chat, with EDD-65 (EDD-66 refused: no reference frame to a model); built.** **`editing.directorLoop` (TP8): owner-approved 2026-11-11 in chat, with EDD-68; built.** | `editing.assembly`, `editing.livePreview`, `editing.intent`, `editing.craft`, `editing.referenceIntent`, `editing.typeKit`, `editing.directorLoop`, all off; each name added to the features answer | Existing keys, routes and shapes unchanged; off → the same answer as before for an older client | Readiness test; ET-ASM-REG-01, ET-PV-REG-01, ET-NL-REG-01, ET-FX-REG-01, ET-RF2-REG-01, ET-TY-REG-01, ET-DL-REG-01 |

| `lib/editing/manifest.ts`, `tests/editing/manifest.test.ts` | TP7 (EDD-67, approved 2026-11-11 in chat) | `2026.11.1` added to `RUNTIMES` with `signature: null`; a new pinned file `lib/editing/runtime/manifest.2026.11.1.json` (2026.11.0 plus `platforms.<id>.packs["pack-fonts"]`, nothing else); tests for the pack and an ephemeral signing key | `2026.11.0` and its signature unchanged; `CHANNELS` still name only `2026.11.0`; no unsigned version is ever served | ET-API-01, ET-API-04, ET-TY-REG-02's server half |
| `lib/harness/contract.ts`, `docs/kriya-harness/contract.json`, `app/api/harness/v1/editing/features/route.ts`, `tests/editing/features.test.ts` | TP11, **owner-approved 2026-11-12 in chat (EDD-28 stands)** | `taviOrder` in the features answer (true only with `editing.tavi` and `editing.assembly` on); optional `DaemonProject.clips` (≤ 50 of `{ n, label? }`, strict); `order` in `EditingQuestionRequest.kind`; regenerated | Every existing field, route and shape unchanged; an older client ignores `taviOrder`; a client sends `clips` only after `taviOrder: true` (rule 17), so an older server never sees it | Features shape tests; `tests/editing/review.test.ts` (TP11 block); `tests/harness/*` |
| `db/schema.ts`, `lib/editing/review.ts` | TP11, owner-approved 2026-11-12 | `editQuestions.kind` and `askQuestion`'s type gain `order` | Other kinds, RLS, grants and the answer path unchanged | `tests/editing/review.test.ts` |
| `lib/editing/tools.ts` | TP11, owner-approved 2026-11-12 | `video_edit_places` lists a folder's advertised clips (number and label, under `FOREIGN`) only with `editing.assembly` on; `video_edit_start`'s description says a brief may name an order by them | Inputs, approvals (`TOOL_CLASSES`), the queue and `lib/agent/*` unchanged | `tests/editing/review.test.ts`, `tests/editing/tavi.test.ts` |
| `supabase/migrations/20271104000000_editing_order.sql`, `supabase/rollback/20271104000000_editing_order.down.sql` (new), `tests/db/migrations.test.ts`, `tests/db/harness-control.test.ts` | TP11, owner-approved 2026-11-12 | The `edit_questions_kind_check` constraint widened to `order`; its rollback (removes order cards, restores the old rule); the rollback tests run it first and apply it last | The table, RLS and grants identical; no applied migration edited | `tests/db/migrations.test.ts`, `tests/db/harness-control.test.ts`, `tests/db/editing-rls.test.ts` |
| `tests/editing/order-card.test.ts` (new) | TP11 | The order card rendered by `EditCardView` (unchanged: it draws any decision card) | — | itself |

`tests/harness/regression.test.ts` needs no change: it filters on `harness.` (EH-31).

## 4. Existing files that change: `kriya-harness`

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `src/modes.js` | ED2 | `["edit", "KRIYA_EDIT", false]` | Other switches and defaults unchanged | `modes.test.js`, `loop-guard.test.js` |
| `bin/kriya.js` | ED2, ED14 | `case "edit"`; `--edit`, `--no-edit` labels; `--allow-edit` on `daemon` | Other commands unchanged | `cli.test.js` |
| `bundle/cordis.patch.yml` | ED6 | One `kriya-edit` row in the Web UI's group | Other rows unchanged | HT-REL-03, ET-REG-02 |
| `expected/*.dump.yml` | ED6 | The reviewed row | Nothing else | HT-REL-03 |
| `src/profiles.js` | ED6 | `@kriya-ai/harness-edit` in `LINKED` | Others unchanged | `profiles.test.js` |
| `scripts/check-seams.js` | ED6 | The two seams used: `sidebar.panellist`, `connection.fetch.register` | Existing seams unchanged | HU-SEAM-01 |
| `package.json`, `package-lock.json` | ED6, ED16 | `files` gains `studio/dist/`; exact-pinned build dependencies; `test:media`, `build:studio`; ED16: `bench:m` | Existing pins unchanged | `check:pins` |
| `THIRD_PARTY_NOTICES.md`, `notices-exceptions.json` | ED6 on | New entries, from esbuild's metafile | Others unchanged | `check:notices`; ET-LIC-01 |
| `SAFETY.md`, `README.md` | ED7, ED14 | Editing sections | Other text unchanged | — |
| `src/daemon.js` | ED14, ED15 | ED15: passes a revision's fields; wakes the Host for a watched folder at each hello, lazily. ED14: `allowEdit` beside `allowServe`; capability sent only after `/editing/manifest` answered 200; `edit` kind hands to the Host; `editing` set checked **first** in the cancel loop; `serving` remembers its dispatch id, so with `KRIYA_EDIT` on an unknown cancel goes to the Host and never reaches `kriya serve`; `control.update` sets it | `running`, `MAX_RUNNING` and every other kind's path unchanged | ET-DMN-01…05; `daemon*.test.js` |
| `plugins/remote/index.js`, `plugins/overview/client.js` | ED14 | **Allow editing from Kriya** beside Allow serving, same rules (RC-D1) | Existing toggles unchanged | `remote.test.js` |
| `contract/contract.json` | ED14, ED15, EV1, MG1, TP1…TP8, TP11 | Regenerated | Existing entries unchanged | `contract.test.js` |
| `src/daemon.js` | TP11, **owner-approved 2026-11-12 in chat** | After `/editing/manifest` answered 200, asks `/editing/features` (lazy `src/edit/runtime/fetch.js`); only on `taviOrder: true` each offered folder's `clips` (lazy `src/edit/host/clips.js`: numbers and the person's labels, never paths, file names or references) go in the hello | With `KRIYA_EDIT` off or editing not allowed: no request, no field, the hello it always sent; `running`, `MAX_RUNNING` and every other kind unchanged | `tests/edit-tp11.test.js`, `tests/edit-daemon.test.js`, `tests/edit-imports.test.js` (two lazy lines added to its list) |
| `scripts/notices.js`, `scripts/runtime-fonts.json` (new), `scripts/OFL-1.1.txt` (new) | TP7 (EDD-67) | One more section, "Fonts in the Media Runtime's font pack", from the two data files beside it (each font's copyright line; the OFL 1.1 text). Read, never imported from `src/edit` (ET-IMP-01); `tests/edit-type.test.js` holds the list to `src/edit/engine/fonts.js` | The lockfile sections and their checks unchanged | `check:notices`; HT-REL-01, -02; ET-LIC-01 |
| `bin/kriya.js` | Live Director (2026-11-12), **owner-requested in chat** ("the terminal command should open the editing studio, not Kriya Harness") | The `case "edit"` refusal line now reads "Editing is off. Run kriya edit --edit to open the Editing Studio, or set KRIYA_EDIT=on." (it said "add --edit", which people typed as `kriya --edit`, the harness). `kriya edit` itself opens the Studio from `src/edit/runtime/cli.js` (§5): in a terminal it opens the link in the browser; piped, or with `--no-open`, it prints only the link as before | Every other command, flag and the `--edit` Web UI path unchanged; the message still starts "Editing is off" | `edit-runtime.test.js`; `tests/edit-live-studio.test.js` ET-LS-08; `tests/edit/media/host.test.js` (piped: the bare link) |

`src/doctor.js` doesn't change: `kriya edit doctor` is its own command.

**Never:** edit anything in `node_modules/@deepseek-ai`, change a default of an
existing switch, change the agent's prompt or tools with `KRIYA_EDIT` off, or import
anything under `src/edit/` from outside it except by a lazy `import()` behind the
switch.

## 5. New files (no row needed)

This repository: `lib/editing/**`, `actions/editing.ts`, `queries/editing.ts`,
`app/api/harness/v1/editing/**`, `app/api/editing/**`, `app/(workspace)/edits/**`,
`components/editing/**`, `skills-harness/kriya-edit-*/**`, `tests/editing/**`,
`tests/db/editing-rls.test.ts`, `supabase/migrations/20271101000000_harness_dispatch_edit.sql`
and `supabase/migrations/20271102000000_editing_tables.sql` (ED14, by the owner's brief),
`supabase/migrations/20271103000000_editing_review.sql` (ED15), with their rollbacks,
`docs/kriya-harness/kriya_video_editing/**`, `screenshots/kriya-editing/**`.

Client: `plugins/edit/**`, `studio/**`, `src/edit/**`, `bench/edit/**`,
`tests/edit-*.test.js`, `tests/edit/**`.
ED17, named in the owner's brief (2026-11-08): `scripts/audit-secrets.js` (EG-2's audit; run by
`tests/edit-security.test.js`, not wired into `package.json`).

## 6. Dependencies

| Where | What | Rule |
| --- | --- | --- |
| Client `dependencies` | Nothing heavy | Exact pins; notices |
| Client `devDependencies` | `esbuild`, React, Mediabunny, `@hyperframes/player` | Bundled into `studio/dist`; every bundled module recorded through the metafile (EH-30) |
| Media Runtime | FFmpeg, Python packages, HyperFrames, Chrome, weights | In the manifest, never in `package.json` |
| This repository | None | No new package is needed |

## 7. Cross-track check

| File | Others holding it | Conflict? |
| --- | --- | --- |
| `lib/config.ts`, `db/schema.ts` | Every track | Hot spots; hold briefly |
| `lib/harness/contract.ts`, `lib/harness/control.ts` | H, S | Additive; a new kind only |
| `lib/agent/tools.ts`, `policy.ts`, `run-task.ts` | A, C, N, R, S | Owner-gated rows; one session |
| `worker/index.ts` | A, O, N, voice, C, S | One loop, one statement |
| `queries/inbox.ts`, `queries/features.ts` | A, N, H, R, S | Additive behind a switch |
| `proxy.ts` | Voice, A5, H, R, S | Separate list entry |
| `app/(workspace)/harness/page.tsx`, `components/harness/control-center.tsx` | H, S | Additive |
| `skills-harness/*` | H | A separate export |
| Client `src/daemon.js` | H, S | One branch, plus the cancel order |
| Client `bundle/cordis.patch.yml`, `expected/*` | H | One row |

**Naming** (EF-27): `studio.*`, `lib/flows/**` and `docs/kriya-studio/` are Flows.
Track E uses `editing.*`, `lib/editing/**`, and the client's `edit` names. The client
folder `studio/` holds this track's app, and is unrelated to Flows' worktree name.

## 8. Settings

All default off or to a safe value.

| Key | Default | Meaning | Phase |
| --- | --- | --- | --- |
| `editing.studio` | off | The Studio may run; the manifest route answers | ED2 |
| `editing.runtimeChannel` | `stable` | Which manifest is served | ED2 |
| `editing.frameVision` | off | Contact sheets may go to the model, with the project's consent | ED7 |
| `editing.customMotion` | off | Model-written compositions, inside confinement | ED8 |
| `editing.skills` | off | Serve `kriya-edit-*` | ED13 |
| `editing.generative` | off | A stock narrator and generated images (EDD-24) | ED13 |
| `editing.urlImport` | off | Owner-gated link import (EDD-22) | ED13 |
| `editing.tavi` | off | Tools, dispatch kind, `editLoop` | ED14 |
| `editing.previews` | off | Preview upload | ED14 |
| `editing.previewMaxBytes` | `47185920` | 45 MiB per file (EH-23) | ED14 |
| `editing.previewDays` | `14` | Retention | ED14 |
| `editing.dailyJobs` | `20` | Tavi jobs per person per day | ED14 |
| `editing.jobLostMinutes` | `30` | Silence before `lost` | ED14 |
| `editing.review` | off | Review Room, decision cards, notes | ED15 |
| `editing.watchFolders` | off | New-recording cards | ED15 |
| `editing.visuals` | off | The Director proposes animated explainer scenes (VISUAL_SCENES.md) | EV1 |
| `editing.playbooks` | off | The Director names the genre and follows its playbook (DIRECTOR_PLAYBOOKS.md) | DP1 |
| `editing.mediaSearch` | off | Licensed pictures and cited definitions (EDD-52, EDD-57) | DP4, DP6 |
| `editing.motion` | off | The motion kit: the Director proposes graphics and chat adds them (MOTION_GRAPHICS.md, EDD-58) | MG1 |
| `editing.assembly` | off | Storyboard, mentions and the assembly make (ASSEMBLY_AND_INTENT.md, EDD-59; approved 2026-11-10, TP1 built) | TP1, TP2 |
| `editing.livePreview` | off | The monitor draws tiles, transitions, looks and sound; partial re-render (EDD-63; approved 2026-11-11, TP3 built) | TP3 |
| `editing.intent` | off | The intent frame, questions, hold to talk (EDD-61; approved 2026-11-11, TP4 built) | TP4 |
| `editing.craft` | off | Effects, keyframes, looks, sound (CRAFT_UPGRADE.md, EDD-64, EDD-69; both approved 2026-11-11; TP5 and TP10 built) | TP5, TP10 |
| `editing.referenceIntent` | off | Edit DNA 2, the style brief, QG-16 (EDD-65; approved 2026-11-11 in chat; TP6 built). EDD-66 stays refused: reading a reference is local code, never a model | TP6 |
| `editing.typeKit` | off | Shipped fonts, type kit, caption looks, motion kit 2, style packs (EDD-67; approved 2026-11-11 in chat; TP7 built) | TP7 |
| `editing.directorLoop` | off | The Director watches its draft by code and fixes it with typed changes inside the make's rounds; escalation only to a tier the server lists; B-roll by meaning; three openings on the Variations wall (EDD-68; approved 2026-11-11 in chat; TP8 built) | TP8 |

Every on/off key ships `off` (`tests/readiness/readiness.test.ts`).

## 9. Stop conditions

Stop and ask when you would: touch a §1 file beyond its exception or a file not
listed; need a secret, a deploy, a real model call, a published package or a real
device on production; run anything locally against the live database; add a
dependency outside §6 or a licence outside SKILLS_AND_OPEN_SOURCE §2; find that a
spike contradicts a decision; ship a client before its server; or be about to commit
or push.
