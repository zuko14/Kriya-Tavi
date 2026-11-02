# Change impact and safe execution (track H)

What track H may touch in this repository, how, and the regression test.
Read **before editing any existing file**. A change not listed in §3 needs
the owner's approval and a row here first. Where tracks A, O, N, voice or C
also list a file, all rules apply; hold it on the shared board. The client
code lives in the `kriya-harness` repository (HD-03) and changes nothing
here.

Verified against `508bb6a` on 2026-10-31; baseline as track C's
CHANGE_IMPACT (Test Files 185 passed, 3 skipped; Tests 2289 passed, 42
skipped; exit 0).

## 1. Protected

Everything protected by tracks A, O, N, voice and C, plus:

| Path | Track H's only exception |
| --- | --- |
| `lib/auth.ts` | **H2, owner-approved (HD-05):** additive `authenticateDevice(request)`; existing helpers unchanged |
| `AGENTS.md` invariant 3 | **H2, owner applies** the HD-05 wording |
| `lib/agent/metering.ts`, `kriya.usage_events`, `kriya.charges` | None (HD-07) |
| `lib/connectors.ts`, `lib/connectors/*` | None |
| `lib/agent/queue.ts` | None: handoff calls the exported `enqueueTurn` as it is |
| `app/api/events/route.ts`, `components/workspace/notifier.tsx` (track A §2) | **H5 only if the owner approves PX-03** (one combined change with track R) |
| `lib/memory/*` | None: `writeMemory` is called as it is |

## 2. Prerequisites

| Id | Change | Test |
| --- | --- | --- |
| HP-1 | Re-run `env -u OPENROUTER_API_KEY npm run check`; record counts | Exit 0, counts ≥ baseline |

## 3. Existing files that change

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `db/schema.ts` | H1 | The five `harness_*` tables; `plans.harnessMonthlyMicroInr` | Existing definitions unchanged | Typecheck; AT-REG-01 |
| `tests/db/migrations.test.ts` | H1 | A down/up case for `20270301000000`; older cases roll track H back first | Existing assertions unchanged | Itself |
| `lib/config.ts` | H1 | The `harness.*` block (HD-18) under `// Kriya Harness (track H)` | Existing keys untouched | Settings tests; HT-REG-01 |
| `proxy.ts` | H2 | `TOKEN_API = ["/api/harness/"]` exempt from the origin check (HF-07); `"/connect/"` in `PROTECTED` (HF-08) | Every other path keeps the origin check and redirects | HT-API-10; existing proxy behaviour unchanged |
| `lib/auth.ts` (protected) | H2 | `authenticateDevice` (HD-05) | `getSessionUser`, `requireUser`, `authenticate`, `requireOwner` unchanged | HT-AUTH-08 |
| `app/(workspace)/account/page.tsx` | H2 | Render `<Devices>` after the existing sections only with `harness.api` on | Off → same page | HT-UI-02 |
| `app/owner/config/page.tsx` | H2 | One `GROUPS` entry "Kriya Harness" (`["harness."]`) | Existing groups unchanged | HT-UI-04 |
| `lib/entitlements.ts` | H3 | `usageSummary` adds the period's non-failed harness charges (owner-gated HD-07), the voice pattern | No harness rows → identical result | HT-MTR-02 |
| `actions/owner.ts`, `components/owner/forms.tsx` | H3 | Plan schema and form gain `harnessMonthlyInr` (₹, stored as micro-INR) | Other fields unchanged | Existing owner tests |
| `app/(workspace)/usage/page.tsx` | H3 | A "Kriya Harness" line when the plan's cap > 0 | Otherwise identical | HT-UI-04 |
| `worker/index.ts` | H3 | One statement in the hourly `janitor()`: stale `reserved` harness rows → `estimated` | Other janitor steps unchanged, errors caught | HT-MTR-03 |
| `queries/inbox.ts`, `actions/inbox.ts` (`inboxBadge`), `app/(workspace)/inbox/page.tsx` | H5 | List and count pending harness approvals only with `harness.api` on | Off → identical lists and badge | HT-APR-01; existing Inbox tests |
| `app/api/events/route.ts` (protected) | H5 | Only with PX-03 approved: announce new harness approval requests | Existing events unchanged | Existing events tests |
| `lib/agent/tools.ts` (protected, track A) | H6 (owner-approved 2026-11-01 in chat: "Add a mirror marker") | `untrustedSeen` also matches assistant texts containing `MIRROR_CONTEXT` (imported from the pure `lib/harness/mirror-context.ts`, the `ROOM_CONTEXT` pattern); `messageTexts` accepts the `assistant` role | Existing tools, `FOREIGN`, `PRIVATE_READ_TOOLS`, `SIDE_EFFECT_TOOLS`, `TOOL_APPROVALS` unchanged; stricter only | AT-REG-01; `tests/harness/mirror.test.ts`; existing `untrustedSeen` tests |
| `proxy.ts` | Harness page (owner 2026-11-02) | `"/harness/"` in `PROTECTED` | `/api/harness/` keeps its bearer check and no origin check | `tests/harness/proxy.test.ts` |
| `lib/config.ts`, `tests/harness/regression.test.ts` | Harness page (owner 2026-11-02) | `harness.installCommand` (no default; one plain `npm`/`npx`/`pnpm`/`brew` line, nothing chained); `harness.releaseStage` (`beta` default, `ga` only after HD-02's gates; HD-20) | Other `harness.*` keys and defaults unchanged | HT-REG-01 (updated list, pattern cases) |
| `queries/harness.ts`, `components/workspace/{sidebar,places}.tsx`, `queries/features.ts` | Harness page (owner 2026-11-02) | `harnessHome` (sessions, open workspaces, pending approvals as the person); the sidebar/palette/Home entry from `getFeatures().harness` (= `harness.api`) | Off → no entry, `/harness` 404 | `harness-hub-check` browser run (`status.md`) |
| `AGENTS.md` | H0, H2 | H0: the track H section; H2: the owner's invariant 3 wording | Other text unchanged | — |
| `status.md` | every phase | Own section and rows | Others untouched | — |

**New files** (no row needed): `app/(workspace)/harness/**`, `components/harness/**`, `app/api/harness/v1/**`, `app/connect/device/**`,
`lib/harness/**`, `actions/harness.ts`, `queries/harness.ts`,
`components/account/devices.tsx`, `components/inbox/harness-approval.tsx`,
`scripts/harness-contract.ts`, `docs/kriya-harness/contract.json`,
`tests/harness/**`, `tests/db/harness-rls.test.ts`, the migration
`20270301000000_harness.sql` and its rollback, `screenshots/kriya-harness/**`.

**Dependencies:** none in this repository. The gateway uses `fetch` to
OpenRouter's OpenAI-compatible endpoint (`OPENROUTER_BASE_URL`, already in
`render.yaml`).

## 4. Module boundaries

ARCHITECTURE §4; HT-IMP-01. Handoff and pull use `fileStore`, the
`workspaces` table and `enqueueTurn`; they don't import `lib/cloud` (track C
CT-IMP-03), except the pure path helper `lib/cloud/paths.ts` (PX-02).

## 5. Cross-track check

| File | Others holding it | Conflict? |
| --- | --- | --- |
| `proxy.ts` | Voice (webhooks), A5 (`/share/`), track R (`/rooms`) | Separate list entries; one holder at a time |
| `lib/entitlements.ts` | Voice F9, track R (room spend reads) | Additive sum; R adds no allowance change |
| `queries/inbox.ts`, `actions/inbox.ts` | A3, N2, track R | Additive sections behind each track's switch |
| `app/api/events/route.ts` | Track A (protected), track R | One combined owner-approved change (PX-03) |
| `worker/index.ts` | A, O, N, voice, C | One statement in `janitor()`; hold briefly |
| `db/schema.ts`, `lib/config.ts` | Every track | Hot spots |

## 6. Stop conditions

Stop and ask when you'd touch a §1 file beyond its exception, a file not in
§3, or need a secret, a deploy, a real OpenRouter call, a published package,
a real device sign-in on production, or a local run against the live database.
