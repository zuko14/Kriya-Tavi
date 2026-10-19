# Test strategy

Same tools as today: Vitest, PGlite with the Supabase shim
(`tests/db/harness.ts`), and the scripted `MockLanguageModelV4` used in
`tests/pipeline.test.ts`. No test makes a real call, a real model request or a
real STT/TTS request; those are separate, owner-approved commands
(EVALUATION_PLAN.md §7). `npm run check` must pass at the end of every phase.

Baseline before any voice work (2026-10-17, commit `bdf223f`): `npm run
check` passes in full (typecheck, lint, format, `npm test` **82 passed / 9
files**) after the local line-ending and `.prettierignore` fixes recorded in
`status.md`. **These 82 tests must keep passing unchanged in every phase**; a
voice change that needs an existing test edited needs the owner's approval.

## 1. Layers

| Layer | Tooling | Lives in | Runs |
| --- | --- | --- | --- |
| SQL: RLS, grants, transitions, claim/recover | PGlite + migrations | `tests/db/voice-*.test.ts` | `npm test` |
| Pure logic: schedule math, normalizers, spec validation, money | Vitest | `tests/voice/*.test.ts` | `npm test` |
| Provider adapters: parse/serialize, webhook parsing | Recorded (redacted) payload fixtures | `tests/voice/exotel.test.ts` | `npm test` |
| Dialogue engine and verifier | Scripted model + scripted callee (L-text) | `tests/voice/dialogue.test.ts` | `npm test` |
| Pipeline end to end | Mock telephony + mock STT/TTS + PGlite + worker and voice loops in-process | `tests/voice/pipeline.test.ts` | `npm test` |
| WebSocket service | `kriya-voice` started on an ephemeral port, mock provider client | `tests/voice/voice-service.test.ts` | `npm test` |
| Benchmarks | Real vendors | `scripts/voice-eval.ts` | Manual, paid |
| Live | Real Exotel calls to team numbers | Checklist in `status.md` | Manual, owner present |

## 2. Required tests by area

IDs are referenced from `status.md` phase exit criteria.

### State machines and data (Phase 1)

- **T-SM-01** every allowed edge in `voice_allowed_transitions` succeeds with
  the right actor and evidence.
- **T-SM-02** every rejected example in DATA_MODEL §3.3 is refused.
- **T-SM-03** out-of-order and duplicate events return false, change nothing,
  and write no `voice_transitions` row.
- **T-SM-04** direct status updates are refused: as `authenticated` (no grant)
  and as the privileged role (trigger).
- **T-SM-05** `completed` requires a delivered report or `report_requested =
  false`; `awaiting_report` requires a verified attempt.
- **T-RLS-01…n** for each voice table: no cross-user select/update/delete;
  forged `user_id` refused; token-hash columns not selectable;
  `call_suppressions`, `phone_verifications`, `voice_access` unreadable.
- **T-DB-01** composite FKs refuse a call/attempt pointing at another user's
  task.
- **T-LOG-01** `lib/log.ts` redacts +91 and 10-digit mobile numbers.

### Queue and durability (Phase 3)

- **T-Q-01** claim respects `available_at`, `not_before`, per-user live-call
  limit, global concurrency, and skips locked rows (two concurrent claimers get
  different calls).
- **T-Q-02** an attempt is `requested` and committed before `placeCall` is
  invoked (mock asserts the DB state when it's called).
- **T-Q-03** worker dies after `requested`, provider has the call → reconciled
  to `initiated`, no second `placeCall`.
- **T-Q-04** worker dies after `requested`, provider has no record → outreach
  `unknown` → task `needs_owner`; **no** second `placeCall`.
- **T-Q-05** busy → retry after the configured gap, within the window, at most
  `max_attempts`; outside calling hours → waits for the next window or
  `exhausted`.
- **T-Q-06** cancel while scheduled / dialing / connected → no further dials;
  live call gets `hangup()` within one heartbeat.
- **T-Q-07** idempotent create and confirm (same key → same task; confirm twice →
  one set of calls).
- **T-Q-08** limits: daily outreach count, per-number counts, suppression
  checked at confirmation **and** at claim.
- **T-WH-01** webhook with unknown token → 404, nothing stored.
- **T-WH-02** duplicate webhook → one `call_events` row, one transition.
- **T-WH-03** terminal webhook triggers verification; API disagreement → API wins.
- **T-WH-04** `proxy.ts` lets the webhook path through without Origin and still
  refuses other cross-site POSTs.

### Dialogue and verification (Phase 4)

- **T-DLG-01** opening disclosure is the fixed text, never model output, and is
  repeated if interrupted.
- **T-DLG-02** tools outside the current state are rejected.
- **T-DLG-03** `note_agreement` refused without a matching read-back + yes.
- **T-DLG-04** time outside `acceptable` can only become a proposal.
- **T-DLG-05** barge-in: `speech_started` → `clear` sent, TTS aborted,
  `interrupted` recorded, `played_ms` from marks.
- **T-DLG-06** budgets: duration, turns, tool calls per turn, escalation once.
- **T-DLG-07** injection and sensitive-request scenarios (S21–S24) make no
  tool calls beyond notes; OTP-like digits redacted in stored turns.
- **T-VER-01…08** as listed in EVALUATION_PLAN.md §6.
- **T-NORM-01** time/date normalizer table: "3", "3 pm", "half past three",
  "15:30", "tomorrow", "next Friday", near-midnight cases, owner timezone ≠ IST.

### Reminders (Phase 6)

- **T-REM-01** report call created at authorization; idempotent.
- **T-REM-02** delivered only after the final mark while connected; answered
  alone isn't delivered.
- **T-REM-03** hang-up mid-report → retry; attempts bounded; quiet hours
  respected; `exhausted` → task `unreported`.
- **T-REM-04** wrong-person answer → no task details spoken (assert TTS text).
- **T-REM-05** voice cancel/postpone → repeat-back required; transitions
  recorded with `actor = 'owner'` and turn evidence.
- **T-REM-06** "call him again" → draft only; no `voice_calls` created.
- **T-REM-07** a missed report creates no notification, no `/api/events` event,
  and calls no SMS/email/push code (spy on modules; grep test that
  `lib/voice/**` imports none of them).
- **T-REM-08** verification call: correct DTMF code verifies; 3 wrong tries
  fail; expiry.

### UI (Phase 7)

- **T-UI-01** confirmation renders from the server payload; editing invalidates
  the approval (`stale_approval` path).
- **T-UI-02** at 360 px no horizontal scroll on `/calls/[taskId]`; touch
  targets ≥ 44 px (checked in a browser session; record screenshots in
  `status.md`).
- **T-UI-03** mic denied / unsupported paths show the right messages; text
  input still works.

### Cost (Phase 8)

- **T-COST-01** every attempt, including busy/no-answer, gets a telephony
  usage row; unpriced → null cost, counted unmetered.
- **T-COST-02** idempotent `request_key`s under duplicate delivery.
- **T-COST-03** mixed INR/USD summing in `lib/money.ts`; rounding.
- **T-COST-04** one charge per voice task, including failed/cancelled tasks;
  repricing only changes estimated/unpriced.
- **T-COST-05** `usageSummary` includes voice charges; allowance blocks
  confirmation.
- **T-COST-06** daily platform cap stops claims.

### Security (Phase 9)

- **T-SEC-01** stream token reuse, wrong `call_sid`, missing Basic auth →
  connection closed, attempt untouched.
- **T-SEC-02** no secrets or numbers in logs during a full pipeline run (capture
  log output, scan for patterns).
- **T-SEC-03** client bundle contains no `EXOTEL_`/vendor key names (build and
  grep `.next/static`).
- **T-SEC-04** emergency stop and `voice.liveCalls = off` stop new dials within
  the settings cache window.
- **T-SEC-05** `kriya-voice` can't read threads, memories or connections (its
  queries are limited to the attempt's task; code review + test with a second
  user's data present).

### Regression guards for the existing product

From CHANGE_IMPACT_AND_SAFETY.md. Each protects something that works today.

- **T-FK-01** (Phase 1) deleting a thread that a voice task points at succeeds
  and sets only `voice_tasks.thread_id` to null; deleting a parent task sets
  only `parent_task_id` to null; deleting the auth user cascades everything
  (finding F1).
- **T-DB-02** (Phase 1) every column in the voice migration exists in
  `db/schema.ts` with the same nullability (query `information_schema` on
  PGlite, compare with the Drizzle table config).
- **T-MIG-01** (Phase 1) voice down then up on PGlite; then core down + up still
  passes (F2).
- **T-ENV-01** (Phase 2) `checkEnvironment("worker")` with no voice variables
  doesn't throw in production mode.
- **T-CFG-01** (Phase 2) every new `voice.*` setting has a `pattern` or is
  listed as free text in its `hint`.
- **T-IMP-01** (Phase 2, extended each phase) the import graph from
  `voice/index.ts` and `worker/index.ts` contains no `server-only`, `next/*`,
  `lib/auth`, `lib/supabase`, `lib/rate-limit`, `lib/owner` (F7).
- **T-WRK-01** (Phase 3) with voice calls dialing in the mock, agent tasks are
  still claimed and finish; a thrown error in the voice loop doesn't stop the
  agent loop (F6).
- **T-AGT-01** (Phase 4) `propose_call` is absent from the tool set and from
  the instructions for a user without voice access, present with it (F5).
- **T-AGT-02** (Phase 4) instructions snapshot with and without voice; the
  existing text is byte-identical for users without voice (F4).
- **T-POL-01** (Phase 4) every attempt row has `policy_version`; the engine
  takes prompts and thresholds only from the loaded bundle.
- **T-OWN-01** (Phase 8) owner console queries for voice never select
  `conversation_turns.text` or outcome text (static check of the query
  builders + a test with a canary string).

## 3. Mock provider contract

`lib/voice/mock.ts` implements `TelephonyProvider`, `SpeechRecognitionProvider`
and `SpeechSynthesisProvider` from a scenario file (EVALUATION_PLAN.md §1):
emits status events with timings, optional duplicates/out-of-order, a scripted
callee (text for L-text, PCM for the voice-service test), failures on demand,
and records every `placeCall`/`hangup` for assertions. The same scenario files
drive tests and the paid evaluations.

## 4. Rules

- A test exists and passes **before** the code path that has an external side
  effect is enabled (AGENTS.md, voice rules).
- Fixtures from real providers are redacted (numbers masked, ids replaced) before
  commit.
- Tests never sleep for real seconds; inject a clock into `lib/voice/schedule.ts`
  and use database `now()` overrides where needed.
- A failing test is reported with its output in `status.md`; never skipped to
  mark a phase complete.
