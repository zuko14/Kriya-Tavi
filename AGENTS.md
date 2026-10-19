# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Product invariants — never break these

1. **Tenant isolation.** Anything done on a person's behalf goes through
   `withUser(userId, …)` (`db/index.ts`), so Row Level Security applies. Use
   `privileged` only for bookkeeping that has its own authorization check
   (worker leases, metering, verified webhooks, `requireOwner()`), and always
   scope it by user id explicitly.
2. **The `kriya` schema is never exposed** through Supabase's Data API. New
   tables go in `kriya`, with RLS enabled and a policy, in a new migration
   under `supabase/migrations/` (never edit an applied one). Add a test to
   `tests/db/`.
3. **Identity comes from the session only** (`requireUser`, `authenticate`,
   `requireOwner` in `lib/auth.ts`). Never trust a user id, role, plan or
   price from the browser.
4. **Secrets are environment-only.** Never store one in the database, return
   one from a server action, render one, or log one. `lib/log.ts` redacts,
   but don't rely on it. The exceptions are the OAuth tokens of connected
   accounts and the login profiles of the agent browser (sealed browser
   session state). Both are stored only as ciphertext from `lib/secrets.ts`
   (key in `KRIYA_TOKEN_KEY`) and are never selectable by the person's
   session. Tokens are opened only in `lib/connectors.ts`; login profiles
   only in `lib/browser/profiles.ts`, and are passed only to `kriya-browser`
   for one session.
5. **Agents act only through tools in `lib/agent/tools.ts`.** A tool that
   changes anything outside Kriya goes in `SIDE_EFFECT_TOOLS`, needs an
   approval step, and must never run on the web server.
6. **Money is integers.** Micro-USD, micro-INR and paise in `bigint`; math in
   `lib/money.ts`. Keep reported cost, estimated cost and customer charge
   apart. Never invent prices or exchange rates.
7. **Limits are enforced on the server** (`lib/entitlements.ts`, SQL), never
   only in the UI.

## Stack

- Next.js 16 (App Router, Turbopack). Read the bundled docs in
  `node_modules/next/dist/docs/` before using a Next API (e.g. `proxy.ts`
  replaces middleware).
- AI SDK 7: `instructions` (not `system`), `isStepCount`, `onEnd`/`onStepEnd`.
  Docs in `node_modules/ai/docs/`.
- Supabase: Auth through `@supabase/ssr` (`getClaims()`), Postgres through
  Drizzle on `postgres` (async queries). Types in `db/schema.ts` mirror the SQL
  migrations, which are the source of truth.
- UI primitives in `components/ui` (Base UI). Buttons rendering links need
  `nativeButton={false}`.

## Commands

```bash
npm run dev           # web, :6796
npm run dev:worker    # worker
npm test              # vitest + PGlite
npm run check         # typecheck + lint + format check + tests — run before finishing
npm run build
npm run db:migrate    # apply supabase/migrations (MIGRATION_DATABASE_URL)
```

## Conventions

- Mutations go through `actions/*.ts` (`"use server"`): authenticate, validate
  with zod, write through `withUser`.
- Reads for server components go in `queries/`.
- Platform settings: add keys to `SETTINGS` in `lib/config.ts`; owners edit
  them in `/owner/config`.
- Tools: add to `lib/agent/tools.ts`, render in `components/thread/tool-call.tsx`,
  label in `components/workbench/activity.tsx`.
- Client components must not import server modules (`db`, `lib/config`,
  `lib/models`); use `lib/tiers.ts` and friends.
- Styling: tokens in `app/globals.css` (`rigel` = Kriya indigo, `betelgeuse` =
  saffron, `label-mono` for small caps metadata). Mobile first: 44px touch
  targets, test at 360px wide.
- Conventional Commits.

## Testing changes that call models

Model calls cost money. Use the scripted model in `tests/pipeline.test.ts`
for behaviour; use `npm run models:eval` (three short requests) only to
qualify a real model.

## Voice assistant (phone calls)

Planned in `docs/voice-assistant/`; progress in the root `status.md`.

1. Before each session, read `status.md` and the documents its current phase
   names. Implement only that phase; small prerequisite fixes are allowed if
   recorded in `status.md`.
2. Check `git status` first and preserve the person's uncommitted changes. No
   sweeping refactors or rewrites of existing workflows without approval.
   Before editing any existing file, read
   `docs/voice-assistant/CHANGE_IMPACT_AND_SAFETY.md`: only the changes listed
   there are allowed; anything else needs the person's approval first.
3. Commit, branch, push or deploy only when the person authorizes it. Never
   push to the `origin` remote. Never modify production data.
4. Add and pass tests before enabling any new external side effect.
5. No real phone call, real STT/TTS request or paid benchmark without the
   person's explicit go-ahead. Live calls stay behind `KRIYA_VOICE_LIVE`,
   `voice.liveCalls`, the voice allow-list and the test-number allow-list until
   Phase 9 is signed off.
6. Never fabricate test results, call outcomes, costs, prices or provider
   behaviour. Unknowns are written down as unknowns with a verification step.
7. Provider secrets stay in the environment: never in source, browser bundles,
   transcripts or logs. Phone numbers are personal data: never logged.
8. Voice status changes only through `kriya.voice_transition()`. Neither the
   browser nor a model may set a task or call to completed.
9. The live-call model acts only through `createCallTools()` in
   `lib/agent/tools.ts`: notes on the current call and `end_call`. These run in
   `kriya-voice`, never on the web server, and no in-call tool may place calls,
   send messages or read other data. The call itself is the side effect the
   owner approved; calls are placed only by `kriya-worker`.
10. Owner reminders are phone calls only. Never add push, SMS, WhatsApp or
    email fallbacks.
11. Improvement is a governed loop (`docs/voice-assistant/SELF_IMPROVEMENT.md`):
    never let production behaviour change itself; safety guards, limits, state
    machines and the AI disclosure are never tuned by it.
12. At the end of a session update `status.md`: changed files, commands run
    and their real output, blockers, and the next exact action. Don't mark a
    phase COMPLETE until its exit checks pass.

## Agent platform (track A)

Role teams that act, remember, work in the background and prove what they
did. Planned in `docs/agent-platform/`; progress in the root `status.md`
(phases `A0`–`A13`). Start from `docs/agent-platform/AGENT_MASTER_PROMPT.md`.
Voice rules 2, 3, 6, 7 and 12 apply to this track too.

1. Before editing any existing file, read
   `docs/agent-platform/CHANGE_IMPACT_AND_SAFETY.md`: only the changes listed
   there are allowed. Both tracks share the coordination board in `status.md`.
2. Every new capability ships behind a switch that defaults off. Off means
   existing agents get the same prompt and tools as before (AT-REG-01).
3. Risk classes (R0–R5) are decided by code in `lib/agent/policy.ts`, never
   by a model. R2–R4 need the person's approval of the exact action. R5
   (passwords, OTPs, CAPTCHAs, payments, identity documents, filing returns)
   never exists as a tool: the person takes over.
4. Agents never create, store, see or type a site password. Login profiles
   (sealed browser sessions) need decision AD-05 **and** the invariant 4
   amendment before any code stores one.
5. Official APIs first. The browser obeys each site's mode in
   `lib/browser/sites.ts`; unknown sites are read-only. No scraping of other
   people, no bulk actions, no bot-detection evasion.
6. `kriya-browser` has no database access and no secrets except its own
   service secret. Its egress guard is never relaxed. Browser tests use the
   fixture sites only; no real site in `npm test`.
7. "What I did" is derived from verified tool executions, never from model
   text.
8. Memory written after untrusted content stays unconfirmed until the person
   confirms it. Sensitive values (cards, Aadhaar, OTPs, passwords, bank
   details) are never stored in memory.
9. Agents extract money figures; `lib/ledger.ts` computes them and SQL checks
   them. Only the person confirms entries. Kriya never pays and never files
   returns.
10. Reminders the person asks for are phone calls (voice rule 10). Approvals
    use the existing in-app notifier only.
11. Some actions are the person's alone and never become agent tools:
    confirming ledger entries, approving skills, trusting memory, creating
    share links, undo, and caps. Agent tools and the person's actions share
    one database identity under `withUser`, so this boundary is enforced in
    code (test AT-POL-07), not by RLS.
12. The public facts commons (`kriya.public_facts`) holds no personal data
    and is written only by the fact job from domains in `kriya.fact_sources`,
    with a verbatim quote and two agreeing fetches. Never write to it from a
    user's task, and never claim a competitor lacks a feature without RG-9.
