# Repository audit (track E)

What exists today in `Kriya-Tavi` (at `d46bb0c`) and `kriya-harness` (at
`0ebfd0c`) that this track builds on, read on 2026-11-07. Claims about other
projects are in SOURCE_AUDIT.md. If this document and the code disagree, the
code is the fact: record an EF id and ask.

## 1. The client (`kriya-harness`)

| Fact | Where | Why it matters |
| --- | --- | --- |
| Package `@kriya-ai/harness` 0.2.0, private, ESM, Node ≥ 24.9, exact pins | `package.json`, `scripts/check-pins.js` | Every new dependency is an exact pin and goes through `check:notices` |
| Built on `@deepseek-ai/dsh` 0.2.1-rc.5; nothing in DSH is edited | `bundle/cordis.patch.yml`, HD-02 | The Studio is a plugin row, never a DSH change |
| A plugin is a `plugins/<name>/{index.js,client.js,package.json}` pair: `index.js` on the host, `client.js` loaded with `window.__ModuleLoader__.load` | `plugins/overview`, `plugins/projects` | The pattern to follow |
| A full page is a `main` slot plus a `sidebar.panellist` row | `plugins/projects/client.js` (`ctx.slots.register`) | Only the Studio's entry row; the Studio itself is a separate app |
| Routes: `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`, **exact paths only**; registered through `ctx.inject(["connection"], …)` | `plugins/overview/index.js`, `dsh-client-connection` | Two small routes only. Too limited for the Studio (EH-20). WP §3b records a 404 from registering too early |
| Agent tools: `ctx.tools.register(defineTool(…))` | `plugins/kriya-tools`, `plugins/browser` | The `edit_*` tools |
| Switches: `SWITCHES` in `src/modes.js`: flag, env name, default | `src/modes.js` | `edit`, default off |
| Composed profiles are pinned by `expected/*.dump.yml`; seams by `scripts/check-seams.js` | HT-REL-03, HU-SEAM-01 | Both change with the new row |
| Web UI authentication: a launch token exchanged for a signed cookie, plus a `Host` and `Origin` fence against DNS rebinding | `dsh-client-connection` | The Studio's own server copies the same pattern |
| The daemon: `MAX_RUNNING = 2`; a cancel not in `running` falls through to killing `kriya serve`; it kills children on exit | `src/daemon.js` | Edits never use this path (EH-02, EH-03, EH-05) |
| DSH directory pickers exist | `dsh-client-ui-directory-picker-browse`, `-native` | "Add folder" without copying; whether a plugin can reach them is checked in EX-07 |
| `playwright-core` drives the installed Chrome for the agent's browser | `src/browser.js` | Separate from HyperFrames' pinned Chrome (EDD-07) |
| Model calls: the local relay and the gateway | `src/gateway-proxy.js`, `bundle/cordis.patch.yml` (`llm-pi-ai`) | The Director uses the same route, by tier alias |
| Tiers are read from `GET /models`, with limits and image support | `KRIYA_ALLOWED_TIERS`, `KRIYA_MODEL_IMAGES`, `KRIYA_MODEL_LIMITS` | The Director reads these, never a model id |
| Loop: plan, step, check, verdict by exit code, checkpoints, attempt rank and set-aside | `src/loop.js`, `src/verify.js`, `src/failure.js`, `KRIYA_LOOP_V2.md` | The repair ladder follows the same rule: never keep a worse attempt |
| Daemon: long-polls dispatches, typed kinds, folders offered by the computer | `src/daemon.js`, CC-D1…D9 | Tavi jobs arrive here |
| Remote Control streams a session to `/harness`, lines not output | `src/live.js`, `REMOTE_CONTROL.md` | Studio sessions show up in Kriya for free |
| Intent router: BM25 over skills, a brief, hides nothing | `src/intent.js`, `plugins/router` | Video requests find the `kriya-edit-*` skills |
| Local state lives in `~/.kriya/` (`kriyaHome()`, 0700), never in the project | `src/store.js`, `src/paths.js` | The index and caches go there |
| Worktrees in use: `-evolve`, `-studio` (Flows), `-upgrade` | `git worktree list` | Use a new `../kriya-harness-edit`; the person's checkout has an untracked `.DS_Store` only |

## 2. The server (`Kriya-Tavi`)

| Fact | Where | Why it matters |
| --- | --- | --- |
| Device identity: `authenticateDevice` only | `lib/auth.ts`, invariant 3 | Every new harness route uses it |
| Gateway accepts tier aliases, reserves in SQL, records `harness_usage` | `lib/harness/gateway.ts`, `lib/harness/metering.ts` | Editing adds no second ledger for tokens |
| Route table and contract | `lib/harness/contract.ts` → `docs/kriya-harness/contract.json` (`scripts/harness-contract.ts`) | New routes and the `edit` kind go here |
| Dispatch: `queue()`, `next()`, `report()`, `cancel()`, `controlCenter()` | `lib/harness/control.ts` | Tavi uses `queue()` as Flows does |
| Kinds are a SQL check; payload ≤ 16 KB, result ≤ 32 KB; `queued` expires after 10 minutes | `supabase/migrations/20270801000000_harness_control.sql` | Needs a migration; a running job isn't affected by the expiry |
| A running action may update its `result` | `lib/harness/control.ts` (Flows, CHANGE_IMPACT §1) | Progress needs no new route |
| Worker loops | `worker/index.ts` (`flowLoop` at line 365) | `editLoop` copies the pattern behind `editing.tavi` |
| `enqueueTurn` saves a **user** message and runs a model turn | `lib/agent/queue.ts:211` | Not used for finished jobs (EH-16) |
| Server-authored thread messages: stable id, `onConflictDoNothing` | `lib/voice/thread-summary.ts` | The pattern for a finished job |
| Gateway limits: 3 open answers per person; `harness.rpm` 60 per device, all routes | `20270301000200_harness_open_cap.sql`, `lib/harness/route.ts` | The Governor (EH-13, EH-14) |
| Bodies pass the firewall only as `gzip+base64` | `src/gateway-proxy.js`, `lib/harness/route.ts` | Director calls use it (EH-15) |
| Tools: `lib/agent/tools.ts`; `SIDE_EFFECT_TOOLS`, `FOREIGN`, `PRIVATE_READ_TOOLS` | protected, track A | Owner-gated rows |
| Classes: `TOOL_CLASSES`, `TOOL_WRITES`, unknown tool = R5 | `lib/agent/policy.ts` | The new tools get classes here |
| Capability registry derived from those tables | `lib/agent/capabilities.ts` | New `System` value `device`; not grantable |
| Tool cards and labels | `components/thread/tool-call.tsx`, `components/workbench/activity.tsx` | AGENTS.md conventions |
| Agent starting points | `lib/templates.ts`, shared with client components | **Not changed** (EH-11); a preset comes through `getFeatures()` |
| Library skills, default harness skills | `skills/`, `skills-harness/` (13 skills, `NOTICES.md`), `lib/harness/default-skills.ts`, `harness.defaultSkills` | `kriya-edit-*` go in `skills-harness/` |
| `kriya.resource_usage.kind` is a list that tracks extend | `db/schema.ts:583` | `edit_preview_bytes` |
| Plan caps are columns defaulting to 0 | `plans.workspaceMinutes`, `plans.harnessMonthlyMicroInr` | `plans.editingPreviewBytes` |
| Latest migration | `20271001000000_harness_live.sql` | Track E's are `20271101000000_editing.sql`, `20271102000000_editing_review.sql` |
| Settings and owner groups | `lib/config.ts`, `app/owner/config/page.tsx` (`GROUPS`) | `editing.*` |
| File storage | `lib/files.ts`: bucket `kriya-files`, no video MIME, 60-second links | **Not used** for previews (EH-24, EH-25); own bucket |
| Orphan sweep | `lib/cloud/janitor.ts` compares `storage.objects` with rows | The pattern for previews after account deletion (EH-26) |
| Tool tables are pinned | `tests/agent/tool-policy.test.ts`, `tests/operator/capabilities.test.ts`; `CAPABILITIES` throws at import without `FACTS` | EH-09, EH-10 |
| `/harness` page and Control Center | `app/(workspace)/harness/page.tsx`, `components/harness/control-center.tsx` | Shows edit jobs when on |

## 3. What does not exist yet

No media handling of any kind in either repository: no FFmpeg, no player, no
timeline, no transcript engine. The word `video` in this repository refers to
connectors (`instagram_publish`, the YouTube note RG-10). So the track adds a
new subsystem and touches little that exists, which is the safe shape.

## 4. Existing rules that bind this track

| Rule | Effect here |
| --- | --- |
| Invariant 1, `withUser` | All new tables are owner-only; tool writes go through `withUser` |
| Invariant 2 | New tables in `kriya`, RLS, policy, new migration, test in `tests/db/` |
| Invariant 3, track H rule 3 | Device routes use `authenticateDevice`; no device endpoint approves anything |
| Invariant 4 | No secret on the device beyond the device token; provider keys never reach the client |
| Invariant 5 | Tavi tools run in `kriya-worker`, are side effects with approval, never on the web server |
| Invariant 6 | Costs in integers; `lib/money.ts` |
| Invariant 7 | Limits in SQL |
| Track H rule 4 | Director calls use tier aliases and the existing reservation |
| Track H rule 5 | DSH composed, never edited |
| Track H rule 6 | Memory from the device stays unconfirmed; no agent tools on the web server |
| Track-A rule 5 | No scraping others, no bulk actions, no evasion |
| Track-A rule 8 | Taste and memory after untrusted content stay unconfirmed |
| Track-A rule 11 | Confirming taste rules, approving jobs: the person's alone |
| Track N rule 3 | "Delivered" is computed by code |
| Track N rule 9 | Side effects are never retried silently |
| Operator rule 6 | Never run locally against the live database |
| Operator rule 7 | Every screen phase ends with a browser check on the isolated stack |
| Voice rules 2, 3, 6, 7, 12 | Preserve changes, commit only on authorisation, no fabrication, no personal data in logs, update `status.md` |

## 5. Reuse map

| Need | Reuse | Don't build |
| --- | --- | --- |
| Sign-in, allowance, models | Device token, gateway | A new account or key |
| Long job control from Kriya | Dispatch and daemon | A socket or queue |
| Live view on the phone | Remote Control | A new stream |
| Skills delivery | `/api/harness/v1/skills`, `skills-harness/` | A new registry |
| Approvals | Existing Inbox and approval flow | A new approval type |
| Thread cards | `components/thread/tool-call.tsx` | A new page in Kriya |
| Project history | The operations log (new), not git | A git repository for media |
| Full-text search | `node:sqlite` FTS5 | A search engine |
| Vector search | Brute force over `Float32Array` | A vector database |
