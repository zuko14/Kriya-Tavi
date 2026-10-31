# Implementation plan (track H)

| Phase | Name | Depends on | Decisions | Holds (existing files) | Exit checks |
| --- | --- | --- | --- | --- | --- |
| H0 | Blueprint and decisions | — | — | `AGENTS.md`, `status.md` | Documents consistent (REAUDIT); owner marks HD-01…HD-19 |
| HP-1 | Baseline re-check | H0 | — | — | `npm run check` exit 0, counts ≥ baseline |
| H1 | Data model (one migration `20270301000000`) | HP-1; track C's C1 merged (migration order) | HD-07, HD-18 | `db/schema.ts`, `tests/db/migrations.test.ts`, `lib/config.ts` | HT-DB-01…07; HT-REG-01 (settings) |
| H2 | Device identity, connect page, Devices | H1 | HD-05 (owner-gated), HD-15 | `lib/auth.ts`, `proxy.ts`, `app/(workspace)/account/page.tsx`, `app/owner/config/page.tsx` | HT-AUTH-01…08, HT-API-01/02/08/10; browser check (connect, Devices) |
| H3 | Gateway and ledger | H2 | HD-06, HD-07, HD-16 (owner-gated: HD-06, HD-07) | `lib/entitlements.ts`, `actions/owner.ts`, `components/owner/forms.tsx`, `app/(workspace)/usage/page.tsx`, `worker/index.ts` | HT-GW-01…08, HT-GW-10, HT-MTR-01…06; HT-GW-09 on staging (owner) |
| H4 | Client alpha in `kriya-harness` | H3; repository created; npm scope (HQ-03) | HD-02, HD-03, HD-04, HD-14, HD-17 (owner-gated: HD-02, HD-03, HD-14) | none here | Client CI: HT-REL-01…03, contract tests, `kriya doctor`, `kriya run` against the fake gateway; one owner-run session against staging; recorded `--dump-config` |
| H5 | Approvals from the phone | H4 | HD-08; PX-03 optional | `queries/inbox.ts`, `actions/inbox.ts`, `app/(workspace)/inbox/page.tsx` (+ `app/api/events/route.ts` with PX-03) | HT-APR-01…03; client approval-answerer tests; browser check |
| H6 | Session mirror | H4 | HD-09 | none | HT-MIR-01/02; client sync tests (offline queue) |
| H7 | Skills and memory | H4 | HD-10 | none | HT-API-07; client tests |
| H8 | Handoff and pull | H4; track C C5 and C6 | HD-11 | none | HT-HND-01…03; staging handoff → cloud workspace restored (sha256 match) |
| H9 | Security, scale, release readiness | H5–H8 | — | none | HG-1…HG-6; public beta only after HG-7 |
| H10 | Your machine as an execution world | H9; track C C3 | HD-12 decision record (owner-gated: new Render service) | `render.yaml` (relay service), track C provider name check (new migration) | A new decision record, its tests, CT-ISO-style probes for the device world |
| H11 | ACP for editors | H4 | HD-13 | none | Client ACP tests; one editor session |
| H12 | Controlled pilot | H9 | new decision for public copy (RG-9) | — | 14 days, named users, numbers in `status.md` |

Lanes: after H4, **H5, H6, H7** run in parallel (different server files:
H5 Inbox files; H6 `lib/harness/mirror.ts`; H7 `lib/harness/memory.ts`,
`lib/harness/skills.ts`); H8 waits for track C. H1 runs after track C's C1
so migrations stay in timestamp order with one writer at a time.

## Rollout

1. Code ships with `harness.*` off and every plan's harness cap at 0.
2. Owner: staging migration; a test plan with a small cap; `harness.api` and
   `harness.gateway` on; client alpha installed from a private tarball;
   HT-GW-09.
3. Owner: H9 gates; public beta on npm; production switches on for chosen
   plans.

## Rollback

| Level | Action |
| --- | --- |
| Gateway | `harness.gateway` off → model calls refused with a plain message |
| Everything | `harness.api` off → all harness routes 404 |
| A device | Revoke it (person) or delete its row (owner) |
| A release | npm deprecate the version; `harness.minClientVersion` forces an upgrade |
| Data | Down migration after `harness.api` is off (DATA_MODEL §5) |
