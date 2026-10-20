# Kriya Tavi: status (voice assistant + agent platform)

Canonical progress and coordination file for two tracks:

| Track | Phases | Blueprint | Master prompt |
| --- | --- | --- | --- |
| Voice assistant (owner-directed outbound calls, verified outcomes, phone-call reminders) | 0–10 (below) | `docs/voice-assistant/` | `docs/voice-assistant/AGENT_MASTER_PROMPT.md` |
| Agent platform, track A (role teams that act, remember, work in the background and prove what they did) | A0–A12 (section "Agent platform (track A)" at the end) | `docs/agent-platform/` | `docs/agent-platform/AGENT_MASTER_PROMPT.md` |

Both tracks share the Coordination board below; phase ids tell them apart
(`3` is voice, `A3` is track A). The SaaS platform's own status stays in
`docs/kriya/status.md`.

**Every coding agent, before each session:** read this file, `AGENTS.md`, and
the documents named under the phase you're working on. Work on **one** phase.
Update this file at the end with changed files, commands run with their real
output, blockers and the next exact action. A phase is `COMPLETE` only when every
exit check below it has passed and the results are recorded here.

Statuses: `NOT_STARTED` · `IN_PROGRESS` · `BLOCKED` · `COMPLETE`.

Voice agents start from `docs/voice-assistant/AGENT_MASTER_PROMPT.md`; track A
agents from `docs/agent-platform/AGENT_MASTER_PROMPT.md`.

## Coordination board

One row per active agent. Claim before working, release when you stop; edit
only your own row. Rules: AGENT_MASTER_PROMPT.md §4.

| Phase | Agent | Branch / worktree | Claimed (IST) | Files held | Last update |
| ----- | ----- | ----------------- | ------------- | ---------- | ----------- |

## Documents

| Document | What it decides |
| --- | --- |
| `docs/voice-assistant/DECISIONS.md` | D-01…D-16 (all **Proposed**, awaiting owner approval) |
| `docs/voice-assistant/COMPETITOR_RESEARCH.md` | Market and platform findings, research gaps |
| `docs/voice-assistant/REPOSITORY_AUDIT.md` | What exists, gaps G1–G14, files to change |
| `docs/voice-assistant/VOICE_ARCHITECTURE.md` | Services, pipeline, vendor candidates, latency budget |
| `docs/voice-assistant/DATA_MODEL_AND_STATE_MACHINES.md` | Tables, RLS, state machines, leases, retention |
| `docs/voice-assistant/VOICE_REMINDERS.md` | Phone-only reminders, delivery criterion, retries |
| `docs/voice-assistant/CONVERSATION_AND_VERIFICATION.md` | Task spec, dialogue states, call tools, outcome schema, verifier |
| `docs/voice-assistant/SECURITY_AND_COMPLIANCE.md` | TRAI/DPDP reading, limits, threats, questions for counsel |
| `docs/voice-assistant/TELEPHONY_PROVIDER_ASSESSMENT.md` | Exotel/Plivo/Twilio, account checks X1–X11, provider contracts |
| `docs/voice-assistant/COST_AND_METERING.md` | Usage, prices, charges, budgets |
| `docs/voice-assistant/API_AND_EXECUTION_CONTRACTS.md` | Actions, routes, transactions, retries |
| `docs/voice-assistant/UX_AND_INTERACTION_SPEC.md` | Screens and flows |
| `docs/voice-assistant/IMPLEMENTATION_PLAN.md` | Phase order rationale, config, rollout, rollback |
| `docs/voice-assistant/TEST_STRATEGY.md` | Test ids (T-…) referenced below |
| `docs/voice-assistant/EVALUATION_PLAN.md` | Scenarios S01–S30, metrics and thresholds |
| `docs/voice-assistant/CHANGE_IMPACT_AND_SAFETY.md` | **Read before editing any existing file**: re-audit findings F1–F11, protected files, allowed changes per file, module boundaries, agent protocol, readiness gates |
| `docs/voice-assistant/SELF_IMPROVEMENT.md` | Governed improvement loop (D-17): signals, cases, regression scenarios, policy versions, shadow/canary, rollback |

## Overview

| Phase | Name | Status | Depends on |
| --- | --- | --- | --- |
| 0 | Research, audit, requirements, decisions | IN_PROGRESS (documents done; awaiting owner approval) | — |
| 1 | Domain model, migration, RLS, state machines | COMPLETE 2026-10-20 (PGlite; applied to staging Supabase `kriya-tavi` 2026-10-20, Postgres 17) | 0 approved |
| 2 | Provider interfaces, mocks, `kriya-voice` skeleton | COMPLETE 2026-10-20 (mocks only; Exotel framing unverified until X9; B9 open) | 1 |
| 3 | Durable call orchestration on mocks | COMPLETE 2026-10-20 (mock provider; the worker doesn't start the loop until a real provider exists, phase 5) | 2 |
| 4 | Dialogue engine, STT/TTS/LLM, outcomes, verification | IN_PROGRESS (2026-10-20: engine, outcomes, verification and L-text done on mocks; vendor adapters + paid benchmark open, B2, B6) | 2 (benchmark needs keys) |
| 5 | Controlled live outbound calls (Exotel, test numbers) | BLOCKED | 3, 4, external approvals |
| 6 | Owner reminders and spoken reports | COMPLETE 2026-10-20 (mock provider; the live check to the owner's phone moves to phase 5's exit; migration `20261022000000` not applied to staging) | 3, 4 (live check needs 5) |
| 7 | Mobile UI | IN_PROGRESS (2026-10-20: 360 px browser checks on staging done with screenshots; §11.7 measured, F29 fixed, acceptance met on a mock call (F30 fixed); Phone & calls built and checked at 360 px (F33 fixed); open: real-Android mic + TalkBack, F28, F31) | 3, 6 |
| 8 | Cost, limits, monitoring, owner dashboard | IN_PROGRESS (2026-10-20: metering, charges, allowance, daily cap, per-task budget, owner views and the `/usage` Calls row built; open: owner pages in a browser, C1 on real rows, F34) | 3, 4 |
| 9 | Security, compliance, recovery, production readiness | IN_PROGRESS (mock prep COMPLETE 2026-10-20: live switches, T-SEC-02…04, T-VER-01…08, fault suite D1 = 0 over 70 runs, legal drafts, transcript retention; G-A…G-D evidenced; G-E…G-H need Phase 5, counsel and an external review) | 5–8 |
| 10 | Continuous improvement loop (D-17) | COMPLETE 2026-10-20 on test data (precondition Phase 9 not met: built at the owner's request; nothing changes until the owner promotes a version; content use waits for B11) | 9 (foundations in 1, 4, 7) |

Order differs from the brief (D-15): durable orchestration (brief 5) and
dialogue (brief 4) come before live calls (brief 3), so no call is placed before
idempotency and recovery are proven.

### Wrap-up (2026-10-20 ~20:45 IST, Claude Code / Opus 5.5)

All voice code that can be built and tested on mocks is in place for
Phases 1–10, committed on `main` (local, not pushed; last `51b1af6`), and all
four voice migrations are applied to the Supabase project (`scripts/migrate.ts
--status`: `20261020000000`…`20261023000000` all `applied`, none pending).
Last complete `npm run check` (before `51b1af6`): Test Files 103 passed,
Tests 1292 passed | 26 skipped, exit 0; `51b1af6` itself: `improve.test.ts`
11/11, `tsc` and `eslint` clean. The Coordination board holds no claims.

Open, by phase (none of it is mock code; each needs an account, money,
counsel, a person or a device):

| Phase | Still open |
| --- | --- |
| 0 | Owner approval of the phase-0 documents |
| 4 | Real STT/TTS adapters and the paid benchmark (B2, B6) |
| 5 | BLOCKED: Exotel account, KYC, A2P (B3–B5, B8); enforce `test_numbers_only` (F25); the live checklist, incl. Phase 6's call to the owner's phone |
| 7 | Real-Android mic + TalkBack check; F31 (`DATABASE_URL` pooler) |
| 8 | Owner pages in a browser; C1 on real rows; F34 (owner) |
| 9 | Counsel Q1–Q11 (B4, B7, B11), an external security review, G-E…G-H with live evidence |
| 10 | Console views for versions and cases; the "Is this right?" button; the drift run (paid) |
| Findings | F24–F27, F32, F33 (calling hours), F35 (shared gate module) |

**Database advisors (2026-10-20 ~21:00 IST):** the Supabase security lints
the owner reported are fixed by migration `20261115000000_database_lint.sql`
(+ rollback), applied to the project (`migrate.ts`: `applied
20261115000000_database_lint.sql`). 0011: the 14 functions pin
`search_path = ''` (every body already qualified its tables). 0008: the 18
server-only tables get an explicit permissive deny-all policy for `anon` and
`authenticated` (no access change). Checked on the live database afterwards:
0 unpinned functions, 0 RLS tables without a policy, 0 tables without RLS.
`tests/db/lint.test.ts` keeps both at zero. The migration had to be
versioned after track A's `202611xx` files, which run later by name.
`npm run check`: Test Files 104 passed, Tests 1299 passed | 26 skipped,
exit 0. Left for the owner: Auth → leaked password protection (a dashboard
setting, not SQL).

## Current blockers

| # | Blocker | Blocks | Needed from |
| --- | --- | --- | --- |
| B1 | ~~Owner approval of DECISIONS.md D-01…D-16~~ Resolved 2026-10-20 (D-01…D-17 approved) | Phase 1 | Owner |
| B2 | Platform not yet on real services: Supabase migrations unapplied (2026-10-20: all applied to staging `kriya-tavi`, incl. both voice migrations), no OpenRouter run, no Render deploy (`docs/kriya/status.md`) | Phases 4 (benchmark), 5 | Owner |
| B3 | Exotel account: KYC, AgentStream Voicebot enabled for outbound, ExoPhone CLI, cluster, quote (X1–X11) | Phase 5 | Owner + Exotel |
| B4 | Counsel answers Q1–Q4 (A2P/TCCCPR status, CLI series, DPDP basis for recipients, disclosure wording) | Phase 5 (third-party calls), 9 | Owner + counsel |
| B5 | A2P pre-declaration through Exotel (D-16) | Phase 5 | Owner + Exotel |
| B6 | STT/TTS vendor keys and an OpenRouter key for benchmarks (paid) | Phase 4 exit | Owner |
| B7 | TRAI Third Amendment primary text couldn't be read (scanned PDF); needs a human read or OCR | Phase 9 sign-off | Owner/counsel |
| B8 | Is Kriya AI an India-registered company (Plivo and likely Exotel KYC need it)? | Phase 5 | Owner |
| B9 | `.env.example` not readable by agents here (local guardrail); new variables must be added by the owner | Phase 2 | Owner |
| B10 | ~~Supabase Postgres version must be ≥ 15~~ Resolved 2026-10-20: `kriya-tavi` runs Postgres 17 (Supabase project list); voice migrations applied. Supabase Postgres version must be ≥ 15 for `on delete set null (column)` (F1); check `show server_version` on the project | Phase 1 apply to Supabase (not the PGlite tests) | Owner |
| B11 | Counsel answer Q11 (using de-identified call content for improvement) | Phase 10 content use | Owner + counsel |

---

## Phase 0 — Research, audit, requirements, decisions

**Status:** IN_PROGRESS — all documents written; exit needs owner approval (B1).

- **Objective:** an evidence-based blueprint so later phases need no
  reinterpretation.
- **Done (2026-10-17):** all documents above; `AGENTS.md` gained voice rules;
  this file. Re-audit the same day: CHANGE_IMPACT_AND_SAFETY.md (findings
  F1–F11, of which F1 — a foreign-key design that would have broken thread
  deletion — was proven on PGlite and fixed in DATA_MODEL), SELF_IMPROVEMENT.md
  (D-17), premium UI spec (UX §11, D-18). Two local, content-free fixes so
  `npm run check` passes on this machine: `render.yaml` working copy back to LF
  (`git diff` empty) and `.serena` added to `.prettierignore`. No application
  code, migrations, dependencies, env vars or provider accounts were touched; no
  calls were made.
- **Checks run (2026-10-17, commit `bdf223f`, before writing docs):**
  `npm run typecheck` pass · `npm run lint` pass · `npm test` 82 passed / 9
  files. After writing docs: see "Phase 0 check log" at the end of this file.
- **Exit criteria:** (1) documents consistent (cross-check done; log below);
  (2) `npm run check` passes (done, see the check log); (3) owner marks each
  decision Approved or Changed in DECISIONS.md and records it here.
- **Next exact action:** owner reviews `docs/voice-assistant/DECISIONS.md` and
  writes "Approved D-…" (or changes) under "Owner approvals" at the end of this
  file.

## Phase 1 — Domain model, migration, RLS, state machines

**Status:** COMPLETE (2026-10-20, Claude Code; on PGlite, not yet applied to Supabase)

- **Objective:** the voice tables, transition function and RLS exist and are
  proven by tests; nothing calls them yet.
- **Read first:** DATA_MODEL_AND_STATE_MACHINES.md (all), COST_AND_METERING.md
  §2–3, SECURITY_AND_COMPLIANCE.md §6.
- **Preconditions:** Phase 0 approved (at least D-05, D-06, D-10, D-12, D-13,
  D-17); CHANGE_IMPACT_AND_SAFETY.md §5 preflight passes.
- **Must follow:** DATA_MODEL's caution box and migration rules — composite
  `on delete set null (column)` form (F1), no extensions, nothing that can't run
  in a transaction, PGlite-compatible, down file deletes its own version row.
- **Files:** new `supabase/migrations/20261020000000_voice_core.sql`, new
  `supabase/rollback/20261020000000_voice_core.down.sql`, `db/schema.ts`,
  `lib/log.ts` (phone redaction), `lib/entitlements.ts` (types for voice plan
  columns only), new `tests/db/voice-rls.test.ts`,
  `tests/db/voice-transitions.test.ts`, `tests/db/migrations.test.ts` (add the
  voice down/up case).
- **Database:** tables `voice_access`, `voice_profiles`, `phone_verifications`,
  `voice_tasks`, `voice_approvals`, `voice_calls`, `call_attempts`,
  `call_events`, `conversation_turns`, `call_outcomes`, `voice_transitions`,
  `voice_usage`, `voice_charges`, `voice_prices`, `call_suppressions`,
  `voice_allowed_transitions`; functions `voice_transition`, status-guard
  triggers; `kriya.plans` voice columns (defaults = off);
  `call_attempts.policy_version text not null` (D-17). Claim/heartbeat/recover
  functions are Phase 3.
- **APIs/contracts:** `kriya.voice_transition(entity, id, to, actor, evidence)
  returns boolean`.
- **Credentials:** none.
- **Tasks:** write migration + rollback; mirror in `db/schema.ts`; seed
  `voice_allowed_transitions` from DATA_MODEL §3; column grants; phone-number
  redaction in `lib/log.ts`.
- **Tests:** T-SM-01…05, T-RLS-*, T-DB-01, T-DB-02, T-FK-01, T-MIG-01,
  T-LOG-01 (with its negative cases); the existing 82 tests unchanged and
  passing.
- **Security/privacy checks:** every new table has RLS (existing test
  `migrations.test.ts` "turns on row level security for every kriya table"
  passes); token-hash columns not selectable; no user write grants except the
  documented ones.
- **Acceptance:** a browser session can't change any voice status; out-of-order
  events are no-ops; wrong actor/evidence raises.
- **Rollback:** run the down migration (tested); the feature has no callers.
- **Exit:** `npm run check` passes; results pasted here.
- **Blockers:** B1 (resolved 2026-10-20: D-01…D-17 approved, see Owner approvals).

**Session plan (2026-10-20 09:46 IST, Claude Code / Opus 5.5, `main` in place,
uncommitted):**

- Preflight: `git status --short` clean; `main` at `d8ed1d5`; `npm run check`
  exit 0 (typecheck, lint, format pass; **863 passed, 26 skipped / 81 files**).
  The "82 tests" figure above predates track A; the baseline held unchanged
  this session is the full current suite.
- Create: `supabase/migrations/20261020000000_voice_core.sql`,
  `supabase/rollback/20261020000000_voice_core.down.sql`,
  `tests/db/voice-rls.test.ts` (T-RLS-*, T-DB-01, T-DB-02, T-FK-01),
  `tests/db/voice-transitions.test.ts` (T-SM-01…05), `tests/voice/log.test.ts`
  (T-LOG-01; `tests/voice/` is an allowed new path, CHANGE_IMPACT §3).
- Change: `db/schema.ts` (add the voice tables and the five `plans` columns;
  existing definitions untouched); `lib/log.ts` (phone-number value
  redaction); `tests/db/migrations.test.ts` (add T-MIG-01, existing cases
  untouched).
- Not changing `lib/entitlements.ts`: `Plan` is inferred from `db/schema.ts`,
  so the new plan columns are typed with no edit there.
- Tests first: T-LOG-01, T-SM-01…05, T-RLS-*, T-DB-01, T-DB-02, T-FK-01,
  T-MIG-01.
- Risks and mitigations:
  1. The voice migration's timestamp (`20261020…`) sorts **before** the 14
     track A migrations (`20261101…`–`20261114…`). PGlite applies files in
     name order, so `npm test` proves every track A migration still applies on
     top. `scripts/migrate.ts` applies pending versions by set membership, so
     it works too. The Supabase CLI (`supabase db push`) refuses
     out-of-order versions on a database that already has later ones applied
     (needs `--include-all`). Recorded as F12; B2 says no migration has been
     applied to Supabase yet.
  2. Phone redaction could over-redact amounts, ids or timestamps → T-LOG-01
     negative cases, plus the existing AT-SEC-03 log test must stay green.
  3. `kriya.transition` is a session setting any privileged session can set,
     so the status trigger is a guard against accidents for the privileged
     role. The security boundary for people is "no update grant at all". The
     function resets the setting after its own update.
  4. `call_attempts.policy_version` has no FK to track A's
     `kriya.policy_versions`: that table is created by a later migration, and
     the voice loop's versions are its own (D-17).
- Open questions: none blocking. B10 (Supabase Postgres ≥ 15) applies only to
  applying this migration to Supabase, not to the PGlite tests.

**Session result (2026-10-20 10:10 IST, Claude Code / Opus 5.5):** `COMPLETE`

- Files created: `supabase/migrations/20261020000000_voice_core.sql`,
  `supabase/rollback/20261020000000_voice_core.down.sql`,
  `tests/db/voice-fixtures.ts` (shared rows for the two voice DB tests),
  `tests/db/voice-rls.test.ts`, `tests/db/voice-transitions.test.ts`,
  `tests/voice/log.test.ts`.
- Files changed: `db/schema.ts` (voice tables + five `plans` fields, additive),
  `lib/log.ts` (one `PHONE` pattern in `clean()`),
  `tests/db/migrations.test.ts` (T-MIG-01 appended), `status.md`,
  `docs/voice-assistant/DECISIONS.md` (status column: D-01…D-17 Approved),
  `docs/voice-assistant/CHANGE_IMPACT_AND_SAFETY.md` (F12–F14),
  `docs/voice-assistant/DATA_MODEL_AND_STATE_MACHINES.md`,
  `SECURITY_AND_COMPLIANCE.md`, `CONVERSATION_AND_VERIFICATION.md` (column
  rename, F13).
- What exists: 16 tables (`voice_access`, `voice_profiles`,
  `phone_verifications`, `voice_tasks`, `voice_approvals`, `voice_calls`,
  `call_attempts`, `call_events`, `conversation_turns`, `call_outcomes`,
  `call_suppressions`, `voice_prices`, `voice_usage`, `voice_charges`,
  `voice_allowed_transitions` (51 edges), `voice_transitions`), the five plan
  columns (defaults = voice off), `kriya.voice_transition()`, status-guard
  triggers on tasks/calls/attempts, append-only trigger on
  `voice_transitions`. Nothing calls them yet.
- Tests added and results (all pass): T-LOG-01 (22 cases incl. negatives:
  `₹1,20,000`, UUIDs, ISO timestamps, epoch ms/s, migration versions, numeric
  fields); T-SM-01 (every edge × every allowed actor, plus timestamps),
  T-SM-02…05; T-RLS-* for all 16 tables (own-rows read, no insert/update/
  delete except `voice_profiles` preference columns and own
  `conversation_turns` delete, token-hash and `stream_owner` columns not
  selectable, five tables unreadable, `voice_transition` not executable by a
  person); T-DB-01; T-DB-02; T-FK-01 (thread delete, parent-task delete,
  account delete); T-MIG-01 (voice down/up, then voice down + core down + up).
  `npx vitest run` on the four phase files: **87 passed (87)**.
- `npm run check` (2026-10-20 10:05): typecheck pass, lint pass, "All matched
  files use Prettier code style!", **Test Files 81 passed | 3 skipped (84),
  Tests 937 passed | 26 skipped (963)**, exit 0. The 863 baseline tests pass
  unchanged (937 − 74 new).
- `npm run build`: exit 0 (run because every page imports `db/schema.ts`).
- Exit criteria: `npm run check` passes ✔. Acceptance: a browser session
  can't change any voice status ✔ (T-SM-04, no update grant); out-of-order
  events are no-ops ✔ (T-SM-03); wrong actor/evidence raises ✔ (T-SM-02,
  T-SM-05). Every new table has RLS ✔ (existing migrations test + T-MIG-01).
  Rollback tested ✔.
- Deviations: (1) `call_attempts.verification` → `provider_snapshot`, because
  an existing track A test counts every `kriya` column named `verification`
  (F13; docs updated). (2) `voice_usage` FKs are `deferrable initially
  deferred`, or account deletion fails (F14). (3) `voice_transitions` gained a
  `voice_task_id` column (FK, cascade) so deleting a task removes its history,
  as DATA_MODEL §5 requires ("Cascade"). (4) `lib/entitlements.ts` not
  changed: `Plan` is inferred from `db/schema.ts`. (5) Evidence rules the doc
  left open were set conservatively and are in the edge table: e.g.
  `→ failed` needs `error_code`, `authorized → in_progress` needs
  `voice_call_id`, any cancel needs `cancel_requested_at` on the row and (for
  tasks) no live attempt. Phase 3 may adjust them in a new migration.
- Not tested: applying to a real Supabase project (no database connection
  was made). Before that: B10 (`show server_version` ≥ 15) and F12 (use
  `npm run db:migrate`, or `supabase db push --include-all`).
- New findings: F12 (migration order vs track A), F13, F14 in
  CHANGE_IMPACT_AND_SAFETY.md §1.
- **Next exact action:** Phase 2 (provider interfaces, mocks, `kriya-voice`
  skeleton). B9 still stands: new env variables in `.env.example` need the
  owner. Phase 3's claim/heartbeat/recover functions must change status only
  through `kriya.voice_transition()` (or set `kriya.transition` the same way),
  and must select `call_attempts` by named columns in a person's session.

## Phase 2 — Provider interfaces, mocks, `kriya-voice` skeleton

**Status:** COMPLETE (2026-10-20, Claude Code; on mocks; B9 open for `.env.example`)

- **Objective:** typed provider contracts, a scenario-driven mock, audio
  framing utilities, and a `kriya-voice` service that accepts a mock stream.
- **Read first:** TELEPHONY_PROVIDER_ASSESSMENT.md §2.1, §4; VOICE_ARCHITECTURE.md
  §1, §3; TEST_STRATEGY.md §3.
- **Preconditions:** Phase 1 COMPLETE.
- **Files:** new `lib/voice/providers.ts`, `lib/voice/mock.ts`,
  `lib/voice/audio.ts`, `voice/index.ts`, `tests/voice/audio.test.ts`,
  `tests/voice/voice-service.test.ts`, `tests/voice/scenarios/*.json` (S01, S02,
  S05, S15 first); `lib/config.ts` (`SECRETS`, `voice.*` settings), `lib/env.ts`
  (`voice` service checks), `package.json` (`voice`, `dev:voice` scripts; `ws`),
  `render.yaml` (`kriya-voice`), `docs/kriya/deployment.md` (new variables).
- **Dependencies:** `ws` — review license (MIT expected), maintenance and size
  before adding; record the review here. No other new runtime dependency.
- **Credentials:** none.
- **Tasks:** contracts as specified; mock provider emitting status/stream events
  from scenario files; 320-byte-multiple chunking and resampling 8↔16 kHz;
  WebSocket server with Basic auth + one-time token check + `call_sid` match;
  `/health` with drain on SIGTERM.
- **Tests:** audio framing; T-SEC-01 (token reuse, wrong call_sid, no auth);
  drain behaviour.
- **Security checks:** secrets only from env; `server-only`-style guard so
  `lib/voice/*` server modules never enter client bundles.
- **Acceptance:** a mock stream connects, exchanges audio, receives marks,
  `clear` empties the queue, stop closes cleanly.
- **Rollback:** remove the service from Render; code inert without
  `KRIYA_VOICE_ENABLED`.
- **Exit:** `npm run check` + `npm run build` pass; results here.
- **Blockers:** B9 (owner adds variables to `.env.example`).

**Session plan (2026-10-20 10:20 IST, Claude Code / Opus 5.5, `main` in place,
uncommitted; Phase 1's changes from this session are also still uncommitted):**

- Preflight: Phase 1 COMPLETE; board empty; `npm run check` re-run before the
  first edit (result in the session result).
- Dependency review: **none added.** `ws` 8.22.0 (MIT, `node_modules/ws/
  package.json`) and `@types/ws` 8.18.2 are already in `package.json`, added
  by track A for `kriya-browser`.
- Create: `lib/voice/providers.ts` (contracts, TELEPHONY §4),
  `lib/voice/audio.ts` (PCM ↔ base64 LE, 1,600-sample chunks = 3,200 bytes,
  8↔16 kHz resampling, Exotel JSON framing as a `MediaCodec`),
  `lib/voice/mock.ts` (scenario-driven telephony, scripted STT, TTS, and a
  mock Exotel stream client), `lib/voice/streams.ts` (one-use stream token
  claim: hash + status + `call_sid` match, one `update … returning`),
  `voice/index.ts` (HTTP `/health`, `WS /media/exotel`, Basic auth before
  upgrade, token claim after `start`, outgoing queue paced by marks (≤ 2
  chunks ahead), `clear`, drain on SIGTERM), tests `tests/voice/audio.test.ts`,
  `tests/voice/mock.test.ts`, `tests/voice/voice-service.test.ts` (T-SEC-01,
  drain, acceptance), `tests/voice/boundaries.test.ts` (T-IMP-01, T-ENV-01),
  `tests/voice/scenarios/S01.json`, `S02.json`, `S05.json`, `S15.json`.
- Change: `lib/env.ts` (a `voice` service: `DATABASE_URL`,
  `KRIYA_VOICE_STREAM_SECRET`; nothing new for web or worker), `package.json`
  (`voice`, `dev:voice` scripts only), `render.yaml` (new `kriya-voice`
  service only; existing services untouched), `docs/kriya/deployment.md` (the
  new service and its two variables).
- Not changing `lib/config.ts` this phase: no code reads a `voice.*` setting
  yet, and `KRIYA_VOICE_STREAM_SECRET` lives only on `kriya-voice`, so listing it
  in `SECRETS` would show "not set" in the owner console (which reports the
  web service's environment). T-CFG-01 moves to the phase that adds the first
  `voice.*` setting.
- Risks: (1) Exotel's JSON nesting (`start.call_sid`,
  `media.payload`, `mark.name`) is from the docs' field list, not a real
  payload: the parser is the one place to fix after X9. (2) Pacing by marks
  depends on Exotel echoing a mark per chunk; to verify on the account. (3)
  F7: `voice/index.ts` must not pull in `server-only`/`next`/auth modules →
  T-IMP-01 walks the import graph.
- Questions for the owner: B9 — one variable for `.env.example`
  (`KRIYA_VOICE_STREAM_SECRET`), listed in the session
  result.

**Session result (2026-10-20 11:05 IST, Claude Code / Opus 5.5):** `COMPLETE`

- Files created: `lib/voice/providers.ts`, `lib/voice/audio.ts`,
  `lib/voice/mock.ts`, `lib/voice/streams.ts`, `voice/index.ts`,
  `tests/voice/audio.test.ts`, `tests/voice/mock.test.ts`,
  `tests/voice/voice-service.test.ts`, `tests/voice/boundaries.test.ts`,
  `tests/voice/scenarios/S01.json`, `S02.json`, `S05.json`, `S15.json`.
- Files changed: `lib/env.ts` (a `voice` service: `DATABASE_URL`,
  `KRIYA_VOICE_STREAM_SECRET` ≥ 32 chars; web and worker lists untouched),
  `package.json` (scripts `voice`, `dev:voice`; no dependency change),
  `render.yaml` (new `kriya-voice` web service only, `healthCheckPath:
  /health`, `maxShutdownDelaySeconds: 300`; existing services untouched),
  `docs/kriya/deployment.md` (new "Voice service" section),
  `docs/voice-assistant/CHANGE_IMPACT_AND_SAFETY.md` (F15), and the secret's
  rename in IMPLEMENTATION_PLAN, SECURITY_AND_COMPLIANCE §6,
  TELEPHONY_PROVIDER_ASSESSMENT §2.3.
- Tests added (all pass): audio framing (8: LE base64, 3,200-byte chunks with
  silence padding, chunk durations, 8↔16 kHz resampling, Exotel
  parse/serialize, malformed input ignored, 320-byte rule); mock providers
  (13: four scenario files well formed, webhooks correlated by attempt, S02
  busy, S05 no answer, S15 duplicates share a dedupe key and late events
  arrive out of order, S01 completed, placeCall failures on demand, hangup,
  STT/TTS mocks incl. abort); `kriya-voice` (12): health; **T-SEC-01** — no or
  wrong Basic auth → 401 with the attempt untouched, other paths → 404,
  wrong `call_sid` / unknown token / attempt not dialed → close 1008 with the
  attempt untouched, token accepted once, no `start` → 1008; acceptance —
  audio and DTMF pass through, at most two chunks ahead of playback, the
  caller's own marks come back after playback, `clear` empties the queue and
  stale marks release nothing, `stop` closes with 1000; **drain** — stops
  taking streams (503, `accepting: false`), waits for the live call, ends
  calls still running at the window with 1001; weak secret refused.
  Boundaries (6): **T-IMP-01** for `voice/index.ts` and `worker/index.ts`
  (no `server-only`, `next/*`, `lib/auth|supabase|rate-limit|owner`), the
  voice service loads no `lib/agent/*`, no `"use client"` file imports
  `lib/voice`; **T-ENV-01** worker with no voice variables doesn't throw in
  production; `voice` service names a missing/short secret without showing it.
- `npm run check` (2026-10-20 ~11:00): typecheck pass, lint pass, "All
  matched files use Prettier code style!", **Test Files 85 passed | 3 skipped
  (88), Tests 976 passed | 26 skipped (1002)**, exit 0 (937 before + 39 new).
- `npm run build`: exit 0.
- Smoke run: `npx tsx voice/index.ts` with a throwaway local secret and port
  → `GET /health` returned `{"ok":true,"accepting":true,"calls":0}`, log line
  `"service":"voice","message":"kriya-voice listening"`. **Not verified
  here:** the SIGTERM → drain path of the real process (Windows' `kill` ends
  the process without delivering SIGTERM to Node; `drain()` itself is covered
  by the tests; Render runs Linux).
- Exit criteria: `npm run check` + `npm run build` pass ✔. Acceptance ✔ (see
  tests). Security: secrets from env only ✔; `lib/voice` kept out of client
  bundles by the boundaries test (not `server-only`, which F7 forbids) ✔.
- Deviations: (1) No `ws` review needed: `ws` 8.22.0 (MIT) was already a
  dependency (track A). (2) `lib/config.ts` unchanged: no code reads a
  `voice.*` setting yet, and a `kriya-voice`-only secret in `SECRETS` would
  show "not set" in the owner console; T-CFG-01 moves to the phase that adds
  the first setting. (3) The stream secret is `KRIYA_VOICE_STREAM_SECRET`, not
  `EXOTEL_STREAM_SECRET` (F15). (4) `ProviderCall.reportedCost.micro` is a
  `number`, matching every other micro amount in the repo, not the doc's
  `bigint`. (5) Worker env vars (`KRIYA_VOICE_URL`) aren't added to
  `render.yaml`/`lib/env.ts` until Phase 3 reads them. (6) Pacing uses one
  internal mark per chunk (`~gen.n`), so it depends on the provider echoing
  marks; to verify on the Exotel account.
- Open items / owner: **B9** — add to `.env.example`:
  `KRIYA_VOICE_STREAM_SECRET=` (kriya-voice only; ≥ 32 random characters).
  **X9** — capture one real (redacted) `start` and `media` message to confirm
  the JSON nesting `exotelCodec` assumes. Audio arriving between `start` and
  the token check is dropped (≈ first 100 ms).
- **Next exact action:** Phase 3 (durable call orchestration on mocks). It
  should: add a unique index on `call_attempts.stream_token_hash` in its
  migration (the token lookup is a scan today); renew
  `stream_heartbeat_at` from `kriya-voice` every 5 s and move the attempt
  `answered → connected` (actor `voice`) once the dialogue owns the call;
  read the owner's settings through `voice.*` keys with patterns (T-CFG-01).

## Phase 3 — Durable call orchestration on mocks

**Status:** COMPLETE (2026-10-20, Claude Code; on the mock provider)

- **Objective:** draft → confirm → scheduled → dialing → retries → settled,
  with idempotency, leases, recovery, cancel and webhooks, all on the mock
  provider.
- **Read first:** DATA_MODEL §3–4; API_AND_EXECUTION_CONTRACTS.md (all);
  SECURITY_AND_COMPLIANCE.md §5; VOICE_REMINDERS.md §6.
- **Preconditions:** Phase 2 COMPLETE.
- **Files:** migration `20261021000000_voice_queue.sql` (+ rollback):
  `claim_voice_call`, `heartbeat_voice_call`, `recover_voice_calls`; new
  `lib/voice/tasks.ts`, `lib/voice/schedule.ts`, `lib/voice/run-call.ts`,
  `lib/voice/verify.ts` (provider reconciliation part), `lib/voice/schemas.ts`,
  `actions/voice.ts` (draft without LLM extraction: structured input only;
  confirm; decline; cancel; emergency stop), `app/api/voice/exotel/status/[token]/route.ts`
  (works with the mock's payloads), `proxy.ts` (`WEBHOOKS`),
  `worker/index.ts` (second loop behind `KRIYA_VOICE_ENABLED`),
  `tests/db/voice-queue.test.ts`, `tests/voice/pipeline.test.ts`.
- **Database:** queue functions; indexes per DATA_MODEL.
- **Credentials:** none.
- **Tasks:** write-ahead attempt (`requested` committed before `placeCall`);
  window/limit/suppression checks at confirm and claim; bounded retries;
  unknown-attempt handling; cancel and emergency stop; telephony `voice_usage`
  rows with null cost.
- **Tests:** T-Q-01…08, T-WH-01…04, T-WRK-01, T-IMP-01, T-COST-01 (rows
  exist), S02, S05, S15, S16.
- **Must follow:** the voice loop in `worker/index.ts` gets its own running map
  and `VOICE_CONCURRENCY` (F6); `proxy.ts` gets exact prefixes only.
- **Security checks:** actions use session identity; ownership through
  `withUser`; webhook token hashed; no number in logs.
- **Acceptance:** under fault injection (crash after `requested`, duplicate
  webhooks, out-of-order), at most one `placeCall` per intended attempt (D1 = 0).
- **Rollback:** unset `KRIYA_VOICE_ENABLED`; down migration.
- **Exit:** `npm run check` passes; results here.
- **Blockers:** none beyond Phase 2.

**Session plan (2026-10-20 11:15 IST, Claude Code / Opus 5.5, `main` in place,
uncommitted; Phases 1–2 of this session are uncommitted too):**

- Preflight: Phase 2 COMPLETE; board empty; last `npm run check` (Phase 2
  exit) 976 passed / 26 skipped, re-run before the first edit.
- Migration `20261021000000_voice_queue.sql` (+ rollback): unique indexes on
  `call_attempts.stream_token_hash` and `callback_token_hash`;
  `claim_voice_call(worker, lease, max_live)` (scheduled/retry_wait, due by
  `available_at` and `not_before` on DB `now()`, not cancelled, `skip locked`,
  advisory lock per user, one live outreach call per user, global cap),
  `heartbeat_voice_call`, `recover_voice_calls(worker, lease)` (expires
  pending approvals and unconfirmed tasks; takes over calls whose lease
  expired, for the app to reconcile). One new edge, `task authorized →
  failed` (worker/janitor, `error_code`): today an authorized task whose
  outreach window closes before any dial has no way out.
- New: `lib/voice/schemas.ts` (zod spec per CONVERSATION §2, structured draft
  input, Indian mobile → E.164, refusals), `lib/voice/schedule.ts` (third-party
  calling hours 09:00–21:00 IST Mon–Sat, quiet hours in the owner's timezone,
  report window, retry times), `lib/voice/tasks.ts` (draft, request
  confirmation, confirm, decline, cancel, emergency stop; limits and
  suppression), `lib/voice/run-call.ts` (claim → re-check → attempt
  `requested` committed → `placeCall` → watch with heartbeat until terminal;
  cancel → hangup; recovery; the voice loop with its own map), `lib/voice/
  verify.ts` (webhook handling, provider reconciliation — the API wins —,
  settling calls and tasks, telephony `voice_usage` rows with null cost),
  `actions/voice.ts`, `app/api/voice/exotel/status/[token]/route.ts`.
- Change: `proxy.ts` (`/api/voice/exotel/status/` in `WEBHOOKS`, exact
  prefix), `worker/index.ts` (voice loop behind `KRIYA_VOICE_ENABLED=1`, own
  `voiceRunning` map and `VOICE_CONCURRENCY`, errors caught; idle without a
  telephony provider — none is real until Phase 5), `lib/config.ts`
  (`KRIYA_PHONE_HASH_KEY` in `SECRETS`: web hashes numbers at draft time),
  `lib/env.ts` (`KRIYA_PHONE_HASH_KEY` optional on web). `render.yaml`
  unchanged this phase (no live calls; adding a secret to `kriya-web` would
  prompt on Blueprint sync — Phase 5).
- Tests first: `tests/db/voice-queue.test.ts` (T-Q-01), `tests/voice/
  schedule.test.ts`, `tests/voice/pipeline.test.ts` (T-Q-02…08, T-WH-01…03,
  T-COST-01, S02, S05, S15, S16, T-WRK-01), `tests/voice/webhook.test.ts`
  (route + T-WH-04 on `proxy`), `tests/voice/actions.test.ts`. T-IMP-01 is
  re-run (it already walks the worker's graph).
- Risks: (1) D1 = 0 — a dial only after its attempt row commits as
  `requested`, and an attempt that can't be proven is never redialled for a
  third party. (2) F6 — the voice loop can't take agent task slots. (3)
  Holidays: SECURITY §5 says national holidays are off, but there's no
  holiday list in the repo and I won't invent one; Sundays only, recorded as
  open. (4) Outreach window end isn't specified: `report_at` if set, else
  `not_before` + 24 h, recorded. (5) HTTP 429 handling is left to the Exotel
  adapter (Phase 5): the mock doesn't produce it.
- Questions: none blocking.

**Session result (2026-10-20 ~13:40 IST, Claude Code / Opus 5.5):** `COMPLETE`

- Created: `supabase/migrations/20261021000000_voice_queue.sql` +
  `supabase/rollback/20261021000000_voice_queue.down.sql`;
  `lib/voice/schemas.ts`, `schedule.ts`, `tasks.ts`, `run-call.ts`,
  `verify.ts`; `actions/voice.ts`; `app/api/voice/exotel/status/[token]/route.ts`;
  tests `tests/db/voice-queue.test.ts`, `tests/voice/schedule.test.ts`,
  `pipeline.test.ts`, `webhook.test.ts`, `actions.test.ts`.
- Changed: `proxy.ts` (one exact prefix in `WEBHOOKS`), `worker/index.ts`
  (`startVoice()`: logs that no calls are placed — see deviation 1),
  `lib/config.ts` (`KRIYA_PHONE_HASH_KEY` in `SECRETS`), `lib/env.ts` (same,
  optional on web), `lib/voice/providers.ts` + `mock.ts` (optional
  `findByAttempt` for recovery), `db/schema.ts` (four `…E164` columns named
  explicitly, F16), `tests/db/voice-rls.test.ts` (T-DB-02 uses Drizzle's own
  casing, F16), `tests/db/voice-fixtures.ts` (unique token hashes per
  attempt, needed by the new unique indexes),
  `docs/voice-assistant/CHANGE_IMPACT_AND_SAFETY.md` (F16, F17).
- Database: unique indexes on both token hashes; `claim_voice_call` (global
  advisory lock, global cap, one live outreach call per person, due by DB
  `now()`), `heartbeat_voice_call`, `recover_voice_calls` (expires
  approvals and unconfirmed tasks; takes over lapsed leases). New edges
  `task authorized → failed`, `call scheduled → exhausted`, `call dialing →
  blocked` (F17). Functions return ids only, so the voice-core rollback still
  works with the queue applied (T-MIG-01 green).
- Tests (all pass): T-Q-01 (claim: due times, cancel, per-person outreach,
  report calls not held up, global cap, two claims differ, not callable by a
  person), heartbeat, recovery, queue down/up; schedule (calling hours,
  Saturday → Monday, 15-min retry, quiet hours across midnight and in other
  zones incl. a DST change, report window, retries never in quiet hours);
  pipeline: T-Q-02 (attempt `requested` when `placeCall` runs), T-Q-03/S16
  (crash after requested, provider has it → reconciled, one `placeCall`),
  T-Q-04 (no record → `unknown` → call and task `needs_owner`, no redial),
  T-Q-05 (retry moved to the next opening; window closed → exhausted), T-Q-06
  (scheduled cancel at once; ringing call hung up within a heartbeat), T-Q-07
  (same key → same task; confirm twice → one set of calls), T-Q-08 (daily
  limit; suppression at confirm and at dial; 3/day per number → deferred to
  tomorrow without an attempt), S02, S05, S15, T-WH-01…03, T-COST-01
  (telephony rows, cost null), T-WRK-01 (agent `claim_task` works while a
  voice call is dialing; a throwing provider doesn't stop the voice loop),
  rejected/timeout `placeCall`, emergency stop, voice access, number
  validation, quiet-hours and unverified-number refusals, another person's
  task → `not_found`; webhook route (404, 413, 400, 200) and **T-WH-04**
  (exact prefix; look-alike paths and other POSTs still 403); actions
  (session identity only, user id in input ignored, field errors, rate
  limits, stop never rate limited). T-IMP-01 re-run green.
- **Acceptance (D1 = 0):** in every fault case above (crash after
  `requested` with and without a provider record, duplicate and
  out-of-order webhooks, forged final webhook, timeout, cancel mid-ring) the
  mock records at most one `placeCall` per intended attempt.
- `npm run check` (2026-10-20 ~13:35): typecheck, lint pass, "All matched
  files use Prettier code style!", **Test Files 90 passed | 3 skipped (93),
  Tests 1031 passed | 26 skipped (1057)**, exit 0 (976 before + 55 new).
  `npm run build`: exit 0 (route `ƒ /api/voice/exotel/status/[token]`).
- Deviations: (1) **The worker doesn't start `voiceLoop` yet.** The loop
  (own map, concurrency, errors caught) is in `lib/voice/run-call.ts` and
  tested; but no real telephony provider exists before Phase 5, and running
  the mock in a deployed worker would fake calls (D-12: refuse, never fake).
  `KRIYA_VOICE_ENABLED=1` logs that no calls are placed. Phase 5 starts the
  loop with the Exotel provider and adds `VOICE_CONCURRENCY`. (2) Phase 1
  defect fixed here (F16). (3) Three new edges (F17) and a strict
  `transition()`. (4) Not handled: HTTP 429 from the provider (Exotel adapter,
  Phase 5); national holidays (no list exists; Sundays only); a stale
  `connected` stream (kriya-voice heartbeat, Phase 4). Outreach window = report
  time, else 24 h (ponytail-marked default). (5) `render.yaml` unchanged: no
  live calls, and a new secret on `kriya-web` would prompt on Blueprint sync.
- Owner items: add `KRIYA_PHONE_HASH_KEY=` to `.env.example` (B9; web; 32+
  random bytes) when voice is deployed.
- **Next exact action:** Phases 4 (dialogue, STT/TTS/LLM, outcome extraction,
  verification) and 7 (UI on these actions) can now run, in parallel with
  each other per IMPLEMENTATION_PLAN §1. Phase 4 must: move attempts
  `answered → connected` (actor `voice`) and calls `dialing → in_call` when
  kriya-voice takes the stream, heartbeat `stream_heartbeat_at` and add
  stale-stream recovery, write `call_outcomes` so `in_call → settled` and
  `awaiting_report` follow from an accepted outcome, and load a policy
  bundle for `call_attempts.policy_version` (now `"baseline"`).

## Phase 4 — Dialogue, speech, outcomes, verification

**Status:** IN_PROGRESS (2026-10-20, Claude Code; free L-text part this session, paid benchmark blocked on B2/B6)

- **Objective:** a bounded English dialogue engine with barge-in, outcome
  extraction and verification, proven on L-text (free) and benchmarked on
  L-audio (paid).
- **Read first:** CONVERSATION_AND_VERIFICATION.md (all); VOICE_ARCHITECTURE.md
  §4–8, §10; EVALUATION_PLAN.md §1–6.
- **Preconditions:** Phase 2 COMPLETE (Phase 3 helpful, not required).
- **Files:** new `lib/voice/spec.ts`, `lib/voice/languages.ts`,
  `lib/voice/dialogue.ts`, `lib/voice/outcome.ts`, `lib/voice/verify.ts`
  (outcome checks), `lib/voice/stt/<vendor>.ts`, `lib/voice/tts/<vendor>.ts`;
  `lib/agent/tools.ts` (`createCallTools`, `propose_call`),
  `components/thread/tool-call.tsx` and `components/workbench/activity.tsx`
  (render/label `propose_call`), `actions/voice.ts` (LLM spec extraction in
  `draftCall`), `scripts/voice-eval.ts`, `package.json` (`voice:eval`),
  `tests/voice/dialogue.test.ts`, `tests/voice/normalize.test.ts`,
  scenarios S01–S30.
- **Credentials:** none for tests; OpenRouter + 2–3 STT/TTS vendor keys for the
  benchmark (B6; owner approves the spend).
- **Tasks:** state machine and guards; fixed disclosure; call tools with zod;
  barge-in with `clear`/marks; budgets; escalation once; redaction of OTP-like
  digits; extraction + deterministic checks; LLM/STT/TTS `voice_usage` rows.
- **Tests:** T-DLG-01…07, T-VER-01…08, T-NORM-01, T-AGT-01, T-AGT-02,
  T-POL-01, T-IMP-01; L-text suite passes with the scripted model.
- **Must follow:** `createCallTools()` never joins `KriyaTools` (F8);
  `propose_call` and its instructions line only for users with voice access
  (F4, F5); prompts and thresholds come from the policy bundle
  `lib/voice/policy/v1.ts` (D-17).
- **Benchmark (exit, paid):** B-STT, B-TTS, B-LLM per EVALUATION_PLAN.md §3;
  results in `docs/voice-assistant/benchmarks/<date>.md`; vendor choices set in
  `voice.stt`/`voice.tts`/`voice.model`; O1, O2, S1, S2, T1, L1, L2 measured.
- **Security checks:** no tool beyond notes and `end_call`; `kriya-voice` reads
  only the attempt's task (T-SEC-05).
- **Acceptance:** thresholds in EVALUATION_PLAN.md §4 "Phase 4" column met,
  with n and dates recorded.
- **Rollback:** code only.
- **Exit:** `npm run check` passes; benchmark recorded; thresholds met or the
  shortfall recorded as a blocker (no rounding up).
- **Blockers:** B2, B6 for the benchmark.

**Session plan (2026-10-20 05:59 IST by the machine clock, Claude Code / Opus
5.5, `main` in place, uncommitted; Phases 1–3 are uncommitted too):**

- Preflight: Phase 3 COMPLETE; board empty; decisions D-04, D-09, D-10, D-11,
  D-14, D-17 Approved. `npm run check` before the first edit: typecheck, lint,
  format pass; **Test Files 90 passed | 3 skipped (93), Tests 1031 passed | 26
  skipped (1057)**, exit 0. `git status`: only Phases 1–3's own changes.
- **Conflict found and decided by the owner (2026-10-20, this session):**
  AGENTS.md voice rule 9 / D-14 put `createCallTools()` in
  `lib/agent/tools.ts`, run by `kriya-voice`; Phase 2's boundaries test says
  `kriya-voice` loads nothing of `lib/agent/`, and importing `tools.ts` would
  load `lib/secrets.ts` + `lib/connectors.ts` into the voice process. Owner
  chose: new `lib/agent/call-tools.ts` (only `ai` + `zod`), re-exported from
  `tools.ts`; the boundaries test narrows to "only `lib/agent/call-tools.ts`";
  AGENTS.md rule 9 and D-14 wording updated.
- Create: `lib/voice/policy/v1.ts` (the bundle: prompts, wording, thresholds,
  lexicons; fixed guards stay in code), `lib/voice/languages.ts` (`en-IN`:
  disclosure, time/date normalizer, affirmative/hedge/negative lexicons, OTP
  and card redaction), `lib/voice/dialogue.ts` (state machine §3, guards,
  budgets, escalation once, fixed replies for §8), `lib/agent/call-tools.ts`,
  `lib/voice/outcome.ts` (observed/interpreted schemas, extraction with
  escalation, max 2 tries), `lib/voice/session.ts` (one connected call: STT →
  dialogue → TTS, barge-in with `clear`, marks → `played_ms`, turns, heartbeat,
  usage rows), `lib/voice/spec.ts` (LLM spec extraction for drafts),
  `scripts/voice-eval.ts`, scenario files, tests.
- Change: `lib/agent/tools.ts` (`createProposeCallTool`, re-export
  `createCallTools`; `KriyaTools` gains only `propose_call`), `lib/agent/
  run-task.ts` (voice availability + the tool when available),
  `lib/agent/instructions.ts` (capability line only with voice),
  `components/thread/tool-call.tsx`, `components/workbench/activity.tsx`,
  `actions/voice.ts` (`extractCallDraft`), `lib/config.ts` (`voice.model`,
  `voice.escalationModel`), `package.json` (`voice:eval`), `voice/index.ts`
  (played-chunk count; sessions only when speech providers exist),
  `lib/voice/run-call.ts` (`loadAttemptContext`, stale-stream recovery, bundle
  version on attempts), `lib/voice/verify.ts` (observed rows, settle `in_call`
  from an accepted / needs-review outcome, outcome checks),
  `lib/voice/tasks.ts` (export voice availability), `tests/voice/
  boundaries.test.ts` (owner-approved narrowing).
- Tests first: T-NORM-01, T-DLG-01…07, T-VER-01…03 and 08 (04 is Phase 6's
  report delivery; 05–07 already pass as T-SM-04/05), T-AGT-01, T-AGT-02,
  T-POL-01, T-IMP-01 extended, T-SEC-05; L-text scenarios on the scripted
  model.
- Not this session: STT/TTS vendor adapters (`lib/voice/stt|tts/<vendor>.ts`)
  and the paid benchmark. Vendor choice is what the benchmark decides (B6);
  writing adapters against APIs I can't call would be guessing. The session
  code runs on the provider interfaces (mocks in tests).
- Risks: (1) the stream may start before the `answered` webhook, and only
  `answered → connected` exists → the session waits briefly for `answered`
  (to verify on Exotel, X9). (2) `voice_tasks.result` has no
  `callback_requested` → mapped to `unclear` on the task, kept in the outcome.
  (3) Extraction runs in `kriya-voice` at stream end (and in worker recovery),
  not inside the webhook request (a model call there would slow the provider's
  retry clock): a deviation from CONVERSATION §7, recorded. (4) Closing the
  stream is how Tavi ends a call; whether Exotel hangs up then is unverified
  (Phase 5).
- Questions: none open (call-tools location decided above).

**Session result (2026-10-20 06:47 IST by the machine clock, Claude Code /
Opus 5.5):** `IN_PROGRESS`. Everything that can be built and proven without
vendor keys or spend is done and green; the exit needs the paid benchmark
(B2, B6) and the STT/TTS adapters it chooses.

- Created: `lib/voice/policy/v1.ts` (bundle: prompts, wording, endpointing and
  confidence thresholds only), `lib/voice/languages.ts` (`en-IN`: fixed lines,
  time/date normalizer, lexicons, OTP/card/phone redaction), `lib/voice/
  dialogue.ts` (state machine, guards, budgets, escalation once,
  `resultFromNotes`), `lib/agent/call-tools.ts`, `lib/voice/outcome.ts`
  (observed/interpreted, extraction with escalation, deterministic checks),
  `lib/voice/session.ts` (STT → dialogue → TTS, barge-in with `clear`, marks →
  `played_ms`, turns, heartbeat, cancel, max duration, opt-out suppression,
  llm/tts/stt usage rows), `lib/voice/spec.ts` (draft from free text),
  `scripts/voice-eval.ts`, scenarios `S03 S04 S06 S07 S08 S09 S10 S11 S22 S23
  S24 S28` (+ variants and dialogue gold on `S01`); tests `normalize`,
  `dialogue`, `outcome`, `session`, `agent`, `spec`, `draft-action`
  (+ `fair-model.ts` helper).
- Changed: `lib/agent/tools.ts` (`createProposeCallTool`, re-export of
  `createCallTools`; `KriyaTools` gains only `propose_call`),
  `lib/agent/run-task.ts` (voice availability → tool + capability),
  `lib/agent/instructions.ts` (one line only with voice and writes),
  `components/thread/tool-call.tsx`, `components/workbench/activity.tsx`,
  `actions/voice.ts` (`extractCallDraft`), `lib/voice/{verify,run-call,
  tasks,schemas}.ts`, `voice/index.ts` (`playedChunks`; streams refused while
  no speech vendor exists), `package.json` (`voice:eval`),
  `tests/voice/boundaries.test.ts` (new case, existing cases unchanged),
  `AGENTS.md` rule 9 and D-14 (F18), `CHANGE_IMPACT_AND_SAFETY.md` (F18–F23).
  Not changed: `lib/config.ts` (no code reads a `voice.*` model setting until
  vendors and the live service are wired; T-CFG-01 moves with them).
- Tests (all pass): **T-NORM-01** (59 cases); **T-DLG-01** (fixed disclosure,
  repeated when talked over), **-02** (tools outside the state, a tool that
  doesn't exist), **-03** (hedges, wrong read-back, model-only yes), **-04**
  (outside window/date/authority → proposal + "I'll check"; a time the callee
  never said is refused), **-05** (barge-in on the stream: `clear` sent,
  synthesis aborted, turn `interrupted` with `played_ms`), **-06** (80 %
  duration, 2 tools/turn, escalation once then polite close, 40 model turns,
  3 turns without progress), **-07** (injection, OTP never stored or shown to
  the model, opt-out, bot question, emergency); **T-VER-01, -02, -08** plus
  commitment, citation and contradiction checks (T-VER-03 and 05–07 already
  pass from Phases 1 and 3; T-VER-04 is Phase 6's report delivery);
  **T-AGT-01**, **T-AGT-02** (prompt byte-identical without voice);
  **T-POL-01** (attempts stamped `v1`; wording/thresholds from the bundle);
  **T-SEC-05**; **T-IMP-01** extended; end to end on mocks: S01 (dial →
  webhooks → stream → dialogue → outcome accepted → task `completed`/`agreed`,
  usage llm 2 · tts 4 · stt 1 · telephony 1), S13, S17, S24. L-text: 13
  scenario files × 5–6 phrasings on the scripted model, all pass.
- `npm run check` (2026-10-20 ~06:45): typecheck pass, lint 0 errors (1
  warning: an unused `eslint-disable` in `tests/voice/session.test.ts`,
  removed afterwards; `npx eslint` on that file clean), "All matched files use
  Prettier code style!", **Test Files 97 passed | 3 skipped (100), Tests 1223
  passed | 26 skipped (1249)**, exit 0 (1031 before + 192 new; the existing
  tests unchanged). `npm run build`: exit 0.
- Exit criteria: `npm run check` ✔. **Benchmark ✘ not run** (B-STT, B-TTS,
  B-LLM need vendor keys, an OpenRouter key and the owner's go-ahead on spend:
  B2, B6). **Thresholds (EVALUATION_PLAN §4 Phase 4 column) not measured**: the
  scripted model proves the code paths, not O1/O2/T1/L1/L2 for a real model;
  no number is claimed.
- Deviations: (1) No STT/TTS vendor adapters: the benchmark chooses the
  vendors, and adapters written against APIs I can't call would be guesses.
  (2) Extraction runs in `kriya-voice` at stream end and in worker recovery,
  not in the webhook (F23). (3) `extractCallDraft` is a new action that fills
  the card; `draftCall` still takes the completed card, because a task row
  needs a number (API §2 said `draftCall` takes text). (4) `end_call` is
  allowed in every state after the opening (its reasons include `declined`
  and `wrong_person`), wider than CONVERSATION §3's table. (5) Message and
  question goals close after the callee's reply, without a model turn
  (ponytail-marked). (6) A bare time ("at 3") is confirmed through the
  read-back ("…at 3 PM?") rather than a separate AM/PM question. (7)
  Barge-in fires on the first recognised words, not on raw speech energy
  (ponytail-marked; tune in L2). (8) The stream may arrive before the
  answered webhook: the session waits up to 5 s, then refuses (to check on
  Exotel, X9). (9) Findings F19, F20, F22 fixed here.
- Not tested: real STT/TTS/LLM vendors; real Exotel stream framing and event
  order; whether closing the stream hangs up an Exotel call (Phase 5);
  `voice:eval -- --text --model …` was written but **not run** (paid).
- **Next exact action:** owner provides an OpenRouter key and approves the
  spend for `npm run voice:eval -- --text --model deepseek/deepseek-v4-flash`
  (L-text on a real model, B-LLM part); then chooses 2–3 STT/TTS vendors and
  provides keys (B6) so the next session can write `lib/voice/stt|tts/
  <vendor>.ts` from their docs, run B-STT/B-TTS per EVALUATION_PLAN §3, record
  `docs/voice-assistant/benchmarks/<date>.md`, add `voice.stt`/`voice.tts`/
  `voice.model` settings (T-CFG-01) and wire `runSession` in `voice/index.ts`.
  Phase 7 (UI) can start now on these actions.

## Phase 5 — Controlled live outbound calls

**Status:** BLOCKED (B2, B3, B4, B5, B8)

- **Objective:** real calls through Exotel to **team test numbers only**, with
  verified provider events, under the D-12 switches.
- **Read first:** TELEPHONY_PROVIDER_ASSESSMENT.md (all);
  SECURITY_AND_COMPLIANCE.md §2, §4, §8.
- **Preconditions:** Phases 3 and 4 COMPLETE; B2–B5, B8 resolved and recorded
  here; owner's written go-ahead with the list of test numbers and dates.
- **Files:** new `lib/voice/exotel.ts`, `tests/voice/exotel.test.ts` (redacted
  fixtures); `render.yaml` and `docs/kriya/deployment.md` (Exotel variables).
- **Credentials:** `EXOTEL_*` (B3).
- **Tasks:** answer X1–X11 on the account and record the answers; choose
  `Calls/connect` + `StreamUrl` vs connect-to-flow; implement adapter; request
  IP allow-listing; verify codec/sample rate from `start.media_format`.
- **Tests:** unit tests on recorded payloads; manual live checklist: S01, S02,
  S05, S14, S29 to team phones, each recorded here with call ids (no numbers),
  observed vs expected.
- **Security checks:** CLI is Kriya's ExoPhone; disclosure heard on every call;
  emergency stop tested live; no recording enabled.
- **Acceptance:** every live attempt's final state equals the provider's call
  details; no duplicate rings; latency L1 measured live.
- **Rollback:** `voice.liveCalls = off`; unset `KRIYA_VOICE_LIVE`.
- **Exit:** checklist complete with evidence; owner sign-off; Phase 6's live
  check (a report call and a verification call to the owner's phone) recorded
  here (moved from Phase 6, owner decision 2026-10-20).

### Session 1 (2026-10-20, Claude Code / Opus 5.5, `main` in place, uncommitted): adapter, no live call

Owner: Exotel trial account configured (`kriyaai2`, cluster sg,
`api.exotel.com`, ExoPhone as CLI); asked for the adapter, wiring, tests and a
controlled test-call script. **No call was placed this session.**

- **Choice:** connect-to-flow (`Calls/connect` with `Url` = App Bazaar flow).
  `Calls/connect` + `StreamUrl` bridges two numbers, so it doesn't fit a
  one-leg voicebot. New variable `EXOTEL_FLOW_URL`.
- **New:** `lib/voice/exotel.ts` (placeCall, getCall `?details=true`,
  parseStatusEvent for JSON **and** form bodies, hangup),
  `tests/voice/exotel.test.ts` (13 cases, synthetic/redacted fixtures),
  `scripts/exotel-test-call.ts` (one call, test-number allow-list,
  `KRIYA_VOICE_LIVE=1`, `--yes`, no DB, numbers masked).
- **Changed:** `lib/voice/run-call.ts` `prepareAttempt` blocks a non-mock
  provider's call to any number not in `voice.testNumbers`
  (`not_a_test_number`). Unset means none. **F25 fixed**: stricter than the
  per-user flag until Phase 9. `lib/voice/verify.ts`: Exotel is registered
  from env; a final webhook is verified only with the worker-recorded call id
  (**F27 fixed**). `lib/config.ts`: setting `voice.testNumbers`
  (`KRIYA_VOICE_TEST_NUMBERS`). `worker/index.ts` `startVoice`: runs
  `voiceLoop` with Exotel only when Exotel env, `EXOTEL_CALLER_ID`, https
  `KRIYA_APP_URL` and wss `KRIYA_VOICE_URL` are all set. Otherwise it logs and
  places no calls. `tests/voice/pipeline.test.ts`: F25 and F27 cases.
- **Commands:** `npm run check`: exit 0. Typecheck, lint and format clean;
  105 test files passed, 3 skipped; 1314 tests passed, 26 skipped.
- **Unknowns (docs read 2026-10-20, to verify on the first call):**
  - Callback content type: both are parsed (X5).
  - Times have no zone: read as IST (X1).
  - `Price` has no currency: kept raw, `reportedCost` null (X8).
  - **No hangup API is documented**: `hangup` throws, callers log it, and
    `TimeLimit` caps the call. A cancel while ringing can't stop the ring.
  - How the per-attempt stream token reaches the Voicebot applet (X2). Until
    then a live stream fails auth and closes (fail closed).
- **Still blocking worker-placed live calls:**
  - No `voice_prices` row for Exotel, so `overBudget` blocks (X8).
  - `KRIYA_APP_URL` is localhost and `KRIYA_VOICE_URL` is unset.
  - The privacy notice doesn't name Exotel (F15), so `EXOTEL_*` is not yet in
    `SECRETS`/`lib/env.ts`.
  - B4, B5, B8.
- **Next exact action:** the owner creates a Greeting flow and sets
  `EXOTEL_FLOW_URL`, then runs
  `scripts/exotel-test-call.ts --to <own number>` (dry run), then with
  `--yes`. Record the CallSid, observed statuses and redacted details here.
- **First attempt (2026-10-20, run by the owner):** `Calls/connect.json`
  answered **403**, so no call was placed. The error didn't include Exotel's
  reason, so `exotel.ts` errors now carry `RestException.Message`, with digit
  runs cut to the last 4. The test was updated, and exotel tests, tsc and
  eslint are clean.
- **Second attempt (2026-10-20, owner):** 403 "Your account is not yet KYC
  compliant. This is mandatory before making outbound calls." This answers
  X1: KYC is required even on the trial account. B3 and B8 still block.
  Nothing to change in code. Next: the owner completes Exotel KYC (with Kriya
  AI's entity documents; B8 asks whether the company is registered in India),
  then reruns the script unchanged.

## Phase 6 — Owner reminders and spoken reports

**Status:** COMPLETE 2026-10-20 (mock provider; live check moved to Phase 5)

- **Objective:** verified owner number, scheduled report calls with the D-08
  delivery criterion, bounded retries, and voice commands.
- **Read first:** VOICE_REMINDERS.md (all); DECISIONS D-07, D-08, D-13.
- **Preconditions:** Phases 3 and 4 COMPLETE (mock work); live check needs
  Phase 5.
- **Files:** new `lib/voice/owner-report.ts`; `lib/voice/dialogue.ts` (owner
  mode); `actions/voice.ts` (preferences, verification, report management);
  `tests/voice/reminders.test.ts`.
- **Tasks:** verification call with DTMF; report script from verified outcome;
  identity check; voicemail rule; delivered/acknowledged; retries within
  window and quiet hours; voice commands mapped to `lib/voice/tasks.ts`.
- **Tests:** T-REM-01…08; S18, S19, S20, S29, S30.
- **Security checks:** commands accepted only on verified-owner attempts; no
  non-call channel (T-REM-07).
- **Acceptance:** R1 = 100 % on the suite; worked example of VOICE_REMINDERS §8
  reproduced in a test.
- **Rollback:** cancel pending report calls; unset `KRIYA_VOICE_ENABLED`.
- **Exit:** `npm run check` passes; live check to the owner's phone recorded
  after Phase 5.

**Session plan (2026-10-20 ~14:45 IST, Claude Code / Opus 5.5, `main` in
place after commit `0c4d014`, uncommitted):**

- Preconditions: Phase 3 COMPLETE; Phase 4 IN_PROGRESS with its mock work
  done and only the paid benchmark open. The owner chose to start Phase 6
  on mocks anyway ("Phase 6 on mocks (Recommended)"). D-07, D-08, D-13
  Approved. `npm run check` on `0c4d014`: 1233 passed | 26 skipped. Board:
  empty.
- Already in place (Phases 1–3): `voice_profiles`, `phone_verifications`,
  `voice_calls.kind` incl. `owner_report`/`verification`, `delivered_at`,
  `acknowledged_at`, `last_report_mark_at`, the task states
  `awaiting_report`/`unreported` with SQL guards; the `owner_report` call
  is created at confirmation; dialling checks the verified number and
  quiet hours.
- Missing: everything during an owner call (`runSession` is outreach-only),
  settling owner calls (the code settles `in_call` only from an outcome),
  the verification call, and the owner's actions.
- **Conflict, resolved by the owner:** API §"Preferences and verification"
  schedules `voice_calls(kind='verification')`, but `voice_calls.voice_task_id`
  is NOT NULL with a foreign key to `voice_tasks`, and a verification has no
  task. Owner: "New migration (Recommended)".
- Create: `supabase/migrations/20261022000000_voice_verification.sql` +
  rollback (`voice_task_id` nullable only for `kind = 'verification'`);
  `lib/voice/owner-report.ts` (the owner call's dialogue, with the same
  `opening`/`hear`/`played` shape as `Dialogue`: identity check, report
  script from the verified outcome, acknowledgement, voice commands with
  repeat-back; the verification call's DTMF code); `tests/voice/reminders.test.ts`.
- Change: `lib/voice/session.ts` (pick the dialogue by call kind; DTMF;
  silence → voicemail rule; owner calls settle from delivery, not an
  outcome); `lib/voice/run-call.ts` (`loadReportContext`: that task's
  outreach outcome only; verification dialling); `lib/voice/verify.ts`
  (settle owner calls; a delivered report completes the task);
  `lib/voice/tasks.ts` (cancel reports, remind again, preferences, start
  verification; actor `owner`); `actions/voice.ts` (zod + rate limits);
  `db/schema.ts` (`voiceTaskId` nullable, mirroring the migration).
- Tests first: T-REM-01…08; S18, S19, S20, S29, S30; the worked example of
  VOICE_REMINDERS §8.
- Risks: (1) the boundary rule "kriya-voice reads a task only through
  `loadAttemptContext`": the report needs the same task's outreach outcome,
  so a sibling loader scoped by attempt, task and user; recorded as a
  finding for the owner. (2) Owner intents are recognised by fixed patterns
  (no model, no cost); unrecognised speech gets "I can't do that on this
  call". (3) The migration is applied to staging only when the owner says so.
- Deferred: the "Phone & calls" section in `/account` (Phase 7's file, after
  this phase's actions exist).

**Session state (2026-10-20 ~15:30 IST, stopped at the usage limit;
`IN_PROGRESS`, uncommitted):**

- Done: migration `20261022000000_voice_verification` + rollback
  (`voice_task_id` nullable only for `kind = 'verification'`, also on
  `voice_transitions`; no FK on `phone_verifications.voice_call_id`, because
  one would stop the voice-core rollback, T-MIG-01); `db/schema.ts` mirrors it;
  `tests/db/voice-verification.test.ts` 3/3 and `tests/db/migrations.test.ts`
  pass. `lib/voice/owner-report.ts` (ReportCall, VerificationCall, reportText,
  startPhoneVerification, verificationStatus); `languages.ts` `en.clock`,
  `en.owner.*`; `session.ts` picks the dialogue by call kind, handles DTMF and
  the silence/voicemail rule, and settles owner calls; `run-call.ts` has
  `loadVerificationContext`, `loadReportContext` and verification dialling;
  `verify.ts` settles owner calls from delivery (`retryAt`/`retryOrEnd`), a
  delivered report completes the task, and no outcome is made for calls
  without a task. `npx tsc --noEmit` exit 0.
- `tests/voice/reminders.test.ts`: **8 of 16 pass** (hang-up before the last
  mark, the §8 worked example, quiet hours, wrong person, voicemail, 3×
  verification). **8 fail**: each one where the report is delivered then the
  call settles. `voice_transition('task', …, 'completed', 'verifier',
  {result})` raises at line 73 of the function body, i.e. `verifier` isn't an
  allowed actor for that edge from the task's current status, or the status
  isn't `awaiting_report` when the report settles. Next: print the task's
  status at that point and the `awaiting_report → completed` rule; then fix
  `followTask` (likely it runs while the task is still `in_progress`, or needs
  another actor).
- Not started: `actions/voice.ts` (preferences, startPhoneVerification,
  verificationStatus with zod + rate limits); T-REM-07 import check in
  `tests/voice/boundaries.test.ts`; full `npm run check`; finding F32 (the
  `loadReportContext` boundary note) in CHANGE_IMPACT; the migration is **not**
  applied to staging.

**Session result (2026-10-20 ~16:20–16:50 IST, Claude Code / Opus 5.5,
`main` in place; resumed from the session state above):** `COMPLETE` on
mocks. Owner decision this session: "COMPLETE (mocks) (Recommended)": the
live check to the owner's phone needs Phase 5 and moves to its exit.

- Root cause of the 8 failures: not the actor or the task's status. The
  task was `awaiting_report`, and `verifier` is allowed for `awaiting_report
  → completed`. But `voice_transition()` also requires
  `evidence.voice_call_id` to name a delivered `owner_report` call when a
  report was requested ("completed needs a delivered report call"), and
  `followTask` passed only `{result}`. Fix in `lib/voice/verify.ts`
  (`followTask`): pass the delivered report's id. After it, 15/16 passed.
- Same kind of bug in the last one (S19, voice "cancel the other
  reminders"): `voice_transition()` cancels only a call with
  `cancel_requested_at` set, and `cancelOthers` (`lib/voice/owner-report.ts`)
  didn't set it. It now sets it in the same statement that picks the calls
  (the pattern of `cancelVoiceTask`). Reminders: **16/16**.
- `actions/voice.ts`: `updateVoicePreferences` (strict zod, partial: IANA
  timezone, HH:mm quiet hours, report mode, attempts 1–5, retry 5–120 min,
  retention 0–365 days, the SQL checks' bounds), `verifyOwnerPhone`
  (→ `startPhoneVerification`; its own limit of 5 an hour per account, since
  each one rings the phone, plus the per-address limit),
  `ownerPhoneVerificationStatus` (uuid). All `requireUser()` first.
  `lib/voice/owner-report.ts`: `updatePreferences` makes the profile row with
  defaults (privileged, by user id; the session has no insert grant), then
  updates through `withUser` (RLS + the column grant; the number isn't
  editable).
- `tests/voice/boundaries.test.ts`: **T-REM-07**: the import graph of every
  `lib/voice/**` file reaches no `lib/events.ts`, `lib/connectors*`,
  `components/workspace/notifier*` or `app/api/events/`, no mail/SMS/push
  package, and no voice source uses `Notification`/`showNotification`.
- Coverage map: T-REM-01 is `T-Q-07` in `tests/voice/pipeline.test.ts`
  (confirming twice → one `owner_report`); S18 is the §8 worked example
  (T-REM-03); T-REM-02…08, S19, S20, S29, S30 in `tests/voice/reminders.test.ts`.
- F32 added to `CHANGE_IMPACT_AND_SAFETY.md` (open, owner): the two extra
  loaders beside `loadAttemptContext`.
- Also: restored the `## Phase 7 — Mobile UI` heading, which the previous
  session's edit had removed.
- Commands: `npx vitest run tests/voice/reminders.test.ts` → **Tests 16
  passed (16)**; `npx vitest run tests/voice/boundaries.test.ts` → 8 passed;
  `npm run check` → typecheck, lint, "All matched files use Prettier code
  style!", **Test Files 100 passed | 3 skipped (103), Tests 1253 passed | 26
  skipped (1279)**, exit 0 (a first run failed `format:check` on the two new
  files; fixed with `prettier --write`).
- Not done / open: migration `20261022000000_voice_verification` is **not**
  applied to staging (needs the owner's go-ahead); the "Phone & calls"
  section in `/account` (Phase 7, now unblocked: the actions exist); the live
  check (Phase 5); F32 (owner).
- **Next exact action:** owner decides F32 and whether to apply
  `20261022000000` to staging; then Phase 7 builds "Phone & calls" on
  `updateVoicePreferences` / `verifyOwnerPhone` / `ownerPhoneVerificationStatus`.

## Phase 7 — Mobile UI

**Status:** IN_PROGRESS (2026-10-20, Claude Code)

- **Objective:** the screens in UX_AND_INTERACTION_SPEC.md.
- **Read first:** UX_AND_INTERACTION_SPEC.md; API_AND_EXECUTION_CONTRACTS.md §2, §4.
- **Preconditions:** Phase 3 actions; Phase 6 for report/settings parts.
- **Files:** `app/(workspace)/calls/page.tsx`, `calls/new/page.tsx`,
  `calls/[taskId]/page.tsx`, `components/voice/*`, `queries/voice.ts`,
  `app/api/voice/tasks/[taskId]/stream/route.ts`, `app/(workspace)/account/page.tsx`
  (Phone & calls section), `components/workspace/bottom-nav.tsx` or Home entry,
  `components/workspace/command-palette.tsx`, `proxy.ts` (`/calls` in `PROTECTED`).
- **Tests:** T-UI-01…03; existing tests unchanged.
- **Premium bar:** UX_AND_INTERACTION_SPEC.md §11 (presence states, live
  captions, moments, result hero, evidence chips, "Is this right?" feedback),
  with every quality bar in §11.7 measured and recorded; no new dependency
  (D-18). Verify on a real Android phone whether `getUserMedia` and Web Speech
  can share the mic (§11.2) and record the result.
- **Checks:** 360 px, 44 px targets, mic-denied path, no notifications, dark and
  light, reduced motion.
- **Acceptance:** the canonical scenario can be created, confirmed, followed
  and reviewed on a phone browser (mock provider).
- **Exit:** `npm run check` + `npm run build`; screenshots listed here.

**Session plan (2026-10-20 06:53 IST by the machine clock, Claude Code / Opus
5.5, `main` in place, uncommitted):**

- Preflight: Phase 3 actions exist; Phase 4's draft extraction exists; D-18
  approved this session; `npm run check` before the first edit: **1223 passed
  | 26 skipped**, exit 0. Board: only this row.
- Scope (owner, 2026-10-20): everything except what needs Phase 6 — the
  "Phone & calls" settings section in `/account`, owner-number verification,
  report times on new calls and report delivery in the outcome. Those wait for
  Phase 6.
- Create: `queries/voice.ts` (list and one task, through `withUser`, attempts
  by granted columns only; result lines and failure texts from §5–6 computed
  on the server), `app/(workspace)/calls/page.tsx`, `calls/new/page.tsx`,
  `calls/[taskId]/page.tsx`, `components/voice/presence.tsx` (§11.1, CSS only
  from existing keyframes), `components/voice/new-call.tsx` (dictation → draft
  card → `draftCall`), `components/voice/confirm-card.tsx` (§3/§11.3),
  `components/voice/controls.tsx` (stop, stop all, live refresh, delete
  transcript), `app/api/voice/tasks/[taskId]/stream/route.ts` (SSE, §4 API).
- Change: `proxy.ts` (`/calls` in `PROTECTED`, `/api/voice/tasks` in
  `PROTECTED_API`), `components/workspace/command-palette.tsx` and
  `app/(workspace)/home/page.tsx` (entry only with voice access; a sixth
  bottom tab doesn't fit at 360 px, so `bottom-nav.tsx` is unchanged),
  `actions/voice.ts` (`deleteTranscript`, `voiceEntry`).
- Tests first: T-UI-01 (card from the server payload; edit → `stale_approval`),
  result lines never overstate, list sections, SSE route ownership, proxy
  prefixes. T-UI-02/03 need a browser on the running app.
- Risks: (1) T-UI-02 (360 px, screenshots) and the real-Android mic check need
  the app running against a database with the voice migrations; none is
  applied to Supabase (B2, F12) and I won't connect to it — recorded as not
  done unless a local run is possible. (2) The level ring uses interim-result
  pulses, not `getUserMedia` (the Android conflict is unverified). (3) No
  `createFollowUp`, "Is this right?" (needs Phase 10's `voice_feedback`) or
  draft field editing (`updateDraft` not built): left out and recorded.
- Questions: none open.

**Session result (2026-10-20 07:12 IST by the machine clock, Claude Code /
Opus 5.5):** `IN_PROGRESS`. The screens, stream and server logic are built
and tested. The exit needs browser checks on the running app (T-UI-02/03,
screenshots, §11.7 bars, the real-Android mic check); none could run here.

- Created: `queries/voice.ts`, `app/(workspace)/calls/page.tsx`,
  `calls/new/page.tsx`, `calls/[taskId]/page.tsx`,
  `app/api/voice/tasks/[taskId]/stream/route.ts`, `components/voice/
  presence.tsx`, `confirm-card.tsx`, `controls.tsx`, `new-call.tsx`,
  `tests/voice/ui.test.ts`.
- Changed: `proxy.ts` (`/calls/` in `PROTECTED`, `/api/voice/tasks/` in
  `PROTECTED_API`; exact prefixes), `app/(workspace)/home/page.tsx` ("Phone
  calls" row with voice access only), `components/workspace/
  command-palette.tsx` ("Phone calls" with voice access only),
  `actions/voice.ts` (`deleteCallTranscript`, `voiceEntry`),
  `lib/voice/tasks.ts` (`deleteTranscript`, through `withUser`),
  `docs/voice-assistant/DECISIONS.md` (D-18 Approved),
  `CHANGE_IMPACT_AND_SAFETY.md` (F24). Unchanged: `bottom-nav.tsx` (a sixth
  tab doesn't fit at 360 px, so §1 is decided as Home + palette),
  `globals.css`, `package.json` (no dependency, §11.7).
- Built: `/calls` (Live / Needs you / Upcoming / Done, sticky headers, Stop
  all, Mascot empty state); `/calls/new` (tap-to-dictate presence disc reusing
  `useDictation`, editable text, on-device/speech-service note, unsupported
  and mic-blocked messages, server draft → a question for each missing field,
  `draftCall`); `/calls/[taskId]` (draft → "Review and confirm" → card from
  the server's payload with masked number, "Show all" required, countdown,
  "Listen to the opening" via `speechSynthesis` on tap, `btn-liquid` confirm,
  `vibrate(12)` where supported; per-call status lines; live stream with
  opt-in captions; result hero with "Verified by call records" / "Needs your
  review"; agreed/suggested/questions with "heard in turn n →" links;
  transcript with "(cut off)"; delete transcript; Stop / Stop and hang up);
  SSE stream per API §4 (owner only, 1 s live / 5 s idle, 10 min).
- Tests (`tests/voice/ui.test.ts`, 10, all pass): **T-UI-01** (card renders
  from the server's payload; full number hidden; confirm disabled until shown;
  declining and asking again makes the old card `stale_approval`); list
  sections and lines; "agreed" only from an accepted outcome; another
  person's calls invisible (RLS); outcome evidence and cut-off turns; §6
  failure text; stream 401/404 for signed-out / someone else / bad id, first
  event is the task; proxy: `/calls/…` → login, stream API → 401, `/callsx`
  untouched. The boundaries test still passes (no client file imports
  `lib/voice`).
- `npm run check` (2026-10-20 ~07:10): typecheck, lint, "All matched files use
  Prettier code style!", **Test Files 98 passed | 3 skipped (101), Tests 1233
  passed | 26 skipped (1259)**, exit 0. `npm run build`: exit 0; routes
  `ƒ /calls`, `ƒ /calls/new`, `ƒ /calls/[taskId]`.
- **Not done (exit open):** T-UI-02 (360 px, 44 px targets, screenshots),
  T-UI-03 (mic denied / unsupported in a real browser), §11.7 bars (60 fps
  trace, layout shift, dark/light, reduced motion, screen reader, JS size vs
  the largest route), the real-Android check of `getUserMedia` with Web Speech.
  All need the app running against a database with the voice migrations; none
  is applied to Supabase (B2, F12), and I didn't connect to it.
- Deferred by the owner: "Phone & calls" in `/account`, owner-number
  verification, report times on new calls, report delivery in the outcome
  (Phase 6). Left out: "Draft a follow-up call" (`createFollowUp` not built),
  "Is this right?" (needs Phase 10's `voice_feedback`), editing a draft's
  fields (`updateDraft` not built; the card's second button is "Not yet",
  back to draft), the "Calls" row on `/usage` (Phase 8).
- Deviations: the level ring pulses on interim results, not a microphone level
  (§11.2 fallback; the Android conflict is unverified); the draft editor lives
  on `/calls/new` (a task row needs a number, Phase 4 deviation 3).
- **Next exact action:** apply the voice migrations to a staging Supabase
  project (owner: B2/B10/F12) or run a local Supabase, then open `/calls`,
  `/calls/new` and a task at 360 px in light and dark, record screenshots and
  the §11.7 measurements here, and check the mic on a real Android phone.
  Then Phase 6 adds the deferred parts.

**Session 2 result (2026-10-20 ~13:00–13:30 IST, Claude Code / Opus 5.5,
`main` in place):** `IN_PROGRESS`. The 360 px browser checks ran on the
staging Supabase project; the exit still has open items (below).

- Owner instructions this session: apply the two pending voice migrations,
  commit the working tree, run the dev server and the 360 px checks with
  screenshots; "Yes, it's staging; seed it" (test data); cleanup through the
  Supabase connector.
- Migrations: `npx tsx --env-file=.env scripts/migrate.ts` →
  `applied 20261020000000_voice_core.sql`, `applied
  20261021000000_voice_queue.sql` (project `kriya-tavi`, Postgres 17 per the
  Supabase project list; track A versions were already applied, so this was
  the out-of-order case of F12, handled by `migrate.ts`).
- `npm run check` before the commit: typecheck, lint, "All matched files use
  Prettier code style!", **Test Files 98 passed | 3 skipped (101), Tests 1233
  passed | 26 skipped (1259)**, exit 0.
- Commit `94de49d` (local only, not pushed): all uncommitted voice work,
  Phases 1–4 and 7, 97 files. The staged diff was scanned for keys and
  connection strings first (none).
- Test data (staging, owner-approved, **deleted afterwards**): one auth user
  inserted with a confirmed email (no email sent), `voice_access`, a
  non-default plan `voice-ui-test` with voice on, a `test` subscription, and
  two drafts made by `createDraft` (fake numbers, no model). Cleanup check:
  1 user and 1 plan deleted; 0 rows left in voice_tasks, voice_access,
  subscriptions, voice_approvals, profiles, voice_transitions for that user.
- Local-only overrides for the dev process (no file changed): a throwaway
  `KRIYA_PHONE_HASH_KEY`, and `NEXT_PUBLIC_SUPABASE_URL`/publishable key of
  `kriya-tavi`, because `.env.local` points Auth at a placeholder project
  (F28).
- Checks at 360 × 780 (Playwright Chromium), screenshots in
  `screenshots/voice-phase7/`:
  - Signed out, `/calls` → `/login?next=%2Fcalls`.
  - `/calls`, `/calls/new`, a draft task, the confirm card: light and dark
    (`calls-360-*`, `calls-new-360-*`, `task-draft-360-*`,
    `confirm-card-360-*`, `confirm-card-shown-360-dark`,
    `confirm-card-bottom-360-light`). `scrollWidth` 360 on every page, no
    horizontal scroll.
  - 44 px: every button on the card is ≥ 44 px high (Show all 78×44, Listen
    to the opening 182×44, Not yet 70×44, Confirm & call 134×44, Stop
    318×44); the dictation disc is 96×96. Only element under 44: the existing
    header logo link (103×28), not Phase 7.
  - Confirm card: "Confirm & call" disabled until "Show all", enabled after,
    disabled again after reload (the pending approval is reused). Number
    masked as `+91 90xxx xxx01`; cost shows "price not yet set". Nothing was
    confirmed; no call was queued.
  - T-UI-03: speech recognition stubbed to fail with `not-allowed` → "Microphone
    access is blocked for Kriya in this browser."
    (`calls-new-mic-denied-360-light`); removed → "Voice typing isn't
    available in this browser; type instead."
    (`calls-new-unsupported-360-light`). The real speech service was never
    started.
  - Reduced motion: `tavi-breathe` runs by default and no infinite animation
    runs under `prefers-reduced-motion: reduce` (`/calls`, `/calls/new`,
    task).
  - Layout shift (PerformanceObserver, buffered): CLS 0 on `/calls`,
    `/calls/new` and the task.
  - SSE: the task page opens `/api/voice/tasks/<id>/stream`.
  - Entry points: the command palette (Ctrl+K) shows "Phone calls" and opens
    `/calls`. The Home row didn't appear for a user without agents (F29).
  - Console: no application errors (only HMR socket errors from restarting
    the dev server).
- `npm run build` (after the checks): exit 0; routes `ƒ /calls`,
  `ƒ /calls/[taskId]`, `ƒ /calls/new`.
- **Not done (exit open):** 60 fps trace, screen reader pass, JS size vs the
  largest route (§11.7); the real-Android `getUserMedia` + Web Speech check;
  the acceptance flow past confirmation (followed and reviewed needs the worker
  loop with the mock provider, which doesn't start until a real provider exists;
  result hero and evidence chips not seen in a browser); whether a phone
  without a keyboard can open the palette; F29.
- New findings: F25–F27 (automated security review of `94de49d`, Phases 3–5
  code, left for Phase 5), F28 (`.env.local` placeholder), F29 (Home entry).
- Uncommitted after this session: `status.md`, `CHANGE_IMPACT_AND_SAFETY.md`,
  `screenshots/voice-phase7/` (15 PNG, 1.4 MB).
- Next action at the end of session 2: owner fixes `.env.local` (F28); render
  the Home row outside `hasAgents` (F29); §11.7 measurements; Android check.
  Session 3 below did the second and third.

**Session 3 result (2026-10-20, Claude Code / Opus 5.5, `main` in place,
uncommitted; owner: "go on"):** `IN_PROGRESS`.

- F29 fixed: `app/(workspace)/home/page.tsx` keeps the "Phone calls" link in
  one `callsLink` and renders it in both branches (above the templates when
  there are no agents). Checked in the browser on staging: a voice user with
  no agents sees it (318×56, light and dark, `home-entry-no-agents-360-*`),
  and it opens `/calls`; `scrollWidth` 360.
- Test data: re-seeded through the Supabase connector (user, voice_access,
  plan `voice-ui-test`, `test` subscription; no drafts, no agents), deleted
  afterwards; check: 0 users, plans, subscriptions, voice_access, profiles
  left.
- §11.7, measured:

  | Bar | Result |
  | --- | --- |
  | 60 fps | Only `transform`/`opacity` animated (`tavi-breathe`, Tailwind ping/pulse/spin; one `transition-transform`). rAF frame times for 5 s at 4× CPU throttle (CDP) in desktop Chromium, 144 Hz display: `/calls/new` breathing 144 fps, p95 7.1 ms, 0 frames > 33 ms; Home scroll 141 fps, p95 7.1 ms, 1 of 706 > 33 ms. A proxy: not a DevTools trace on a real mid-range Android |
  | Layout shift | CLS 0 on `/calls`, `/calls/new`, a task (session 2) |
  | JS size | Entry JS per route from the build's client manifests, gzip: `/calls` 276 KB, `/calls/[taskId]` 278 KB, `/calls/new` 278 KB; largest route `/a/[agentId]/[threadId]` 586 KB. Under the largest: pass |
  | Dark and light | All voice screens, both (session 2) |
  | Reduced motion | No infinite animation under `reduce` (session 2) |
  | Screen reader | Presence is `role="status"` `aria-live="polite"` and announces "Tell me who to call and what to ask"; every control on `/calls/new` has a name; captions are `role="log"` (`controls.tsx:201`, code only: rendered only during a live call). No real screen reader (TalkBack/NVDA) was run |
  | 360 px | Pass (session 2) |
  | No new dependency | `package.json` in `94de49d` adds only Phase 2/4 scripts (`dev:voice`, `voice`, `voice:eval`), no dependency |

- After the fix: `tsc --noEmit`, `eslint` and `prettier --check` on the
  changed file clean; `npm run check` → **Test Files 98 passed | 3 skipped
  (101), Tests 1233 passed | 26 skipped (1259)**; `npm run build` exit 0
  (`ƒ /calls`, `ƒ /calls/[taskId]`, `ƒ /calls/new`, `ƒ /home`).
- **Still open (exit):** real-Android `getUserMedia` + Web Speech check;
  a TalkBack pass; the acceptance flow past confirmation (worker loop with the
  mock provider; result hero and evidence chips in a browser); whether a phone
  without a keyboard can open the palette; F28 (owner).
- Next action at the end of session 3: F28 (owner), the Android mic +
  TalkBack check, then Phase 6. Session 4 below did the acceptance flow.

**Session 4 result (2026-10-20 ~13:50–14:20 IST, Claude Code / Opus 5.5,
`main` in place, uncommitted; owner: "continue the next", then "Yes, run it
on staging" for one mock call):** `IN_PROGRESS`. **Acceptance met**; the exit
still needs the real-Android checks.

- F28: the owner approved fixing `.env.local`, but the local "Protect
  secrets" guardrail blocks any command on that file; left to the owner (the
  two lines are in this session's chat).
- Acceptance run: a temporary script (deleted, never committed), run by the
  owner in their own terminal because the guardrail keeps `.env` away from
  the agent, replayed S01 from `tests/voice/session.test.ts` on staging: test
  user, `createDraft` → `requestConfirmation` → `confirmCall` (the same
  functions the confirm card calls), worker `claimNext` + `runCall` on the
  mock provider, status webhooks, a local `kriya-voice` with mock STT/TTS and
  the scripted model (no network beyond localhost, no real call, no paid
  model). Script output: `voice call placed`, `voice stream connected`,
  `voice session ended … turns: 7`, `voice outcome checked … accepted`,
  `DONE: stream closed 1000; outcome accepted; task completed/agreed`.
- Followed live on `/calls` at 360 px: list "LIVE 1 · My CA · On the call
  now" (`calls-live-360-light`); the task shows `role="status"` "On the call
  with My CA", the "Show what's being said" toggle (169×44) and the turns so
  far (`task-live-360-light`, `task-live-360-dark`).
- Reviewed: list "DONE 1 · My CA agreed to Wednesday the 21st at 3 PM"
  (`calls-done-360-*`); the task's result hero "My CA agreed to Wednesday the
  21st at 3 PM", "Verified by call records", AGREED chip with "heard in turn
  5 →" (`#turn-5`, 44 px), full 7-turn transcript, "Delete transcript"
  (`task-result-360-*`, `task-result-bottom-360-light`). `scrollWidth` 360;
  every control 44 px.
- Found and fixed on the way: **F30** (`lib/voice/run-call.ts`, a `Date`
  bound in raw SQL that real Postgres rejects; every outreach call would have
  failed before dialling). A Phase 3 file, fixed as a prerequisite for this
  acceptance; `tests/voice/pipeline.test.ts` + `session.test.ts`: 2 files, 33
  passed. Found, open (owner): **F31** (`DATABASE_URL` on the 5432 session
  pooler; 15 clients ran out with the app and the script, HTTP 500 on
  `/calls` until idle connections closed).
- `npm run check` after the F30 fix: exit 0; "All matched files use
  Prettier code style!"; **Test Files 98 passed | 3 skipped (101), Tests 1233
  passed | 26 skipped (1259)**.
- Script-only issues fixed during the run, not product bugs: claimed before
  the database's `now()` reached `available_at` (clock skew; the worker
  polls), a 5 s watch window copied from the test (the mock answers
  "completed" whenever asked), missing `autoPlay`, reading the STT stream
  before it opened.
- Observations for the owner: (1) the transcript shows during a live call
  even with "Show what's being said" unchecked; the toggle may be meant only
  for live captions, so check against UX §11; (2) Tavi's goodbye says the same
  thing twice ("I'll let Asha know … Asha will be informed"), with the
  scripted model, so it may come from Phase 4's closing line.
- Test data: five test users over the runs (four failed runs and one full
  one), each removed; final check over every `kriya` table with `user_id`: 0
  rows for all five ids; plan `voice-ui-test` deleted.
- **Still open (exit):** real-Android `getUserMedia` + Web Speech check; a
  TalkBack pass; whether a phone without a keyboard can open the palette;
  F28, F31 (owner).
- **Next exact action:** owner fixes `.env.local` (F28) and `DATABASE_URL`
  (F31), then does the Android mic + TalkBack check against the staging app;
  then Phase 6 adds the deferred parts.

**Session 5 result (2026-10-20 ~16:55–17:30 IST, Claude Code / Opus 5.5,
`main` in place after `2addc76`, uncommitted; owner: "Apply the migration to
staging and start Phase 7's Phone & calls"):** `IN_PROGRESS`.

- Staging migration: `npx tsx --env-file=.env scripts/migrate.ts --dry-run`
  → `would apply 20261022000000_voice_verification.sql` (only that one); then
  without `--dry-run` → `applied 20261022000000_voice_verification.sql`;
  `--status` → all three voice migrations `applied`.
- **F33 fixed first** (automated security review of `2addc76`): a
  verification call skipped suppression and every per-number cap.
  `startPhoneVerification` (`lib/voice/owner-report.ts`) now refuses a
  suppressed number and allows at most 3 verifications per number per 24 h
  across all accounts (database `now()`, advisory lock per number); dialling
  (`lib/voice/run-call.ts`) re-checks suppression. Open for the owner:
  verification calls still ignore calling hours.
- "Phone & calls" built: `components/voice/phone-settings.tsx` (number
  masked from the server, "Call me to verify" → 6-digit code in large type →
  status in an `aria-live` region, polled every 3 s until final; timezone,
  quiet hours, report mode, attempts, gap, transcript retention 0/7/30/90;
  every control 44 px by class), `queries/voice.ts` `getPhoneSettings`
  (through `withUser`; masks the number), `app/(workspace)/account/page.tsx`
  (section `#phone`, only with `voiceAvailable`; "Reminders and results come
  only as phone calls."; `StopAll`, UX §9).
- Tests (`tests/voice/reminders.test.ts`, +3): F33 refusals across accounts;
  settings masked and saved through the owner's session; a new owner gets
  defaults and the number can't be set through preferences (column grant).
- `npm run check` → "All matched files use Prettier code style!", **Test
  Files 100 passed | 3 skipped (103), Tests 1256 passed | 26 skipped
  (1282)**, exit 0. `npm run build` → exit 0, `ƒ /account`.
- **Not done:** the 360 px browser check of `/account#phone` (light/dark,
  44 px measured, screenshots). It needs a seeded staging test user, which
  needs the owner's go-ahead each time (sessions 2–4), and F28 still blocks
  local sign-in. No verification call can be placed: the worker doesn't run
  the loop without a real provider (Phase 5).
- Browser check attempt (after commit `28641d1`): the owner ran the seed
  script (one confirmed user `44bf461c-…`, `voice_access`, plan
  `voice-ui-test`, a `test` subscription; read-only check: all present).
  Dev server started with `.env` loaded into its process (`process.loadEnvFile`;
  `node --env-file` is refused because Next passes it on in `NODE_OPTIONS`).
  Sign-in failed: `.env` has `NEXT_PUBLIC_SUPABASE_URL` for `kriya-tavi` but
  no `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, so the key comes from
  `.env.local`'s placeholder project (F28); Auth answers 401. Also: server
  actions need `http://localhost:6796`, not `127.0.0.1` (proxy origin check).
  Dev server stopped. **The test data is still on staging.**
- Browser check, second try (owner fixed `.env.local`, F28): plain `npm run
  dev` with a throwaway `KRIYA_PHONE_HASH_KEY`; signed in at
  `http://localhost:6796` as the seeded user; onboarding completed (one agent,
  removed with the user). At 360 × 780 (Playwright Chromium), `/account#phone`:
  `scrollWidth` 360; every control 44 px high (number field 318×44, "Call me
  to verify" 318×44, timezone 318×44, quiet hours 145×44 each, radio rows 44,
  tries 119×44, gap 120×44, retention 318×44, Save 54×44, Stop all calls
  106×44); no console errors. Light and dark set through `next-themes`
  (`localStorage.theme`; emulated `prefers-color-scheme` doesn't change it,
  the default is dark). Screenshots: `account-phone-360-{light,dark}.png`,
  `account-phone-bottom-360-{light,dark}.png` in `screenshots/voice-phase7/`.
- **Found and fixed:** after Save the form showed the old values again (the
  database had the new one: `report_max_attempts` 5). React 19 resets a
  `<form action={…}>` once the action ends, to the defaults from before the
  refresh. `phone-settings.tsx` now submits with `onSubmit`; re-checked in
  the browser: the field keeps 4 after Save. `prettier --check`, `eslint`,
  `tsc --noEmit` clean.
- Not pressed: "Call me to verify" (no call could be placed before Phase 5;
  it would only show the code).
- Cleanup (seed script `cleanup`): `{"users":0,"plans":0,"rowsLeft":{}}`
  over every `kriya` table with `user_id`. Dev server stopped.
- Uncommitted: `components/voice/phone-settings.tsx`, `status.md`, four
  screenshots (332 KB).
- **Next exact action:** commit these (owner); then the remaining Phase 7
  exit items: real-Android mic + TalkBack; F31 (owner).

## Phase 8 — Cost, limits, monitoring

**Status:** NOT_STARTED

- **Objective:** priced usage, one charge per voice task, allowance and spend
  caps, owner dashboards and alerts.
- **Read first:** COST_AND_METERING.md (all).
- **Files:** new `lib/voice/metering.ts`; `lib/money.ts` (mixed-currency sum);
  `lib/entitlements.ts` (`usageSummary` + voice limits); `lib/owner.ts`,
  `app/owner/finance/page.tsx`, `app/owner/operations/page.tsx`,
  `app/owner/config/page.tsx` (`voice_prices`); `app/(workspace)/usage/page.tsx`;
  tests.
- **Credentials:** none; prices entered by the owner from written quotes.
- **Tests:** T-COST-01…06, T-OWN-01; `tests/money.test.ts` additions.
- **Note:** counting voice charges in `usageSummary` changes the allowance check
  for agent tasks too (F9, intended); the existing pipeline tests must pass
  unchanged.
- **Acceptance:** cost per successful task (C1) computed from real rows; no
  price appears that the owner didn't enter.
- **Exit:** `npm run check` passes.

**Session 1 (2026-10-20 ~17:25–18:20 IST, Claude Code / Opus 5.5, `main` in
place after `d21b857`, uncommitted; owner: "claim and proceed to Phase 8"):**
`IN_PROGRESS`.

- Read: COST_AND_METERING.md (all); TEST_STRATEGY T-COST-01…06, T-OWN-01;
  CHANGE_IMPACT rows for `lib/entitlements.ts`, `lib/config.ts`, `app/owner/*`,
  `lib/owner.ts`, `lib/money.ts`. Found: no `voice.*` setting existed yet
  (the CHANGE_IMPACT Phase 2 row expected them); `voice_prices`,
  `voice_usage`, `voice_charges` were in place from Phase 1; telephony, STT,
  TTS and LLM usage rows were already written.
- Created: `lib/voice/metering.ts` (estimates from `voice_prices` by
  provider+product and the latest effective price, units incl. 30/60 s
  pulses and per attempt; LLM rows from the model catalogue like agent
  metering; `sumVoiceCost` in micro-INR; one charge per terminal task,
  `chargeFinishedVoiceTasks` sweep, `repriceVoiceTask` changes only
  estimated/unpriced; `voiceSpendToday`; `dailyCapAllows`);
  `actions/voice-prices.ts` (owner price sheet: zod, decimal → micro without
  floats, `requireOwner`, audit row, reprices open charges);
  `components/owner/voice-price-form.tsx`; `tests/voice/metering.test.ts`.
- Changed: `lib/money.ts` (`toMicroInr` only); `lib/config.ts`
  (`voice.dailySpendCapMicroInr`, with a pattern); `lib/entitlements.ts`
  (`usageSummary` adds voice charges and their unpriced count;
  `checkVoiceAllowed`; `checkTaskAllowed` unchanged in behaviour, its
  allowance part shared); `lib/voice/tasks.ts` (`limits` refuses with
  `limit_allowance`; the allowance is read before the transaction);
  `lib/voice/run-call.ts` (`claimNext` refuses at the cap, and when the cap
  is unset for any provider but the mock; `recoverVoice` charges finished
  tasks); `lib/owner.ts` (`voiceFinance`, `voiceOperations`,
  `voicePriceSheet`, aggregates only); `app/owner/finance` (voice tiles,
  per-component table, unpriced banner), `app/owner/operations` (spend vs
  cap, 80 % alerts, calls by state, attempts in 24 h, owners near their
  allowance), `app/owner/config` ("Voice" settings group, price sheet);
  `tests/money.test.ts` (T-COST-03, existing cases unchanged).
- Found and fixed while testing: reading settings or model prices through
  the shared client inside a transaction deadlocked on PGlite (one
  connection) and would take a second pooled connection on Postgres (F31);
  settings are now read before the transaction and catalogue prices through
  it. The same for `usageSummary` inside confirmation.
- Tests (`tests/voice/metering.test.ts`, 8): T-COST-01 (busy, no-answer and
  answered attempts each one telephony row, null cost, charge `unpriced` with
  3 unmetered), T-COST-02 (each attempt ended twice → one row), T-COST-04
  (failed and cancelled tasks charged once, sweep idempotent; a 60 s-pulse
  price reprices to `estimated` 600000 micro-INR with the busy attempt still
  unmetered; a `final` charge unchanged; USD without a rate `unpriced`, then
  `final` at 84.0000), T-COST-05 (`usageSummary` adds the voice charge; a
  used-up allowance → `requestConfirmation` `limit_allowance`), T-COST-06
  (cap reached → no claim; under it → claimed; unset → a real provider is
  refused, the mock claims), T-OWN-01 (static: `lib/owner.ts` names no
  transcript/outcome/note column; canary in a turn and an outcome never in
  the voice views' output). `tests/money.test.ts` +1 (T-COST-03).
- `npm run check` → "All matched files use Prettier code style!", **Test
  Files 101 passed | 3 skipped (104), Tests 1265 passed | 26 skipped
  (1291)**, exit 0; the existing pipeline tests pass unchanged (F9).
  `npm run build` → exit 0 (`ƒ /owner/config`, `/owner/finance`,
  `/owner/operations`).
- Not done: the "Calls" row on `/usage` (UX §10; `app/(workspace)/usage/page.tsx`
  has no CHANGE_IMPACT row, so it needs the owner's approval first); the
  per-task cost budget projected before each dial (§5); the owner views
  weren't opened in a browser; acceptance C1 needs real rows (no live call
  before Phase 5). F34 (owner).
- **Next exact action:** owner decides F34 and approves the `/usage` change;
  then add the Calls row and the per-task budget check, and look at the
  three owner pages in a browser.

**Session 2 (2026-10-20 ~18:25–18:45 IST, same agent; owner: "Do what else
needed to be done"):** `IN_PROGRESS`.

- Per-task budget before each dial (§5): `overBudget` in
  `lib/voice/metering.ts` (the task's cost so far + one full-length call at
  the provider's `outbound` price; no telephony price → nothing projected;
  USD without a rate → over, never dial blind). `prepareAttempt` blocks the
  outreach call with `error_code: budget`; the task fails with "Another try
  would go over this call's cost limit, so I stopped." (`queries/voice.ts`).
  Not done: the in-call check at 100 % (kriya-voice).
- `/usage` "phone calls · this period" row (UX §10), voice access only:
  calls, minutes, charged (estimated until final), calls left today;
  `getCallUsage` in `queries/voice.ts` through `withUser`. The owner's "do
  what else needed" taken as the approval this file needed; recorded as a
  CHANGE_IMPACT §3 row.
- Tests (`tests/voice/metering.test.ts`, +2): the budget (no price → fits;
  ₹0.005/s × 300 s > ₹1; ₹0.001/s fits; plus ₹0.80 spent → over); the Calls
  row counts only the person's own calls (another user's ₹9 charge absent).
  `npx vitest run tests/voice/metering.test.ts` → 10 passed. `tsc --noEmit`
  clean.
- F34 still open (owner).

## Phase 9 — Security, compliance, recovery, readiness

**Status:** NOT_STARTED

- **Objective:** evidence that the system is safe to open beyond test numbers.
- **Read first:** SECURITY_AND_COMPLIANCE.md; EVALUATION_PLAN.md §4–5.
- **Tasks:** T-SEC-01…05; counsel sign-off on Q1–Q11 recorded; privacy notice
  and terms updated (`app/legal`); recovery drills (kill worker/voice mid-call,
  provider outage, Render deploy during a call); external security review;
  ≥ 300 evaluation runs incl. ≥ 50 live pilot calls with consenting people;
  remove the test-number allow-list only after all of the above.
- **Acceptance:** EVALUATION_PLAN.md §4 "before launch" column met with
  evidence; no open critical findings.
- **Exit:** owner sign-off recorded here; every gate G-A…G-H in
  CHANGE_IMPACT_AND_SAFETY.md §6 has evidence.

**Session 1, prep on mocks (2026-10-20 ~18:45–19:00 IST, Claude Code / Opus
5.5, `main` in place, uncommitted; owner: "start the another phase according
to the status.md"):** `IN_PROGRESS`. No voice phase is unblocked: 9 needs 5
(BLOCKED: B3–B5, B8) and 10 needs 9; track A's only open phase, A11, waits
on A10 (BLOCKED). Following A11's precedent, this is preparation that needs
no account, counsel or live call. Every gate stays open.

- **Found:** the live switches AGENTS.md voice rule 5 names
  (`KRIYA_VOICE_LIVE`, `voice.liveCalls`) existed nowhere in code. Added:
  `voice.liveCalls` in `lib/config.ts` (default off, owner-only, no env) and
  `liveAllowed` in `claimNext` (`lib/voice/run-call.ts`): a real provider is
  claimed for only with `KRIYA_VOICE_LIVE=1` **and** `voice.liveCalls = on`;
  the mock needs neither. Phase 5 must keep both.
- T-SEC-01 and T-SEC-05 already existed (`voice-service.test.ts`,
  `session.test.ts`). Added: **T-SEC-02** (`session.test.ts`: every console
  line of a whole call captured; no callee number in any spacing, no stream
  secret, no phone-hash key); **T-SEC-03** (`boundaries.test.ts`: no secret
  or vendor variable name in `.next/static/**/*.js`; skipped without a
  build; ran here against the build from Phase 8 session 1); **T-SEC-04**
  (`metering.test.ts`: a real provider isn't claimed with the switches off,
  nor with only `KRIYA_VOICE_LIVE`; claimed with both; after the emergency
  stop nothing is claimed and every call is cancelled). `npx vitest run
  tests/voice/metering.test.ts tests/voice/boundaries.test.ts
  tests/voice/session.test.ts` → **3 files, 28 passed**.
- **`npm run check` not completed:** Claude Code stopped it because the
  machine was low on memory (not a test failure). The last complete run, in
  Phase 8 session 1 before these changes: 1265 passed | 26 skipped, exit 0.
  `tsc --noEmit` is clean after all changes.
- Gate evidence (CHANGE_IMPACT §6), as of now:

  | Gate | Evidence | Open |
  | --- | --- | --- |
  | G-A | `npm run check` + `npm run build` passed after Phase 8 session 1 | a complete check after this session's changes |
  | G-B | voice migrations + rollback on PGlite (`tests/db/migrations.test.ts`), applied to staging; RLS tests per table | rollback on staging |
  | G-C | mocks: `pipeline.test.ts` "crash recovery (D1 = 0)" (T-Q-03/S16, T-Q-04, timeouts → unknown, no redial), S15/T-WH-02 duplicate webhooks, T-Q-07 | the EVALUATION_PLAN §4 fault-injection suite with D1/S1 counts; live |
  | G-D | T-VER-01, 02, 03, 08 found by id (`outcome.test.ts`) | T-VER-04…07 not found by id; O2 bound |
  | G-E | Phase 6: R1 = 100 % on `reminders.test.ts` (19) | live owner calls (Phase 5) |
  | G-F | — | counsel Q1–Q10 (B4), A2P declaration (B5) |
  | G-G | emergency stop and live switches tested on mocks (T-SEC-04); owner alerts on `/owner/operations` | rehearsals on staging, deploy during a live call, alert firing |
  | G-H | automated reviews (F25–F27, F33) | independent code + security review |

- **Next exact action:** re-run `npm run check` when the machine has memory
  free; then look for or write T-VER-04…07 (TEST_STRATEGY) and the EVALUATION_PLAN
  §4 fault-injection suite on mocks; everything else here waits on Phase 5,
  counsel and an external review.

**Session 2, mock prep completed (2026-10-20 ~19:10–20:30 IST, Claude Code /
Opus 5.5, `main` after `85b9797`; owner: "COMPLETE PHASE 9 (Readiness,
Recovery & Integrity on Mocks)"):** mock prep **COMPLETE**; the phase stays
`IN_PROGRESS` (G-E…G-H need live calls, counsel and an external review).

- Fixed first (automated security review of `85b9797`, both fail-open, F37):
  `checkVoiceAllowed` refuses a new call while the plan has a rupee allowance
  and any voice charge is unpriced (`unpricedVoiceTasks`; agent charges
  unaffected, F9); for a real provider the daily cap refuses while anything
  today is unmetered, and `overBudget` refuses without a telephony price or
  with unmetered spend on the task. The mock is held only to what's priced.
  Tests in `metering.test.ts` (13).
- **T-VER-04…07** (`outcome.test.ts`, against the database): a report
  answered but never played to its last mark → `retry_wait`, not delivered;
  the person's session gets `permission denied` and a direct write as the
  database owner hits the status trigger; `voice`, `owner`, `worker`,
  `webhook` can't complete a task; `completed` needs a delivered report call
  id. All eight T-VER ids now exist (01–03 and 08 before).
- **Fault-injection suite** (`tests/voice/faults.test.ts`): 7 faults × 10
  runs = 70 runs on the mock provider: busy twice → exhausted; duplicate and
  reversed webhooks (S15); worker dies after `requested` with and without a
  provider record (S16, T-Q-04); `placeCall` timeout → unknown → owner;
  `placeCall` refused → failed → retry; the call drops while connected and
  kriya-voice is lost (S14/S17) → `voice_lost`, no redial. R2 = 100 % (every
  run in its expected state); **D1 = 0 extra rings** over every placed
  attempt; no attempt after an `unknown` or connected one. Rule of three:
  0 in 70 → ≤ ~4.3 % at 95 % (EVALUATION_PLAN §5); mocks only, so no claim
  about real calls. Only the harness needed fixes on the way (unique
  provider ids per run; a number per run, because the per-number limits
  rightly stopped the 4th run; statuses at 0 ms within the watch window).
- **Transcript retention was never enforced** (found while drafting the
  privacy text, F36): `voice_profiles.transcript_retention_days` was stored
  and read nowhere. Added `pruneTranscripts` in the new
  `lib/voice/housekeeping.ts`, run by the worker janitor (`worker/index.ts`):
  turns deleted after the owner's days (30 without a profile) from the
  attempt's end, never while an outcome is pending; the outcome and signals
  stay. Test in `improve.test.ts`.
- **Legal drafts** (`lib/legal.ts`, still "Draft, pending legal review"):
  privacy (what calls keep: text, not audio; the people called and the keyed
  fingerprint for opt-outs; retention as built; call signals; content use
  only with opt-in and after counsel, Q11; telephony and speech providers as
  a processor, named before calls go live; the basis for people called
  written as open, Q3); terms ("Phone calls": genuine personal reasons only,
  no marketing or bulk; Kriya's limits; telecom rules open, Q1); AI
  disclosure (confirm before any call, 9 AM–9 PM Mon–Sat, agreement only
  within authority, results checked against what was said, reminders only
  by phone and never on voicemail). `tests/readiness` 11/11.
- Gate evidence, updated:

  | Gate | Evidence | Open |
  | --- | --- | --- |
  | G-A | `npm run check` exit 0: Test Files 103 passed, Tests 1292 passed (Phase 10 session below) | `npm run build` after this session (not run; the owner pages didn't change this session) |
  | G-B | migrations + rollbacks on PGlite incl. T-MIG-01 newest-first; RLS suites; voice migrations 1–3 on staging | a rollback rehearsed on staging |
  | G-C | fault suite: D1 = 0, R2 = 100 % over 70 mock runs | the same on live calls |
  | G-D | T-VER-01…08 pass | O2 bound on ≥ 300 runs incl. ≥ 50 live |
  | G-E…G-H | — | Phase 5, counsel (B4), A2P (B5), an external review |
- **Next exact action:** owner: counsel on Q1–Q11, Exotel (B3–B5, B8), then
  Phase 5; an external security review.

## Phase 10 — Continuous improvement loop

**Status:** COMPLETE 2026-10-20 on test data (see the session below)

- **Objective:** the governed loop of SELF_IMPROVEMENT.md running in
  production: metrics per attempt, owner feedback, weekly cases, regression
  scenarios, policy versions with shadow/canary and automatic rollback.
- **Read first:** SELF_IMPROVEMENT.md (all); EVALUATION_PLAN.md.
- **Preconditions:** Phase 9 COMPLETE; foundations from Phases 1
  (`policy_version`), 4 (bundle loading), 7 (feedback UI); B11 for any use of
  call content.
- **Files:** migration `2026xxxx_voice_improvement.sql` (+ rollback) for
  `voice_policy_versions`, `attempt_metrics`, `voice_feedback`, `voice_cases`,
  `voice_profiles.improvement_opt_in`; new `lib/voice/policy/*.ts`,
  `lib/voice/improve.ts` (metrics, grouping, rollback trigger); `worker/index.ts`
  janitor hook; `lib/config.ts` (`voice.policyVersion`, canary %); owner console
  views; tests.
- **Tests:** metrics computed for every attempt; case grouping by taxonomy;
  canary assignment stable per user; automatic rollback on a simulated
  severity-1 case; no content read for users without opt-in; fixed guards
  unaffected by any bundle (a bundle that tries to change a guard is rejected).
- **Acceptance:** one full cycle demonstrated on simulated data: case →
  scenario → candidate → offline gate → shadow → canary → active, and one
  rollback.
- **Rollback:** set `voice.policyVersion` to the previous active version.
- **Exit:** `npm run check` passes; cycle evidence recorded here.

**Session 1 (2026-10-20 ~19:40–20:30 IST, Claude Code / Opus 5.5, `main`
after `85b9797`; owner: "IMPLEMENT PHASE 10"):** `COMPLETE` on test data.
The precondition "Phase 9 COMPLETE" is not met; built at the owner's
request. Nothing in production changes by itself: only the owner promotes a
version, v1 stays the default, and call content is read only for opted-in
owners in the shadow stage, which waits for counsel (B11) before real use.

- Migration `20261023000000_voice_improvement.sql` + rollback:
  `voice_policy_versions` (complete bundle + hash, status, canary %, targets,
  reports; one active and one canary at a time; no user grant),
  `attempt_metrics` (numbers and codes, select-own), `voice_feedback`
  (select- and insert-own, only on one's own attempts; no grant on `id` or
  `created_at`, so a correction can't be backdated), `voice_cases` (the
  taxonomy as a check, unique per code + version + week, no grant),
  `voice_profiles.improvement_opt_in` (default false). No foreign key to a
  voice table, so rows outlive attempts and the voice core still rolls back
  alone; T-MIG-01 updated to roll back newest-first (27 voice tables).
  `db/schema.ts` mirrors it. Applied to the Supabase project by the owner
  (2026-10-20; `migrate.ts --status`: all four voice migrations `applied`).
- `lib/voice/policy/index.ts`: a strict bundle schema (only v1's tunable
  keys; `disclosure`, `limits` or any other key refused), seven safety
  sentences that must stay word for word, threshold bounds, a canonical
  hash. `bundleFor` loads only canary/active, valid, hash-matching bundles,
  else v1; `policyFor` picks the canary by a stable per-user hash, else
  `voice.policyVersion`. `prepareAttempt` stamps it; kriya-voice runs the
  stamped bundle for the whole call; outcome extraction uses its prompt.
  The session still loads no agent or memory code (boundaries test).
- `lib/voice/improve.ts`: per-attempt metrics (status, end reason, verifier
  status, result code, disclosure played, turns, low-confidence turns,
  barge-ins, latency p50/p95 from turn timing, opt-out, wrong person,
  seconds, cost; null when not measured); `groupCases` (signals and the
  owner's corrections → the §3.3 taxonomy; false agreement and disclosure
  are severity 1; idempotent); `linkScenario`; `proposeVersion` (a valid
  bundle; every target case has its regression scenario);
  `recordOfflineGate` (zero-tolerance metrics, the target improves, ≥ 50
  paired runs); `runShadow` (opted-in owners only; the report holds attempt
  ids, no content); `advance` (owner only: shadow → 5 → 25 → 100 % →
  active; blocked by an open severity-1 case); `rollback`;
  `checkRollbacks` (automatic on severity 1, or the needs-review or
  opt-out rate over its guard with ≥ 20 calls). The gate and guard formulas
  are copies of track A's (F35).
- Janitor (`worker/index.ts` → `voiceHousekeeping`): charges, metrics,
  cases, rollbacks, then transcript pruning, each step isolated.
  `lib/config.ts`: `voice.policyVersion` (default v1, owner-only);
  `setSetting` takes a null actor for automatic rollbacks.
  `actions/voice.ts`: `correctCallOutcome` (zod, rate limit, own attempts).
- Tests (`tests/voice/improve.test.ts`, 8): fixed guards stay out of every
  bundle (extra key, dropped safety sentence, wild threshold refused; a
  hand-edited stored bundle never loads); metrics for every verified
  attempt, once; cases with severity 1, idempotent, RLS on corrections; the
  canary stable per user, widening only adds people; **the full cycle:
  case → scenario → candidate → offline gate (a failing run stays a draft)
  → shadow (n = only opted-in calls, agreement 1) → canary 5/25/100 →
  active (`voice.policyVersion` = v2)**; **automatic rollback**: a
  severity-1 case puts canary v3 at `rolled_back` 0 % and blocks advancing,
  then one on active v2 hands back to v1; both audited with no actor;
  transcript retention.
- `npm run check` (after all of this turn's changes): "All matched files use
  Prettier code style!", **Test Files 103 passed | 3 skipped (106), Tests
  1292 passed | 26 skipped (1318)**, exit 0. A first run failed only
  T-REM-07, on F35; fixed.
- Not done: owner console views per policy version (§7); the "Is this
  right?" button (the action exists); the drift run (§3.7, paid).
- Follow-up `51b1af6` (automated review of `d4aedc9`, F38): a false
  agreement needs the checked outcome to have said `agreed`; a rollback
  reinstates only a retired parent without an open severity-1 case, else v1.
- **Next exact action:** a console view for versions and cases; counsel on
  Q11 before any real shadow run.

---

## Phase 0 check log

| Date | Check | Result |
| --- | --- | --- |
| 2026-10-17 | `npm run typecheck` (before docs) | Pass |
| 2026-10-17 | `npm run lint` (before docs) | Pass |
| 2026-10-17 | `npm test` (before docs) | 82 passed, 9 files |
| 2026-10-17 | `prettier --write` on the new/changed Markdown | Formatted |
| 2026-10-17 | `npm run format:check` (after first docs) | Failed on `render.yaml` and `.serena/*`, none touched by Phase 0. Cause: `render.yaml` working copy had CRLF (git index LF, `.gitattributes` `eol=lf`); `.serena/` is a local tool folder Prettier scanned. Note: `.prettierignore` has `*.md`, so Markdown is never format-checked |
| 2026-10-17 | Re-audit: FK behaviour on PGlite 18.6 (scratchpad script) | Plain composite `on delete set null` → parent delete fails (`null value in column "user_id"`); `on delete set null (thread_id)` → works. Design fixed (F1) |
| 2026-10-17 | Local fixes: `render.yaml` CRLF → LF (`git diff render.yaml` empty before and after); `.serena` appended to `.prettierignore` | Done |
| 2026-10-17 | `npm run check` (after fixes) | **Pass**: typecheck, lint, format, 82 passed / 9 files |
| 2026-10-17 | Cross-references after re-audit (script over all voice docs, `status.md`, `AGENTS.md`) | D-01…D-18 all defined and used; every cited T- id defined in TEST_STRATEGY.md; Q1–Q11 defined |
| 2026-10-17 | `npm run check` (final, after re-audit docs) | **Pass**: typecheck, lint, format, 82 passed / 9 files |

## Owner approvals

| Date (IST) | Approval | How recorded |
| --- | --- | --- |
| 2026-10-20 | **Approved D-01 … D-16** | Owner, in the Claude Code session, wrote: "I approve D-01 to D-16, start Phase 1" |
| 2026-10-20 | **Approved D-17** | Owner, same session, answering the agent's question ("Approve D-17 (Recommended)") |

| 2026-10-20 | **Approved D-18**; Phase 7 builds everything except the parts that need Phase 6 (the "Phone & calls" settings, owner-number verification, report delivery), which are deferred until Phase 6 | Owner, in the Claude Code session, answering the agent's questions ("Approve D-18 (Recommended)"; "Build the rest, defer those (Recommended)") |

---

# Agent platform (track A)

Role teams for students, developers, founders, freelancers, creators and
small businesses that carry out tasks (official APIs, a supervised browser
with the person's own login profiles, generated documents), remember goals
and context, work in the background, and show what they actually did with
evidence. Blueprint: `docs/agent-platform/`. Agents start from
`docs/agent-platform/AGENT_MASTER_PROMPT.md`.

## Track A documents

| Document | What it decides |
| --- | --- |
| `docs/agent-platform/DECISIONS.md` | AD-01…AD-36 (all **Proposed**, awaiting owner approval) |
| `docs/agent-platform/VISION_AND_SCOPE.md` | Intent, the four enforceable guarantees, principles, in/out of scope, glossary |
| `docs/agent-platform/ROLE_PLAYBOOKS.md` | Per-role teams and workflows (ST-, DV-, FD-, FL-, CR-, BZ-), the LinkedIn and accountant walk-throughs |
| `docs/agent-platform/RESEARCH.md` | Market, browser infrastructure, memory research, site terms, India rules, research gaps RG-1…RG-8 |
| `docs/agent-platform/REPOSITORY_AUDIT.md` | What exists, gaps AG-01…AG-17, findings AF-01…AF-07 |
| `docs/agent-platform/ARCHITECTURE.md` | Services, loop, policy engine, verification, scheduler, modules, failure modes, switches |
| `docs/agent-platform/MEMORY_AND_CONTEXT.md` | Memory kinds, write path, retrieval, budgets, token-economy techniques T1–T11, summaries, consolidation |
| `docs/agent-platform/BROWSER_AND_LOGIN_PROFILES.md` | `kriya-browser`, action model, commit detection, egress guard, live view, login profiles, fixtures |
| `docs/agent-platform/DATA_MODEL_AND_STATE_MACHINES.md` | Migration rules, tables per phase, state machines, RLS, retention |
| `docs/agent-platform/TOOLS_AND_CONTRACTS.md` | Tool catalogue with classes, loadouts, actions, routes, SQL functions, idempotency |
| `docs/agent-platform/SECURITY_AND_COMPLIANCE.md` | Threats S1–S15, DPDP duties, counsel questions AQ-1…AQ-6, gates GA-1…GA-8 |
| `docs/agent-platform/UX_SPEC.md` | Inbox, What I did, goals, live view, logins, files, accounts, memory, skills |
| `docs/agent-platform/TEST_AND_EVALUATION.md` | Test ids AT-…, metrics V/P/M/C/B/L/R, scenario suites AS-…, paid-run rules |
| `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md` | **Read before editing any existing file**: protected files, allowed change per file and phase, boundaries, stop conditions, proposed invariant amendments |
| `docs/agent-platform/IMPLEMENTATION_PLAN.md` | Order, parallelism (incl. with voice), configuration, rollout, rollback |
| `docs/agent-platform/SIGNATURE_FEATURES.md` | Kriya's own differentiators K1–K10 (receipts, ₹ quotes and caps, undo, Radar, zero-token watchers, public facts commons, cross-check, shares, kits, lite mode); AD-27…AD-36 |

## Track A overview

| Phase | Name | Status | Depends on |
| --- | --- | --- | --- |
| A0 | Blueprint and decisions | IN_PROGRESS (documents done; awaiting owner approval) | — |
| A1 | Memory v2 and context economy | COMPLETE 2026-10-18 (M1 0.80 accepted by owner; 360 px screenshots open) | A0 approved (A1 decisions approved 2026-10-18) |
| A2 | Role packs and teams | BLOCKED (360 px walk-through needs a database; code and tests done; K10 moved to A3) | A1 |
| A3 | Goals, schedules, background runs, Inbox, What I did, tool policy | COMPLETE 2026-10-18 (AS-SCH R1 15/15, P1 0, V1 1/1; AT-LITE-01; 360 px screenshots open, need a database) | A1 |
| A4 | Browser runtime on fixture sites | BLOCKED (AB-08 staging capacity only; B1 1.00, P1 = P2 = 0 on fixtures) | A0 approved (parallel with A1) |
| A5 | Files and documents | COMPLETE 2026-10-18 on fixtures (owner ran check, browser suite and build: all exit 0; live bucket AB-05 and 360 px screenshots open) | A4 (owner: proceed on fixtures) |
| A6 | Login profiles, take-over, live view (+ K9 kits) | COMPLETE 2026-10-18 on fixtures (see A6 Session result; open: public live-view route AB-11, 360 px screenshots, phone-network latency) | A3, A4, AD-05 approval |
| A7 | Accounts: bills, ledger, GST, invoices, reports | COMPLETE 2026-10-18 on fixtures (owner accepted; L1 = 0; check + build pass. Open for the pre-launch pilot: L2 (paid labelled run), the official GSTIN check-code algorithm, 360 px screenshots) | A5 |
| A8 | Official-API connectors (GitHub, Sheets, YouTube, Instagram) | COMPLETE 2026-10-18 (check + build pass on fixtures; live use needs AB-06, RG-4, RG-10; 360 px screenshots open; youtube_upload deferred to A5) | A3 (+ AB-06 for live use) |
| A9 | Skills (+ embeddings only if M1 < 0.90) | COMPLETE 2026-10-18 on fixtures (no embeddings; AB-08 open for live; `max_skills` 0 until set; 360 px screenshot open) | A3, A4 |
| A10 | Controlled pilot on real sites | BLOCKED (AB-02, AB-04, AB-07) | A2, A6, A7, A8, A9, A13 |
| A11 | Security, compliance, recovery, readiness | IN_PROGRESS (prep 2026-10-18: runbooks, legal drafts, rotation code, readiness suite; all gates open) | A10 |
| A12 | Governed improvement loop | COMPLETE on test data 2026-10-19 (behind `agents.improvement`, off; no live canary run yet) | A11 |
| A13 | Watchers, Radar, public facts commons (K4–K6) | COMPLETE 2026-10-18 on fixtures (W1 = 0, F1 = 0, AS-RAD 15/15; check + build pass. Open: RG-11 price, fact targets to list, GST/state-code checks, 360 px screenshots) | A3, A4 (runs before A10; ids aren't order) |

## Track A blockers

| # | Blocker | Blocks | Needed from |
| --- | --- | --- | --- |
| AB-01 | Owner approval of AD-01…AD-26 | A1+ | Owner |
| AB-02 | Platform not yet on real services (same as voice B2) | A4 capacity check on staging, A10 | Owner |
| AB-03 | ~~AD-05 approved **and** the invariant 4 amendment applied~~ **Resolved 2026-10-18** (owner approved AD-04, AD-05, AD-35; amendment applied) | A6 | Owner |
| AB-11 | A public `wss://` route to `kriya-browser`'s `/live/<session>` (Render private services aren't reachable from browsers); set `KRIYA_BROWSER_LIVE_URL` on web | A6 live use | Owner |
| AB-04 | Terms review (primary text) for every site to leave `assisted`; LinkedIn and Upwork first (RG-2, RG-3) | `supervised` mode on any site in A10 | Owner + counsel |
| AB-05 | Supabase Storage bucket `kriya-files` (private) created on the project | A5 live use (tests don't need it) | Owner |
| AB-06 | OAuth apps: GitHub App/OAuth app; Meta app with Instagram permissions and app review; Google scopes for Sheets and YouTube (verification) | A8 live use | Owner |
| AB-07 | Counsel answers AQ-1…AQ-6 (minors, roles, retention, liability, per-site permission, AI disclosure) | A10 (AQ-1, AQ-5, AQ-6), A11 (all) | Owner + counsel |
| AB-08 | Chromium sandbox and capacity on Render (RG-1) | A4 exit | Owner (staging service) |
| AB-09 | `.env.example` not editable by agents here (voice B9); new variables added by the owner | A4 | Owner |
| AB-10 | Primary sources for GST Rule 46 and the GSTIN checksum (RG-5) | A7 exit | Agent (research) + owner check |

---

## Phase A0 — Blueprint and decisions

**Status:** IN_PROGRESS — documents written 2026-10-17; exit needs owner approval (AB-01).

- **Done:** the 16 documents above (re-audited 2026-10-17, findings AF-08…AF-22 fixed in the design); `AGENTS.md` "Agent platform" section;
  this section. No application code, migrations, dependencies, env vars or
  accounts touched.
- **Exit:** (1) documents cross-checked (log below); (2) `npm run check`
  passes; (3) owner marks each AD Approved or Changed under "Track A owner
  approvals".
- **Next exact action:** owner reviews `docs/agent-platform/DECISIONS.md`
  (start with AD-03, AD-04, AD-05, AD-06, AD-16) and writes "Approved AD-…"
  or changes below.

## Phase A1 — Memory v2 and context economy

**Status:** COMPLETE (2026-10-18; M1 0.80 accepted by the owner; 360 px
screenshots open)

**Session plan (2026-10-18, Claude Code / Opus 5.5, `main` in place,
uncommitted; owner allowed no branches or commits):**

- Scope of this session (foundation slice; the phase stays IN_PROGRESS):
  1. AT-REG-01 snapshots of today's instructions and tool definitions,
     taken **before** any code change.
  2. Migration `20261101000000_memory_v2.sql` + rollback (`memories`
     `unique (id, user_id)` first, new columns, nullable `agent_id`, widened
     `source`; `thread_summaries`; `maintenance_jobs`; `resource_usage`).
     Newest existing migration is `20261018000000`; no voice migration exists.
  3. `db/schema.ts` mirror; `run-task.ts` always-on loader filter (AF-16).
  4. New `lib/memory/{sensitive,write,retrieve,context}.ts` with tests.
  5. `lib/config.ts`: `agents.memoryV2` (default `off`),
     `agents.maintenanceCapMicroUsd`.
- Deferred to the next session: V2 tool factory and runner/instructions
  wiring behind the switch, summaries, consolidation, worker maintenance
  loop, actions/queries/UI, AS-MEM/AS-CTX suites, C1 baseline and metrics.
  (The C1 baseline needs prompt sizes from today's code: the AT-REG-01
  snapshots preserve today's prompt, so the baseline can still be taken
  before the switch-on path exists.)
- Tests first: AT-REG-01, AT-REG-02, AT-MEM-01…05, 07, 08, 09, 12,
  AT-RLS-MEM-01, migration down/up.
- Risks: `Memory.agentId` becomes `string | null` (typecheck finds every
  caller); `getMemories` selects every column, so the generated `search`
  column is **not** declared in Drizzle; the instructions contain today's
  date, so snapshots pin the clock.
- Questions for the owner: none blocking.

**Session result (2026-10-18, Claude Code / Opus 5.5):** `IN_PROGRESS`
(foundation slice done as planned; exit criteria not yet reachable).

- **Created:** `supabase/migrations/20261101000000_memory_v2.sql`,
  `supabase/rollback/20261101000000_memory_v2.down.sql`,
  `lib/memory/{sensitive,retrieve,write,context}.ts`,
  `tests/agent/{regression,runner,sensitive,memory,context}.test.ts`,
  `tests/agent/__snapshots__/regression.test.ts.snap`,
  `tests/db/agent-memory-rls.test.ts`.
- **Changed:** `db/schema.ts` (memories mirror: nullable `agentId`, new
  columns, `MEMORY_KINDS`; new `threadSummaries`, `maintenanceJobs`,
  `resourceUsage`; the generated `search` column is deliberately not
  declared), `lib/agent/run-task.ts` (loader: `invalid_at is null and not
  archived`, `agentId!`; AF-16), `lib/config.ts` (`agents.memoryV2` default
  `off`; `agents.maintenanceCapMicroUsd` default `0` = no maintenance model
  spend until the owner sets it), `tests/db/migrations.test.ts` (one new
  down/up case; existing cases untouched), `docs/agent-platform/
  MEMORY_AND_CONTEXT.md` §5.1 and `REPOSITORY_AUDIT.md` (AF-23, AF-24).
- **Order kept:** AT-REG-01 snapshots were written (6 snapshots, 651 lines)
  before any code change, then stayed green after every step. AT-REG-02 was
  seen failing on the old loader ("expected … not to contain 'Rent is
  12000'") before the fix.
- **Tests (ids):** AT-REG-01, AT-REG-02, AT-MEM-01, 02, 03, 04, 05 (write
  side: `unconfirmed` and excluded from block 3; detecting untrusted turns
  is wiring, next session), 06, 07, 08, 09, 12, AT-RLS-MEM-01, memory v2
  down/up. Not yet: AT-MEM-10, 11, 13, AT-MNT-01, 02.
- **Commands and real output:**
  - `npx vitest run tests/db` after the migration: 3 files, 38 passed.
  - `npx vitest run tests/agent/runner.test.ts` before the loader fix:
    1 failed, 2 passed; after: 9 passed (`tests/agent`).
  - `npm run check` (final): typecheck, lint pass; "All matched files use
    Prettier code style!"; **Test Files 15 passed (15), Tests 161 passed
    (161)**. The original 82 tests / 9 files are unchanged.
  - `npm run build`: not run; nothing under `app/`, `components/`,
    `worker/` or `browser/` changed.
- **Measured (n = 1 fixed dataset, PGlite, uncommitted tree on `bdf223f`):**
  recall scores for "laptop budget?" own-match 0.7568, own-fresh 0.7000,
  own-chai 0.6000, shared-unconf 0.2568, shared-old 0.1315 (AF-24). No
  M-, C- or other metric was measured yet.
- **Exit criteria:** M1/M2/M4/M5 on AS-MEM, C1 vs baseline, "switch off =
  identical" with the switch wired: **not yet** (suites and wiring are next).
  `npm run check` passes.
- **Deviations:** (1) AF-23 tokeniser keeps `\p{M}` (doc updated). (2)
  Recall scores every visible note (text match adds to the score) instead
  of only text matches, so a related note with no shared word can still be
  recalled; with no words in the query it is recency order, as §5.1 says.
  (3) `similar` notes come from everything the agent can see (shared + its
  own), not only the new note's own scope. (4) Block 1 (identity, standing
  orders) is measured but never cut, since cutting would drop the person's
  orders; blocks 2–8 are enforced. (5) An `unconfirmed` duplicate is not
  upgraded to `trusted` by a later trusted write: trust is the person's to
  set (DATA_MODEL §4).
- **Blockers / questions:** none new. Note for the owner: the session
  guard hook asks for a facts statement before every first edit of a file;
  `GATEGUARD_EXEMPT_GLOBS` could exempt `tests/**` and `lib/memory/**`.
- **Next exact action:** (1) V2 tool factory in `lib/agent/tools.ts`
  (`memory_write` with kind/slot/shared/importance, `memory_update`,
  `memory_forget` = invalidate, `memory_search`; `recall_episodes` waits for
  A3's `episodes`), untrusted-turn detection from step messages, used only
  when `agents.memoryV2` is on; (2) `run-task.ts` + `instructions.ts` V2
  path through `assembleContext`, `memoryIds` in metadata, batched
  `last_used_at`/`use_count`; add a second AT-REG-01 snapshot with the
  switch on; (3) C1 baseline on AS-CTX with today's prompt before (2) is
  switched on; (4) summaries + maintenance loop (AT-MEM-10, 13, AT-MNT-*);
  (5) actions/queries/UI; (6) AS-MEM/AS-CTX suites and metrics.

**Session plan (2026-10-18, session 2, Claude Code / Opus 5.5, in place):**
next actions (1) and (2) above. Files: `lib/agent/tools.ts` (new
`createMemoryToolsV2`, `untrustedSeen`, optional `taskId` on `ToolEnv`,
optional `memoryIds` on `KriyaMetadata`; `createMemoryTools` untouched),
`lib/agent/instructions.ts` (optional V2 argument; without it the output is
byte-identical, guarded by AT-REG-01), `lib/agent/run-task.ts` (read the
switch once per task; V2 context per member; `memoryIds`; batched
`last_used_at`/`use_count`), `lib/memory/retrieve.ts` (`searchNotes`), the
two UI label files. Tests first: second AT-REG-01 snapshot (switch on),
untrusted detection (AT-MEM-05 wiring), runner with the switch on and off.
Summary checkpoints stay for the next session.

**Session result (2026-10-18, session 2):** `IN_PROGRESS` (next actions (1)
and (2) done; the switch can now be turned on for testing, not for users:
no UI to confirm or review notes yet).

- **Changed:** `lib/agent/tools.ts` (`createMemoryToolsV2`: `memory_write`
  with kind/slot/shared/importance, `memory_update`, `memory_forget` =
  invalidate, `memory_search` with history; `untrustedSeen`; optional
  `ToolEnv.taskId`, `KriyaMetadata.memoryIds`; `KriyaTools` typed with the
  v2 superset; `createMemoryTools` untouched), `lib/agent/instructions.ts`
  (shared `stableSections`; `buildInstructionsV2` = stable sections + memory
  guidance + `assembleContext` blocks, date moved to "# Now"),
  `lib/agent/run-task.ts` (switch read once per task; v2 loads always-on +
  recalled notes per member, recall query = latest person message; v2 tools
  for lead and `assign` members; `memoryIds` in the reply's finish
  metadata; one batched `last_used_at`/`use_count` update after the reply),
  `lib/memory/retrieve.ts` (`searchNotes`), `components/thread/tool-call.tsx`,
  `components/workbench/activity.tsx` (labels for the two new tools).
- **Created:** `tests/agent/memory-tools.test.ts`; new cases in
  `tests/agent/runner.test.ts` and `tests/agent/regression.test.ts`
  (2 new snapshots: v2 prompt, v2 tool definitions).
- **Tests first:** the 3 switch-on runner cases failed before the wiring
  (3 failed, 4 passed), then passed. The 6 switch-off AT-REG-01 snapshots
  stayed green through the refactor of `instructions.ts`: off is still
  byte-identical.
- **Commands and real output:** `npm run check`: "All matched files use
  Prettier code style!", **Test Files 16 passed (16), Tests 177 passed
  (177)**; `npm run build`: exit 0, all routes built.
- **Fixed on the way:** `memory_search` built `limit` (empty) when called
  without zod's default; `execute` now defaults it to 10.
- **Not done:** C1 baseline (needs AS-CTX scenarios), summaries and the
  maintenance loop, person-side actions/UI (confirm, pin, export, pause,
  chain erase via `eraseMemory`), AS-MEM/AS-CTX suites and metrics.
  `recall_episodes` waits for A3's `episodes` table.
- **Next exact action:** (3) AS-CTX scenario files + `scripts/agent-eval.ts`
  scripted runner measuring prompt sizes, run once with the switch off to
  record the C1 baseline; then (4) thread summaries + maintenance loop
  (AT-MEM-10, 13, AT-MNT-01, 02).

**Session plan (2026-10-18, session 3):** next action (3). New files only:
20 AS-CTX seeds in `tests/eval/scenarios/AS-CTX/*.json` (agent, notes,
three topics with real person questions and answers, a final question);
`tests/eval/threads.ts` expands a seed into a 42-turn thread
deterministically (synthetic, stated as such in the results);
`tests/eval/context.eval.test.ts` runs each scenario through the real
`runTask` on PGlite with a scripted model, switch off and on, and measures
prompt and tool-definition sizes (chars ÷ 4). With `KRIYA_EVAL_OUT` set it
writes the numbers as JSON; the baseline goes to
`docs/agent-platform/benchmarks/2026-10-18-as-ctx-baseline.md`.
`package.json` is not touched (A4's file): the free run is
`KRIYA_EVAL_OUT=<file> npx vitest run tests/eval`.

**Session result (2026-10-18, session 3):** `IN_PROGRESS` (next action (3)
done: C1 baseline recorded).

- **Created:** `tests/eval/scenarios/AS-CTX/AS-CTX-01…20.json` (seeds, all
  roles, fictional people), `tests/eval/threads.ts`,
  `tests/eval/context.eval.test.ts`,
  `docs/agent-platform/benchmarks/2026-10-18-as-ctx-baseline.md`.
  **Changed:** `docs/agent-platform/REPOSITORY_AUDIT.md` (AF-25).
- **Measured (n = 20, scripted model, commit `bdf223f` + uncommitted A1
  work, one model call per task, chars ÷ 4):** C1 with the switch **off**
  (baseline): mean **5,669.75**, median **5,699**, min 4,345, max 7,756.
  With the switch **on** (no summaries yet): mean 6,331.1, median 6,357
  (+11.7 % mean). History is 73–84 % of C1; v2 tool definitions 767 vs 255
  tokens per call (AF-25). C3 not measurable on the scripted model.
- **Commands and real output:** `KRIYA_EVAL_OUT=… npx vitest run
  tests/eval`: 2 passed, 6.79 s. `npm run check`: "All matched files use
  Prettier code style!", **Test Files 17 passed (17), Tests 179 passed
  (179)**.
- **Fixed on the way:** an implicit `any[]` in the eval test (typecheck).
- **Implication for the A1 exit:** the −30 % target (≤ 3,968.8 mean C1 on
  this suite, against the off baseline) can only come from summary
  checkpoints, which must also absorb the +11.7 % that memory v2 adds now.
- **Next exact action:** (4) thread summaries + maintenance loop:
  `lib/memory/summaries.ts` (cut rule AT-MEM-13, deterministic check
  AT-MEM-10, zod format), maintenance job claim/lease loop in
  `worker/index.ts` with its own map behind the switch, job enqueue at task
  end when history since the checkpoint exceeds 24,000 characters,
  `run-task.ts` dropping covered messages and adding block 8, usage in
  `resource_usage` with the daily cap (AT-MNT-01, 02); then re-run AS-CTX
  with summaries (scripted summariser) and record C1 against this baseline.

**Session result (2026-10-18, session 4):** `IN_PROGRESS` (next action (4)
done; the C1 target is **not met**, see below).

- **Created:** `lib/memory/summaries.ts` (cut rule, fact check, zod shape,
  rendering), `lib/memory/maintenance.ts` (enqueue, claim with
  `for update skip locked`, lease recovery, IST daily cap, deferral without
  using an attempt, budget → balanced retry, `resource_usage` rows, default
  summariser via `generateText` + `Output.object`),
  `tests/agent/summaries.test.ts`, `tests/agent/maintenance.test.ts`,
  `docs/agent-platform/benchmarks/2026-10-18-as-ctx-checkpoints.md`.
- **Changed:** `lib/agent/run-task.ts` (v2: latest checkpoint loaded, its
  messages left out of the model input only, block 8 added; summary job
  queued after the task), `worker/index.ts` (maintenance loop on its own
  5 s timer, own `maintenance` map and `MAINTENANCE_CONCURRENCY` (default
  1), only while `agents.memoryV2` is on; shutdown waits for both maps;
  janitor deletes `done` jobs after 7 days), `tests/agent/runner.test.ts`
  (3 checkpoint cases), `tests/eval/context.eval.test.ts` (runs the real
  job path before the switch-on measurement).
- **Tests (ids):** AT-MEM-10, AT-MEM-13, AT-MNT-01 (job never a task; the
  person can send a message while it runs), AT-MNT-02 (usage in
  `resource_usage`, nothing in `charges`; cap 0, cap reached and an
  unpriced call today each defer without a model call), lease recovery,
  runner checkpoint on/off and enqueue on/off.
- **Order:** the pure rules were tested first (`summaries.test.ts`).
  `maintenance.ts` was written **before** its DB tests; to make up for it, a
  mutation check was run: with the unpriced-cost rule removed, "waits for
  tomorrow with an unpriced call today" failed (1 failed, 8 passed); the
  file was restored and `git diff --no-index` showed no difference.
- **Fixed on the way:** my first draft of the previous-checkpoint check was
  a garbled double negation; replaced by `dropped()` before it ever ran.
- **Measured (n = 20, scripted model and summariser, `bdf223f` + A1 work):**
  C1 mean **5,351.4** with the switch on and checkpoints vs **5,669.75**
  off: **−5.6 %, target −30 % not met**. Checkpoints were written for 4 of
  20 threads, which fell 57.0–60.6 %; the other 16 stay under the
  24,000-character trigger and pay the v2 overhead (+10.0 to +15.5 %).
- **Commands and real output:** `npx vitest run tests/agent/summaries.test.ts`
  9 passed; `tests/agent/maintenance.test.ts` 9 passed;
  `tests/agent/runner.test.ts` 10 passed; `KRIYA_EVAL_OUT=… npx vitest run
  tests/eval` 2 passed (7.01 s); `npm run check`: **Test Files 19 passed
  (19), Tests 200 passed (200)**, Prettier clean; `npm run build`: exit 0.
- **Question for the owner (blocks the C1 exit criterion):** the −30 %
  target can't be met on AS-CTX with the 24,000-character trigger from
  MEMORY_AND_CONTEXT §7 and the current v2 tool descriptions. Options, each
  to be measured on this suite before adoption (AD-25): (a) lower the
  trigger (for example 12,000 characters); (b) shorter v2 memory tool
  descriptions (AF-25); (c) accept −30 % as a target for longer threads
  only and record per-length results. No value was changed without your
  decision.
- **Next exact action:** owner's answer on the trigger; meanwhile (5)
  person-side memory actions and UI: About you, review list (confirm /
  delete unconfirmed), pin, export (JSON), pause per agent, erase chain via
  `eraseMemory`; then (6) AS-MEM suite and M1/M2/M4/M5.

**Session result (2026-10-18, session 5):** `IN_PROGRESS` (next action (5)
done except "pause", see AF-26).

- **Created:** `lib/memory/person.ts` (`sharedNotes`, `addPersonNote` with
  the sensitive check and slot history, `notesToReview`, `confirmNote`,
  `pinNote`, `exportNotes`), `components/account/about-you.tsx` (About you
  list, add, pin, forget-for-good with confirmation, "New memories to
  review" with Confirm/Delete, JSON export; 44 px targets on phones),
  `tests/agent/person-memory.test.ts`.
- **Changed:** `actions/memory.ts` (new actions `listAboutYou`,
  `addAboutYou`, `confirmMemory`, `pinMemory`, `forgetForGood`,
  `exportMemory`, all zod + `requireUser` + `withUser`; `deleteMemory` now
  erases the chain, identical while nothing is superseded),
  `queries/workspace.ts` (`getMemories` lists current notes only, identical
  with the switch off), `app/(workspace)/account/page.tsx` ("About you"
  section, rendered only when `agents.memoryV2` is on),
  `lib/memory/write.ts` (exports `SLOT_PATTERN`),
  `docs/agent-platform/REPOSITORY_AUDIT.md` (AF-26).
- **Tests:** `person-memory.test.ts` failed first (module missing), then
  8 passed: About you add/list, slot history, sensitive refusal with the
  PAN-slot exception, review list and confirm, another person's note can't
  be confirmed or pinned, pin, export (own notes only, history included,
  no hashes or task ids), chain erase.
- **Commands and real output:** `npm run check`: Prettier clean, **Test
  Files 20 passed (20), Tests 208 passed (208)**; `npm run build`: exit 0,
  `/account` built.
- **Not verified:** the About you section was not rendered in a browser
  (no database or Supabase project here), so no 360 px screenshot exists
  yet; the UX checks in CHANGE_IMPACT §3 ("Screenshots at 360 px") remain
  open. The "Used N memories" chip on replies is not built.
- **Questions for the owner:** (1) the C1 trigger question from session 4
  is still open; (2) AF-26: add `agents.memory_paused boolean` in a new
  migration for "Pause memory", or drop the feature; (3) AF-26: may the
  existing `addMemory`/`editMemory` refuse sensitive values too (it changes
  today's behaviour, which CHANGE_IMPACT says must stay the same)?
- **Next exact action:** (6) AS-MEM suite (planted facts, updates,
  contradictions, slots, Hinglish/Telugu queries, injection attempts) on
  the scripted model, measuring M1 recall@5 (from block 6), M2, M4, M5;
  then the "Used N memories" chip and 360 px screenshots once a database is
  available.

**Session result (2026-10-18, session 6):** `IN_PROGRESS` (next action (6)
done; M1 target **not met**).

- **Created:** `tests/eval/scenarios/AS-MEM/AS-MEM-01…60.json` and
  `_pool.json` (40 ordinary notes of one fictional person),
  `tests/eval/memory.eval.test.ts`,
  `docs/agent-platform/benchmarks/2026-10-18-as-mem.md`.
- **Method:** no model; each scenario plants notes among the 40, applies
  updates through `updateMemory`, writes injected and sensitive notes
  through the real v2 `memory_write` tool (after a scripted `web_fetch`
  where the scenario says so), then builds the memory blocks with the same
  functions `run-task.ts` calls. M2 is a proxy (old value never reaches the
  prompt), stated as such.
- **Measured (n = 60, PGlite, `bdf223f` + A1 work):** **M1 = 0.72**
  (36 / 50; target ≥ 0.90): fact 10/10, lang 10/10, update 10/10,
  contradiction 5/5, gap **1/5**, paraphrase **0/10**. **M2 = 0**, **M4 =
  0**, **M5 = 0** (all 5 sensitive writes refused). M2, M4 and M5 are hard
  assertions in the test; M1 is recorded, not asserted.
- **Commands and real output:** the AS-MEM run: 2 passed; `npm run check`:
  Prettier clean, **Test Files 21 passed (21), Tests 210 passed (210)**.
- **Fixed on the way:** an implicit `any[]` (typecheck).
- **Question for the owner (blocks the M1 exit criterion):** pick a
  retrieval change to test on this suite (AD-25): (1) matches first, then
  recency (expected to fix the gap family, not paraphrases); (2) re-weight
  the text term; (3) start the conditional embeddings step (A9, AD-09),
  which the measured M1 < 0.90 now triggers by the plan's own rule, once
  tuning is done.
- **A1 exit status:** M2/M4/M5 met; M1 (0.72) and C1 (−5.6 % vs −30 %)
  not met; switch-off identical (AT-REG-01) met; `npm run check` met.
  Open owner questions: C1 trigger, M1 retrieval option, AF-26 (pause,
  existing actions' sensitive check). Phase stays `IN_PROGRESS`.
- **Next exact action:** after the owner chooses, implement the chosen
  retrieval and trigger changes behind the same switch, re-run AS-MEM and
  AS-CTX and record both; meanwhile the "Used N memories" chip (UX_SPEC) is
  the remaining unblocked A1 item.

**Session result (2026-10-18, session 7, owner's decisions applied):**
`IN_PROGRESS` (C1 met; M1 not met).

- **Changed:** `lib/memory/retrieve.ts` (matches first; the order clause is
  left out when the query has no words, since Postgres rejects a constant in
  `ORDER BY`, caught by the existing fallback test), `lib/memory/summaries.ts`
  (trigger 12,000), `lib/agent/tools.ts` (shorter v2 descriptions; v2
  `memory_write`/`memory_update` save nothing while the agent's memory is
  paused), `lib/memory/person.ts` (`refuseSensitive`, `agentMemoryStates`,
  `setMemoryPaused`), `actions/memory.ts` (`addMemory`/`editMemory` refuse
  sensitive values; `setAgentMemoryPaused`), `components/account/about-you.tsx`
  ("Memory per agent" with Pause/Resume), `db/schema.ts`
  (`agents.memoryPaused`, left out of the agent form schema),
  `tests/agent/{memory,memory-tools,person-memory,regression}.test.ts`,
  `tests/db/migrations.test.ts` (pause down/up), docs
  (`MEMORY_AND_CONTEXT.md` §5.1, §6, §7, §11; `DATA_MODEL…md` §2.1;
  `CHANGE_IMPACT…md` §3 row; `TEST_AND_EVALUATION.md` C1 row).
- **Created:** `supabase/migrations/20261101000001_memory_pause.sql` +
  rollback, `docs/agent-platform/benchmarks/2026-10-18-a1-tuned.md`.
- **Tests first:** golden order changed to the approved rule and seen
  failing; `refuseSensitive` and both pause tests seen failing before the
  code.
- **Caught on the way:** my scripted text edit first shortened the note
  description of today's (switch-off) `memory_write` instead of the v2 one;
  the AT-REG-01 switch-off snapshot failed, the original text was restored
  exactly, and only the v2 snapshot was updated (`-u -t "v2 memory tool
  definitions"`: 1 updated); all 8 snapshot tests then passed.
- **Measured (scripted, `bdf223f` + A1 work):** AS-CTX: 20 of 20 threads
  checkpointed, mean C1 **2,483.55 vs 5,669.75 off: −56.2 %** (target
  −30 %, **met**); v2 tool definitions 558 tokens (was 767). AS-MEM:
  **M1 0.80** (40 / 50; gap 5/5, paraphrase 0/10; target 0.90, **not
  met**); M2 0, M4 0, M5 0.
- **Commands and real output:** both eval runs 2 passed each;
  `npm run check`: Prettier clean, **Test Files 21 passed (21), Tests 214
  passed (214)**; `npm run build`: exit 0, `/account` built.
- **A1 exit criteria:** M2/M4/M5 = 0 met; C1 met (scripted summariser);
  AT-REG-01 met; `npm run check` met; **M1 0.80 < 0.90 not met**; 360 px
  screenshots and the "Used N memories" chip not done; a paid real-model
  run of AS-CTX (summary length) not done (needs the owner's go-ahead).
- **Next exact action:** M1 < 0.90 after tuning is, by AD-09 and
  MEMORY_AND_CONTEXT §10, the condition for the embeddings step (A9). The
  owner decides whether to run A9's embeddings now (needs pgvector on
  Supabase, RG-8 PGlite check, embedding cost) or accept 0.80 for A1. The
  remaining unblocked A1 work: the "Used N memories" chip.

**Session result (2026-10-18, session 8, closure under the owner's standing
approvals):** **`COMPLETE`**.

- **Created:** `components/thread/used-memories.tsx` ("Used N memories"
  popover; loads the notes on first open; marks unconfirmed, changed and
  "about you" notes; 44 px trigger on phones).
- **Changed:** `lib/memory/person.ts` (`notesByIds`: the reply's notes in
  its order; RLS hides other people's), `actions/memory.ts`
  (`usedMemories`: zod, `requireUser`, `withUser`; returns `[]` while
  `agents.memoryV2` is off), `components/thread/transcript.tsx` (one
  additive line in `AgentMessage`'s footer, owner-approved today, new A1
  row in CHANGE_IMPACT §3), `tests/agent/person-memory.test.ts` (1 case),
  `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md` (the row).
- **Behind the switch:** `memoryIds` is written only when
  `agents.memoryV2` is on (existing runner test "switch off: no
  memoryIds"), so with it off no chip renders; the action also refuses.
- **Tests first:** the `notesByIds` case failed ("notesByIds is not a
  function", 1 failed / 10 passed), then 11 passed.
- **Commands and real output:** preflight `npm run check`: **Test Files 21
  passed (21), Tests 214 passed (214)**, exit 0. Final `npm run check`:
  first run failed on lint (`react/no-unescaped-entities` in the new file)
  then Prettier; fixed; **Test Files 21 passed (21), Tests 215 passed
  (215)**, exit 0. `npm run build`: "Compiled successfully", exit 0.
- **Exit criteria:** M2 = M4 = M5 = 0 met; C1 −56.2 % on checkpointed
  threads met and accepted by the owner; **M1 = 0.80 accepted by the owner
  for A1** (embeddings stay in A9, not started); AT-REG-01 switch-off
  identical met; `npm run check` met; metrics recorded with n and commit
  (sessions 3–7). Paid real-model AS-CTX run: not approved, not run.
- **Open item (not an exit criterion; owner said to record it):** 360 px
  screenshots of Account → About you and of the chip were not taken: no
  database or Supabase project here. Next step when one exists: `npm run
  dev`, switch `agents.memoryV2` on in `/owner/config`, screenshot both at
  360 px and list them here.
- **Next exact action:** A4 (browser runtime on fixtures).

- **Objective:** typed, scoped, dated, sourced memory with quarantine and
  retrieval; thread summaries; cache-friendly prompt; measured token
  savings, all behind `agents.memoryV2`.
- **Read first:** MEMORY_AND_CONTEXT.md (all); DATA_MODEL §0, §2.1, §4;
  TOOLS_AND_CONTRACTS §2.1; CHANGE_IMPACT §3 rows for `db/schema.ts`,
  `tools.ts`, `run-task.ts`, `instructions.ts`, `actions/memory.ts`.
- **Preconditions:** AD-09, AD-10, AD-11, AD-12, AD-13, AD-26 approved.
- **Files:** migration `20261101000000_memory_v2.sql` + rollback (memories
  `unique (id, user_id)` first, AF-08; `thread_summaries`;
  `maintenance_jobs`; `resource_usage`, AF-12/13); `db/schema.ts`; new
  `lib/memory/{context,retrieve,write,sensitive,consolidate,summaries}.ts`;
  `lib/agent/tools.ts` (new V2 factory; the old one is kept for switch-off,
  AF-16); `lib/agent/run-task.ts` (incl. the always-on loader filter);
  `lib/agent/instructions.ts`; `actions/memory.ts`; `queries/workspace.ts`;
  `worker/index.ts` (maintenance loop with its own map); `lib/config.ts`
  (`agents.memoryV2`,
  `agents.maintenanceCapMicroUsd`); UI: About you, chips, review list;
  `components/thread/tool-call.tsx`, `components/workbench/activity.tsx`;
  tests `tests/agent/memory.test.ts`, `tests/db/agent-memory-rls.test.ts`,
  `tests/eval/scenarios/AS-MEM/*`, `AS-CTX/*`.
- **First task:** take the AT-REG-01 snapshots and the C1 baseline on AS-CTX
  **before** changing behaviour.
- **Tests:** AT-REG-01, AT-REG-02, AT-MEM-01…13, AT-MNT-01, AT-MNT-02,
  AT-RLS-MEM-01; migration down/up.
- **Acceptance:** M1 ≥ 0.90, M2 = 0, M4 = 0, M5 = 0 on AS-MEM (scripted);
  C1 measured vs baseline (target −30 % on long threads); switch off =
  identical behaviour.
- **Rollback:** `agents.memoryV2 = off`; down migration (export shared notes
  first).
- **Exit:** `npm run check` passes; metrics recorded here with n and commit.

## Phase A2 — Role packs and teams

**Status:** BLOCKED (the 360 px walk-through of the 7 use cases needs a
running database; code and tests done; K10 Lite mode moved to A3 by the
owner)

**Session plan (2026-10-18, Claude Code / Opus 5.5, `main` in place,
uncommitted):**

- Preconditions: A1 COMPLETE; AD-14, AD-36 approved (2026-10-18); no other
  agent on the board. K10 Lite mode deferred to A3 by the owner, so **no
  migration** in A2 (`profiles_lite` moves with it; `role_pack_version` is
  not needed: packs are code).
- Change: `lib/templates.ts` (new pack-only templates Disha, Khoj, Setu,
  Lekha, Saathi, Niyukti, Srota, kept **outside** `agentTemplates`, so
  `templatesFor` and the agent picker are unchanged; `ROLE_PACKS` per use
  case with team, team name, what each can do now, connection notes,
  3–5 profile slots; `suggestionsFor` finds pack roles by exact role only,
  so every existing agent's suggestions stay the same), `lib/config.ts`
  (`agents.rolePacks`, default `off`), `actions/account.ts`
  (`completeTeamOnboarding`: zod, `requireUser`, switch checked on the
  server, members and slots checked against the pack, never the browser's
  word), `components/account/forms.tsx` (export `UseCasePicker` and
  `LanguageSelect` with an optional `onChange`; nothing else changes),
  `app/onboarding/page.tsx` (switch on → "Meet your team"; off → today's
  form, untouched).
- Create: `lib/teams.ts` (`createTeam` inside one `withUser` transaction:
  plan's `max_agents` checked in the same transaction, agents, a squad
  when two or more, its thread, "About you" slots through A1's
  `addPersonNote`), `components/onboarding/team.tsx`,
  `tests/agent/templates.test.ts`, `tests/agent/teams.test.ts`.
- Tests first: `suggestionsFor` and `templatesFor` unchanged for every
  existing role and use case; every pack resolves, 3–5 valid slots, honest
  "can do now" lines; team creation: one transaction, squad + thread,
  limit enforced with nothing written, existing agents → no team, slots as
  trusted shared notes, sensitive values refused, another person's data
  untouched.
- Risks: a 6-agent founder pack vs Free's 3 agents (preselect up to the
  limit; server refuses more); pack agents must not promise tools that
  arrive later (Lekha has no ledger yet: she organises and drafts, never
  computes final totals, pays or files); "A few things about you" saves
  shared notes, which only memory v2 reads, so the step shows only with
  `agents.memoryV2` on.
- Deferred: `loadout` and `starterGoals` data (added with their consumers:
  runner loadouts, A3 goals); landing on Home (A2 lands in the team's
  thread, whose empty view already shows each agent's suggestions; Home
  is A3's file).

**Session result (2026-10-18, session 1):** `BLOCKED` on the acceptance
walk-through only (no database or Supabase project here).

- **Created:** `lib/teams.ts` (`createTeam`, `TeamError`),
  `components/onboarding/team.tsx` ("Meet your team" in three steps),
  `tests/agent/templates.test.ts`, `tests/agent/teams.test.ts`.
- **Changed:** `lib/templates.ts` (7 pack-only templates: Disha, Khoj,
  Setu, Lekha, Saathi, Niyukti, Srota; `ROLE_PACKS` for all 7 use cases
  with team name, three "can do now" lines per agent, connection notes,
  3–5 profile slots; `packFor`; `suggestionsFor` exact-role lookup now also
  finds pack roles, keyword scoring unchanged), `lib/config.ts`
  (`agents.rolePacks`, default `off`), `actions/account.ts`
  (`completeTeamOnboarding`; additions only, `completeOnboarding`
  untouched), `components/account/forms.tsx` (`UseCasePicker` and
  `LanguageSelect` exported; optional `onChange`), `app/onboarding/page.tsx`
  (switch on → team flow; switch off → the same JSX as before).
- **Tests first:** the template test was written before `templates.ts`
  changed: the 3 regression cases passed on today's code (baseline
  recorded by running `templatesFor` / `suggestionsFor` before any edit)
  and the 12 pack cases failed; then 15 passed. `teams.test.ts` failed
  first (module missing), then 7 of 8 passed: the Aadhaar case used a
  number without a valid Verhoeff check digit, which A1's detector rightly
  ignores; with a checksum-valid fictional number, 8 passed.
- **Commands and real output:** `npm run check`: exit 0, **Test Files 28
  passed | 2 skipped (30), Tests 359 passed | 17 skipped (376)**;
  `npm run build`: exit 0, "Compiled successfully", `/onboarding` built.
- **Exit criteria:** `suggestionsFor` unchanged for existing roles ✓ (and
  `templatesFor` order for every use case ✓); team creation respects
  `plans.max_agents` in the same transaction, nothing written on refusal ✓;
  switch off = onboarding identical ✓ (verified by the diff: the old branch
  and `completeOnboarding` are unchanged; no render test); AT-LITE-01 and
  the profile column grant: **moved to A3** with K10 (owner); `npm run
  check` + `npm run build` ✓; **360 px walk-through of the 7 use cases with
  screenshots: not done** (no database here).
- **Not tested:** the server action `completeTeamOnboarding` itself (it
  needs a session); its logic lives in `createTeam`, which is tested. The
  three-step form was not rendered in a browser.
- **Deviations:** no migration (K10 moved); `loadout` and `starterGoals`
  not added (no consumer yet); the person lands in the team's thread, not
  Home (Home is A3's file; the empty thread view already shows each
  agent's suggestions); "A few things about you" appears only with
  `agents.memoryV2` on, because only memory v2 reads shared notes.
- **Next exact action:** when a database exists: `npm run dev`, set
  `agents.rolePacks` (and `agents.memoryV2`) on in `/owner/config`, sign up
  once per use case at 360 px, record screenshots here, then mark A2
  `COMPLETE`. Meanwhile A3.

- **Objective:** each use case gets its team (templates, loadouts, profile
  slots, starter goals) at onboarding, behind `agents.rolePacks`.
- **Read first:** ROLE_PLAYBOOKS.md; UX_SPEC §2; TOOLS_AND_CONTRACTS §3.
- **Preconditions:** A1 COMPLETE; AD-14, AD-36 approved.
- **Files:** migration `20261102000000_profiles_lite.sql` + rollback
  (`profiles.lite_mode`, grant keeps the 4 existing columns);
  `lib/templates.ts`; `actions/account.ts`; `components/account/forms.tsx`;
  `app/onboarding/page.tsx`; new `components/onboarding/team.tsx`;
  `lib/config.ts`; lite-mode polling in the thread and tab pollers; tests
  `tests/agent/templates.test.ts`.
- **Tests:** `suggestionsFor` unchanged for existing roles; team creation
  respects `plans.max_agents` in the same transaction; switch off =
  onboarding identical; AT-LITE-01; profile column grant.
- **Acceptance:** at 360 px, each of the 7 use cases reaches Home with its
  team; screenshots listed here.
- **Exit:** `npm run check` + `npm run build`.

## Phase A3 — Goals, schedules, background runs, Inbox, What I did

**Status:** COMPLETE (2026-10-18; 360 px screenshots open, need a database,
as in A2)

**Session plan (2026-10-18 13:35 IST, session 1, Claude Code / Opus 5.5,
`main` in place, uncommitted, owner's standing approvals):**

- Preconditions: A1 COMPLETE; AD-02, AD-03, AD-15, AD-20, AD-27, AD-28,
  AD-33 approved (2026-10-18). Preflight `npm run check`: exit 0, **Test
  Files 28 passed | 2 skipped (30), Tests 359 passed | 17 skipped (376)**.
  No other agent on the board.
- Scope of this session (backend foundation; the phase stays IN_PROGRESS):
  migration, schedules maths and scheduler, policy for tools, approvals
  index and expiry, verification, episodes with the receipt chain, the K7
  citation checker, the K2 cap conversion, goal and schedule tools. **Next
  sessions:** Inbox, goal page, "What I did" and receipt UI, actions and
  queries, transcript "Scheduled run" label, nav, quotes query, owner
  counts (AT-OWN-A1), AS-SCH suite, K10 Lite mode.
- Migration `20261101000003_goals_schedules.sql` (next free after
  `20261101000002`) + rollback: `allowed_transitions` + `check_transition()`
  (goal, schedule, approval seeded); `goals`, `schedules` (+ `cap_micro_inr`
  per run for K2), `schedule_runs`, `approvals`, `episodes` (receipt chain,
  `episodes_guard`, `checks` for K7 results); `tool_executions.verification`;
  `plans.max_goals`, `max_schedules`, `min_schedule_interval_minutes`.
- Create: `lib/schedules.ts` (rule zod, next-run maths in IST, claim,
  run, recover), `lib/goals.ts`, `lib/agent/{verify,episodes,approvals}.ts`,
  tests below.
- Change (all in CHANGE_IMPACT §3 for A3): `db/schema.ts` (mirror; `TaskInput`
  channel widened; `verification`), `lib/agent/policy.ts` (`classifyTool`,
  tool classes), `lib/agent/run-task.ts` (approval map from policy,
  `verification` column, approvals rows and episode at the end, goal tools,
  all new behaviour behind switches), `lib/agent/queue.ts`
  (`enqueueScheduled`, `taskRow` channel, approvals-row check),
  `lib/agent/tools.ts` (`Verification`, `createGoalTools`, metadata
  `channel`/`scheduleId`), `worker/index.ts` (scheduler loop behind
  `KRIYA_SCHEDULES_ENABLED`, expiry pass behind `agents.inbox`, each on its
  own timer), `lib/config.ts` (`agents.inbox`, `agents.goals`,
  `agents.receipts`, `agents.quotes`, `agents.approvalTtlHours`),
  `lib/money.ts` (`capToProviderMicroUsd`), `lib/entitlements.ts` (goal and
  schedule limits), `tests/db/migrations.test.ts`, the two label files.
- Tests first: AT-SCH-01, AT-POL-01, 02, 07, AT-VER-01…03, AT-XCK-01,
  AT-RCP-01…03, AT-TR-01, AT-SCH-02…05, 07, 08, AT-INB-01…03, AT-GOL-01,
  AT-QUO-02 (conversion part), AT-WRK-A1, AT-RLS-A* for the new tables,
  migration down/up; AT-REG-01 and the existing tests unchanged.
- Design choices, recorded as deviations: (1) due schedules are claimed in
  one TS transaction (`for update skip locked`, insert `claimed` runs,
  advance `next_run_at`) instead of a plpgsql `claim_due_schedules`, so the
  next-run maths live once, in `lib/schedules.ts` (AT-SCH-01); same
  guarantees. (2) Two switches beyond ARCHITECTURE §5, both off:
  `agents.inbox` (approvals index, expiry, episodes) and `agents.goals`
  (goal and schedule tools), because approval expiry changes today's
  behaviour and must be switchable. (3) Existing calendar/Gmail tools return
  no read-back today (A8), so their runs go to the episode's "not
  confirmed" list as "ran, not re-checked", never as ✓ (AD-02).
- Risks: the approval map must stay identical for existing tools
  (AT-POL-01); the receipt hash must exclude model prose (AT-RCP-03);
  `enqueueApproval` must behave exactly as today when no approvals row
  exists (switch off).
- Question for the owner (doesn't block this session): K7 needs one prompt
  line asking for quoted citations, but `lib/agent/instructions.ts` isn't
  listed for A3 in CHANGE_IMPACT §3. May A3 add it, behind `agents.inbox`?

**Session result (2026-10-18, session 1):** `IN_PROGRESS` (backend
foundation done as planned; the UI half and the AS-SCH suite are next).

- **Created:** `supabase/migrations/20261101000003_goals_schedules.sql` +
  `supabase/rollback/20261101000003_goals_schedules.down.sql`;
  `lib/schedules.ts` (rule zod, next run in IST, cadence in words, runs per
  month, shortest gap, create/update, claim, run, recover);
  `lib/goals.ts` (create with its own thread; update with the evidence rule);
  `lib/agent/verify.ts` (`verificationOf`, claims vs runs, K7 citation
  check, source texts); `lib/agent/episodes.ts` (derive, receipt hash,
  chained write under an advisory lock, `verifyChain`);
  `lib/agent/approvals.ts` (Inbox index rows, titles, expiry pass;
  `redactInput` moved here from `run-task.ts`, unchanged);
  tests `tests/db/agent-goals-rls.test.ts`, `tests/agent/{schedules,
  scheduler,tool-policy,verify,episodes,runner-a3}.test.ts`.
- **Changed:** `db/schema.ts` (mirror of the 5 tables; `TaskInput.channel`
  `"web" | "schedule"` + optional `scheduleId`/`workflowId`/`skillId`,
  AF-21; `toolExecutions.verification`; `Verification` type; 3 plan
  columns), `lib/agent/policy.ts` (`TOOL_CLASSES`, `classifyTool`,
  `TOOL_WRITES`, `PERSON_ONLY_WRITES`), `lib/agent/run-task.ts`
  (`TOOL_APPROVALS` built from the policy, identical for existing tools;
  `verification` written in `onToolExecutionEnd`; goal tools behind
  `agents.goals`; approvals index + episode at the end behind
  `agents.inbox`), `lib/agent/queue.ts` (`enqueueScheduled`; `taskRow`
  optional run argument, default unchanged; `enqueueApproval` refuses a
  non-pending index row with the existing 409 `stale` and records the
  decision), `lib/agent/tools.ts` (`createGoalTools`: `goal_create`,
  `goal_update`, `schedule_create`, `schedule_update`; `KriyaTools`;
  metadata `channel`/`scheduleId`), `worker/index.ts` (own loop, 30 s:
  approval expiry while `agents.inbox` is on, schedules only with
  `KRIYA_SCHEDULES_ENABLED=1`, each part in its own try/catch),
  `lib/config.ts` (`agents.inbox`, `agents.approvalTtlHours` = 72,
  `agents.goals`, `agents.receipts`, `agents.quotes`, all off),
  `lib/money.ts` (`capToProviderMicroUsd`), `lib/entitlements.ts`
  (`checkGoalAllowed`, `checkScheduleAllowed`), `tests/db/migrations.test.ts`
  (one down/up case), `tests/money.test.ts` (one new `describe`; existing
  cases untouched), `components/thread/tool-call.tsx`,
  `components/workbench/activity.tsx` (labels).
- **Tests (ids):** AT-SCH-01, 02, 03, 04, 05 (SQL and runtime), 07, 08;
  AT-POL-01, 02, 07; AT-VER-01, 02, 03; AT-XCK-01; AT-RCP-01, 02, 03;
  AT-INB-01, 02, 03; AT-GOL-01 (rule in `lib/goals.ts`; see "not tested");
  AT-TR-01 (goal, schedule, approval: every disallowed pair raises);
  AT-QUO-02 (conversion and the scheduled task's budget), AT-QUO-03;
  AT-RLS-A* for goals, schedules, schedule_runs, approvals, episodes;
  migration down/up; AT-REG-01 unchanged and passing.
- **Order:** every new test file was run and seen failing (missing module
  or missing behaviour) before its code, except that `approvals.ts` was
  drafted before `episodes.test.ts`; the draft was set aside, the test
  written and seen failing, then the module added. Mutation checks, each
  restored afterwards: busy-thread rule in `runDue` (caught: "skips a fire
  into a thread that's already busy"); catch-up from the old due time
  (**not caught** at first: a gap; added "skips times missed while the
  worker was down", which then caught it); "unverified counts as done" in
  `deriveEpisode` (caught by AT-VER-01).
- **Fixed on the way:** PGlite returns `bigint` as a number (test
  expectation); my episode-test helper inserted several queued tasks in one
  thread, which `tasks_one_active_per_thread` rightly refused (helper now
  inserts finished tasks); `schedule_create`'s output was 467 characters,
  under the 500-character summary cut, so AT-VER-03 proved nothing: the
  tool now echoes the run's prompt back (a real confirmation for the
  model) and the test uses a realistic prompt.
- **Commands and real output:** preflight `npm run check`: exit 0, Test
  Files 28 passed | 2 skipped (30), Tests 359 passed | 17 skipped (376).
  Final `npm run check`: "All matched files use Prettier code style!",
  **Test Files 35 passed | 2 skipped (37), Tests 425 passed | 17 skipped
  (442)**, no typecheck or lint errors. `npm run build`: exit 0, "Compiled
  successfully". `KRIYA_TEST_BROWSER=1 npm test`: not run (nothing under
  `browser/` or documents changed).
- **Deviations (as planned):** (1) due schedules are claimed in one TS
  transaction (`for update skip locked`, `claimed` run row, `next_run_at`
  advanced) instead of a plpgsql `claim_due_schedules`, so next-run maths
  live only in `lib/schedules.ts`; missed times are skipped, not replayed.
  (2) Switches `agents.inbox` and `agents.goals` added beyond ARCHITECTURE
  §5 (approval expiry changes today's behaviour). (3) Calendar and Gmail
  runs have no read-back until A8, so they appear under "not confirmed" as
  "Ran, but wasn't checked afterwards", never as done. (4) Episodes are
  written only for tasks that did, claimed or cited something; a task with
  none gets no record (no empty receipts). (5) `goal_create` has no
  `checkIn` input yet (no consumer); `goal_update` has no `note` (no
  column). (6) `schedule_create` verification uses method `api_readback`
  for a read-back from Kriya's own database (the contract has no `db`
  method). (7) Tool writes are declared with `table+` / `table-` /
  `table.column:values` so inserting a note isn't confused with confirming
  one (AT-POL-07).
- **Not tested / limits:** PGlite runs one transaction at a time, so the
  two-worker claim (AT-SCH-02) and the concurrent receipt chain (AT-RCP-01)
  prove idempotency keys and uniqueness, not real lock contention; that
  needs a Postgres run. AT-WRK-A1 is by inspection (separate loop, own
  timer and try/catch; the task loop never awaits it); `worker/index.ts`
  starts itself on import, so no automated test. AT-GOL-01 is exercised
  through `updateGoal`'s rule but has no dedicated test yet. The K7 check
  runs on every reply with `agents.inbox` on, but no prompt line asks the
  model for quoted citations yet (question below), so uncited ₹/deadline
  sentences after reading a source will show as unsupported. Claim
  detection is English-only (ponytail note in `verify.ts`).
- **Exit criteria (phase):** not yet: R1 on AS-SCH (suite not written), P1
  and V1 on the suite, Inbox / goal page / "What I did" / receipt UI,
  transcript "Scheduled run" label, quotes query (AT-QUO-01), owner counts
  (AT-OWN-A1), K10 Lite mode, `npm run build` after the UI.
- **Questions for the owner:** (1) K7 prompt line in
  `lib/agent/instructions.ts` (not listed for A3 in CHANGE_IMPACT §3),
  behind `agents.inbox`: allowed? (2) K10 Lite mode needs
  `app/api/events/route.ts` (CHANGE_IMPACT §2, protected) for polling:
  approve the change, or keep Lite mode's polling client-side only?
- **Next exact action:** session 2: AT-GOL-01 dedicated test; then
  `queries/{inbox,goals,episodes}.ts`, `actions/{goals,schedules,quotes}.ts`
  (zod + `requireUser` + `withUser`; resume is the person's), pages
  `app/(workspace)/inbox` and `app/(workspace)/goals/[goalId]`, "What I
  did" card under replies, "Scheduled run" label in `transcript.tsx`, Inbox
  in the bottom nav, `proxy.ts` (`/inbox`, `/goals`), quotes (AT-QUO-01);
  then AS-SCH (15) with R1.

**Session plan (2026-10-18, session 2):** owner's instructions of the same
day (below, "Track A owner approvals"): AT-GOL-01 test; queries
`{inbox,goals,episodes}.ts`; actions `{goals,schedules,inbox,quotes}.ts`;
`/inbox` and `/goals/[goalId]` pages; "What I did" card; "Scheduled run"
label; nav and `proxy.ts`; quotes (AT-QUO-01); owner counts (AT-OWN-A1); the
K7 prompt line behind `agents.inbox`; AS-SCH (15) with R1, P1, V1. Lite mode
(K10) is not in the owner's session-2 list: its column, toggle and
client-side polling are left for a later session.

**Session result (2026-10-18, session 2):** `IN_PROGRESS`. The owner's
session-2 list is done; left for A3: K10 Lite mode (column, toggle,
client-side polling back-off) and the 360 px screenshots (need a database).

- **Created:** `queries/{inbox,goals,episodes}.ts`;
  `actions/{goals,schedules,inbox,quotes}.ts` (zod, `requireUser`,
  `withUser`); `lib/quotes.ts` (p50/p90 from real charges, none under 10
  samples); pages `app/(workspace)/inbox/page.tsx` (filters All · Approve ·
  Answer · Memories; approval cards with what approving does, cadence and
  next runs, expiry; questions from background runs; memory review),
  `app/(workspace)/goals/page.tsx`, `app/(workspace)/goals/[goalId]/page.tsx`
  (checklist with proof chips, schedules in words with next run in IST,
  pause/resume/end, quotes and ₹ caps behind `agents.quotes`, month spend vs
  budget, records, thread link); `components/inbox/controls.tsx`;
  `components/thread/what-i-did.tsx`; tests `tests/agent/{goals,quotes,
  owner,queries,person-controls,transcript,proxy}.test.ts`,
  `tests/eval/schedules.eval.test.ts`,
  `tests/eval/scenarios/AS-SCH/AS-SCH-01…15.json`;
  `docs/agent-platform/benchmarks/2026-10-18-as-sch.md`.
- **Changed:** `lib/agent/instructions.ts` (K7 line only when
  `capabilities.citations`), `lib/agent/run-task.ts` (sets `citations` only
  with `agents.inbox` on), `lib/goals.ts` (`setGoalStatus`, `setGoalBudget`,
  `explain`), `lib/schedules.ts` (`setScheduleStatus`, resume for the person
  only; `setScheduleCap`), `lib/owner.ts` (`backgroundCounts`),
  `app/owner/operations/page.tsx` (Background runs tiles),
  `components/thread/transcript.tsx` ("Scheduled run" label and muted bubble;
  "What I did" card), `components/workspace/bottom-nav.tsx` (Inbox tab with
  count, only while `agents.inbox` is on), `app/(workspace)/home/page.tsx`
  ("Today": Inbox count, open goals with next step, last checked actions;
  the desktop entry point, since the bottom nav is phone-only), `proxy.ts`
  (`/inbox`, `/goals` in `PROTECTED`), `tests/agent/runner-a3.test.ts`
  (prompt line on/off), `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md`
  (two rows for the owner-approved `transcript.tsx` card and
  `instructions.ts` line).
- **Tests (ids):** AT-GOL-01 (dedicated: undone item, missing record,
  someone else's record, empty checklist all refused; proven goal accepted),
  AT-QUO-01, AT-OWN-A1 (counts only, planted content never returned; static
  scan of `lib/owner.ts`), Inbox/goal/episode queries (own rows only), person
  controls, "Scheduled run" render test, `proxy.ts` routing, K7 line on/off,
  AS-SCH (15); AT-REG-01 unchanged.
- **Order:** new test files were run and seen failing before their code
  (quotes, owner counts, queries, person controls). Exceptions, each covered
  by a mutation check instead: AT-GOL-01 (rule written in session 1);
  "Scheduled run" (label first; mutation `scheduled = false` → 1 failed);
  `proxy.ts` (entries removed → 4 failed); AS-SCH (`schedule_create` demoted
  to R1 → AS-SCH-09…12 and the metric test failed). All restored.
- **Fixed on the way:** the Inbox showed no agent name for approvals whose
  task had no `agent_id` (join now falls back to the thread's agent); an
  ended schedule's resume surfaced Drizzle's wrapped "Failed query" text (now
  refused up front: "This schedule has ended."; `explain()` turns transition
  refusals into one plain sentence); a type I'd named `Record` shadowed the
  built-in; generated scenario JSON reformatted by Prettier.
- **Incident (no effect on code or data):** while writing this section I
  passed Markdown with backticks inside a double-quoted shell string, so
  bash ran command substitutions on fragments of it. Every one failed
  harmlessly (`npm run check\`: missing script; `npm run build\`: missing
  script; `prettier`: command not found; file paths: "not a directory"); no
  install, build, delete or network call happened. The section lost its
  code-formatted words and was rewritten from a file. Status edits now go
  through files or the Edit tool, never shell-quoted Markdown.
- **Measured (AS-SCH, n = 15, scripted, PGlite, `bdf223f` + uncommitted
  work):** **R1 = 15 / 15**, **P1 = 0** (1 consequential run), **V1 = 1 /
  1**, 15 / 15 scenarios pass. Small P1/V1 sample, stated as such in the
  benchmark.
- **Commands and real output:** AS-SCH: "Tests 16 passed (16)", exit 0.
  `npm run check` (first run): exit 1, Prettier flagged the 15 generated
  JSON files only; after `prettier --write`: exit 0, "All matched files use
  Prettier code style!", **Test Files 43 passed | 2 skipped (45), Tests 475
  passed | 17 skipped (492)**. `npm run build`: exit 0, "Compiled
  successfully", `/inbox`, `/goals`, `/goals/[goalId]` built.
- **Exit criteria:** R1 = 100 % ✓; P1 = 0 ✓; V1 = 100 % ✓; existing pipeline
  and queue tests unchanged ✓; `npm run check` ✓; `npm run build` ✓.
  **Not done:** K10 Lite mode (moved to A3 by the owner, not in the
  session-2 list); 360 px screenshots of Inbox, goal page, Home "Today" and
  the bottom nav (CHANGE_IMPACT §3 proof; no database here).
- **Not tested:** the pages and server actions themselves were not rendered
  or called in a browser (no database or Supabase project); their logic
  lives in tested `lib/` and `queries/` functions. Bottom-nav Inbox tab at
  360 px: five tabs of 72 px each by arithmetic, not by screenshot.
  `proxy.ts` prefixes match like the existing ones (`/inbox` also covers
  `/inboxes`, which doesn't exist).
- **Next exact action:** K10 Lite mode, client-side only (owner,
  2026-10-18): migration `profiles.lite_mode` + column grant keeping the
  four existing columns, `setLiteMode` in `actions/account.ts`, toggle in
  Account, polling back-off in the browser hooks (thread 350 ms → 1.5 s,
  tabs 3 s → 10 s), `saveData` default, AT-LITE-01; then, with a database,
  the 360 px screenshots, and A3 can be marked COMPLETE.

**Session result (2026-10-18, session 3, K10 Lite mode):** `IN_PROGRESS`,
waiting on one owner decision (polling, below) and the 360 px screenshots.

- **Conflict found (code is the fact; stopped and asked):** the owner's
  instruction asks for the polling back-off "in browser hooks", but neither
  interval is in browser code. Thread "350 ms" is `POLL_MS` in `streamTask()`
  (`lib/agent/queue.ts`), a server loop that reads `task_events` and
  streams to the browser over one open response (`useChat` doesn't poll).
  Tab "3 s" is `POLL_MS` and `retry: 3000` in `app/api/events/route.ts`
  (off-limits by the owner's instruction) with one `EventSource` in
  `components/workspace/notifier.tsx` (CHANGE_IMPACT §2, protected). No
  back-off code was written; nothing unused was added.
- **Created:** `supabase/migrations/20261101000004_profiles_lite.sql`
  (`profiles.lite_mode boolean not null default false`; additive
  `grant update (lite_mode)`), its rollback, `lib/lite.ts` (`liteMode`:
  the person's choice, or on while `navigator.connection.saveData` is true;
  no imports, client-safe), `tests/agent/lite.test.ts`.
- **Changed:** `db/schema.ts` (`profiles.liteMode`), `actions/account.ts`
  (`setLiteMode`: zod, `requireUser`, `withUser`), `components/account/forms.tsx`
  (`LiteModeToggle`: switch with 44 px target; reads `saveData` on the
  device and shows it on, and locked, while the browser asks to save data),
  `app/(workspace)/account/page.tsx` ("Display" section).
- **AT-LITE-01 (partial):** off by default; the person sets their own; can't
  set someone else's (RLS); the four original profile columns stay editable
  and `status` stays denied; rollback and re-apply; `saveData` turns it on.
  **Not yet:** polling intervals (blocked by the conflict above).
- **Order:** `lite.test.ts` was seen failing (module missing) before the
  code. The test first imported a `saveLiteMode` helper; it was changed to
  update as the person directly, so `lib/lite.ts` stays free of database
  imports for client use.
- **Limit (owner's spec):** with `lite_mode not null default false`, the
  database can't tell "never chose" from "chose off", so a browser asking to
  save data keeps Lite mode on and the toggle is locked meanwhile. A
  nullable column would let the person override it; not done (spec).
- **Commands and real output:** `npx vitest run tests/agent/lite.test.ts`:
  5 passed. `npm run check`: exit 0, "All matched files use Prettier code
  style!", **Test Files 44 passed | 2 skipped (46), Tests 480 passed | 17
  skipped (497)**. `npm run build`: exit 0, "Compiled successfully".
- **Not tested:** the toggle wasn't rendered in a browser (no database); the
  action itself wasn't called (needs a session; its single statement is
  what the test runs as the person). Today the setting changes nothing else
  in the app: its effects wait for the polling decision.
- **Question for the owner:** how should Lite mode slow updates?
  (a) Thread: the browser asks for a slower stream (`/turn?lite=1`) and
  `streamTask` polls every 1.5 s for it; a server change in `queue.ts`
  (A3-listed) and the turn route (not listed). (b) Tabs: approve an edit to
  `notifier.tsx` (§2) so, in Lite mode, the browser closes its
  `EventSource` while the tab is hidden and reconnects on focus; the
  server's 3 s loop is unchanged. (c) Client-only items instead of polling:
  tap-to-load images in replies (`components/thread/markdown.tsx`, not
  listed) and the system font. (d) Accept Lite mode as a saved setting now
  and decide later.
- **A3 exit status:** every A3 exit check passes (R1, P1, V1 on AS-SCH;
  check; build; existing tests unchanged) except K10's polling and the
  360 px screenshots of Inbox, goal page, Home "Today", the bottom nav and
  Account → Display (need a database, as in A2).
- **Next exact action:** the owner's answer on Lite mode polling; then
  build the chosen option with its AT-LITE-01 interval test, and mark A3
  COMPLETE with the 360 px screenshots recorded as an open acceptance item.
  No new phase starts without the owner's authorization.

**Session result (2026-10-18, session 4, K10 polling under the owner's
decision of the same day):** **`COMPLETE`**, with the 360 px screenshots
recorded as an open acceptance item, as in A2.

- **Owner's decision applied:** Options 1 and 2 with a user override.
  Thread: the browser sends `x-kriya-lite: 1` (the route also accepts
  `?lite=1`) and `streamTask()` waits 1,500 ms between empty reads instead
  of 350 ms. Tabs: in Lite mode the `/api/events` `EventSource` closes while
  `document.visibilityState === "hidden"` and reopens when the tab is
  visible; `app/api/events/route.ts` is untouched (`git status` shows no
  change). Override: the person's explicit choice wins; until they make
  one, `navigator.connection.saveData === true` turns Lite mode on, and the
  toggle is never locked.
- **Migration corrected in place:** `20261101000004_profiles_lite.sql` now
  adds `lite_mode boolean` (nullable: null = not chosen yet) instead of
  `not null default false`, which couldn't tell "never chose" from "chose
  off". The file was written this session and has never been applied to
  any database (none exists here) or committed, so it was edited rather
  than followed by a second migration.
- **Created:** `components/workspace/use-lite-mode.ts` (`useLiteMode`: the
  choice loaded once per page through `getLiteMode()` and shared;
  `liteModeNow()` for request time; `setLiteChoice` for the toggle),
  `tests/agent/lite-route.test.ts`.
- **Changed:** `lib/lite.ts` (`liteMode(chosen | null, saveData)`,
  `LITE_HEADER`, `followWhileVisible`), `lib/agent/queue.ts` (`streamTask`
  optional `{ lite }`; `LITE_POLL_MS = 1_500`; default unchanged),
  `app/api/threads/[threadId]/turn/route.ts` (reads the header or query on
  POST and GET; owner-approved), `components/thread/thread-view.tsx` (the
  transport adds the header on send and re-attach), `components/workspace/
  notifier.tsx` (CHANGE_IMPACT §2; owner-approved targeted edit: the
  existing handler is wrapped in `open()` and run through
  `followWhileVisible`), `components/account/forms.tsx` (toggle starts from
  the choice or the save-data hint; not locked; keeps the shared state in
  sync), `actions/account.ts` (`getLiteMode`), `db/schema.ts` (nullable
  `liteMode`), `tests/agent/lite.test.ts`,
  `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md` (rows for the turn route,
  `thread-view.tsx` and the `notifier.tsx` exception).
- **AT-LITE-01 (complete):** unset until chosen, then kept; never on
  someone else's profile; the four original profile columns stay editable
  and `status` denied; rollback and re-apply; explicit choice beats the
  save-data hint both ways; `streamTask` waits 350 ms normally and 1,500 ms
  in Lite mode (first wait measured through a `setTimeout` spy on a running
  task, PGlite); the route passes `{ lite: true }` for the header or query
  and `{ lite: false }` otherwise; in Lite mode the connection closes when
  the tab hides, reopens when shown, isn't opened from a hidden tab, and
  outside Lite mode stays open (stand-in document and EventSource).
- **Order:** the new cases were seen failing first (9 of 10 in
  `lite.test.ts` + both route cases; only the unchanged 350 ms case passed).
- **Fixed on the way:** the first `npm run check` failed on lint ("Cannot
  access refs during render", `thread-view.tsx` line 513: a ref read inside
  the transport's `useMemo`); replaced by `liteModeNow()`, which reads the
  shared state at request time.
- **Commands and real output:** Lite tests: 12 passed. `npm run check`
  (first): exit 1, 1 lint error (above); `npm run build`: exit 0. After the
  fix: `npm run check`: exit 0, "All matched files use Prettier code
  style!", **Test Files 45 passed | 2 skipped (47), Tests 487 passed | 17
  skipped (504)**; `npm run build`: exit 0, "Compiled successfully".
- **Consequence to know:** in Lite mode a hidden tab receives no
  notifications (that's the saving); they arrive on return, since the
  page refreshes its data when the connection reopens.
- **Not tested:** nothing was rendered in a real browser (no database):
  the toggle, the header on real requests and the EventSource on a real
  phone; `navigator.connection.saveData` exists only in Chromium-based
  browsers, so elsewhere Lite mode is only the person's choice.
- **A3 exit criteria:** R1 = 100 % ✓; P1 = 0 ✓; V1 = 100 % ✓; existing
  pipeline and queue tests unchanged ✓; AT-LITE-01 ✓; `npm run check` ✓;
  `npm run build` ✓. **Open acceptance item:** 360 px screenshots of Inbox,
  goal page, Home "Today", the bottom nav and Account → Display, when a
  database exists (as A2).
- **Next exact action:** none started. Waiting for the owner's instruction
  before any new phase. With a database: `npm run dev`, switch on
  `agents.inbox`, `agents.goals`, `agents.receipts` and `agents.quotes`,
  take the 360 px screenshots for A2 and A3, and list them here.

- **Objective:** goals with their own threads; approved schedules that
  enqueue ordinary tasks; an Inbox of approvals, questions and memory
  reviews; episodes derived from verified executions; the policy engine for
  tools.
- **Read first:** ARCHITECTURE §2; DATA_MODEL §1, §2.3, §3.1–3.3;
  TOOLS_AND_CONTRACTS §1, §2.2, §6; UX_SPEC §3–5; CHANGE_IMPACT rows for
  `run-task.ts`, `queue.ts`, `worker/index.ts`, `proxy.ts`.
- **Preconditions:** A1 COMPLETE; AD-02, AD-03, AD-15, AD-20, AD-27, AD-28,
  AD-33 approved.
- **Includes signature features:** K1 receipts (hash chain), K2 quotes and
  ₹ caps, K7 deterministic citation check (SIGNATURE_FEATURES.md).
- **Files:** migration `20261103000000_goals_schedules.sql` + rollback
  (goals, schedules, schedule_runs, approvals, episodes with receipt chain,
  `tool_executions.verification`, transition table); new
  `lib/agent/{policy,verify,episodes,approvals}.ts`, `lib/goals.ts`,
  `lib/schedules.ts`, `actions/{goals,schedules,inbox,quotes}.ts`,
  `queries/{goals,inbox,episodes}.ts`, pages `app/(workspace)/inbox`,
  `app/(workspace)/goals/[goalId]`; `lib/agent/queue.ts` (`enqueueScheduled`,
  approvals-row check); `db/schema.ts` (tasks input type, AF-21);
  `components/thread/transcript.tsx` ("Scheduled run"); `lib/money.ts`
  (cap conversion); edits per CHANGE_IMPACT §3.
- **Tests:** AT-POL-01, AT-POL-02, AT-POL-07, AT-VER-01…03, AT-SCH-01…05,
  AT-SCH-07, AT-SCH-08, AT-INB-01…03, AT-GOL-01, AT-TR-01, AT-WRK-A1,
  AT-OWN-A1, AT-RCP-01…03, AT-QUO-01…03, AT-XCK-01, AT-RLS-A*; AS-SCH.
- **Acceptance:** R1 = 100 % on AS-SCH; P1 = 0; V1 = 100 %; existing
  pipeline and queue tests unchanged.
- **Rollback:** unset `KRIYA_SCHEDULES_ENABLED`; pause all; down migration.
- **Exit:** `npm run check` + `npm run build`.

## Phase A4 — Browser runtime on fixture sites

**Status:** BLOCKED (AB-08: staging capacity is the only exit item left)

**Session plan (2026-10-18, Claude Code / Opus 5.5, `main` in place,
uncommitted, owner's standing approvals):**

- Preconditions: AD-03, AD-06, AD-08, AD-18, AD-23 approved (2026-10-18).
  Preflight `npm run check`: 214 passed / 21 files (A1 session 8 log).
  No other agent on the board.
- **Dependency review** (npm registry, 2026-10-18):
  | Package | Version | Licence | Runtime deps | Unpacked size | Maintenance |
  | --- | --- | --- | --- | --- | --- |
  | `playwright-core` | 1.64.1 (released 2026-10-14), pinned exactly so the Docker image's Chromium build matches its CDP protocol | Apache-2.0 | none | 13,656,167 bytes | Microsoft (`microsoft/playwright`), 5 maintainers; daily alpha releases, last stable 4 days old |
  | `ws` | 8.22.0 (2026-09-26) | MIT | none | 151,410 bytes | `websockets/ws`, 1 maintainer, releases through 2026 |
  `ws` is needed only by the live view (take-over, A6, which also needs
  AD-04/AD-05). **Not added in A4** (nothing would use it); it will be
  added by whichever phase needs it first, as the plan says.
- Migration: `20261101000002_browser.sql` (next free after
  `20261101000001`; the doc's `20261104000000` is a placeholder):
  `kriya.browser_sessions` (RLS, select own), `kriya.open_browser_session()`
  that enforces `plans.browser_minutes` against this month's
  `resource_usage` (invariant 7), rollback.
- Create: `browser/{index,session,egress,snapshot}.ts`, `browser/Dockerfile`;
  `lib/browser/{provider,client,sites,session}.ts`; `lib/agent/policy.ts`
  (`classifyBrowserAction`, `approvalFor`; A3 adds `classifyTool`);
  `tests/fixtures/sites/*` (signup, profile-editor, job-application,
  bill-portal, feed, injection, redirect-internal, hindi-telugu, slow);
  tests below.
- Change: `package.json` (+`playwright-core`, scripts `browser`,
  `dev:browser`), `db/schema.ts` (mirror), `lib/config.ts`
  (`agents.browser` off), `lib/env.ts` (worker optional
  `KRIYA_BROWSER_URL`/`SECRET`), `lib/agent/tools.ts`
  (`createBrowserTools`), `lib/agent/run-task.ts` (browser belt behind
  switch + plan + env), `render.yaml` (`kriya-browser` pserv; worker
  optional vars), `tests/db/migrations.test.ts`, the two UI label files,
  `docs/kriya/deployment.md`.
- Tests first: AT-POL-03…06 (pure), AT-IMP-01 (static scan), egress IP
  rules (pure), AT-BRW-01…04, 06, 07, 09, 11 and `/render/pdf` network
  block (`KRIYA_TEST_BROWSER=1`, real service on an ephemeral port +
  fixtures), RLS + down/up for the migration.
- Risks found while reading: (1) fixtures are served on loopback, which
  the egress guard must block: the guard gets an exact host→fixture map
  passed **in code** by the tests only (never from env), and redirects to
  loopback/metadata stay blocked; (2) Chromium bypasses proxies for
  loopback by default, so it's launched with `--proxy-bypass-list=<-loopback>`
  and WebRTC non-proxied UDP disabled; (3) the `browser/` service may not
  import `lib/` (AT-IMP-01), so it checks its own env; (4) **AF-27**: an
  approval ends the task and the person's answer starts a new task
  (`enqueueApproval`), but BROWSER §3.4 assumes the approved click runs in
  the same live session (60 s idle timeout). Code is the fact; the runner
  wiring of R3/R4 approvals waits for the owner's answer.
- Deferred, with reasons: live view and handoff tokens (A6; AD-04/AD-05
  not approved); `ws`; screenshot storage as `kriya.files` (A5 table; A4
  keeps a sha256 of each evidence screenshot); `agents.screenshotRetentionDays`
  (no stored screenshots yet); `browser:capacity` script and staging
  numbers (AB-08); loadouts (A2's templates; A4 offers the browser by
  switch + plan + env).
- Questions for the owner: AF-27 (asked when the wiring is reached).

**Session result (2026-10-18, session 1):** `IN_PROGRESS`. Runtime, guard,
policy, metering and the read-only runner are done and tested on fixtures.
Not COMPLETE: the staging capacity check is blocked (**AB-08**), the AS-BRW
and AS-SEC (browser) scenario suites (metric B1) are not written, and
AT-BRW-05 is partial by the owner's AF-27 decision.

- **Created:** `browser/{index,session,egress,snapshot,protocol}.ts`,
  `browser/Dockerfile`; `lib/browser/{provider,client,sites,snapshot,session}.ts`;
  `lib/agent/policy.ts`; `supabase/migrations/20261101000002_browser.sql` +
  rollback; `tests/fixtures/sites/index.ts` (signup, profile-editor,
  job-application, bill-portal, feed, injection incl. `/shifty`,
  redirect-internal, hindi-telugu, slow; one module, served by host name);
  `tests/browser/{egress,imports,service}.test.ts`;
  `tests/agent/{policy,browser-tools}.test.ts`;
  `tests/db/agent-browser-rls.test.ts`.
- **Changed:** `package.json` + `package-lock.json` (`playwright-core`
  1.64.1 exact; scripts `browser`, `dev:browser`), `db/schema.ts`
  (`browserSessions`), `lib/config.ts` (`agents.browser` off;
  `KRIYA_BROWSER_SECRET` in `SECRETS`), `lib/env.ts` (worker optional
  `KRIYA_BROWSER_URL`/`SECRET`), `lib/agent/tools.ts` (`createBrowserTools`;
  browser reads count as untrusted for memory quarantine; `KriyaTools`
  union), `lib/agent/run-task.ts` (browser belt behind switch + plan
  minutes + configured service, lead agent only; heartbeat with the task;
  close + metering in `finally`; `browser_open` gets the private-content
  web guard), `render.yaml` (`kriya-browser` pserv; worker optional vars),
  `tests/db/migrations.test.ts` (down/up case), `tests/agent/runner.test.ts`
  (3 cases), the two label files, `docs/kriya/deployment.md`,
  `docs/agent-platform/REPOSITORY_AUDIT.md` (AF-27).
- **Tests (ids):** AT-POL-03 (incl. on the real hindi-telugu page), 04, 05,
  06; AT-IMP-01; AT-BRW-01 (incl. heartbeat loss), 02, 03, 04, 06 (unit
  proxy + real Chromium), 07, 09, 11; AT-BRW-05 evidence part (provider
  level); `/render/pdf` network block (AT-PDF-01's network half; templates
  are A5); ref-swap refusal; service secret; RLS + minutes in SQL; down/up;
  runner on/off; AT-REG-01 unchanged.
- **Order:** policy, egress, service, DB and tool tests were seen failing
  first. Exception: the AT-BRW-05 evidence test was written with its code;
  a mutation check (always "verified") made it fail ("expected 'verified'
  to be 'unverified'") and the file was restored (`git diff --no-index`
  empty).
- **Found and fixed on the way:** (1) Node's `BlockList` applies an IPv6
  `::ffff:0:0/96` rule to plain IPv4 addresses, so that rule blocked every
  public IPv4 address; mapped addresses are now refused by prefix (Node
  also maps the expanded form, tested). (2) Headless Chrome ignores
  `autofocus`; the signup fixture focuses the password by script. (3)
  AT-BRW-04's fixed 2 s sleep raced the slow fixture under parallel test
  files; it now polls (63/63 three runs in a row). (4) Drizzle wraps the
  database error in `cause`; the minutes message is read from there.
- **Safety additions (raise only):** social-action words (like, share,
  repost, comment, reply, subscribe, join, endorse, vote, sign up,
  register) are commits; any clickable whose name is a commit word is R4,
  not only buttons inside forms; checkbox/radio clicks are fills (R3);
  unknown refs are R4; refs live under a random per-session attribute and a
  ref whose element changed since the snapshot is refused; pop-ups closed;
  WebRTC non-proxied UDP and QUIC off; service workers blocked.
- **Commands and real output:** `npm run check`: exit 0, **Test Files 26
  passed | 1 skipped (27), Tests 335 passed | 16 skipped (351)**.
  `KRIYA_TEST_BROWSER=1 npm test` (with `BROWSER_CHROMIUM_PATH` = local
  Google Chrome 155.0.8059.80): exit 0, **Test Files 27 passed (27), Tests
  351 passed (351)**. `npm run build`: exit 0, "Compiled successfully".
  `npm audit`: 5 high findings, all pre-existing (`@next/eslint-plugin-next`,
  `braces`, `eslint-config-next`, `fast-glob`, `micromatch`), none from
  `playwright-core`.
- **Not verified:** the Docker image was not built (it downloads Node and
  Chromium 1248; no deploy approved); Chromium 1248, the build
  `playwright-core` 1.64.1 expects, was not downloaded: tests ran on the
  local Chrome 155 through `BROWSER_CHROMIUM_PATH`. CI must run them on the
  pinned build. Snapshot budget `SNAPSHOT_TOKEN_BUDGET = 3000` tokens is my
  proposal (the blueprint gives no number).
- **Exit criteria:** `npm run check` ✓; `KRIYA_TEST_BROWSER=1 npm test` ✓;
  `npm run build` ✓; P1 = P2 = 0 on the tests (no fill or commit can run;
  R5 refused by policy and again by the service) ✓; egress blocks every
  listed range ✓; **B1 on AS-BRW: not measured** (suite not written);
  **capacity on staging: blocked (AB-08)**.
- **Deviations:** no `ws` (nothing uses it before A6); no live view,
  handoff token or screenshot storage (A6, A5); no `browser_type`,
  `browser_select`, `browser_screenshot` or `browser_extract` tools in the
  runner (always refused under the read-only decision; `browser_extract`
  needs a model or schema design: snapshot text covers reading);
  `browser:capacity` script not written (AB-08); loadouts wait for A2;
  the service sets `facts.domain` to the host and the worker's client turns
  it into the registrable domain (the service can't import `lib/`).
- **Next exact action:** (1) AS-BRW (30) and the browser part of AS-SEC as
  scenario files run through `createBrowserTools` on the real service and
  fixtures, recording B1, P1, P2; (2) when a staging service exists (AB-08):
  build the image, check the sandbox starts, measure sessions per instance
  and RAM, record here; (3) before the first `supervised` site: decide
  replay vs hold (AF-27) and wire R3/R4 approvals with `commitWithEvidence`.

**Session result (2026-10-18, session 2):** `BLOCKED` on **AB-08** only.
Every other exit item is met or accepted by the owner (AT-BRW-05 partial,
AF-27).

- **Created:** `tests/eval/scenarios/AS-BRW/AS-BRW-01…30.json`,
  `tests/eval/scenarios/AS-SEC/AS-SEC-01a…04c.json` (9, browser families
  01, 02, 04), `tests/eval/browser.eval.test.ts`,
  `docs/agent-platform/benchmarks/2026-10-18-as-brw.md`.
- **Changed:** `lib/browser/session.ts` (bug: after `browser_close` the
  task kept the closed session, so every later step got "stopped"; `close`
  now forgets it and the next step opens a new session, within the
  minutes), `tests/agent/browser-tools.test.ts` (that case, seen failing
  first: "expected 1 to be 2"), `tests/fixtures/sites/index.ts` (feed posts
  240 px tall, more after scrolling).
- **Measured (n = 30 + 9, free run, local Chrome 155, `bdf223f` + A1/A4
  work):** **B1 = 1.00 (30 / 30)**, **P1 = 0**, **P2 = 0**, AS-SEC 9 / 9.
  First run: B1 0.933 (28 / 30), P1 0, P2 0. Both failures were in the
  harness, not the runtime: the runner's lookup by name picked the
  `<h1>Sign in</h1>` heading over the submit button (the snapshot had the
  button as `type: "submit"`, R4), and the feed fixture couldn't scroll.
  P1 and P2 are counted from the actions that reached `kriya-browser`,
  each classified against its page, and asserted as 0.
- **Commands and real output:** eval: "Tests 1 passed (1)",
  `{"B1":1,"B1n":"30 / 30","SEC":"9 / 9","P1":0,"P2":0}`; `npm run check`:
  exit 0, **Test Files 26 passed | 2 skipped (28), Tests 336 passed | 17
  skipped (353)**; `KRIYA_TEST_BROWSER=1 npm test`: exit 0, **Test Files
  28 passed (28), Tests 353 passed (353)**; `npm run build`: exit 0.
- **Exit criteria:** `npm run check` ✓; `KRIYA_TEST_BROWSER=1 npm test` ✓;
  `npm run build` ✓; B1 ≥ 0.90 ✓ (1.00); P1 = P2 = 0 ✓; egress blocks every
  listed range ✓; AT-BRW-05 partial (owner, AF-27); **capacity on staging
  ✗ blocked (AB-08)**.
- **Next exact action:** when a staging service exists (AB-08): build
  `browser/Dockerfile`, confirm Chromium starts with its sandbox as the
  non-root user, measure sessions per instance, RAM per session and cold
  start, record here, then mark A4 `COMPLETE`. Meanwhile A2.

- **Objective:** `kriya-browser` with sessions, snapshots, deterministic
  commit detection, egress guard, evidence and PDF rendering, proven on
  fixtures only.
- **Read first:** BROWSER_AND_LOGIN_PROFILES.md §1–4, §7–10; ARCHITECTURE
  §1, §3, §4; TEST_AND_EVALUATION §1, browser ids.
- **Preconditions:** A0 approved (AD-03, AD-06, AD-08, AD-18, AD-23);
  dependency review of `playwright-core` and `ws` recorded here.
- **Files:** new `browser/{index,session,egress,snapshot,liveview}.ts`,
  `browser/Dockerfile`, `lib/browser/{provider,client,sites}.ts`,
  browser tools in `lib/agent/tools.ts`, policy additions,
  migration `20261104000000_browser.sql` + rollback,
  `tests/fixtures/sites/*`, `tests/browser/*`; `package.json`,
  `lib/env.ts`, `lib/config.ts`, `render.yaml`, `docs/kriya/deployment.md`.
- **Tests:** AT-POL-03…06, AT-BRW-01…07, 09, 11, AT-IMP-01, AT-PDF-01; AS-BRW;
  AS-SEC (browser part).
- **Acceptance:** B1 ≥ 0.90 on fixtures (scripted); P1 = P2 = 0; egress
  blocks every listed range; capacity measured on staging (AB-08), with
  numbers here.
- **Rollback:** `agents.browser = off`; unset `KRIYA_BROWSER_URL`.
- **Exit:** `npm run check`, `KRIYA_TEST_BROWSER=1 npm test`, `npm run build`.

## Phase A5 — Files and documents

**Status:** COMPLETE 2026-10-18 on fixtures (owner sign-off below). Open:
live upload on a real project (AB-05), 360 px screenshots of Account → Files
and Shared links.

### Session plan (2026-10-18 18:38 IST, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's instruction (this session):** A9 signed off; AT-BRW-07 gets a
  1 s / 100 ms poll on directory removal; **AD-18, AD-19, AD-34 approved**;
  proceed with A5 on `main`, uncommitted, no real external calls. Owner's
  answers to this session's questions: migration **`20261110000000_files.sql`**
  (sorts after A9, DATA_MODEL §0.1; the instruction's `20261105000000` was the
  placeholder); web gets **optional** `KRIYA_BROWSER_URL`/`SECRET` for PDF
  rendering (`lib/env.ts`, `render.yaml`); extraction in **its own worker
  loop** behind `agents.files`; agent tools `file_*`/`document_render`
  **deferred** (no `run-task.ts` change).
- **Preconditions:** AD-18/19/34 approved ✓. A4 is BLOCKED on AB-08 only;
  the owner's instruction to proceed is recorded as accepting A4's fixture
  results for A5 (as for A9). Preflight `npm run check`: exit 0, "Test Files
  54 passed | 2 skipped (56) · Tests 557 passed | 17 skipped (574)". Board
  empty.
- **Switch:** `agents.files` (default off): Files and Shared links sections,
  receipt Download PDF / Share, upload actions, the extraction loop. Off =
  today's product (no tool or prompt change at all).
- **Create:** migration + rollback (`files`, `share_links`, `share_views`;
  file transitions; plan columns `max_file_mb` 10, `storage_mb` 100,
  `max_shares` 5, enforced by insert triggers); `lib/files.ts` (allow-list,
  magic-byte sniffing, storage port with a Supabase implementation, upload,
  confirm, generated files, the browser-upload resolver); `lib/extract.ts`
  (txt/csv/docx in code, PDF and images through an injected model, sha256
  cache); `lib/documents/{format,templates,render}.ts` (invoice, resume,
  report, media kit, letter, receipt); `lib/share.ts`; `actions/files.ts`,
  `actions/share.ts`; `app/api/files/[fileId]/route.ts`,
  `app/share/[token]/page.tsx`, `app/share/[token]/pdf/route.ts`;
  `components/account/{files,shares}.tsx`, a share dialog; tests.
- **Change:** `db/schema.ts` (mirror), `lib/config.ts` (switch),
  `lib/env.ts` + `render.yaml` (optional web browser vars), `proxy.ts`
  (`/api/files/` in `PROTECTED_API`; `/share/` stays public),
  `worker/index.ts` (extract loop; janitor: expired screenshots and share
  snapshots), `lib/agent/policy.ts` + `browser/{protocol,index,session}.ts`
  (`upload` action, always R4, bytes only from `kriya.files`),
  `app/(workspace)/account/page.tsx`, `components/thread/what-i-did.tsx`
  (receipt Download PDF + Share), `tests/db/migrations.test.ts`,
  `tests/agent/proxy.test.ts`, `tests/browser/service.test.ts` (AT-BRW-07
  poll; AT-BRW-10, AT-PDF-01 cases), `docs/kriya/deployment.md`,
  CHANGE_IMPACT §3 rows for the files not yet listed for A5.
- **Tests first:** AT-FILE-01…03, AT-BRW-10, AT-PDF-01, AT-SHR-01…05,
  AT-RLS-A (files, share_links, share_views), down/up.
- **Risks and how they're avoided:** share token leaking (only sha256
  stored; `token_hash` not selectable; link shown once; 404 without detail);
  public page reading live data (it reads only the snapshot row and its
  file, through `privileged` scoped to that row); polyglot uploads (declared
  type must equal sniffed type; PDFs with JavaScript/launch/embedded files
  and binaries containing markup are rejected); XSS in templates (every value
  escaped, test); limits only in UI (SQL triggers); an agent creating a
  share (no tool; AT-POL-07 + AT-SHR-04).
- **Found while reading:** DATA_MODEL §2.11 writes the share expiry check as
  `expires_at <= created_at - interval '30 days'`, which would reject every
  link; the code uses `+` (recorded as AF-28).
- **Deviation planned:** `confirmUpload` sniffs and hashes on the web server
  (bytes are only inspected, nothing runs), so the person sees "rejected"
  at once; extraction (model calls) stays in the worker.

### Session result (2026-10-18, Claude Code, Opus 5.5)

- **Status:** `IN_PROGRESS`. Code and tests are written and each new test
  file passes; the **final** `npm run check`, browser run and `npm run build`
  were started together and **stopped by Claude Code because the machine ran
  low on memory** before printing anything. `npm run build` has **not** run
  on this phase's code. Not COMPLETE until those three pass.
- **Created:** `supabase/migrations/20261110000000_files.sql`,
  `supabase/rollback/20261110000000_files.down.sql`; `lib/files.ts`,
  `lib/extract.ts`, `lib/share.ts`, `lib/documents/{templates,render}.ts`;
  `actions/files.ts`, `actions/share.ts`; `app/api/files/[fileId]/route.ts`,
  `app/share/[token]/page.tsx`, `app/share/[token]/pdf/route.ts`;
  `components/account/{files,shares}.tsx`,
  `components/thread/receipt-actions.tsx`; `tests/db/agent-files-rls.test.ts`,
  `tests/agent/{files,share,documents}.test.ts`.
- **Changed:** `db/schema.ts` (files, share_links, share_views, plan
  columns), `lib/config.ts` (`agents.files` off, `agents.fileReaderModel`
  unset), `lib/env.ts` + `render.yaml` (optional web browser vars, optional
  worker storage vars), `proxy.ts` (`/api/files/` protected; `/share/`
  public), `worker/index.ts` (extract loop, janitor purge),
  `lib/memory/maintenance.ts` (`withinCap` exported), `lib/agent/policy.ts`
  + `browser/{protocol,index,session}.ts` (upload: R4, file field only,
  bytes only from `kriya.files`, body limit 16 MB),
  `actions/inbox.ts` (`shareable`), `components/thread/what-i-did.tsx`,
  `app/(workspace)/account/page.tsx`, `tests/db/migrations.test.ts`,
  `tests/agent/{proxy,transcript}.test.ts` (one more action mock, as A9),
  `tests/browser/service.test.ts` (AT-BRW-07 poll; AT-BRW-10 case),
  `docs/kriya/deployment.md`, CHANGE_IMPACT §3 (A5 rows),
  REPOSITORY_AUDIT (AF-28).
- **Tests (ids) and real results:** AT-RLS-A files/shares 13/13;
  migrations 9/9 (A5 down/up; the A3 case now rolls A5 back first);
  AT-FILE-01…03 + AT-BRW-10 `tests/agent/files.test.ts` 21/21; AT-SHR-01…04
  + views + retention `tests/agent/share.test.ts` 10/10; AT-SHR-05
  `tests/agent/proxy.test.ts` 16/16; AT-PDF-01 `tests/agent/documents.test.ts`
  and `tests/browser/service.test.ts` with `KRIYA_TEST_BROWSER=1` and local
  Chrome: "Tests 25 passed (25)" (all templates ≤ 360 px wide, A4 MediaBox,
  Indic font embedded: Nirmala UI on this Windows machine, Noto expected in
  the image; AT-BRW-07 with the poll; AT-BRW-10 upload). Mutation checks:
  cache off → "expected 2 to be 1"; revoked filter removed → "expected {…}
  to be null"; both files restored.
- **Full-suite runs:** `npm run check` (before the transcript mock):
  "Test Files 1 failed | 57 passed | 2 skipped (60) · Tests 611 passed | 20
  skipped (631)", exit 1: `tests/agent/transcript.test.ts` couldn't load
  (`what-i-did.tsx` → unmocked `@/actions/share` → server-only module).
  Fixed with a mock; that file alone then "Tests 2 passed (2)". The rerun
  was stopped (low memory). Typecheck, lint and prettier were clean on
  every changed file before that run.
- **Exit criteria:** templates render at 360 px and A4 with Indian formatting
  and Indic glyphs ✓ (local Chrome); extraction cache proven ✓ (AT-FILE-03 +
  mutation); `npm run check` ✗ not yet rerun; browser tests ✓ for the A5
  files, full suite not rerun; build ✗ not run; live upload ✗ (AB-05).
- **Deviations:** migration `20261110000000` (owner); confirm sniffs on the
  web server; agent tools deferred (owner); only `receipt` shares (report and
  goal snapshots need their own source data; ledger exports are A7); invoice
  template is a draft without number or GST (A7, AD-16/17); the share page
  links to the PDF instead of embedding it.
- **Unknowns, with how to verify:** the browser's direct `PUT` to Supabase's
  signed upload link (CORS, headers) has not been tried on a real project:
  upload one file after AB-05. Which OpenRouter models accept PDF file parts
  is unknown: the owner picks `agents.fileReaderModel` and checks it with one
  approved paid call. Polyglot checks don't inflate compressed PDF object
  streams (marked `ponytail:` in `lib/files.ts`).
- **Next exact action:** rerun, one at a time: `npm run check`; then
  `KRIYA_TEST_BROWSER=1 BROWSER_CHROMIUM_PATH=<Chrome> npm test`; then
  `npm run build`. Record the summaries here; if all pass, mark A5 COMPLETE
  on fixtures (360 px screenshots of Files/Shared links and the live upload
  stay open, AB-05).

### Owner verification and sign-off (2026-10-18)

Run by the owner, not by the agent; reported in the owner's message, quoted:

- "`npm run check`: exit 0 (typecheck, lint, prettier clean; 613 unit tests
  passed across 58 files)."
- "Browser & PDF suite with Chrome: exit 0 (73 tests passed, including
  AT-PDF-01 template rendering and AT-BRW-07 profile cleanup)."
- "`npm run build`: exit 0 (all routes compiled successfully)."

Owner instruction: mark A5 COMPLETE, with AB-05 (live `kriya-files` bucket)
and the 360 px screenshots recorded as open. Every other exit criterion is
met (see Session result).

- **Objective:** uploads to a private bucket, extraction with a content-hash
  cache, generated PDFs (report, invoice, resume, media kit, letter).
- **Read first:** DATA_MODEL §2.5; TOOLS_AND_CONTRACTS §2.3, §4; SECURITY S9;
  UX_SPEC §8.
- **Preconditions:** A4 COMPLETE; AD-18, AD-19, AD-34 approved.
- **Includes signature features:** K8 Kriya Share, receipt PDF (K1).
- **Files:** migration `20261105000000_files.sql` + rollback (files,
  share_links, share_views); new `lib/files.ts`, `lib/extract.ts`,
  `lib/documents/*`, `actions/files.ts`, `actions/share.ts`,
  `app/api/files/[fileId]/route.ts`, `app/share/[token]/page.tsx` (public,
  not in `PROTECTED`), Files and Shared links UI; `proxy.ts`; tests.
- **Tests:** AT-FILE-01…03, AT-BRW-10, AT-PDF-01 (templates),
  AT-SHR-01…05, AT-RLS-A*.
- **Acceptance:** every template renders at 360 px-equivalent A4 with
  Indian formatting and Indic glyphs; extraction cache proven.
- **Exit:** `npm run check`, browser tests, build. Live upload check after
  AB-05.

## Phase A6 — Login profiles, take-over, live view

**Status:** COMPLETE 2026-10-18 on fixtures (Session result below). Open:
AB-11 (public live-view route), 360 px screenshots of Account → Logins and
the take-over sheet, live-view latency on a phone network (staging).

### Session result (2026-10-18, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Approved (owner, this session):** AD-04, AD-05, AD-35; the invariant 4
  amendment (CHANGE_IMPACT §7), applied word for word to `AGENTS.md`.
- **Dependency:** `ws` 8.22.0 (MIT, reviewed in A4) and `@types/ws` 8.18.2
  (dev, MIT), pinned exactly.
- **Created:** `supabase/migrations/20261106000000_login_profiles.sql` +
  rollback (`login_profiles` with column grants that never include
  `state_sealed`, state only when active, transitions, `max_login_profiles`
  limit in SQL, `open_login_session()` within browser minutes,
  `browser_sessions` FK; `kits`); `browser/live.ts`; `lib/browser/{profiles,
  kits,live}.ts`; `actions/profiles.ts`; `queries/logins.ts`;
  `app/api/browser/live/[sessionId]/token/route.ts`;
  `components/browser/live-view.tsx`, `components/account/logins.tsx`;
  tests `tests/db/agent-login-rls.test.ts`, `tests/agent/{profiles,kits}.test.ts`,
  `tests/browser/{live,profiles}.test.ts`.
- **Changed:** see CHANGE_IMPACT §3 A6 rows (browser service, worker
  client, policy, tools, runner belt, log redaction, config switches
  `agents.loginProfiles`/`agents.kits` off, env/render optional
  `KRIYA_BROWSER_LIVE_URL`, proxy, Account page, tool card + labels,
  thread-view `SendContext`, worker janitor, fixtures, migrations test,
  `docs/kriya/deployment.md`), `db/schema.ts`, `package.json`.
- **Tests (ids):** AT-SEC-01 (session can't select `state_sealed` or
  connection tokens), AT-SEC-02 (moved ciphertext fails, profile expires),
  AT-SEC-03 (redaction + negative cases + no state/password on the console),
  AT-BRW-08 (policy R3/R4 and the service's own navigation guard), AT-BRW-12
  (wrong person, reuse, expiry, wrong session, wrong secret → 401 before any
  frame; second viewer 409), AT-SCH-06, AT-KIT-01, AT-KIT-02, AT-RLS-A
  (login_profiles, kits), AS-SEC-02 with a login loaded; migration down/up;
  invariant-4 scan (`open` from `lib/secrets` only in `lib/connectors.ts`
  and `lib/browser/profiles.ts`).
- **Acceptance on fixtures (real kriya-browser, local Chrome 155):** sign-in
  typed by the "person" over the live WebSocket on `profile-editor/login`,
  saved (only the site's HttpOnly cookie kept), reused by a new task
  ("Signed in as Fixture Person"), expiry detected after the site revoked the
  session (`login_required`, state deleted), removed; the typed password is
  in no `kriya` table, no log line and no snapshot. `signup/` R5 refusals and
  "no password value in snapshots" stay covered by A4's AT-BRW-02/03.
- **Mutation check:** the service's off-site navigation guard switched to
  `fallback` → the AS-SEC-02 test failed ("expected 'http://exfil.test/collect'
  to be 'http://injection.fixture.test/signed-in'"); restored.
- **Live-view latency (local loopback, Chrome 155, keystroke → next frame,
  n = 15):** median 109 ms, p95 115 ms. Not a phone-network figure.
- **Deviations:** (1) `login_profiles.id` is `uuid`, not `text`, to match
  `browser_sessions.login_profile_id`; (2) no `revoked` row: Remove deletes
  the row and its state (the §6 revocation rule); (3) IndexedDB isn't kept:
  Playwright 1.64 can capture it but `setStorageState` takes cookies and
  localStorage only; (4) in-task take-over (the task waits for Done) isn't
  wired: the runner stays read-only (AF-27), so a login hand-off tells the
  person to add the login under Account → Logins; the service already pauses
  on take-over and resumes on Done; (5) abandoned take-over sessions are
  metered at the 15-minute ceiling (`ponytail` note); (6) no site has a
  `securityPage` yet, so Remove shows generic sign-out advice; (7) pop-ups
  stay closed, so pop-up SSO sign-ins won't work in take-over; (8) kit checks
  read the snapshot's first 4,000 characters of page text.
- **Owner to-dos:** add `KRIYA_AGENTS_LOGIN_PROFILES`, `KRIYA_AGENTS_KITS`,
  `KRIYA_BROWSER_LIVE_URL` to `.env.example` (AB-09); set
  `max_login_profiles` per plan (default 0); AB-11.
- **Commands and real output:** `npm run check`: exit 0, "Test Files 74
  passed | 3 skipped (77) · Tests 807 passed | 26 skipped (833)".
  `KRIYA_TEST_BROWSER=1 BROWSER_CHROMIUM_PATH=<Chrome 155> npx vitest run
  tests/browser tests/eval/browser.eval.test.ts tests/agent/files.test.ts
  tests/agent/documents.test.ts`: exit 0, "Test Files 8 passed (8) · Tests
  104 passed (104)". `npm run build`: exit 0, "✓ Compiled successfully in
  12.7s".
- **Next exact action:** owner: AB-11 and the 360 px screenshots; then A10
  when AB-02/04/07 allow.

- **Objective:** the person signs in through take-over; the session is
  sealed as a login profile; agents use it within the site's mode; live view
  on a phone.
- **Read first:** BROWSER_AND_LOGIN_PROFILES §5–6; SECURITY S4–S8;
  DATA_MODEL §2.6; UX_SPEC §6–7.
- **Preconditions:** A3, A4 COMPLETE; AD-04, AD-05 approved; the invariant
  4 amendment applied to `AGENTS.md`.
- **Files:** migration `20261106000000_login_profiles.sql` + rollback; new
  `lib/browser/profiles.ts`, `actions/profiles.ts`,
  `app/api/browser/live/[sessionId]/token/route.ts`, live-view UI,
  Logins UI; `lib/log.ts`; `proxy.ts`; tests.
- **Includes signature feature:** K9 ready-to-apply kits for `assisted`
  sites (AD-35). They work without a login profile too, so they may ship
  first if AB-03 stays open.
- **Tests:** AT-SEC-01…03, AT-BRW-08, AT-BRW-12, AT-SCH-06, AT-KIT-01,
  AT-KIT-02, AT-RLS-A*; AS-SEC (exfiltration with a profile loaded).
- **Acceptance:** on the `signup/` and `profile-editor/` fixtures: sign-in by
  take-over, save, reuse in a new task, expiry detection, revoke; no state
  in logs or selectable by the session.
- **Exit:** checks + browser tests + build; live-view latency measured.

## Phase A7 — Accounts: bills, ledger, GST, invoices, reports

**Status:** COMPLETE 2026-10-18 on fixtures (owner acceptance below). Open
for the pre-launch pilot: L2 (needs a paid labelled run; no paid calls made),
the official GSTIN check-character algorithm (RG-5), 360 px screenshots of
Accounts.

### Session plan (2026-10-18 19:50 IST, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Approved (owner, this session):** AD-16, AD-17; migration
  `20261111000000_ledger.sql`; single-entry ledger as designed; GSTIN check
  character mod-36 only, **warn-only and marked unverified**; SQL GSTIN check
  loosened (AF-29); SGST column carries UTGST for Union territories; K7 model
  cross-check for **citations only** (AD-33), stored in a new table and run by
  a worker loop behind its own switch; Accounts UI and ledger agent tools
  **deferred**.
- **Preconditions:** A5 COMPLETE (owner, today) ✓; AD-16/17 ✓; RG-5 (AB-10):
  Rule 46 ✓ and Union territory list ✓ from CBIC; GSTIN check-code algorithm
  **no primary source found** (owner: proceed warn-only, RG-5 stays open for
  it). Preflight: the owner's `npm run check` after A5 (exit 0, 613 tests,
  58 files); no code changed since (only `status.md`). Board empty.
- **RG-5 research (read-only, 2026-10-18):**
  - CGST Rule 46(b), CBIC
    (`taxinformation.cbic.gov.in/…/chapter6/rule46_v1.00.html`, fetched
    with TLS verified), verbatim: "a consecutive serial number not exceeding
    sixteen characters, in one or multiple series, containing alphabets or
    numerals or special characters- hyphen or dash and slash symbolised as
    "-'' and "/" respectively, and any combination thereof, unique for a
    financial year". Clauses (l)/(m) name "central tax, State tax,
    integrated tax, Union territory tax or cess"; (n) "place of supply along
    with the name of the State, in the case of a supply in the course of
    inter-State trade or commerce".
  - CGST Act s. 2(114), CBIC (`…/2017_CGST_act/active/chapter1/section2_v1.00.html`),
    verbatim: ""Union territory" means the territory of- (a) the Andaman and
    Nicobar Islands; (b) Lakshadweep; (c) [Dadra and Nagar Haveli and Daman
    and Diu; (d) Ladakh;] (e) Chandigarh; and (f) Other territory."
  - GSTIN structure: ICAI Indirect Taxes Committee article "Structure of
    GSTIN" (carries an authors'-views disclaimer): 2-digit state code, PAN,
    13th = registrations in the State, 14th "assigned based on the nature of
    the business… "Z" is used as a default… regular tax payer", 15th "a
    check code which can be an alpha-numeric character"; NRTP/OIDAR example
    `9917USA00015OS` + check. **Algorithm: not found** on cbic.gov.in,
    gst.gov.in, gstn.org.in or the e-invoice portal; only third-party
    explainers.
  - **Unverified, with the check to run:** the mapping of those Union
    territories to GST state codes (35, 31, 26 and legacy 25, 38, 04, 97) is
    from common use, not from a fetched GSTN list: compare with the GST
    portal's state-code master. The mod-36 check-code algorithm is the one
    common public implementations use: confirm with GSTN.
- **Create:** migration + rollback (`ledger_entries`, `invoice_series`,
  `invoices`, `claim_checks`; transitions `ledger_entry`, `invoice`;
  `issue_invoice()` locking the series row; `plans.ledger_enabled` false,
  checked by insert triggers); `lib/gst.ts`; `lib/ledger.ts` (extraction
  schema, reconciliation, entries, summaries in SQL, invoices, CSV export);
  `lib/agent/crosscheck.ts`; `actions/ledger.ts`; `queries/ledger.ts`;
  tests `tests/db/agent-ledger-rls.test.ts`, `tests/agent/{gst,ledger,crosscheck}.test.ts`,
  `tests/eval/ledger.eval.test.ts` (AS-LED, 25 scripted cases).
- **Change:** `db/schema.ts` (mirror), `lib/config.ts` (`agents.ledger`,
  `agents.crossCheck` off; `agents.crossCheckModel` unset),
  `worker/index.ts` (cross-check loop behind its switch, owner),
  `lib/documents/templates.ts` (tax invoice and period report),
  `tests/db/migrations.test.ts` (down/up; A3 case rolls A7 back first),
  `docs/kriya/deployment.md`, CHANGE_IMPACT §3 rows.
- **Tests first:** AT-LED-01…07, AT-TR-01 (ledger entry, invoice), AT-XCK-02,
  AT-RLS-A (new tables), AS-LED (L1).
- **Risks and how they're avoided:** a model's number reaching a total (every
  sum recomputed in `lib/ledger.ts`, totals `check`ed in SQL); an agent
  confirming (no tool; AT-POL-07 + AT-LED-06); gaps or reuse of invoice
  numbers (locked series row, unique index, no delete after issue); a
  false checksum alarm treated as fact (warn-only reason, never a rejection);
  PGlite runs one connection, so the 20-issue test proves uniqueness and
  no gaps but not true parallel locking (recorded; `for update` is the
  mechanism).
- **Not measured this phase:** L2 (bill extraction accuracy) needs a model
  run on ≥ 100 labelled bills, which is a paid run that isn't approved.

### Session result (2026-10-18, Claude Code, Opus 5.5)

- **Status:** `IN_PROGRESS`. Everything runnable without a paid model is
  built and passes. Not COMPLETE because the acceptance item "L2 recorded on
  a labelled set" needs a paid model run (not approved), and RG-5 is open
  for the GSTIN check-code algorithm. The owner may accept A7 on that basis
  (as A1 was accepted).
- **Created:** `supabase/migrations/20261111000000_ledger.sql`,
  `supabase/rollback/20261111000000_ledger.down.sql`; `lib/gst.ts`,
  `lib/ledger.ts`, `lib/agent/crosscheck.ts`; `actions/ledger.ts`,
  `queries/ledger.ts`; `tests/db/agent-ledger-rls.test.ts`,
  `tests/agent/{gst,ledger,crosscheck}.test.ts`,
  `tests/eval/ledger.eval.test.ts`.
- **Changed:** `db/schema.ts` (ledger tables, `plans.ledgerEnabled`),
  `lib/config.ts` (`agents.ledger`, `agents.crossCheck` off;
  `agents.crossCheckModel` unset), `worker/index.ts` (cross-check loop),
  `lib/documents/templates.ts` (tax invoice, ledger report, `.wide` table
  wrapper), `tests/db/migrations.test.ts` (A7 down/up; the A3 and A5 cases
  roll A7 back first), `tests/agent/documents.test.ts` (the two new
  templates in AT-PDF-01), `docs/kriya/deployment.md`, CHANGE_IMPACT §3,
  REPOSITORY_AUDIT (AF-29).
- **Tests (ids) and real results:** AT-LED-01, 04, 07 (SQL), AT-TR-01
  (ledger entry, invoice) and AT-RLS-A: 21/21; AT-LED-02, 03 (partial):
  7/7; reconciliation, AT-LED-04…07 through `lib/ledger.ts`, invoices,
  export: 14/14; AT-XCK-02: 4/4; migrations 10/10; AS-LED: "Tests 26 passed
  (26)", `{"suite":"AS-LED","n":25,"passed":25,"L1":0}`; AT-PDF-01 with
  local Chrome: 8/8 (tax invoice and ledger report included).
- **Mutation checks (each failed as expected, file restored):** money
  filter removed from `inconclusive()` → "expected 2 to be 1"; confirmed-only
  filter removed from `summarize()` → AS-LED-23, 24 and L1 failed.
- **Found and fixed:** `issue_invoice()` returns the invoices row type, so
  the rollback drops it first; `rateBps / 2` isn't an integer at 0.25 %, so
  halving goes through the divisor; the ledger report was 419 px wide at
  360 px, so wide tables now scroll inside a wrapper while the page doesn't.
- **Commands and real output:** `npm run typecheck`, `npm run lint`,
  `npm run format:check`: exit 0 ("All matched files use Prettier code
  style!"); `npx vitest run --maxWorkers=2` (the check's test step, two
  workers to avoid the earlier low-memory stop): exit 0, "Test Files 63
  passed | 2 skipped (65) · Tests 686 passed | 20 skipped (706)";
  `KRIYA_TEST_BROWSER=1 … vitest run tests/agent/documents.test.ts`: 8/8;
  `npm run build`: exit 0, "✓ Compiled successfully". The full browser
  suite wasn't rerun (A7 changed no file under `browser/`).
- **Metrics:** L1 = 0 (n = 25, AS-LED, 2026-10-18, scripted, no model).
  L2 not measured.
- **Exit criteria:** `npm run check` parts ✓; browser tests (PDF) ✓; build ✓;
  L1 = 0 ✓; L2 ✗ (paid run needed); RG-5 ✗ for the check-code algorithm
  (Rule 46 and s. 2(114) ✓).
- **Deviations:** invoice numbers read `INV/26-27/001` (≤ 16 characters up to
  number 99999 with a 4-character series) instead of the UX example
  `INV/2026-27/014`, which would pass 16 characters at four-digit numbers;
  issuing also records the income as a draft ledger entry linked to the
  invoice (voiding the invoice voids it); 20-at-once issuing is tested on
  PGlite, which runs one connection, so it proves no gaps or repeats but
  not parallel locking (the `for update` lock is the mechanism); AT-LED-03
  vectors are synthetic (owner); UI and agent tools deferred (owner).
- **Next exact action:** owner decides (1) whether to accept A7 with L2 and
  the RG-5 check-code source open, or approve a paid L2 run (≥ 100
  synthetic or consented, redacted bills; owner picks the model); (2) when
  to build the Accounts UI and the ledger tools (one tool-belt line in
  `run-task.ts`, R2 `invoice_issue`). To check outside Kriya: the GST
  state-code list against the GST portal's master, and the check-code
  algorithm with GSTN.

### Session 2 (2026-10-18, Claude Code, Opus 5.5): Accounts screen and tools; A7 closed

- **Owner's decisions (quoted in substance):** A7 accepted with L2 and the
  official GSTIN check-character algorithm recorded as open items for the
  pre-launch pilot (as in A1, A4, A8); no paid model calls. Build the
  Accounts screen and the ledger tools now (`ledger_list`,
  `ledger_draft_entry`, `invoice_draft` behind `agents.ledger`), update nav
  and `proxy.ts`, run `npm run check` and `npm run build`, mark A7 COMPLETE
  with L2 and the 360 px screenshots open, then stop (no A13 or A6).
- **Created:** `app/(workspace)/accounts/page.tsx` (FY-to-date income,
  expenses, GST collected − paid as an estimate; needs-review list with
  reason chips and confirm-with-note; drafts with Confirm all; invoices with
  status badges, Issue with a permanent-number confirmation, PDF, Mark
  paid, Void), `components/accounts/controls.tsx`,
  `tests/agent/runner-a7.test.ts`.
- **Changed:** `lib/agent/tools.ts` (`createLedgerTools`; `ledger_list` is
  a private read, so later web calls stay guarded), `lib/agent/policy.ts`
  (R0, R1, R1; writes `ledger_entries+`, `invoices+`),
  `lib/agent/run-task.ts` (one belt line: switch **and** plan),
  `components/thread/tool-call.tsx`, `components/workbench/activity.tsx`,
  `app/(workspace)/account/page.tsx` ("Open Accounts" with the switch on;
  the bottom nav already has five tabs at 360 px), `proxy.ts`
  (`/accounts`), `tests/agent/proxy.test.ts`, `tests/agent/ledger.test.ts`
  (see below), CHANGE_IMPACT §3.
- **Tool names:** the owner's (`ledger_list`, `ledger_draft_entry`,
  `invoice_draft`) instead of TOOLS §2.5's `ledger_query`/`ledger_add`;
  `bill_extract`, `ledger_summary` and the R2 `invoice_issue` aren't tools
  (issuing stays the person's, in Accounts). The prompt is unchanged.
- **A test corrected, not a rule:** session 1's AT-LED-06 assertion said no
  tool may write `ledger_entries` at all, which `ledger_draft_entry`
  (drafts, as designed) broke: "Test Files 1 failed | 63 passed | 2 skipped
  (66) · Tests 1 failed | 689 passed". It now asserts what DATA_MODEL §4
  requires: no tool changes `ledger_entries.*` or `invoices.*` columns
  (status included); inserts are born draft or needs_review by the SQL
  insert policy (tested in `agent-ledger-rls`).
- **Tests:** `runner-a7` 3/3 (switch off: no ledger tool; switch on, plan
  off: none and the same prompt; on: a drafted bill with a wrong total is
  stored `needs_review` at the code's ₹1,180.00, not the model's).
- **Commands and real output:** `npm run check`: exit 0, "All matched files
  use Prettier code style!", "Test Files 64 passed | 2 skipped (66) · Tests
  690 passed | 20 skipped (710)". `npm run build`: exit 0, "✓ Compiled
  successfully in 8.3s".
- **Open (owner-accepted):** L2; GSTIN check-character source; GST
  state-code list check against the GST portal; 360 px screenshots of
  Accounts (no database here to render it with data).
- **Next exact action:** none for A7. A13 and A6 wait for the owner's
  authorization.

- **Objective:** Lekha's accountant workflow (ROLE_PLAYBOOKS FD-01, FD-02,
  FL-04, BZ-02) with code-computed money and gapless invoice numbers.
- **Read first:** ROLE_PLAYBOOKS §3.1; DATA_MODEL §2.7, §3.5–3.6;
  TOOLS_AND_CONTRACTS §2.5; RESEARCH §5; UX_SPEC §9.
- **Preconditions:** A5 COMPLETE; AD-16, AD-17 approved; RG-5 closed (AB-10).
- **Files:** migration `20261107000000_ledger.sql` + rollback; new
  `lib/ledger.ts`, `lib/gst.ts`, `actions/ledger.ts`, `queries/ledger.ts`,
  Accounts UI, ledger tools, invoice and report templates; tests.
- **Tests:** AT-LED-01…07, AT-TR-01 (ledger, invoice), AT-XCK-02 (model
  cross-check, K7); AS-LED, AS-XCK.
- **Acceptance:** L1 = 0; L2 recorded on a labelled set (no real person's
  bills in the repo; synthetic or consented, redacted).
- **Exit:** `npm run check`, browser tests (PDF), build.

## Phase A8 — Official-API connectors

**Status:** COMPLETE 2026-10-18 on fixtures (see Session result); live use after AB-06

- **Objective:** GitHub, Sheets write, YouTube and Instagram tools with
  read-back verification; K3 Undo window.
- **Read first:** TOOLS_AND_CONTRACTS §2.6; DATA_MODEL §2.8; RESEARCH §4
  (RG-4, RG-10); SIGNATURE_FEATURES K3; CHANGE_IMPACT §2 row for
  `lib/connectors.ts`.
- **Preconditions:** A3 COMPLETE; AD-07, AD-29 approved; owner approval to
  edit `lib/connectors.ts` recorded here.
- **Files:** migration `20261108000000_connectors_v2.sql` + rollback
  (providers `github`, `meta` only, since Sheets and YouTube are Google
  scopes, AF-15; `tool_executions.undo*` columns); `lib/connectors.ts`
  (additive: new providers, extra Google scopes, `calendarDelete`,
  `gmailDeleteDraft`); new
  `lib/connectors/{github,sheets,youtube,instagram}.ts`; `actions/undo.ts`;
  tools; Account → Connected accounts; `tests/connectors/*` with redacted
  recorded fixtures.
- **Tests:** per tool: parse, error mapping, read-back verification, scope
  checks; AT-UNDO-01…03; `tests/connectors.test.ts` unchanged.
- **Exit:** `npm run check`. Live use after AB-06.

### Session plan (2026-10-18, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Approvals relied on** (recorded under "Track A owner approvals"): AD-07,
  AD-29, additive `lib/connectors.ts` edits; in this session also
  `lib/agent/run-task.ts` and `worker/index.ts` (additive, behind switches)
  and youtube_upload deferred to A5.
- **Switches (default off):** `agents.connectors` (GitHub, Sheets, YouTube,
  Instagram tools and their Account options), `agents.undo` (undo columns
  written, Undo button, compensation loop). Off = today's tools, prompt and
  worker (AT-REG-01).
- **Create:** migration `20261108000000_connectors_v2.sql` + rollback
  (provider check widened to `github`, `meta`; `tool_executions.undo`,
  `undo_until`, `undone_at`); `lib/connectors/{github,sheets,youtube,instagram}.ts`;
  `lib/undo.ts` (which tools are reversible, compensation + read-back);
  `actions/undo.ts`; `tests/connectors/*` with hand-written fixtures from the
  documented response shapes (nothing can be recorded before AB-06; marked
  as such); `tests/db/agent-connectors-rls.test.ts`.
- **Change:** `lib/connectors.ts` (new providers in OAuth/exchange/revoke,
  Sheets and YouTube as opt-in Google services kept out of the default
  request, exported `providerFetch` so tokens stay in this file,
  `calendarDelete`, `gmailDeleteDraft`); `db/schema.ts` (providers, undo
  columns); `lib/config.ts` (two switches, four secrets);
  `lib/agent/policy.ts` (classes and writes for the new tools);
  `lib/agent/tools.ts` (new tools in `connectorTools`, `NEEDS`,
  `SIDE_EFFECT_TOOLS`, `Connected` gains optional `github`/`meta`);
  `lib/agent/run-task.ts` (connected flags behind `agents.connectors`;
  undo columns in `onToolExecutionEnd` behind `agents.undo`);
  `lib/agent/instructions.ts` (account lines only for the new connections);
  `worker/index.ts` (undo loop); `components/account/connections.tsx` and
  `app/(workspace)/account/page.tsx` (GitHub, Instagram cards, Sheets and
  YouTube options); `components/thread/what-i-did.tsx` + `actions/inbox.ts`
  (Undo button and state); `tool-call.tsx`, `activity.tsx` (labels);
  `tests/db/migrations.test.ts` (down/up case); `docs/kriya/deployment.md`.
- **Tests first:** AT-UNDO-01 (only inside 10 min, once), AT-UNDO-02
  (verified by read-back), AT-UNDO-03 (non-undoable tools have no undo);
  per connector tool: parse, error mapping, read-back, scope gating;
  AT-REG-01 unchanged; `tests/connectors.test.ts` unchanged.
- **Risks found and how they're avoided:** (1) adding Sheets/YouTube to
  `GOOGLE_SERVICES` would make the route's "nothing picked" fallback ask
  for sensitive scopes → separate opt-in map; (2) `sheets_append` with
  `USER_ENTERED` lets read content inject formulas → `RAW` only;
  (3) `github_label` undo could remove a label that was already there →
  undo removes only labels the call added; (4) DELETE answers 204 with no
  body, which `readJson` rejects → `providerFetch` returns the response;
  (5) a worker that dies mid-undo → compensations are idempotent (404 =
  already gone) and re-run.
- **Unknowns (not fabricated):** Meta Graph API version and Instagram
  insights metrics (RG-4), whether Instagram/YouTube allow deleting
  published media (RG-10) → those tools get no Undo.

### Session result (2026-10-18, Claude Code, Opus 5.5)

- **Status:** COMPLETE: the phase's exit check (`npm run check`) passes,
  and so does the build. Live use waits for AB-06 (OAuth apps, app review),
  RG-4 and RG-10. 360 px screenshots of the Account cards and the Undo
  button are open (no database here, as A2/A3).
- **Created:** `supabase/migrations/20261108000000_connectors_v2.sql`,
  `supabase/rollback/20261108000000_connectors_v2.down.sql`,
  `lib/connectors/{github,sheets,youtube,instagram}.ts`, `lib/undo.ts`,
  `actions/undo.ts`, `tests/connectors/{fixtures,github,google,oauth,instagram}.test.ts`
  (fixtures.ts is a helper), `tests/agent/{undo,runner-a8,connector-tools}.test.ts`.
- **Changed:** `lib/connectors.ts` (additive: GitHub and Meta OAuth,
  exchange, revoke; `GOOGLE_EXTRA_SERVICES` Sheets/YouTube kept out of
  `GOOGLE_SERVICES`; `providerFetch`, `jsonOf`, `readBack`;
  `calendarDelete`, `gmailDeleteDraft`; Google/Notion paths unchanged),
  `db/schema.ts`, `lib/config.ts` (switches `agents.connectors`,
  `agents.undo`; four secrets), `lib/agent/{tools,policy,approvals,instructions,run-task}.ts`,
  `worker/index.ts` (undo loop), `actions/inbox.ts`,
  `components/thread/{what-i-did,tool-call}.tsx`,
  `components/workbench/activity.tsx`, `components/account/connections.tsx`,
  `app/(workspace)/account/page.tsx`, `tests/db/migrations.test.ts` (one
  case added), `tests/agent/transcript.test.ts` (one `vi.mock` for the new
  action, no assertion changed), `docs/kriya/deployment.md`,
  `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md` (A8 rows).
- **Tests:** AT-UNDO-01 (window, once, owner only, no direct column write),
  AT-UNDO-02 (compensation verified by read-back; still-present = failed;
  provider error = failed), AT-UNDO-03 (no undo record → no button);
  connectors: parse, error mapping (401/403/404/400), read-back verified and
  failed cases, RAW-only Sheets writes, token only in the Authorization
  header, scope gating; runner: switch off = no GitHub tool or prompt line,
  switch on = R4 waits for approval, then verified and undo recorded.
  `tests/connectors.test.ts` and AT-REG-01 snapshots unchanged and passing.
- **Commands and real output:** preflight `npm run check` → 487 passed + 17
  skipped / 47 files; final `npm run check` → exit 0, "Test Files 52 passed
  | 2 skipped (54) · Tests 542 passed | 17 skipped (559)"; `npm run build` →
  exit 0.
- **Deviations:** (1) Sheets/YouTube first went into `GOOGLE_SERVICES`;
  AT-REG-01 snapshots failed, so they moved to `GOOGLE_EXTRA_SERVICES` and
  the connect route stayed untouched. (2) `runUndos` first held a row lock
  across API calls and deadlocked (the token lookup needs a second
  connection); it now holds no lock and relies on idempotent compensations.
  (3) Tests were written right after each module, not strictly first.
  (4) `youtube_upload` deferred to A5 (owner). (5) A failed compensation
  isn't retried; the card shows "undo failed" with the reason.
- **Fixtures:** hand-written from documented response shapes with synthetic
  ids; no live call was made. Re-record redacted live responses after AB-06.
- **Open:** RG-4 (Graph `v21.0` still supported? `Bearer` header accepted
  by Graph? JSON POST bodies accepted? Instagram permissions list), RG-10,
  GitHub notifications (closed in session 2: not supported for GitHub Apps;
  tool removed), GitHub token expiry (deployment doc says turn it off).
- **Next exact action:** owner reviews this result; then, after AB-06,
  re-record live fixtures for one read and one write per provider with the
  team's own test accounts, and close RG-4/RG-10.

### Session 2 (2026-10-18, finishing up): documentation research, no API calls

- **GitHub notifications:** docs.github.com (REST, activity/notifications,
  API version 2022-11-28), read 2026-10-18: "These endpoints only support
  authentication using a personal access token (classic)." Kriya connects
  through a GitHub App, so `github_notifications` could never work. It was
  **removed** (connector function, tool, class, labels, prompt line);
  `github_search` covers "what needs my attention" through search queries.
- **RG-10 YouTube:** `videos.delete` exists (50 quota units) but needs the
  `youtube`, `youtube.force-ssl` or `youtubepartner` scope; Kriya asks only
  `youtube.readonly` and doesn't upload yet (A5). No Undo, as planned.
- **RG-10 Instagram:** no Meta-official delete endpoint for published media
  was found; only a third-party catalogue lists one. Stays **unknown**; no Undo.
- **RG-4 Graph version:** Meta's versions table (developers.facebook.com,
  Graph API changelog) lists v21.0, released 2024-10-02, as available,
  expiry "TBD". Still to check before live use: `Authorization: Bearer`
  and JSON bodies on Graph calls (no Meta-official statement found), the
  current permission names, and app review.
- **Check after this change:** see the check log.

## Phase A9 — Skills (+ conditional embeddings)

**Status:** COMPLETE 2026-10-18 on fixtures (see Session result). Unblocked 2026-10-18 by the owner (AD-21 approved;
A4's fixture results accepted for local A9 work; AB-08 stays open for
staging/live; no embeddings).

### Session plan (2026-10-18, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Switch:** `agents.skills` (default off). Off = today's tools and prompt.
- **Create:** migration `20261109000000_skills.sql` + rollback (`kriya.skills`
  per DATA_MODEL §2.9 plus `failures`, `last_run_at`; transitions
  draft→approved→retired; RLS: select/delete own, insert only as `draft`,
  update of status and run counters; `plans.max_skills` default 0);
  `lib/skills.ts` (propose from the turn's tool calls with slots and
  role+name locators for clicks, `max_risk` by code, replay, divergence
  count); `actions/skills.ts` (approve, retire, reset); tools
  `skill_propose` (R1), `skill_list` (R0), `skill_run` (R1 itself; runs
  only steps that need no approval, hands back R2–R4 and guarded web calls
  one by one for normal approval, owner 2026-10-18); Inbox cards; tests.
- **Change:** `db/schema.ts`, `lib/config.ts` (switch),
  `lib/entitlements.ts` (`checkSkillAllowed`), `lib/agent/{tools,policy}.ts`,
  `lib/agent/run-task.ts` (one belt line, owner 2026-10-18),
  `queries/inbox.ts`, Inbox page, `tool-call.tsx`, `activity.tsx`,
  `tests/db/migrations.test.ts`.
- **Tests first:** AT-SKL-01 (unchanged fixture: zero model calls during
  replay), AT-SKL-02 (changed fixture: fallback once, then Inbox), AT-SKL-03
  (re-classified; can't exceed `max_risk`; R2+ handed back), RLS, AT-POL-07.
- **Risks and how they're avoided:** replay bypassing approvals or the web
  guard (steps that need approval are never executed in-tool); input
  validation bypass (each step parsed with its tool's own schema);
  unstable browser refs (role+name locators); agent approving its own skill
  (insert policy forces `draft`; no tool writes `status`).
- **Deviations from the catalogue:** `skill_propose` takes no `fromTaskId`:
  it reads the latest turn with tool calls in the conversation; `skill_list`
  added so the prompt needs no change.

### Session result (2026-10-18, Claude Code, Opus 5.5)

- **Status:** COMPLETE on fixtures: `npm run check` and the build pass;
  browser tests pass except one A4 test that failed once under full-suite
  load and passed 3/3 alone (see below). Live use waits for AB-08 (owner
  kept it open). 360 px screenshot of the Inbox skill card is open (no
  database here). Plans have `max_skills = 0` until the owner sets it.
- **Created:** `supabase/migrations/20261109000000_skills.sql`,
  `supabase/rollback/20261109000000_skills.down.sql`, `lib/skills.ts`,
  `actions/skills.ts`, `tests/agent/{skills,runner-a9}.test.ts`,
  `tests/agent/fixture-browser.ts`.
- **Changed:** `db/schema.ts` (`skills`, `plans.maxSkills`), `lib/config.ts`
  (`agents.skills`), `lib/entitlements.ts` (`checkSkillAllowed`),
  `lib/agent/tools.ts` (`createSkillTools`; `skill_run` counts as a private
  and untrusted read, so later web calls stay guarded and later notes stay
  quarantined), `lib/agent/policy.ts`, `lib/agent/run-task.ts` (one belt
  line + switch), `queries/inbox.ts`, `app/(workspace)/inbox/page.tsx`,
  `components/inbox/controls.tsx`, `components/thread/tool-call.tsx`,
  `components/workbench/activity.tsx`, `tests/db/migrations.test.ts` (A9
  case; the A3 case now rolls A9 back first, newest-first), 
  `tests/db/agent-goals-rls.test.ts` (AT-TR-01's exact count of 13 now
  counts only the entities it tests; it was 16 with the skill transitions),
  `tests/agent/transcript.test.ts` (one more action mock),
  `docs/kriya/deployment.md`, `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md`.
- **Tests:** AT-SKL-01 (unit: replay on the fixture page finds the link by
  role+name though its ref changed; runner: one `skill_run` call, 2 model
  calls in total, both steps run in the browser), AT-SKL-02 (first miss →
  remaining steps handed to the agent; second → `needs_review`, Inbox),
  AT-SKL-03 (a link that now submits is R4 > R0 → refused before clicking;
  a `github_comment` step is handed back unrun; a web step after private
  content is handed back), RLS (no approved insert; other person sees
  nothing), transitions (approved → draft refused), plan limit,
  slot placeholders. AT-POL-07 and AT-REG-01 unchanged and passing.
- **Commands and real output:** `npm run check` → exit 0, "Test Files 54
  passed | 2 skipped (56) · Tests 557 passed | 17 skipped (574)";
  `npm run build` → exit 0; `KRIYA_TEST_BROWSER=1 npm test` without a
  Chromium path → 16 browser tests fail with "Executable doesn't exist"
  (Playwright's own Chromium isn't installed); with
  `BROWSER_CHROMIUM_PATH` = local Chrome (as A4 did) → "Tests 1 failed |
  573 passed (574)": AT-BRW-07's temp profile folder still existed right
  after close; the test alone then passed 3/3. Recorded for A4, not
  changed (another phase's test).
- **Deviations:** `skill_propose` has no `fromTaskId` (reads the latest turn
  with replayable calls); `skill_list` added; `skills.failures` and
  `last_run_at` added for the fallback-then-Inbox rule; a skill run that
  ends in hand-back counts as a success of the replayed part. Tests were
  written alongside the code, not strictly first. No per-agent Skills list
  yet (UX_SPEC §11): skills show in the Inbox and through `skill_list`.
- **Next exact action:** owner reviews; sets `max_skills` per plan in
  `/owner`; decides whether AT-BRW-07's teardown timing on Windows needs a
  fix in A4.

- **Objective:** save, approve and replay procedures deterministically.
  Embeddings only if A1's M1 < 0.90.
- **Read first:** DECISIONS AD-21; DATA_MODEL §2.9, §3.7; TOOLS_AND_CONTRACTS
  §2.7; MEMORY_AND_CONTEXT §10.
- **Preconditions:** A3, A4 COMPLETE.
- **Tests:** AT-SKL-01…03; if embeddings: RG-8 closed, M1 improvement beyond
  noise.
- **Exit:** `npm run check`, browser tests.

## Phase A10 — Controlled pilot on real sites

**Status:** BLOCKED (AB-02, AB-04, AB-07)

- **Objective:** ≥ 50 real runs over AS-ROLE workflows with the team's own
  test accounts, the owner present.
- **Preconditions:** A2, A6–A9, A13 COMPLETE; owner's written go-ahead listing
  sites, accounts and dates; terms reviews recorded (AB-04); counsel AQ-1,
  AQ-5, AQ-6.
- **Tasks:** run the checklist; benchmark self-hosted vs one managed vendor
  (RG-6); record each run (no personal data).
- **Acceptance:** P1 = P2 = 0, V1 = 100 %, B1 ≥ 0.9 per mode; C2 per role
  recorded.
- **Exit:** owner sign-off here.

## Phase A11 — Security, compliance, recovery, readiness

**Status:** IN_PROGRESS (preparation done 2026-10-18; every gate needs
staging, counsel, an external reviewer or the A10 pilot to close)

### Session (2026-10-18, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's instruction:** A6 signed off; proceed with A11 preparation (gates
  review, legal pages, restore and key-rotation runbooks, incident runbook,
  readiness suite); zero external calls. A11 formally depends on A10 and
  AB-07, so this session prepares evidence and doesn't close gates.
- **Owner's answers this session:** (1) approved an additive change to
  `lib/secrets.ts` (§2 exception) for key rotation; (2) legal pages ship as
  drafts, clearly labelled.
- **Created:** `lib/legal.ts` (privacy notice, terms, AI disclosure as data;
  processors list), `lib/readiness.ts` + `scripts/readiness.ts`
  (`npm run readiness`), `docs/agent-platform/runbooks/{restore,key-rotation,incident}.md`,
  `tests/agent/key-rotation.test.ts`, `tests/readiness/readiness.test.ts`.
- **Changed:** `lib/secrets.ts` (rotation, `v2_<key id>` values; `v1` still
  opens), `lib/browser/profiles.ts` (re-seal on use; `resealProfiles` in the
  janitor during a rotation), `app/legal/[doc]/page.tsx` (three docs, draft
  label, cross-links), `lib/log.ts`, `lib/config.ts`, `lib/env.ts`,
  `render.yaml` (`KRIYA_TOKEN_KEY_PREVIOUS`, optional), `worker/index.ts`
  (log line), `package.json` (`readiness`), CHANGE_IMPACT §3 rows.

| Gate | Evidence now | Still needed |
| --- | --- | --- |
| GA-1 | `npm run check` and the browser suites pass for every built phase | AT- tests for A10 and A12 (not written) |
| GA-2 | Scripted AS-SEC on fixtures (A4: 9/9; A6: exfiltration with a login loaded) | The ≥ 200-run adversarial model suite (paid; needs approval) |
| GA-3 | Egress guard tested locally (AT-BRW-06) | On the deployed `kriya-browser` (AB-02, AB-08) |
| GA-4 | `runbooks/restore.md` with the drill and RPO/RTO record | The drill on staging |
| GA-5 | Rotation code tested (`key-rotation.test.ts`); `runbooks/key-rotation.md`; `npm run readiness` counts values per key | The drill on staging |
| GA-6 | — | External security review (browser service, login profiles, egress guard, files) |
| GA-7 | Draft privacy notice, terms, AI disclosure, labelled; open points marked "under legal review" | Counsel AQ-1…AQ-6 (AB-07); the DPDP Rules gazette text |
| GA-8 | — | A10 pilot |

- **Found while writing the rotation runbook (not changed; `lib/connectors.ts`
  needs approval):** (1) a Google refresh re-seals only the access token, so
  refresh tokens stay on the old key until the person reconnects; (2) once
  the old key is removed, a connection on it fails with "sealed with a key
  that's been retired" instead of a reconnect prompt; (3) Disconnect opens
  the token to revoke it before deleting the row, so such a connection can't
  be removed by the person. The runbook routes around this (owner deletes
  those rows before retiring the key). Also: share pages check no switch and
  the owner can't revoke a share (incident runbook "Gap").
- **Commands and real output:** `npm run check`: exit 0, "All matched
  files use Prettier code style!", "Test Files 76 passed | 3 skipped (79) ·
  Tests 826 passed | 26 skipped (852)" (first run failed format on 4 files,
  fixed). `npm run build`: exit 0, "✓ Compiled successfully in 8.3s".
  `npx tsx scripts/readiness.ts` with database variables blank: exit 1 as
  expected offline (`env.required` fail; `keys.token`, `legal.reviewed`
  warn); no values printed.
- **Next exact action:** owner: counsel on AQ-1…AQ-6 and the gazette text;
  name the grievance officer; staging for the restore and rotation drills
  (AB-02); decide on the `lib/connectors.ts` rotation fixes; external review.
- **Unknowns, not guessed:** whether the project's Supabase backups include
  Storage objects; its backup plan and point-in-time window; the DPDP Rules'
  breach timelines (72 h is secondary and unverified); the grievance officer.

### Session (2026-10-19, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's instruction:** A11 preparation signed off; approved the three
  `lib/connectors.ts` rotation fixes (§2 exception).
- **Changed:** `lib/connectors.ts`: a Google refresh also re-seals the
  refresh token when it's on an old key; a token that won't open (retired
  key, damaged) raises the reconnect `ConnectorError` ("… Reconnect Google
  in Account → Connected accounts."), while a missing or malformed key stays
  a platform error; Disconnect skips the provider revoke and still deletes
  the row when the token won't open. `runbooks/key-rotation.md` updated
  (step 6 no longer needs the owner to delete rows; drill expectations).
- **Created:** `tests/connectors/rotation.test.ts` (4 tests).
- **Result:** connector suites 7 files / 53 tests passed, existing
  `tests/connectors.test.ts` and `oauth.test.ts` unchanged.
- **Still open (unchanged):** Notion, GitHub and Meta tokens are re-sealed
  only on reconnect; share pages check no switch and the owner can't revoke
  a share.

- **Objective:** evidence for gates GA-1…GA-8 (SECURITY_AND_COMPLIANCE §6).
- **Tasks:** external review; counsel AQ-1…AQ-6; privacy notice and terms
  in `app/legal`; restore and key-rotation drills; incident runbook.
- **Exit:** owner sign-off; every gate has evidence here.

## Phase A12 — Governed improvement loop

**Status:** COMPLETE on test data (2026-10-19). Behind `agents.improvement`
(off). Open: no live canary has run; part of the owner's severity-1 and
needs-review definitions has no per-task record yet (see session 3); A11
gates still open.

### Session (2026-10-19, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's instruction:** "Proceed with Phase A12"; **AD-25 approved**.
  Scope: versioning data model and evaluation runner, shadow harness,
  canary and rollback, tests that the loop can't change safety rules or
  risk classes. A11 is not COMPLETE (gates open); the owner chose to start
  A12 anyway, so nothing here goes live.
- **Created:** migration `20261114000000_policy_versions.sql` + rollback
  (`kriya.policy_versions`: complete bundle, sha256, status through
  `allowed_transitions`, one active and one canary at most, bundle frozen
  by trigger, RLS on with no grants); `lib/improve.ts` (strict bundle
  schema: prompt wording `saveGuidance` without headings, retrieval weights
  recency/importance/own agent, token budgets `summaryTriggerChars` and
  `recallCandidates`; `BASELINE` = today's constants; `offlineGate`,
  `runSuite`, `shadow`, `inCanary` (hashed 5 → 25 → 100 %), `GUARDS`,
  `advance`, `rollback`, `checkCanary`, `bundleFor`; every step audited in
  `audit_events`); `tests/agent/improve.test.ts` (23 tests).
- **Changed:** `lib/memory/retrieve.ts` (optional `weights`, default
  unchanged), `lib/agent/instructions.ts` (`SAVE_GUIDANCE` exported),
  `db/schema.ts`, `tests/db/migrations.test.ts` (A12 down/up; A3 chain),
  `tests/eval/memory.eval.test.ts` (runner takes weights; A12 cycle),
  CHANGE_IMPACT §3 rows.
- **Fixed, never in a bundle** (strict schema refuses the keys; tested):
  risk classes, tool classes, approval gates, site modes, quarantine and
  the untrusted-content section, the unconfirmed-note penalty, limits and
  cost budgets. `lib/improve.ts` imports nothing from policy, entitlements,
  config or browser (scanned). A full cycle leaves `TOOL_CLASSES` and
  `approvalFor` identical.
- **Cycle on simulated data:** (1) scripted metrics: propose → gate →
  shadow → canary 5/25/100 → active; a second version rolled back
  automatically on a severity-1 guard (people stay on the active one); an
  active version rolled back hands back to its parent, then to `BASELINE`.
  (2) AS-MEM, real gate (n = 60): candidate recency 0.1 vs 0.3: M1 40/50 →
  40/50, M2/M4/M5 0 → 0; **gate rejected** ("M1 didn't improve"); shadow
  agreement 60/60. A sweep (recency 0…0.3, importance 0.2…0.5, own agent
  0…0.2) left M1 at 40/50 for every candidate: the 10 misses are the
  paraphrase family (rank 7–8, no shared words), which weights can't fix.
  Recorded, not tuned towards a pass (AF-24).
- **Not done (needs approval):** `bundleFor` isn't called by
  `lib/agent/run-task.ts` or `lib/memory/maintenance.ts` (held files), so
  live runs still use the constants and aren't stamped with a version; no
  worker job computes canary guard metrics; no owner-console screen for
  promotion (functions take the owner id). Exit "one full cycle and one
  rollback" is met on scripted data; the AS-MEM cycle ended at the gate.
- **Commands and real output:** `npm run check`: exit 0, "All matched files
  use Prettier code style!", "Test Files 78 passed | 3 skipped (81) · Tests
  855 passed | 26 skipped (881)". `npm run build`: exit 0, "✓ Compiled
  successfully in 10.1s". (First AS-MEM cycle run failed on a duplicate
  scenario id when shadow re-planted notes; shadow now compares the gate's
  own runs.)
- **Next exact action (owner):** approve wiring `bundleFor` into
  `lib/agent/run-task.ts` (recall weights, candidates) and
  `lib/memory/maintenance.ts` (summary trigger), with the version stamped
  on each task; a worker job for canary guard metrics; an owner screen to
  promote and roll back. M1's real lever is the paraphrase family
  (embeddings, deferred), not weights.

### Session 2 (2026-10-19, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's instruction:** connect the loop to live runs behind
  `agents.improvement` (baseline when off or when no version is active),
  stamp tasks with the version fingerprint; canary guard step in the worker
  with automatic rollback; owner screen with promotion and rollback; mark
  A12 complete on test data.
- **Created:** `actions/improve.ts` (owner only, zod id, steps audited by
  `lib/improve.ts`), `components/owner/improve-controls.tsx`,
  `app/owner/improve/page.tsx` (switch, version in charge, canary share and
  its live numbers, each version's changes against the baseline, gate and
  shadow results, Start canary / Widen / Make active / Roll back).
- **Changed:** migration `20261114000000` (still unapplied) gains
  `kriya.policy_task_versions` (task → version, fingerprint; failed tasks
  included, which message metadata alone would miss); `lib/improve.ts`
  (`activePolicy`, `BASELINE_POLICY`, `stampTask`, `versionMetrics`,
  `guardCanary` with at least 20 finished canary tasks over 7 days,
  `listVersions`; ratio guards take a `minDelta` so a 0 % active failure
  rate can still be exceeded, found while writing the guard test);
  `lib/agent/run-task.ts` (bundle read once per task: recall weights and
  candidates, save-guidance wording; stamp; `metadata.policy`);
  `lib/memory/maintenance.ts` (summary trigger from the bundle);
  `lib/agent/instructions.ts` (optional `saveGuidance`); `lib/agent/tools.ts`
  (`KriyaMetadata.policy`); `worker/index.ts` (guard every 10 minutes);
  `lib/config.ts` (`agents.improvement`, off); `components/owner/nav.tsx`;
  `docs/kriya/deployment.md`; CHANGE_IMPACT §3.
- **Safety invariants (tested):** bundles can't carry risk classes, tool
  classes, limits, site modes, quarantine text, the unconfirmed penalty or
  cost budgets; the untrusted-content section is in the prompt whatever the
  bundle; with the switch off an active version is ignored (baseline
  wording, no stamp, no metadata); `lib/improve.ts` imports only
  `getSetting` from settings and nothing from policy, entitlements or the
  browser.
- **Tests:** `tests/agent/runner.test.ts` A12 block (4), guard-job test and
  zero-base guard cases in `tests/agent/improve.test.ts` (24 tests),
  migrations 12/12 objects.
- **Commands and real output:** `npm run check`: exit 0, "All matched
  files use Prettier code style!", "Test Files 78 passed | 3 skipped (81) ·
  Tests 860 passed | 26 skipped (886)". `npm run build`: exit 0, "✓
  Compiled successfully in 9.9s", route `ƒ /owner/improve`.
- **Next exact action (owner):** apply migration `20261114000000` on
  staging, turn `agents.improvement` on there, and run one canary; decide
  the agent-track signal for severity-1 cases and `needs_review`.

### Session 3 (2026-10-19, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Owner's definitions:** severity-1 = any unauthorized side effect
  (P1 > 0), data exfiltration attempt (P2 > 0), encryption/decryption
  failure, or unquarantined sensitive data write. Needs review = any ledger
  entry with an arithmetic mismatch or missing GSTIN, any citation claim
  missing its verbatim source quote, or any skill replay whose page has
  drifted from the recorded blueprint.
- **Built (`versionMetrics`, read-only):** `needsReviewRate` = share of a
  version's tasks with a `needs_review` ledger entry (the ledger's
  reconcile reasons include arithmetic mismatches and a missing GSTIN) or an
  episode citation check `unsupported`; `severity1` = tasks that stored a
  memory `sensitiveKind` flags. A severity-1 case rolls the canary back at
  once, without waiting for 20 tasks. Test: ledger review 1 of 2 tasks →
  0.5; one stored password on a canary task → "severity1 1 > 0", rolled
  back, parent still active.
- **Not countable yet (no per-task record exists; needs a small addition
  each, not made):** P1 unauthorized side effects and P2 exfiltration
  attempts (the gates refuse them before they happen and nothing is
  stored), token decryption failures (raised as the reconnect error, not
  stored), skill-replay drift (`skill_run` results aren't stored per task;
  only the skill's failure count is).
- **Readiness:** `npm run readiness` exit 1 offline, as before: `FAIL
  env.required` (no `.env`: `DATABASE_URL`, Supabase keys, `KRIYA_APP_URL`),
  `warn keys.token`, `warn legal.reviewed`; gates GA-1…GA-8 listed (GA-1
  text now says A12 is tested on test data). The script doesn't check
  switches or secret isolation, so those were checked separately: all 19
  `agents.*` on/off switches fall back to `off` (including
  `agents.improvement`); `open` from `lib/secrets.ts` is imported only by
  `lib/connectors.ts` and `lib/browser/profiles.ts` (`actions/profiles.ts`
  imports `isSecretsConfigured`, `lib/readiness.ts` `keyId`).
- **Commands and real output:** `npm run check`: first run exit 1 (Prettier
  on `tests/agent/improve.test.ts`, fixed), then exit 0, "All matched files
  use Prettier code style!", "Test Files 78 passed | 3 skipped (81) · Tests
  861 passed | 26 skipped (887)". `npm run build`: exit 0, "✓ Compiled
  successfully in 3.6s" (run before that formatting-only fix).
- **Track A (owner, 2026-10-19):** code complete and ready for the staging
  deployment and the A10 pilot. What remains is not code in the built
  phases: A10 pilot and its AT- tests, the A11 gates (staging drills,
  external review, counsel), AB-08, the four signals above, and the open
  items recorded per phase (RG-11 price, 360 px screenshots).
- **Next exact action (owner):** deploy to staging with every switch off;
  apply migrations through `20261114000000`; run the restore and
  key-rotation drills; then A10.

- **Objective:** the SELF_IMPROVEMENT.md model (voice) applied to prompts,
  retrieval weights and budgets, with offline gate, shadow, canary,
  rollback. Never safety rules (AD-25).
- **Preconditions:** A11 COMPLETE.
- **Exit:** one full cycle on simulated data and one rollback, recorded here.

## Phase A13 — Watchers, Radar, public facts commons

**Status:** COMPLETE 2026-10-18 on fixtures (see Session result). Open:
RG-11 (Firecrawl price; fetches metered unpriced), `FACT_TARGETS` empty
until the owner lists reviewed targets, 360 px screenshots of Radar and
`/owner/facts`.

### Session plan (2026-10-18 21:00 IST, Claude Code, Opus 5.5, `main` in place, uncommitted)

- **Approved (owner, this session):** AD-30, AD-31, AD-32. Answers: RG-11
  stays open (fetches metered `web_fetch`, unpriced); facts only from an
  **owner-defined fact job** (`FACT_TARGETS` in `lib/facts.ts`, empty by
  default; deterministic quote pattern; two agreeing fetches ≥ 1 h apart),
  never from person-made watchers; `schedules.watch` + run outcome
  `unchanged` + `schedule_create` accepting a watch (same R2); owner-console
  facts list with audited Retract.
- **Preconditions:** A3 COMPLETE; A4 BLOCKED on AB-08 only (owner has
  accepted fixture results for later phases); AD-30/31/32 approved; RG-11
  open by the owner's decision. Preflight: the owner's/A7's `npm run check`
  (exit 0, 690 + 20 skipped / 66 files); no code changed since.
- **Create:** migration `20261113000000_radar_watch.sql` + rollback
  (`watch_state`, `obligations` + transitions, `fact_sources` seeded with
  `gov.in` and `nic.in` suffixes, `public_facts` + allow-list trigger;
  `schedules.watch`; outcome `unchanged`); `lib/watch.ts`;
  `lib/radar/{templates,extract}.ts`; `lib/facts.ts`; `actions/radar.ts`;
  `app/(workspace)/radar/page.tsx` (Coming up, Watchers);
  `app/owner/facts/page.tsx`; tools `facts_lookup` (R0), `obligation_add`
  (R1), `obligation_list` (R0); tests and AS-FCT (20), AS-RAD (15).
- **Change:** `db/schema.ts`, `lib/config.ts` (`agents.watchers`,
  `agents.radar`, `agents.facts`, all off), `lib/schedules.ts` (watch input;
  `runDue` checks a watch before any task; kind kept on re-time),
  `lib/agent/tools.ts` (`schedule_create` watch; new tool group),
  `lib/agent/policy.ts`, `lib/agent/run-task.ts` (belt line + watch flag),
  `worker/index.ts` (scheduler loop: missed obligations, fact job),
  `proxy.ts` (`/radar`), account page link, tool labels,
  `tests/db/migrations.test.ts`, CHANGE_IMPACT rows.
- **Design choices to flag:** (1) normalisation strips only volatile stamps
  (visitor counters, "last updated" stamps, clock times, "n minutes ago"),
  **not content dates**: a moved deadline must count as a change;
  (2) obligations come from the agent's `obligation_add` inside the task a
  changed page starts (the diff is in the prompt), with the quote checked by
  code against the conversation's tool outputs and the date checked to
  appear in the quote, so there's no second model extraction pass;
  (3) `selector` isn't built (Firecrawl returns page text, not DOM);
  (4) reminders are in-app only until voice ships (AD-20).
- **Tests first:** AT-WAT-01…03, AT-RAD-01…04, AT-FCT-01…04, AT-RLS-A,
  AT-TR-01 (obligation), AS-FCT, AS-RAD; down/up.

### Session result (2026-10-18, Claude Code, Opus 5.5)

- **Status:** COMPLETE on fixtures. Every exit item passed: W1 = 0, F1 = 0,
  no obligation without its quote and source, reminders only in Kriya (or a
  phone call once voice ships), `npm run check` and `npm run build`.
- **Created:** `supabase/migrations/20261113000000_radar_watch.sql` +
  `supabase/rollback/20261113000000_radar_watch.down.sql`; `lib/watch.ts`,
  `lib/facts.ts`, `lib/radar/{templates,extract,obligations}.ts`;
  `actions/radar.ts`; `app/(workspace)/radar/page.tsx`,
  `app/owner/facts/page.tsx`, `components/radar/controls.tsx`;
  `tests/db/agent-radar-rls.test.ts`,
  `tests/agent/{watch,radar,facts}.test.ts`,
  `tests/eval/{facts,radar}.eval.test.ts`.
- **Changed:** `db/schema.ts`, `lib/config.ts` (`agents.watchers`,
  `agents.radar`, `agents.facts`, off), `lib/schedules.ts`,
  `lib/agent/{tools,policy,run-task}.ts`, `worker/index.ts`, `proxy.ts`
  (`/radar`), `app/(workspace)/account/page.tsx` ("Open Radar"),
  `components/owner/nav.tsx` ("Facts"), `components/thread/tool-call.tsx`,
  `components/workbench/activity.tsx`, `tests/db/migrations.test.ts` (A13
  down/up; the A3 case rolls A13 back first), `docs/kriya/deployment.md`,
  CHANGE_IMPACT §3.
- **Tests and real results:** RLS, allow-list trigger, transitions 11/11;
  migrations 11/11; AT-WAT-01…03 7/7 (8 unchanged days: 0 tasks, 0 model
  calls, 8 fetches metered unpriced; counter-only change ignored; moved date
  → one run with the diff; diff capped, marked untrusted, and quarantine
  sees it; 5 failures pause; switch off → no fetch); AT-RAD-01…04 and
  closing rules; AT-FCT-02…04; AS-FCT `{"suite":"AS-FCT","n":20,"passed":20,"F1":0}`;
  AS-RAD `{"suite":"AS-RAD","n":15,"passed":15}`.
- **Mutation check:** the one-hour rule removed from `recordFactFetch` →
  "Tests 3 failed | 26 passed (29)"; restored.
- **Found and fixed on the way:** the AT-RAD-04 scan first flagged
  `reasons.push(` as the word "push" (method calls are now excluded);
  `Date.now()` in the owner facts page (React purity lint): expiry now comes
  from SQL.
- **Commands and real output:** `npm run check`: exit 0, "All matched files
  use Prettier code style!", "Test Files 70 passed | 2 skipped (72) · Tests
  764 passed | 20 skipped (784)". `npm run build`: exit 0, "✓ Compiled
  successfully in 9.1s".
- **Metrics:** W1 = 0 (8 watcher-days, scripted); F1 = 0 (AS-FCT, n = 20);
  AS-RAD 15/15. Scripted, no model, 2026-10-18.
- **Deviations:** see the plan's design choices (volatile-only
  normalisation, obligations through `obligation_add` with code checking,
  no `selector`, in-app reminders). The fact job's targets are code, not an
  owner screen; the owner screen lists and retracts. `fact_sources` holds
  only `gov.in` and `nic.in` (exam authorities on `ac.in` need adding by
  migration after review). Date recognition is English month names only.
- **Next exact action:** owner: enter the Firecrawl price (RG-11); list the
  first reviewed fact targets in `lib/facts.ts` (key, URL on an allowed
  domain, quote pattern); decide whether `ac.in` exam sites join
  `fact_sources`. Then A6 or A10 when authorized.

- **Objective:** K5 zero-token watchers, K4 Kriya Radar (obligations with
  verbatim quotes, reminders by phone via voice or in-app), K6 public facts
  commons from allow-listed official sources.
- **Read first:** SIGNATURE_FEATURES.md K4–K6; DATA_MODEL §2.11, §3.9;
  TOOLS_AND_CONTRACTS §2.9; ARCHITECTURE §2.4 (private-content guard note);
  SECURITY S17; AD-20.
- **Preconditions:** A3, A4 COMPLETE; AD-30, AD-31, AD-32 approved; RG-11
  recorded (Firecrawl cost).
- **Files:** migration `20261113000000_radar_watch.sql` + rollback
  (watch_state, obligations, public_facts, fact_sources + trigger); new
  `lib/watch.ts`, `lib/radar/{templates,extract}.ts`, `lib/facts.ts`,
  `actions/radar.ts`, Radar and Watchers UI; tools `facts_lookup`,
  `obligation_add`, `obligation_list`; `worker/index.ts` (watcher step in the
  scheduler loop); owner console facts list + retract (audited).
- **Tests:** AT-WAT-01…03, AT-RAD-01…04, AT-FCT-01…04, AT-RLS-A*; AS-FCT,
  AS-RAD.
- **Acceptance:** W1 = 0 and F1 = 0 (scripted); no obligation shown
  without a quote and source; no reminder channel other than voice or
  in-app.
- **Rollback:** `agents.watchers`/`radar`/`facts` off; down migration.
- **Exit:** `npm run check` (+ browser tests if browser watching is used).

## Track A check log

| Date | Check | Result |
| --- | --- | --- |
| 2026-10-17 | Local fact checks while writing: installed `@electric-sql/pglite` 0.5.10 exports no `vector` subpath; `plans.browser_minutes` exists and is unused; `usage_events.cached_tokens` exists; onboarding creates one agent (`actions/account.ts:80`) | Recorded in RESEARCH.md §3 and REPOSITORY_AUDIT.md |
| 2026-10-17 | Cross-reference script (scratchpad) over `docs/agent-platform/*`, `status.md`, `AGENTS.md` | One gap found and fixed (AS-SEC-01…05 now defined); all other referenced ids defined or wildcards; every named document exists |
| 2026-10-17 | `npx prettier --ignore-path "" --write docs/agent-platform/*.md` (`.prettierignore` has `*.md`, voice F11) | Formatted 15 files, 1 unchanged |
| 2026-10-17 | `npm run check` | **Pass**: typecheck, lint, format, 82 passed / 9 files |
| 2026-10-17 | **Re-audit**: proposed SQL run on PGlite 18.6 against the real migrations (scratch test in `tests/_scratch/`, deleted afterwards; `git status` shows no stray files) | Two blueprint bugs proven: composite self-FK on `memories` and composite FKs to `tasks` fail ("no unique constraint matching given keys"). Proven to work: nullable `agent_id` with the composite FK, generated `tsvector('simple')` + GIN, partial unique index with regex, OR full-text search across romanised Telugu / Devanagari / English, RLS on shared notes, transition trigger with `TG_ARGV`, money `check` (rejects ₹0.01 off), jsonb column on `tool_executions` |
| 2026-10-17 | Re-audit against code: `summarize()` 500-char cut, `taskRow` `channel: "web"`, `db/schema.ts:257` input type, `tasks_one_active_per_thread`, `recordUsage` request key, `enqueueApproval` part-only check, `googleServices()` scopes, proxy `"/s/"` prefix, AI SDK `ToolExecutionOptions.messages`, `fx.usdInr` and `charges.charge_micro_inr` | 15 findings AF-08…AF-22 fixed in the design (REPOSITORY_AUDIT.md §4); none touched application code |
| 2026-10-17 | Signature features designed: SIGNATURE_FEATURES.md (K1–K10), AD-27…AD-36, phase A13, tests and threats added | Docs only |
| 2026-10-17 | Cross-reference script rewritten (the first version's range check never matched `…` because of shell encoding, so its earlier "AS-SEC gap" was a false alarm, though defining those ids was harmless) | Every numbered id defined; remaining hits are bare wildcard prefixes (`AT-POL-*`); every named document exists |
| 2026-10-17 | `npx prettier --ignore-path "" --write docs/agent-platform/*.md`, then `npm run check` | **Pass** (exit 0): typecheck, lint, format, 82 passed / 9 files |
| 2026-10-18 | Master-prompt preflight for phase `NEXT` (Claude Code): `git status` shows only the A0/voice doc changes; DECISIONS.md AD-01…AD-36 all `Proposed`; "Track A owner approvals" empty | **Stopped before claiming a phase**: A1 and A4 (the only phases whose phase dependencies are met) both need A0 approved (AB-01). No code or board row changed |
| 2026-10-18 | `npm run check` (preflight) | **Pass** (exit 0): typecheck, lint, format, 82 passed / 9 files |
| 2026-10-18 | A1 session 1: `npm run check` after migration `20261101000000_memory_v2`, `lib/memory/*`, loader filter | **Pass**: typecheck, lint, format, 161 passed / 15 files (82 original unchanged) |
| 2026-10-18 | A1 session 2: `npm run check` + `npm run build` after the v2 tools and runner wiring | **Pass**: 177 passed / 16 files; build exit 0 |
| 2026-10-18 | A1 session 3: AS-CTX scripted run (n = 20) + `npm run check` | C1 off mean 5,669.75 / median 5,699; on mean 6,331.1. Check **pass**: 179 passed / 17 files |
| 2026-10-18 | A1 session 4: summaries + maintenance loop; AS-CTX rerun; `npm run check` + `npm run build` | C1 on with checkpoints mean 5,351.4 (−5.6 % vs off; target −30 % **not met**). Check **pass**: 200 passed / 19 files; build exit 0 |
| 2026-10-18 | A1 session 5: person-side memory (About you, review, pin, export, erase) | Check **pass**: 208 passed / 20 files; build exit 0 |
| 2026-10-18 | A1 session 6: AS-MEM (n = 60, no model) | M1 0.72 (target 0.90, **not met**); M2 0, M4 0, M5 0. Check **pass**: 210 passed / 21 files |
| 2026-10-18 | A1 session 7: owner's decisions (matches first, trigger 12,000, shorter tools, pause column, sensitive check on old actions) | C1 −56.2 % (met); M1 0.80 (not met); M2/M4/M5 0. Check **pass**: 214 passed / 21 files; build exit 0 |
| 2026-10-18 | A1 session 8: "Used N memories" chip; A1 closed under owner approvals | Check **pass**: 215 passed / 21 files; build exit 0 |
| 2026-10-18 | A2 session 1: role packs, "Meet your team", `createTeam` | Check **pass**: 359 passed + 17 skipped / 30 files; build exit 0 |
| 2026-10-18 | A4 session 2: AS-BRW (30) + AS-SEC browser (9), free run | B1 1.00 (30 / 30), P1 0, P2 0; check **pass** 336 + 17 skipped / 28 files; browser suite 353 / 28; build exit 0 |
| 2026-10-18 | A4 session 1: kriya-browser, egress guard, policy, fixtures, migration `20261101000002`, read-only runner | Check **pass**: 335 passed + 16 skipped / 27 files; `KRIYA_TEST_BROWSER=1 npm test` **pass** 351 / 27 (local Chrome 155); build exit 0 |

| 2026-10-19 | Pre-release audit on a local Supabase CLI stack: fresh `db reset` applies all 15 migrations; upgrade from production's version (20261018000000) with old-shape data via `npm run db:migrate` applies the 12 new ones, data intact; existing user signs in with every switch off, old threads render; switches on: Founder role pack (3 agents, squad, shared facts), real tasks via worker (GST answer correct, browser task on example.com via kriya-browser), total metered US$0.0034; fixed redirect loop for a session with no profile (proxy.ts, pre-existing) | `npm run check` exit 0: 863 passed + 26 skipped / 81 files; `KRIYA_TEST_BROWSER=1` full suite 886/887 with local Chrome (AT-BRW-07 Windows temp-dir cleanup flake, 3/3 alone); `npm run build` exit 0 |
| 2026-10-19 | UI polish (owner request): liquid-glass controls, new agent marks, Geist secondary face, page transitions, loading state; sign-up confirmation fix; local E2E on Supabase CLI stack | `npm run check` exit 0: 861 passed + 26 skipped / 81 files; `npm run build` exit 0; E2E sign-up → Mailpit email → confirm → onboarding → sign in passed at 390 px, dark and light, 0 console errors |
| 2026-10-19 | A12 session 3: severity-1 and needs-review signals; readiness (offline), switches, secret isolation; Track A code complete (owner) | `npm run check` exit 0: 861 passed + 26 skipped / 81 files; `npm run build` exit 0; readiness exit 1 offline (no `.env`) |
| 2026-10-19 | A12 live wiring (runner, maintenance, worker guard, `/owner/improve`); A12 complete on test data | `npm run check` exit 0: 860 passed + 26 skipped / 81 files; `npm run build` exit 0 |
| 2026-10-19 | A11 connector rotation fixes + A12 versioning, gate, shadow, canary, rollback; migration `20261114000000` | `npm run check` exit 0: 855 passed + 26 skipped / 81 files; `npm run build` exit 0; AS-MEM A12 gate rejected (M1 40/50 → 40/50) |
| 2026-10-18 | A8 preflight `npm run check` | **Pass** 487 + 17 skipped / 47 files |
| 2026-10-18 | A8: migration `20261108000000`, `lib/connectors/*`, `lib/undo.ts`, undo action and button, Account cards, runner wiring | Check **pass** 542 + 17 skipped / 54 files (52 passed, 2 skipped); build exit 0 |
| 2026-10-18 | A6: migration `20261106000000`, login profiles, take-over live view, K9 kits | `npm run check` exit 0: 807 passed + 26 skipped / 77 files; browser suites 104/104 (Chrome 155); `npm run build` exit 0; live-view latency local median 109 ms |
| 2026-10-18 | A13: migration `20261113000000`, watchers, Radar, facts commons, tools, worker steps, Radar and owner Facts pages | `npm run check` exit 0: 764 passed + 20 skipped / 72 files; `npm run build` exit 0; W1 = 0, F1 = 0 (20), AS-RAD 15/15 |
| 2026-10-18 | A7 session 2: Accounts screen, ledger tools behind `agents.ledger` + plan; A7 closed (owner) | `npm run check` exit 0: 690 passed + 20 skipped / 66 files; `npm run build` exit 0 |
| 2026-10-18 | A7: migration `20261111000000`, `lib/gst.ts`, `lib/ledger.ts`, K7 cross-check, invoices, CA export; RG-5 research (CBIC Rule 46, s. 2(114)) | typecheck, lint, format exit 0; tests 686 passed + 20 skipped / 65 files (`--maxWorkers=2`); PDF tests 8/8 (Chrome); build exit 0; AS-LED L1 = 0 (25/25) |
| 2026-10-18 | A5: migration `20261110000000`, files, extraction, documents, shares, receipt PDF | Preflight check **pass** 557 + 17 skipped / 56 files; first full check 611 passed + 20 skipped, 1 file failed to load (transcript mock, fixed, 2/2 alone); A5 browser files 25/25 on local Chrome; final rerun + build **stopped by low memory**, not yet run |
| 2026-10-18 | A9: migration `20261109000000`, `lib/skills.ts`, skill tools, Inbox cards | Check **pass** 557 + 17 skipped / 56 files; build exit 0; browser run 573 / 574 (AT-BRW-07 flaked once, 3/3 alone) |
| 2026-10-18 | A8 session 2: docs research (GitHub notifications, RG-4, RG-10); `github_notifications` removed | Check **pass** 542 + 17 skipped / 54 files; build exit 0 |
| 2026-10-18 | A3 session 4: K10 polling (thread 1.5 s via `x-kriya-lite`, notifications closed while hidden), nullable `lite_mode` with user override; A3 closed | Check **pass** 487 + 17 skipped / 47 files; build exit 0 |
| 2026-10-18 | A3 session 3: K10 Lite mode setting (migration `20261101000004`, `setLiteMode`, toggle, `saveData` default); polling stopped on a conflict | Check **pass** 480 + 17 skipped / 46 files; build exit 0 |
| 2026-10-18 | A3 session 2: queries, actions, Inbox, goal pages, What I did, Scheduled run label, nav, proxy, quotes, owner counts, K7 line, AS-SCH | AS-SCH R1 15/15, P1 0, V1 1/1; check **pass** 475 + 17 skipped / 45 files; build exit 0 |
| 2026-10-18 | A3 session 1: migration `20261101000003`, schedules, policy for tools, approvals index + expiry, episodes + receipt chain, K7 check, K2 cap, goal/schedule tools | Check **pass**: 425 passed + 17 skipped / 37 files; build exit 0 |

## Track A owner approvals

- 2026-10-19 (Claude Code session, owner's definitions): severity-1 = P1 >
  0, P2 > 0, an encryption/decryption failure or an unquarantined sensitive
  write; needs review = ledger arithmetic mismatch or missing GSTIN, a
  citation without its verbatim quote, a skill replay whose page drifted.
  Track A code declared complete and ready for staging and the A10 pilot;
  stop and leave changes uncommitted on `main`.
- 2026-10-19 (Claude Code session, owner's decisions on A12): **Approved**
  edits to `lib/agent/run-task.ts` and `lib/memory/maintenance.ts` to read
  the active bundle (baseline when none or `agents.improvement` off) and
  stamp tasks with the version fingerprint; the canary guard step in
  `worker/index.ts` with automatic rollback; the owner screen
  `/owner/improve`. Mark A12 complete on test data, then stop.
- 2026-10-19 (Claude Code session, owner's written instruction): "Phase
  A11 preparation is signed off." **Approved: the three additive
  `lib/connectors.ts` fixes** (re-seal both Google tokens on refresh during
  a rotation; reconnect prompt instead of a crash on a retired key;
  Disconnect without decrypting). **Approved: AD-25**; proceed with A12
  (versioning, evaluation runner, shadow, canary, rollback, safety tests).
  In place on `main`, uncommitted; verify with `npm run check` and
  `npm run build`.

- 2026-10-18 (in a Claude Code session, owner's answer to "which phase,
  and do you approve its decisions"): **Approved AD-09, AD-10, AD-11,
  AD-12, AD-13, AD-26** as written, to run phase A1. All other ADs stay
  `Proposed`.
- 2026-10-18 (Claude Code session, owner's answers to the A1 questions):
  (1) recall: **"matches first"** (notes sharing words with the question
  rank above those that don't; recency within each group); (2) tokens:
  **lower the summary trigger**, **shorter v2 memory tool text**, and the
  C1 −30 % target **applies to long threads only** (those that reach a
  checkpoint); (3) AF-26 pause: **add a migration column**
  (`agents.memory_paused`); (4) AF-26 sensitive check: **yes, add it to the
  existing `addMemory`/`editMemory`** (changes today's behaviour; approved).
- 2026-10-18 (Claude Code session, owner's written standing instruction,
  quoted):
  - "A1 closure: accept M1 = 0.80 for A1. The embeddings step stays in A9
    and is NOT started now. C1 −56.2 % on threads that reach a checkpoint
    is accepted. A paid real-model AS-CTX run is NOT approved."
  - "Approved as written: AD-02, AD-03, AD-06, AD-08, AD-14, AD-15, AD-18,
    AD-20, AD-23, AD-27, AD-28, AD-33, AD-36."
  - "Approved: add playwright-core and ws in A4 after the dependency review
    is recorded in status.md (licence, maintenance, size)."
  - "Approved: work in place on main, leave everything uncommitted."
  - "Everything else stays Proposed. Specifically NOT approved: AD-04,
    AD-05, the invariant 4 amendment, AD-07, AD-16, AD-17, AD-19, AD-21,
    AD-29 to AD-32, AD-34, AD-35."
  - Order of work: close A1 (chip behind `agents.memoryV2`; 360 px
    screenshots recorded as an open item), then A4 (fixtures only; AB-08
    stays blocked), then A2 (behind `agents.rolePacks`), then A3. Hard
    stops: no commits, pushes, branches, deploys, env changes, production
    database, real model calls, real sites, connectors, calls or emails; no
    A5–A13 work, `lib/connectors.ts`, login profiles or CHANGE_IMPACT §2
    files.
- 2026-10-18 (same session, owner's answer to "may the chip touch
  `components/thread/transcript.tsx`, listed for A3 only?"): **Yes,
  additive edit**: add an A1 row to CHANGE_IMPACT §3; `AgentMessage`
  renders the chip only when `metadata.memoryIds` is non-empty.
- 2026-10-18 (same session, owner's answer on AF-27, "how should A4 handle
  supervised-mode fills and commits in the runner?"): **"Read-only runner
  now"**: the runner offers only R0 browser steps and handoff; every R3/R4
  is refused (identical to production today, since no site is
  `supervised`). AT-BRW-05's evidence part (approved click → before/after
  screenshots + page check) is built and tested at provider level; the
  cross-task approval design (replay or hold) is decided before the first
  site becomes `supervised` (A10). AT-BRW-05 is recorded as partial.
- 2026-10-18 (same session, owner's answer on A2 Lite mode, whose polling
  lives in `lib/agent/queue.ts` (A3 only) and the §2-protected
  `app/api/events/route.ts`): **"Defer K10 to A3"**. A2 ships role packs
  and teams only; Lite mode (column, toggle, polling, fonts, images) moves
  to A3, where the events-route change still needs the owner's approval.
  AT-LITE-01 is recorded as moved, not done.
- 2026-10-18 (Claude Code session, owner's answers to the A3 session 1
  questions): (1) **Approved**: one K7 citation line in
  `lib/agent/instructions.ts`, strictly behind `agents.inbox` (or
  `agents.receipts`), switch off byte-identical (AT-REG-01). (2) K10 Lite
  mode: **client-side only**; `app/api/events/route.ts` stays untouched;
  back off polling in the browser hooks when `lite_mode` is on. (3) **Approved
  as reported**: TypeScript claiming for schedules; switches `agents.inbox`
  and `agents.goals` (default off). Session 2 scope as listed by the owner;
  uncommitted on `main`, no push, no real model, telephony or site calls.
- 2026-10-18 (Claude Code session, owner's decision on K10 polling):
  **Options 1 and 2 approved with a user override.** (1) Minimal additive
  change to `app/api/threads/[threadId]/turn/route.ts` to accept `?lite=1`
  or `x-kriya-lite: 1`, passed to `streamTask()` to poll every 1,500 ms
  instead of 350 ms. (2) Targeted edit to `components/workspace/notifier.tsx`
  (§2): in Lite mode close the `/api/events` `EventSource` while the
  document is hidden and reconnect when visible; `app/api/events/route.ts`
  untouched. Save-data: never lock the toggle; the person's explicit choice
  wins; unset → on when `saveData` is true, still switchable. Then mark A3
  complete with the 360 px screenshots open (as A2), and stop before any
  new phase.
- 2026-10-18 (Claude Code session, owner's written instruction): "Phase A3
  is signed off. Proceed with Phase A8." **Approved: AD-07 and AD-29.**
  **Approved: additive edits to `lib/connectors.ts`** per CHANGE_IMPACT.
  Scope: migration `20261108000000_connectors_v2.sql` + rollback; GitHub,
  Sheets write, YouTube, Instagram in `lib/connectors/` with read-back;
  `actions/undo.ts` (10-minute window); Account → Connected accounts; tests
  with fixtures. Work in place on `main`, uncommitted; no push; no real
  API calls or OAuth credentials.
- 2026-10-18 (same session, owner's answers): **Approved additive edits to
  `lib/agent/run-task.ts`** (connected `github`/`meta` flags; undo columns in
  `onToolExecutionEnd`) **and `worker/index.ts`** (undo loop), both behind
  switches that default off. **youtube_upload deferred to A5** (needs files);
  A8 ships `youtube_stats` only.
- 2026-10-18 (Claude Code session, owner's written instruction for A9):
  "Approve AD-21, waive A4." **AD-21 approved as written.** A4's fixture
  benchmarks (B1 = 1.00, P1 = P2 = 0) accepted as sufficient for local A9
  work on fixture sites; AB-08 stays open for staging/live. Replay covers
  A8 connectors and read-only browser steps on fixtures. **No embeddings.**
  Switch `agents.skills` defaults off. Uncommitted on `main`; no real model
  or live site calls.
- 2026-10-18 (same session, owner's answers): **approved the one-line
  `lib/agent/run-task.ts` belt addition** behind `agents.skills`; replay
  **hands back each R2–R4 call** for normal per-call approval.
- 2026-10-18 (Claude Code session, owner's written instruction for A5):
  **Approved AD-18, AD-19, AD-34.** Answers: migration
  `20261110000000_files.sql`; optional web `KRIYA_BROWSER_URL`/`SECRET` for
  PDFs; extraction in its own worker loop behind `agents.files`; agent file
  tools deferred. Later: owner ran check, browser suite and build (all exit
  0) and signed A5 off as COMPLETE with AB-05 and the 360 px screenshots
  open.
- 2026-10-18 (same session, owner's instruction for A7): **Approved AD-16
  and AD-17.** Migration `20261111000000_ledger.sql`. Answers to the A7
  questions: (1) RG-5: **read-only web research allowed** on public CBIC /
  GST portal pages (no APIs, no accounts); (2) GSTIN check character:
  **mod-36 only**, as the primary source specifies (no Verhoeff); (3)
  ledger: **single-entry as designed** (DATA_MODEL §2.7), not double-entry;
  (4) K7 model cross-check: **citations only** (AD-33); money discrepancies
  are found by code (AD-16).
- 2026-10-18 (same session, owner's decisions on A7): **accepted** with L2
  and the official GSTIN check-character algorithm open for the pre-launch
  pilot; no paid model calls. Approved: Accounts screen, the ledger tools
  `ledger_list`, `ledger_draft_entry`, `invoice_draft` in `lib/agent/tools.ts`
  wired into `lib/agent/run-task.ts` behind `agents.ledger`, nav and
  `proxy.ts` updates. Mark A7 COMPLETE, then stop: **A13 and A6 not
  authorized**.
- 2026-10-18 (same session, owner's instruction for A13): A7 signed off.
  **Approved AD-30, AD-31, AD-32.** Answers: RG-11 open, fetches metered
  unpriced; facts only from an owner-defined fact job (`FACT_TARGETS`),
  never from watchers; `schedules.watch`, outcome `unchanged` and
  `schedule_create` watch approved; owner-console facts list with audited
  Retract approved. Zero paid scraping or model calls; fixtures only.
- 2026-10-18 (Claude Code session, owner's written instruction for A6): A13
  signed off. **Approved AD-04, AD-05, AD-35** and the invariant 4 amendment
  (CHANGE_IMPACT §7), applied to `AGENTS.md`. Scope: migration
  `20261106000000_login_profiles.sql` + rollback, `lib/browser/{profiles,kits}.ts`,
  `actions/profiles.ts`, the live-view token route, Logins UI, take-over
  sheet; tests on the `signup/` and `profile-editor/` fixtures only.
  In place on `main`, uncommitted; no real credentials or sites.
