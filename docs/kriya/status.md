# Status: what's done, what's verified, what's left

Branch `kriya-saas`. "Verified" means checked by an automated test or a
command run during development. "Unverified" means written but never run
against the real service, because no credentials were available.

## Stage A — SaaS foundation

| Criterion | Status |
| --- | --- |
| Postgres schema, migrations, rollback | Done. Migration and rollback verified on PGlite (`tests/db/migrations.test.ts`). **Not yet applied to a real Supabase project** |
| RLS on every tenant table, cross-user tests | Done, verified: per-table read/update/delete isolation, forged ownership, cross-user foreign references, column grants on profiles, closed platform tables (`tests/db/rls.test.ts`) |
| Authentication end to end | Code done (sign-up, confirm, sign-in, reset, sign-out, onboarding, deletion, suspension). **Unverified against Supabase Auth**: needs a project |
| Kriya branding and responsive shell | Done: brand mark, tokens, landing, auth, onboarding, account, bottom tabs on mobile, Activity sheet. Built, but **not yet looked at in a phone browser** |
| App still runnable | Production build passes; worker process starts and fails cleanly without a database |

## Stage B — Agent SaaS conversion

| Criterion | Status |
| --- | --- |
| Hosted model gateway | Done (OpenRouter, tiers, fallback, escalation, usage extraction). **No real model call made**: no OpenRouter key was available. `npm run models:eval` is the first thing to run |
| Validated inexpensive model | **Not done.** Candidates from the live catalogue (16 Oct 2026): `deepseek/deepseek-v4-flash` ($0.091 / $0.182 per M tokens, tools + structured output declared), `google/gemini-3.1-flash-lite` ($0.25 / $1.50, also images). Declared support isn't proof; run the eval |
| Conversations and tasks in Postgres | Done, verified (`tests/pipeline.test.ts`) |
| Durable background execution | Done, verified on PGlite: claim, lease, heartbeat, worker-death recovery with backoff, no retry after side effects, deadline expiry, per-user concurrency (`tests/db/queue.test.ts`) |
| Streaming and cancellation | Stream replay verified; owner-only replay verified. Cancellation path written; the live heartbeat-driven stop is **not exercised by a test** |
| Existing features in the new model | Memory, web research, squads, delegation kept. Shell, desktop, vault, Telegram removed from the hosted product (see architecture) |

## Stage C — Metering and administration

| Criterion | Status |
| --- | --- |
| Every model request reconciled to a task | Done, verified: one idempotent `usage_events` row per call with task, attempt, model, tokens, provider cost |
| Idempotent usage and cost | Verified (duplicate deliveries, resent messages, one charge per task) |
| Owner console on real data | Done: overview, finance, users, config, operations, audit, all from SQL aggregates. **Not opened against real data yet** |
| Owner access protected | Done: role table writable only by the bootstrap script; every page and action re-checks; 404 for others. Not covered by an automated HTTP test |
| Plans and quotas enforced server-side | Verified for the daily task limit (`tests/pipeline.test.ts`) and concurrency (`tests/db/queue.test.ts`). Allowance and agent limits written, not individually tested |

## Stage D — Execution capabilities

| Criterion | Status |
| --- | --- |
| Browser tasks through an isolated provider | **Not started.** Deliberately disabled rather than faked |
| Reusable skills | **Not started** |
| Persistent memory | Done (inspect, edit, delete, source marked) |
| Policy-based approval for sensitive actions | Mechanism in place (side-effect classification, no-retry rule); no consequential tools exist yet, so no approval UI |
| Evidence for consequential operations | Every tool call is recorded with inputs (redacted), outcome and timing |
| Worker failures and retries tested | Verified (recovery, fallback after provider failure, deadline) |

## Stage E — Commercial launch readiness

| Criterion | Status |
| --- | --- |
| Billing adapter and webhooks in test mode | Done, verified: signature, duplicates, out-of-order events, payment recorded once, plan switches and lapses (`tests/billing.test.ts`). Razorpay API calls **unverified** without keys |
| Mobile UX on real or emulated browsers | **Not verified** |
| Production build and regression tests | Pass (see below) |
| Environment and deployment docs | Done (`deployment.md`) |
| Security review and risks documented | Self-review only; documented in `security.md`. No external review |
| Rollback and recovery tested | Schema rollback tested on PGlite. Render rollback and backup restore **not rehearsed** |

## Test results

Run on 16 Oct 2026, Windows, Node 24, PGlite 0.5:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run format:check` | Pass |
| `npm test` | **56 passed, 0 failed** (6 files: RLS 23, queue 12, migrations 2, pipeline 5, billing 7, money 7) |
| `npm run build` | Pass, 31 routes, no environment needed |
| Worker start without a database | Starts, warns about optional settings by name, exits on the first query with a structured error |

The pipeline tests found two real bugs, both fixed: provider failures weren't
recognised after the SDK's own retries (`RetryError`), so fallback never
happened; and a resent message raised an error instead of returning its task.

## Blockers needing the owner

1. **A Supabase project** (staging first): to apply the migration and test
   sign-up, email links, RLS through the real pooler, and account deletion.
2. **An OpenRouter key**: to run `npm run models:eval` and choose tier
   models from what actually passes.
3. **A Render account** with the repository connected, and a domain.
4. **Firecrawl key** for web research.
5. **Razorpay** test keys, plans and webhook, for paid plans.
6. **Decisions**: plan prices and limits, markup, FX source, support email,
   and reviewed legal terms. None were invented.
7. **The git remote** still points at the upstream project
   . Create Kriya's own repository before pushing,
   and update `.github/CODEOWNERS`, which still names the upstream author.
8. **`.env.example`** is still the old local app's: a local guardrail blocks editing it.
   The variables are listed in `deployment.md`.

## Roadmap

In priority order, after launch blockers:

1. **Isolated browser provider.** A separate service with one short-lived
   Chromium context per task, egress policy, screenshots as evidence, and an
   approval card before submitting forms, paying or sending messages.
2. **Approval inbox.** One place on the phone for everything waiting on the
   person, with push notifications.
3. **Skills.** Save a successful task as a reusable, inspectable, approvable
   procedure; run it on a schedule.
4. **Scheduled and recurring tasks** with budgets ("every Monday, summarise…").
5. **Files.** Upload PDFs and spreadsheets to a task (Supabase Storage,
   per-user buckets, virus scanning).
6. **Live updates without polling** (Supabase Realtime) and push
   notifications through the web app manifest.
7. **Telugu, Hindi and Hinglish voice**: server-side speech recognition for
   browsers without it, with editable transcripts.
8. **WhatsApp channel**, rebuilt per user with webhooks (replacing the old local app's
   single-owner Telegram bridge).
9. **Team workspaces**: shared agents, roles, a shared budget.
10. **Vertical agent packs** (exam prep, GST paperwork, freelancing) built on
    the same core.
