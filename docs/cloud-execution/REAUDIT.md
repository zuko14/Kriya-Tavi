# Forensic re-audit (track C)

A second pass over every document in `docs/cloud-execution/`, run on
2026-10-31 after they were written, against the code at `508bb6a`, the
other tracks' rules and each other. Its purpose: no decision here may break
an existing workflow, test or invariant, and no two documents may disagree.

## 1. What was checked, and how

| Check | Method | Result |
| --- | --- | --- |
| Every id referenced is defined (CT, CD, CF, CRG, CS, CR, CQ, P) | Script over all docs: ids used vs ids defined in their home tables | Two undefined (CT-SEC-01/02) → defined (R-08); one wrong reference (CS-12 for DNS) → CS-6 (R-07) |
| Every existing path named exists | Script over every backticked `.ts/.tsx/.md/.sql/.yaml/.json` path, new files excluded | All repository paths exist; bare names are siblings or upstream files |
| Settings keys agree | `grep cloud\.*` across docs vs CD-23 | 14 keys, identical everywhere |
| Tool names agree | `grep workspace_*` | Ten tools, identical everywhere |
| Existing tests that pin the design | Read `tests/agent/tool-policy.test.ts`, `tests/operator/capabilities.test.ts`, `tests/agent/share.test.ts`, `tests/next/skills-v2.test.ts`, `tests/agent/skill-library.test.ts`, `tests/agent/improve.test.ts`, `tests/next/regression.test.ts`, `tests/next/mcp-runner.test.ts` | Constraints recorded as CF-12; the design meets each (§3) |
| SQL patterns | Each construct compared with an applied migration: `check_transition('…')` triggers, `touch_updated_at`, `on delete set null (col)`, `pg_advisory_xact_lock(hashtext(…))`, kind-check widening, `allowed_transitions` inserts | All have a precedent that already runs on PGlite and Postgres 17 |
| Names vs existing code | `ls` of `queries/`, `actions/`, `components/` | Collision with the app-shell "workspace" → code under `cloud` names (CF-13, R-01) |
| UI maps exhaustiveness | `components/thread/tool-call.tsx` `META`, `activity.tsx` `TOOL_LABELS` | `Record<string, …>` with defaults: widening `KriyaTools` in C4 can't break C7's files |
| Kill list accepts the new names | `operator.disabledTools` pattern `[a-z_]{1,40}` | Matches every `workspace_*` name |

## 2. Findings in this pass and how each was resolved

| Id | Finding | Resolution (document changed) |
| --- | --- | --- |
| R-01 | Code named `lib/workspace/`, `queries/workspaces.ts`… would sit next to `queries/workspace.ts` and `components/workspace/` (app shell) | All track C code paths renamed to `cloud` (every doc); CF-13 |
| R-02 | A non-root runner can't start commands as another user | Runner runs as root inside the VM, spawns commands with `kriya`'s uid/gid (DECISIONS CD-09, CD-21; TOOLS §2; SECURITY diagram, CS-10; PROVIDERS M5, CRG-09; REPOSITORY_AUDIT §4) |
| R-03 | Runner limits had no path into the sandbox (the image's start command takes no per-workspace arguments) | `WorkspaceSpec.limits` → `KRIYA_RUNNER_LIMITS` in the runner's environment, zod-validated at start (TOOLS §1, §2) |
| R-04 | `actionTitle(tool, input, tense)` can't see the tool's output, so "Opened … in <repo>" couldn't name the repo; and the person should approve the exact destination | `workspace_publish` input gains `repo`, which must equal the workspace's (DECISIONS CD-10; TOOLS §3; CT-PUB-04) |
| R-05 | On a refused session or a failed resume the workspace went "back to the previous status", which the state machine didn't allow | Session row first, status change after; `starting → paused` added for a failed resume (TOOLS §4; DATA_MODEL §5, §6 `TOOL_WRITES`) |
| R-06 | GitHub answers tarball requests with a redirect; `providerFetch`'s handling of it is unverified | Recorded as a C5 verification step with the fallback (TOOLS §5) |
| R-07 | DNS leakage cited CS-12 (protected branches) | CS-6 (DECISIONS CD-12; PROVIDERS CRG-08) |
| R-08 | CT-SEC-01/02 used, never defined | Defined (TEST_STRATEGY) |
| R-09 | The session table's `task_id` foreign key had no index (the class of finding P-2 counted) | `workspace_sessions_task_idx` (DATA_MODEL §2) |
| R-10 | `skills-v2/cloud-coding/` would break NT-SKL-04 (exactly nine directories) and change two skill suites that resolve against every tool; `code-assistance` says Kriya can't run code | Skill injected at run time, `code-assistance` swapped out on workspace turns only (DECISIONS CD-20; CF-11, CF-12) |
| R-11 | The runbook pointed at a non-existent `/owner/plans`; UX pointed at `components/owner/tiles` | `/owner/config` plan forms; `components/owner/ui.tsx` `Tile`/`Tiles` |
| R-12 | The failure table guessed at provider billing for a failed start | Metered like any session from measured seconds (ARCHITECTURE §7) |

## 3. Compatibility with each existing workflow

| Workflow | Touched by track C? | Why it can't break | Proof |
| --- | --- | --- | --- |
| Chat/research turns | No, unless `cloud.workspaces` is on **and** the plan has minutes **and** a provider is set | Belt, prompt and approvals identical when off | CT-REG-01 (+ AT-REG-01, NT-REG-01) |
| Queue, leases, recovery, cancel | No code change | Workspace calls are ordinary tool calls; only `workspace_publish` is a side effect, so recovery's rule is unchanged | `tests/db/queue.test.ts` unchanged; CT-PUB-06 |
| Approvals, Inbox, grants | Data only: `TOOL_APPROVALS` gains the key `workspace_publish` (like every earlier R3/R4 tool, e.g. A8, G2); identity unchanged | `withGrants` never grants it (no `pins`, R4) | NT-REG-01 identity test; OT-CAP `GRANTABLE` exactly four |
| Squads, `delegate`, `assign`, crews | `delegate` carries the belt as today; members' belts untouched | CD-19 | CT-TOOL-08; `tests/operator/runner-grants.test.ts` unchanged |
| Schedules, goals, jobs | No change; a scheduled run may use workspace tools like any task when on | Same limits and approvals | Existing suites |
| Browser (A4) | No change; `browser/egress.ts` imported read-only by the runner image | CT-IMP-02; track A rule 6 | `tests/browser/*` unchanged |
| MCP apps (track N) | No change; `wrapReads` circuits keyed by `system`, now including `"workspace"` (no workspace tool is `idempotent`, so none is wrapped) | ND-21 belt guard keeps classed tools | `tests/next/*` unchanged |
| Voice | No change; `KriyaTools` gains only a `Partial` (F8) | Call tools untouched | `tests/voice/*` unchanged |
| Metering, charges, billing | No change to `metering.ts`/`charges`; compute in `resource_usage` | CD-14; track A's own rule for non-model usage | CT-MTR-02 |
| Memory | Workspace reads count as untrusted, so notes saved after them are unconfirmed (stricter, as for mail and the web) | AD-11 rule reused, not changed | CT-POL-03 |
| Skills | Catalogues and skill files unchanged; injection only on workspace turns | CD-20 | NT-SKL-04 and `tests/agent/skill-library.test.ts` unchanged; CT-SKL-01/02 |
| Delivery, late re-check (track N) | `workspace_publish` returns a read-back `verification`, so delivery status works as for other connector writes; reads carry none | `lib/delivery/status.ts` unchanged | `tests/next/*` unchanged |
| "What I did" | Workspace runs appear as tool runs; how many reads to show is checked in C7's browser pass | Episodes derive from `tool_executions` as before | C7 screenshots |
| Owner console | One config group, one nav link, one page, one plan field | Additive | CT-UI-04 |
| Database lint and advisors | Two new tables with RLS, policies and pinned function | `lint.test.ts` | CT-DB-07 |
| Production data | Nothing applies to production until the owner applies the migration on staging first | IMPLEMENTATION_PLAN §4 | — |

## 4. Brief requirements traced

| Brief section | Where it is met |
| --- | --- |
| §0, §4.1 no parallel product | CD-01, CD-02; REAUDIT §3 |
| §2 baseline preserved, feature truth table, doc inconsistencies | REPOSITORY_AUDIT §3, §5, §7 (CF-01…CF-03) |
| §3.3 package-by-package mapping with license | DSH_COMPONENT_MAP §2–§5 |
| §3.4 model independence | CD-02, CD-24 |
| §4.3 provider boundary and lifecycle | CD-05; TOOLS §1–§2 |
| §5 identity vs compute, profiles, persistence | CD-04, CD-13; DATA_MODEL; v1 has one "code workspace" profile; browser stays A4; desktop deferred (C12+) |
| §6 Render evaluation, Workflows, disks | CD-08; PROVIDERS §2; checkpoints never on a Render disk (CD-13) |
| §7 Supabase as system of record; no blobs in Postgres; one queue | DATA_MODEL §0; CD-02 |
| §8 provider comparison | PROVIDERS §2–§3 |
| §9 cost first-class, metering split, INR | PROVIDERS §4; CD-14; EVALUATION_PLAN M5–M11 |
| §10 isolation, credentials, GitHub, approvals | CD-06, CD-09, CD-10, CD-12; SECURITY |
| §11 UX inside the product, mobile | CD-18; UX_SPEC |
| §13.4 ADRs and artefacts | DECISIONS (ADR format); this directory |
| §13.6 approval boundaries | Owner-gated decisions; AGENT_MASTER_PROMPT §0 |
| §13.7 vertical slice, laptop off, cross-tenant, no duplicate side effects | IMPLEMENTATION_PLAN C1–C10; EVALUATION_PLAN §5; CR-4, CR-5 |
| §15 acceptance criteria | SECURITY §6 (CR-1…CR-8), EVALUATION_PLAN §4–§5 |

## 5. Still open after this pass (not defects in the design)

| Item | Owner of the answer | Blocks |
| --- | --- | --- |
| CRG-01…CRG-09 provider facts | C8 research and test sandboxes | C8 choice |
| CQ-1, CQ-2 counsel | Owner + counsel | C11 |
| Owner approval of CD-01…CD-25 (owner-gated by id) | Owner | CP-1 onward |
| CF-04 (deploys use task attempts) | Owner decision outside track C | Nothing in C; noted for long turns |
| Whether the budget tier can drive multi-step code work | C10 paid run (CD-24) | Pilot quality |

## 6. Result

After R-01…R-12 the documents agree with each other and with the code at
`508bb6a`. No existing assertion changes in any phase; two existing test
files only gain cases (`tests/db/migrations.test.ts` in C1, as every
migration phase did; `tests/operator/verify-guard.test.ts` in C8); every
existing file touched has a row in CHANGE_IMPACT §3 with its regression test; every
owner-gated step is marked. The design is ready for the owner's review of
DECISIONS.md, which is the gate before any implementation.

## 7. Cross-track re-audit with tracks H and R (2026-10-31)

Tracks H (`docs/kriya-harness/`) and R (`docs/rooms/`) were designed on top
of this track. Their effect on track C, checked against this directory:

| Item | Effect on C | Change made here |
| --- | --- | --- |
| H8 handoff/pull runs on `kriya-web` | Needs the checkpoint path rules without importing provider code | CD-27; `lib/cloud/paths.ts` (ARCHITECTURE §2); CT-IMP-03 exception |
| H10 device world | Serves the runner protocol; needs provider `device` | CD-26 (protocol stability); the provider check is widened by H10's own migration (PX-06), not here |
| R4 room tasks | A room task may call `workspace_*` in the owner's bridge thread; no shared workspaces | None (PX-07): the workspace belongs to the thread like any other |
| Shared hot spots | `run-task.ts`, `tools.ts`, `policy.ts` also changed by R4; `worker/index.ts` by H3 and R5; `app/owner/config/page.tsx` by H2 and R1 | Order in `docs/program/C_H_R_PROGRAM.md` §4 |
| Migrations | H `202703…` and R `202704…` sort after C's `202702…` | None (PX-01) |

No decision of tracks H or R changes a track C invariant or protected file.
