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
   but don't rely on it. The one exception is the OAuth tokens of connected
   accounts: stored only as ciphertext from `lib/secrets.ts` (key in
   `KRIYA_TOKEN_KEY`), never selectable by the person's session, opened only
   in `lib/connectors.ts`.
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
