# Repository audit for the voice assistant

Audited 2026-10-17 at commit `bdf223f` on `main`. The working tree was clean (no
uncommitted changes to preserve). Remotes: `kriya` →
`github.com/zuko14/Kriya-Tavi`, `origin` → the upstream project. This audit
changed no application code.

## 1. What exists today

Kriya Tavi is a Next.js 16 web app plus a Node worker on Render, around one
Supabase project. Agents run on OpenRouter models with web research, memory,
squads and connected Google/Notion accounts. Full description:
`docs/kriya/architecture.md`.

| Area | Real files | State |
| --- | --- | --- |
| Auth and identity | `lib/auth.ts` (`getSessionUser`, `requireUser`, `authenticate`, `requireOwner`), `lib/supabase.ts`, `proxy.ts`, `actions/auth.ts` | Built; identity only from `getClaims()` |
| Tenant isolation | `db/index.ts` (`withUser`, `privileged`); RLS in `supabase/migrations/20261016000000_kriya_core.sql` | Built and tested (`tests/db/rls.test.ts`) |
| Schema | `supabase/migrations/20261016…`, `20261017…`, `20261018…`; mirrored in `db/schema.ts` | Three migrations; not yet applied to a real Supabase project (`docs/kriya/status.md`) |
| Durable queue | SQL `kriya.claim_task`, `kriya.heartbeat_task`, `kriya.recover_tasks`; `lib/agent/queue.ts` (web side); `worker/index.ts` (loop); `lib/agent/run-task.ts` (runner) | Built and tested on PGlite (`tests/db/queue.test.ts`) |
| Side-effect safety | `SIDE_EFFECT_TOOLS` in `lib/agent/tools.ts`; `toolApproval` in `run-task.ts`; `recover_tasks` never requeues a task that ran one | Built |
| Approvals | `enqueueApproval` in `lib/agent/queue.ts`; `app/api/threads/[threadId]/approvals/route.ts`; approvals live inside message parts | Built, for tool calls in a thread |
| Evidence | `kriya.tool_executions` (redacted input, outcome, timing) | Built |
| Model gateway | `lib/models.ts` (tiers, `modelForTier`, `fallbackModel`, `createGatewayModel`, OpenRouter usage extraction) | Built; **no real model call made yet** |
| Metering | `lib/agent/metering.ts` (`recordUsage`, `chargeTask`, `repriceTask`); `kriya.usage_events`, `kriya.charges` | Built; keyed to `kriya.tasks` rows |
| Money | `lib/money.ts` (micro-units in BigInt, `parseRate`, `usdToInr`, `applyMarkup`) | Built and tested (`tests/money.test.ts`) |
| Limits | `lib/entitlements.ts` (`usageSummary`, `checkTaskAllowed`); plan columns in `kriya.plans` | Built |
| Platform settings | `SETTINGS` in `lib/config.ts`; `/owner/config` | Built |
| Secrets | `SECRETS` in `lib/config.ts`; `lib/secrets.ts` (AES-256-GCM `seal`/`open`) | Built |
| Logs | `lib/log.ts` (JSON lines; key- and value-based redaction) | Built |
| Rate limits | `lib/rate-limit.ts`; `kriya.hit_rate_limit` | Built |
| Webhooks | `app/api/billing/webhook/route.ts` (HMAC check, dedupe by event id); `WEBHOOKS` in `proxy.ts` exempts it from the Origin check | Built |
| Live status | `/api/events` (SSE, polls `kriya.tasks` every 3 s); `streamTask` polls `kriya.task_events` every 350 ms | Built (polling) |
| Browser voice | `components/thread/dictation.ts` (Web Speech API, on-device where available) used by `composer.tsx`; `Permissions-Policy: microphone=(self)` in `next.config.ts` | Built: dictation into the text box only |
| Notifications | `components/workspace/notifier.tsx` (sound, browser notification, card) | Built; driven by `kriya.tasks` |
| Owner console | `app/owner/*`, `lib/owner.ts`, `actions/owner.ts` | Built |
| Tests | Vitest + PGlite: `tests/db/harness.ts` (Supabase shim); `tests/pipeline.test.ts` (scripted `MockLanguageModelV4`) Re-run 2026-10-17: **82 passed, 9 files**; typecheck and lint pass |
| Deployment | `render.yaml`: `kriya-web` (web) and `kriya-worker` (background worker), Singapore | Defined; not yet deployed per `docs/kriya/status.md` |

**Telephony, server-side STT and TTS: none.** Searching `app`, `lib`,
`components`, `actions`, `worker` and `db` for "phone", "telephon", "exotel"
and "speechSynthesis" finds only marketing copy, a template prompt about phone
numbers, navigation comments, and `formatDetection: { telephone: false }` in
`app/layout.tsx`.

## 2. What the voice feature reuses as is

- `withUser` / `privileged` and the RLS policy patterns (`own_rows`,
  `read_own`), including the composite foreign keys `(id, user_id)` that stop
  cross-tenant references in the database itself.
- The queue pattern: claim with `FOR UPDATE SKIP LOCKED` and a per-user advisory
  lock; lease + heartbeat; recovery that refuses to repeat side effects.
- `lib/money.ts` for every amount; from `kriya.usage_events`, the idea of a
  `request_key` for idempotency and "missing is null, never zero".
- `SETTINGS` in `lib/config.ts` for new platform switches (`voice.liveCalls`, …)
  and `SECRETS` for provider keys.
- `lib/log.ts` for structured logs (extended to redact phone numbers).
- `lib/rate-limit.ts` for burst limits on voice endpoints.
- The webhook pattern of `app/api/billing/webhook/route.ts`.
- `createGatewayModel` and the tier mapping, for the in-call LLM.
- `useDictation`, for "speak to Tavi" in the browser.
- The PGlite harness and the scripted-model approach of `tests/pipeline.test.ts`.

## 3. Gaps and required changes

| # | Gap | Why it matters | Where it gets fixed |
| --- | --- | --- | --- |
| G1 | No service can accept an inbound WebSocket: Render background workers take no inbound traffic, and Next route handlers don't upgrade | Bidirectional call audio needs a public `wss://` endpoint | New `kriya-voice` service (D-03): `voice/index.ts`, `render.yaml` |
| G2 | No phone number, timezone or calling preferences on `kriya.profiles` | Owner reminders need a verified number and a timezone | New `kriya.voice_profiles` (Phase 1) |
| G3 | `kriya.tasks` requires a thread, a tier and a step budget, one active per thread | Voice tasks span hours and several calls | New voice tables and `claim_voice_call` (D-05) |
| G4 | `recordUsage` / `chargeTask` key on `kriya.tasks.id`; `usage_events` is shaped for tokens | Telephony minutes, STT seconds and TTS characters, priced in INR or USD | New `kriya.voice_usage`, `kriya.voice_charges` (COST_AND_METERING.md) |
| G5 | `usageSummary` sums only `kriya.charges` | Voice spend must count against the plan allowance | Extend `usageSummary` to include `voice_charges` (Phase 8) |
| G6 | No plan columns for voice | Limits must be enforced on the server | New `kriya.plans` columns (Phase 1) |
| G7 | `proxy.ts` refuses non-GET requests without the app's `Origin`, except `/api/billing/webhook` | Exotel status callbacks would get a 403 | Add the `/api/voice/exotel/` prefix to `WEBHOOKS` (Phase 5) |
| G8 | `lib/log.ts` doesn't redact phone numbers | Numbers are personal data | Add a phone-number pattern to its value redaction (Phase 1) |
| G9 | `/api/events` and the notifier raise browser notifications for `kriya.tasks` | D-07 forbids non-call reminders for voice | Keep voice state out of `/api/events`; a test asserts it (Phase 6) |
| G10 | Approvals are parts of thread messages | Confirming a call needs its own record with the exact parameters | `kriya.voice_approvals` + `actions/voice.ts` |
| G11 | Live status is polled | A live-call panel polled every 350 ms per viewer is fine only at low scale | Reuse polling first (as threads do); Realtime later (`docs/kriya/security.md`, risk 3) |
| G12 | No error monitoring or paging | A reminder stuck at 6 PM must get noticed | Phase 8: alert queries in `/owner/operations` + log-drain alerts |
| G13 | Open blockers in `docs/kriya/status.md`: migrations not applied to Supabase, no OpenRouter key run, no Render deploy | Voice depends on all three | Listed as blockers in `status.md` |
| G14 | `.env.example` couldn't be read in this audit (a local guardrail blocks it) | New variables must be documented | Phase 2 lists them in `docs/kriya/deployment.md`; the owner updates `.env.example` |

## 4. Files expected to change or be added

Paths for new files are proposals that follow the existing conventions.

| Path | Change | Phase |
| --- | --- | --- |
| `supabase/migrations/20261020000000_voice_core.sql` | New: voice tables, RLS, transition function, claim/heartbeat/recover functions | 1 |
| `supabase/rollback/20261020000000_voice_core.down.sql` | Rollback, tested like `tests/db/migrations.test.ts` (whose RLS-on-every-table check covers new tables automatically) | 1 |
| `db/schema.ts` | Mirror the new tables | 1 |
| `tests/db/voice-rls.test.ts`, `tests/db/voice-transitions.test.ts` | New | 1 |
| `tests/db/voice-queue.test.ts` | New | 3 |
| `lib/voice/providers.ts` | Provider interfaces | 2 |
| `lib/voice/mock.ts` | Mock telephony, STT and TTS | 2 |
| `lib/voice/audio.ts` | PCM framing, resampling, chunking to 320-byte multiples | 2 |
| `voice/index.ts` | New `kriya-voice` service entry point | 2 |
| `lib/voice/schedule.ts` | Calling windows, quiet hours, retry timing | 3 |
| `lib/voice/tasks.ts` | Create, confirm and cancel voice tasks (web side, like `lib/agent/queue.ts`) | 3 |
| `lib/voice/run-call.ts` | Worker side: claim a call, place it, follow it | 3 |
| `worker/index.ts` | A second claim loop for voice calls | 3 |
| `actions/voice.ts` | Server actions | 3, 7 |
| `lib/voice/languages.ts` | Language registry (D-11) | 4 |
| `lib/voice/dialogue.ts` | Bounded dialogue engine | 4 |
| `lib/voice/outcome.ts`, `lib/voice/verify.ts` | Outcome extraction and verification | 4 |
| `lib/voice/stt/<vendor>.ts`, `lib/voice/tts/<vendor>.ts` | Adapters for the vendors chosen by benchmark | 4 |
| `lib/agent/tools.ts` | `createCallTools()` (in-call) and `propose_call` (draft from a thread) | 4 |
| `lib/voice/exotel.ts` | Real Exotel adapter | 5 |
| `app/api/voice/exotel/status/[token]/route.ts` | Status webhook | 5 |
| `proxy.ts` | Add `/api/voice/exotel/` to `WEBHOOKS`; add `/calls` to `PROTECTED` | 5, 7 |
| `lib/voice/owner-report.ts` | Owner report script and voice commands | 6 |
| `queries/voice.ts` | Reads for pages | 7 |
| `app/(workspace)/calls/...` | UI pages | 7 |
| `app/api/voice/tasks/[taskId]/stream/route.ts` | Live status (SSE) | 7 |
| `components/voice/*` | UI components | 7 |
| `lib/voice/metering.ts` | Voice usage and charges | 8 |
| `lib/entitlements.ts` | Voice limits (Phase 1) and voice spend (Phase 8) | 1, 8 |
| `lib/config.ts` | `voice.*` settings; `EXOTEL_*` and STT/TTS keys in `SECRETS` | 2 |
| `lib/env.ts` | A `voice` service with its own checks | 2 |
| `lib/log.ts` | Phone-number redaction | 1 |
| `render.yaml` | The `kriya-voice` service and new variables | 2 |
| `package.json` | `ws` (after review), `dev:voice` and `voice` scripts | 2 |
| `AGENTS.md` | Voice rules | 0 (done) |

## 5. Risks found in the repository itself

1. **Nothing is deployed or verified against real services yet**
   (`docs/kriya/status.md`). Voice must not be the first thing to touch a
   production Supabase project; the Stage A–C blockers come first.
2. **Region.** Render runs in Singapore; Exotel's API host for India is
   `api.in.exotel.com`. Audio crosses Singapore↔India plus the STT/TTS vendors'
   regions. This must be measured (EVALUATION_PLAN.md, L1). Whether Render
   offers an India region was not verified.
3. **Pool sizes.** `DB_POOL_MAX` is 10 on web and 6 on the worker. A voice
   service that held a transaction per call would exhaust a small pool. Rule: no
   transaction stays open across audio; writes are short.
4. **Side effects on recovery.** `recover_tasks` semantics must be copied
   faithfully: a call whose provider request was _sent_ may have rung someone,
   so recovery reconciles with the provider before any retry
   (VOICE_REMINDERS.md §6).
5. **The `origin` remote still points at the upstream project.** Never push
   voice work there.
