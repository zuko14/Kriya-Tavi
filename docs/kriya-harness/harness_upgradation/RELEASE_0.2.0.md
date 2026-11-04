# Kriya Harness 0.2.0: release preparation (U10)

Owner decisions (chat, 2026-11-04): "B4 is our winner (18/21)", "I approve
Phase U9", "Proceed with Phase U10 (packaging B4, updating README/SAFETY
docs, and release preparation)", "Prepare the commits".

## What 0.2.0 changes for people

| Change | Default | Off switch | Evidence |
| --- | --- | --- | --- |
| The Kriya loop (`kriya_verify`, plans, step builders, checkpoints, stale-pass re-check) | **on** | `--no-loop`, `KRIYA_LOOP=off` | BENCHMARK_PLAN §6.3: B4 18/21 vs 14/21 |
| Turn budget (150 steps, 60 min, 10 identical calls) | **on** | `--no-budget`, `KRIYA_BUDGET=off` | HU-M-01/02; no task lost in §6.3 |
| Kept request (`--anchor`) | off | — | HU-M-06; unmeasured on real models |
| Model limits from Kriya, overflow recovery | when the server sends them | — | HU-M-03/04 |
| `kriya usage [--json]` | — | — | CLI test |

Known cost: the loop arm spent ₹3.34 per passed task against ₹2.33 without
it (+43%) and took ~1.5× the time per task on the capability set.

## Server (Kriya) changes in this release

- U1 `context_length_exceeded` from the gateway; U3/U9 `GET /models`
  `contextWindow` / `maxOutputTokens` from `kriya.models`;
  `harness.maxOutputTokens` (default 65,536, owner-editable, 1,024–262,144,
  never above the model's own) replaces the fixed 16,384.
- Migration `20270701000000_model_limits.sql` (+ rollback).
- KriyaBench: spend meter, intervals, paired comparison, capability set,
  grading on originals.

## Release steps (owner; nothing here was run against production)

1. Review and merge the two branches (`feat/harness-upgrade` in both repos).
2. Apply the migration to production: `npm run db:migrate` with the
   production `MIGRATION_DATABASE_URL` (as for every migration).
3. Deploy `kriya-web`.
4. In `/owner/config`, refresh the model catalogue so `context_window` and
   `max_output_tokens` are filled; check `harness.maxOutputTokens`.
5. Optional: set `harness.minClientVersion` to `0.2.0` once 0.2.0 is
   installable, so old clients are asked to update.
6. Publish the client (HB-02: npm scope `@kriya-ai` and `npm login` are
   still the owner's), with `npm run release:check` and the SBOM from CI.
7. Restart `kriya` on each machine; confirm a check per project with
   `kriya verify use <number>`.

## Rollback

Client: install 0.1.x, or run 0.2.0 with `--no-loop --no-budget`. Server:
`supabase/rollback/20270701000000_model_limits.down.sql`; redeploy the
previous `kriya-web` (the contract changes are additive, so 0.2.0 clients
keep working without limits).
