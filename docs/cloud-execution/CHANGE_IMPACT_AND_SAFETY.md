# Change impact and safe execution (track C)

What track C may touch in the existing product, exactly how, and the test
that proves nothing broke. Read this **before editing any existing file**.
A change not listed in §3 needs the owner's approval and a new row here
first. Where track A's, O's, N's or the voice track's CHANGE_IMPACT also
lists a file, **all** rules apply, and the file is held on the shared
Coordination board in `status.md` by one agent at a time.

Verified against `508bb6a` (`main`, clean but the brief) on 2026-10-31.
**Baseline:** `env -u OPENROUTER_API_KEY npm run check` → typecheck pass;
lint 0 errors / 6 warnings (existing, CF-09); format pass; Test Files 185
passed, 3 skipped (188); Tests 2289 passed, 42 skipped (2331); exit 0.

## 1. Protected (never touch without the owner's explicit approval)

Everything in track A's CHANGE_IMPACT §2, track O's §1, track N's §1 and
the voice track's protected list, plus:

| Path | Why | Track C's only exception |
| --- | --- | --- |
| `kriya.tasks`, `claim_task`, `heartbeat_task`, `recover_tasks`, `lib/agent/queue.ts` | One orchestrator (CD-02) | None (CF-04 stays an owner decision) |
| `lib/agent/metering.ts`, `kriya.usage_events`, `kriya.charges` | Model metering | None: compute goes to `resource_usage` (CD-14) |
| `lib/connectors.ts`, `kriya.connections`, `lib/secrets.ts` | Token handling | None |
| `lib/connectors/github.ts` | Token use for GitHub (track N treats it as protected) | **C5 only, owner-approved (CD-09, CD-10):** additive `githubTarball`, `githubCommitTree`, `githubOpenDraftPr`; existing functions and `REPO`/`BRANCH`/`FILE_PATH` unchanged |
| `browser/**`, `lib/browser/**` | Track A rule 6 | `browser/egress.ts` **imported read-only** by `runner/egress-proxy.ts` and copied into the runner image; never edited |
| `lib/agent/policy.ts` **values** | The safety floor | Additions only (§3) |
| `lib/agent/capabilities.ts` `GRANTABLE` | OD-03 | None: no workspace tool has `pins` |
| `lib/agent/episodes.ts`, `lib/agent/verify.ts` | Receipts and claims | None |
| `skills/**`, `skills-v2/**`, `CATALOG`, `CATALOG_V2` | NT-SKL-04 and the skill suites (CF-12) | None: `cloud-coding` is injected at run time (CD-20) |
| `LICENSE` | Governance | None; `NOTICE.md` is new (CD-22, owner-gated) |
| Every applied migration | Invariant 2 | None |

## 2. Prerequisites

| Id | Change | Test |
| --- | --- | --- |
| CP-1 | Re-run `env -u OPENROUTER_API_KEY npm run check` on the current `main`; record counts. Correct CF-01 (`docs/kriya/status.md`: branch line, Stage D rows for the browser, skills and approvals, from REPOSITORY_AUDIT §5) and CF-02 (`docs/kriya/architecture.md` "Execution capabilities": the browser as built in A4, no `workstation/`, a pointer to this track). Docs only | Exit 0; counts ≥ the baseline above |

## 3. Existing files that change, and how

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `db/schema.ts` | C1 | Add `workspaces`, `workspaceSessions` mirroring the migration; `plans.workspaceMinutes`; `resourceUsage.kind` enum gains `workspace_seconds`, `workspace_storage_bytes` (comment `// Cloud workspaces (track C)`) | Existing definitions unchanged | `npm run typecheck`; `tests/agent/regression.test.ts` unchanged |
| `tests/db/migrations.test.ts` | C1 | A down/up case for `20270201000000`; older cases roll track C back first (newest first, as N1 did) | Existing assertions unchanged | Itself |
| `lib/config.ts` | C1 | The `cloud.*` block of CD-23 under `// Cloud workspaces (track C)`, the `operator.*` shape | Existing keys untouched | Settings parse tests; CT-REG-01 |
| `lib/config.ts` `SECRETS` | C3, C8 | C3: `KRIYA_WORKSPACE_SECRET`. C8: the chosen provider's key | Existing names untouched | Typecheck |
| `lib/env.ts` | C3, C8 | Optional worker rows: `KRIYA_WORKSPACE_SECRET` ("cloud workspaces"), the provider key (C8) | No new required variable; existing rows unchanged | Existing env tests |
| `lib/agent/policy.ts` | C4, C5 | C4: `TOOL_CLASSES` and `TOOL_WRITES` rows for the nine non-publish tools; `PERSON_ONLY_WRITES += "workspaces.close_requested_at"`. C5: the `workspace_publish` rows (R4) | No existing value changes | `tests/agent/policy.test.ts`, `tests/agent/tool-policy.test.ts` (AT-POL-01, -02, -07) unchanged and passing; `tests/agent/improve.test.ts` unchanged; CT-POL-01/02 |
| `lib/agent/capabilities.ts` | C4, C5 | `System` gains `"workspace"`; `FACTS` rows (C4 nine, C5 publish with `verification: "api_readback"`) | `CAPABILITIES` keys = `TOOL_CLASSES` keys; `GRANTABLE` exactly the four | `tests/operator/capabilities.test.ts` unchanged |
| `lib/agent/tools.ts` | C4, C5 | C4: `export { createWorkspaceTools } from "@/lib/cloud/tools"`; `PRIVATE_READ_TOOLS` += five read tools; `KriyaTools` += `Partial<ReturnType<typeof createWorkspaceTools>>`; the comment at line 140 ("Hosted Kriya has no shell…") says workspace tools come from `lib/cloud` behind `cloud.workspaces`. C5: `SIDE_EFFECT_TOOLS += "workspace_publish"` | Existing factories, `FOREIGN`, `UNTRUSTED_READ_TOOLS` rules unchanged; no tool name contains `share` | AT-REG-01 snapshots; `tests/agent/share.test.ts`; existing tool tests |
| `lib/agent/instructions.ts` | C4 | `Capabilities.workspace?` and a `WORKSPACE_LINE`, emitted only when set | Not set → byte-identical prompt | AT-REG-01 snapshots; CT-TOOL-06 |
| `lib/agent/approvals.ts` | C5 | `actionTitle`: one `workspace_publish` case before `default` | Every other branch unchanged | Existing approval tests |
| `lib/agent/run-task.ts` | C4 | The lines of ARCHITECTURE §4: read `cloud.workspaces`; construct `TaskWorkspace`; heartbeat line; `capabilities.workspace`; belt line; `cloud-coding` injection inside the `skillLibrary` block; `close` in `finally` | Off → belt, prompt, `TOOL_APPROVALS` identity, records identical; members' belts unchanged | CT-REG-01, NT-REG-01, OT-REG-01, `tests/agent/runner-*.test.ts` unchanged |
| `lib/agent/run-task.ts` | C5 | Pass `{ publish: cloud.publish === "on" }` to `createWorkspaceTools` | Same | CT-PUB-* |
| `worker/index.ts` | C6 | In `schedulerLoop`, one new `try` block: `workspaceJanitor()` when `cloud.workspaces` is on or any workspace is `running`/`paused` | Other steps untouched; its errors caught and logged | CT-JAN-05; typecheck |
| `components/thread/thread-page.tsx` | C7 | Read the thread's workspace through `queries/cloud.ts` and render `<CloudStrip>` above the transcript when one exists | No workspace → identical markup | CT-UI-01; existing thread tests |
| `components/thread/tool-call.tsx`, `components/workbench/activity.tsx` | C7 | Cases for `tool-workspace_*` parts and labels | Other tools render and label as before | Typecheck; CT-UI-02 |
| `app/(workspace)/usage/page.tsx` | C7 | One line "Cloud workspace minutes" when the plan has minutes (data from `queries/cloud.ts`) | Plan without minutes → identical page | CT-UI-04 |
| `app/owner/config/page.tsx` | C7 | One `GROUPS` entry "Cloud workspaces", prefix `["cloud."]` | Existing groups unchanged | CT-UI-04 |
| `components/owner/nav.tsx` | C7 | "Cloud" link to `/owner/cloud` | Existing links unchanged; `proxy.ts` untouched (`/owner` already protected) | Typecheck |
| `actions/owner.ts`, `components/owner/forms.tsx` | C7 | Plan schema and form gain `workspaceMinutes` (`int(0, 100_000)`) | Other fields unchanged | Existing owner action tests |
| `scripts/verify-guard.ts`, `tests/operator/verify-guard.test.ts` | C8 | Provider keys (`E2B_API_KEY`, `DAYTONA_API_KEY`) flagged unless `KRIYA_VERIFY_PAID=1`, like `OPENROUTER_API_KEY`; one new test case | Existing checks unchanged | OT-UIV-01 |
| `render.yaml` | C8 | `kriya-worker`: `KRIYA_WORKSPACE_SECRET` and the provider key as `sync: false` | No new service; existing keys untouched | Blueprint diff reviewed |
| `docs/kriya/deployment.md` | C8 | The two variables (names only), the image build and template registration step | — | — |
| `docs/kriya/status.md`, `docs/kriya/architecture.md` | CP-1 | CF-01, CF-02 corrections | Other content unchanged | — |
| `README.md` | C10 | One line on cloud workspaces, only after C10's evidence | — | — |
| `AGENTS.md` | C0 | The "Cloud execution (track C)" section (done in C0) | Invariants and other tracks' text unchanged | — |
| `status.md` | every phase | Own section and board rows only | Other tracks' sections untouched | — |

**New files** (no row needed): `runner/**` (incl. `runner/Dockerfile`),
`lib/cloud/**` (including the pure `lib/cloud/paths.ts` that track H's web
routes import, PX-02), `queries/cloud.ts`, `actions/cloud.ts`,
`components/thread/cloud-strip.tsx`, `app/owner/cloud/**`, `tests/cloud/**`,
`tests/db/cloud-rls.test.ts`, `tests/fixtures/cloud/**`,
`supabase/migrations/20270201000000_cloud_workspaces.sql` and its rollback,
`NOTICE.md` (owner-gated, CD-22), `screenshots/cloud-execution/**`,
`docs/cloud-execution/**`.

**Dependencies:** none. The runner uses Node built-ins and `zod` (already a
dependency); adapters call provider REST APIs with `fetch`. If C8 finds a
vendor SDK necessary, that is a `package.json` row the owner approves first.
`.env.example` is edited by the owner (voice B9).

## 4. Module boundaries

See ARCHITECTURE §2 (diagram) and TEST_STRATEGY CT-IMP-01…03. In short:
`lib/cloud` is worker-only; `runner/` imports nothing of Kriya but the two
egress predicates; the web side reads through `queries/cloud.ts` and writes
only `close_requested_at` through `actions/cloud.ts`.

## 5. Cross-track check (2026-10-31)

| File held by another track's row | Conflict? | Rule |
| --- | --- | --- |
| `lib/agent/run-task.ts` (A, O, N, voice, Skill Studio) | No overlapping lines: track C adds its own settings read, an object beside `browser`, one heartbeat line, one capability key, one belt line, one block inside the existing `skillLibrary` block after Skill Studio's, one `finally` line. Approvals are untouched (`workspace_publish` comes through `TOOL_CLASSES`), so O4's identity rule and N5's composition hold | Hold on the board |
| `lib/agent/tools.ts` (A, O, N, voice) | Voice F8: `KriyaTools` gains only a `Partial`; call tools untouched | — |
| `lib/agent/policy.ts` (O §1 values protected) | Additions only | — |
| `lib/agent/capabilities.ts` (O1, N4/N5) | New `System` value and rows; `GRANTABLE`, `UNCLASSIFIED_OK` unchanged | — |
| `lib/connectors/github.ts` (A8, N3) | Additive functions only, owner-approved at C5 start | Same approval pattern as A8, N3 |
| `worker/index.ts` (A, O, N, voice F6) | One `try` block in `schedulerLoop`; no new loop, no shared map | Hold on the board |
| `lib/config.ts`, `db/schema.ts` | Hot spots | One holder at a time |
| `components/thread/tool-call.tsx`, `activity.tsx` (A, N5) | New cases only | — |
| `app/owner/config/page.tsx` (OF-18, N2) | One more `GROUPS` entry | — |
| `docs/kriya/*.md` (voice, A11) | Only the CF-01/CF-02 rows | — |

## 6. Preflight for every session

1. `git status --short`: anything you didn't make → stop and ask; never discard it.
2. `env -u OPENROUTER_API_KEY npm run check` passes; if not before you start: stop.
3. Every decision your phase lists is Approved in "Track C owner approvals";
   owner-gated ones approved by id.
4. Your phase and its files are free on the board; claim them.
5. A migration timestamp, if any, is claimed and sorts last (track C range `202702…`).
6. No local run uses `.env` or `.env.local`; export `.env.verify` and pass
   `npm run verify:guard` (operator rule 6).

## 7. Stop conditions

Stop and ask the owner when:

- you'd touch a §1 file or a file not in §3, or a §3 file beyond its row;
- an existing test fails and the cause isn't clearly your change;
- a table, a function, the AI SDK or a provider behaves differently from
  these documents (record a new CF id in REPOSITORY_AUDIT §7);
- you're about to put any secret into a sandbox, make a workspace tool R2+
  other than publish, let publish update an existing ref, relax
  `browser/egress.ts`, or run user code anywhere but a provider sandbox (or
  the `local` provider on the verify stack);
- you need a secret, an account, money, a deploy, a real model call, a real
  provider sandbox, a real GitHub repository or a real site;
- a local run would reach the live database.
