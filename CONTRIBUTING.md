# Contributing to Kriya Tavi

## Ground rules

Read [AGENTS.md](AGENTS.md) first: its invariants (tenant isolation, secrets,
server-side limits, integer money) apply to every change. Be kind; see the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

See [Local development](README.md#local-development). Use your own Supabase
development project; never point local code at production.

## Making a change

1. Branch from `main`.
2. Schema change? Add a new file in `supabase/migrations/` (timestamped,
   never edit an applied one), update `db/schema.ts`, add RLS and a test in
   `tests/db/`.
3. Behaviour change in tasks, metering or billing? Extend
   `tests/pipeline.test.ts` or `tests/billing.test.ts`.
4. UI change? Check it at 360px wide, in both themes, with the keyboard.
5. `npm run check && npm run build` must pass.
6. Commit with Conventional Commits (`feat:`, `fix:`, `docs:` …) and open a
   pull request describing what changed and how you verified it.
