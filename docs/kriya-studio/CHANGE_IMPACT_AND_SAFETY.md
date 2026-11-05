# Change impact and safety (track S)

What track S touches. Read before editing an existing file. Changes outside §1
need a row here first. Other tracks' CHANGE_IMPACT rules still apply; where a
protected file is listed, the reason and the regression test are given.

## 1. Existing files that change

| File | Change | Must stay true | Regression |
| --- | --- | --- | --- |
| `db/schema.ts` | Four `flow*` tables; `flow_design` in `resourceUsage.kind` | Existing tables unchanged | Typecheck |
| `lib/config.ts`, `app/owner/config/page.tsx` | `studio.*` keys; one group | Others untouched | ST-REG |
| `worker/index.ts` | One import, one `flowLoop`, behind `studio.flows` | Other loops unchanged | ST-REG |
| `queries/features.ts`, `components/workspace/places.ts` | `flows` flag and one place | Off → no entry | ST-REG |
| `proxy.ts` | `"/flows"` in `PROTECTED` | Every other path unchanged | Existing proxy tests |
| `queries/workspace.ts` | Flow node threads are not listed, like crew parts, with `studio.flows` on | Off → same queries | ST-REG |
| `queries/inbox.ts`, `app/(workspace)/inbox/page.tsx` | Gates waiting for the person, with `studio.flows` on | Off → same lists | ST-REG |
| `lib/agent/tools.ts` (protected, track A; **SO-04**) | `privateContentSeen`, `untrustedSeen` also match `FLOW_PRIVATE`, `FLOW_CONTEXT` from `lib/flows/marker.ts`. Stricter only | Tools, `FOREIGN`, `SIDE_EFFECT_TOOLS`, `TOOL_APPROVALS` unchanged | AT-REG-01; ST-TAINT |
| `lib/harness/contract.ts` | Optional `plan`, `profile` in the `run` payload (dispatch payloads aren't in `contract.json`, so that file is unchanged) | Existing fields unchanged | HT-API-01 |
| `lib/harness/control.ts` | A running action may update its `result` | Status transitions unchanged | ST-DEV |
| `lib/harness/evolve/profile.ts` | The schema and `BASELINE` move to `profile-schema.ts` (no `node:crypto`) so the editor can validate; re-exported | Exports and behaviour unchanged | HU-EV-01 |
| `tests/db/migrations.test.ts` | The ST-DB-01 case; two older cases roll flows back first and apply it last | Existing assertions | Itself |
| `tests/operator/verify-scripts/*` | New `flow-*` stub scripts | Others unchanged | — |
| `NOTICE.md`, `package.json`, `package-lock.json` | `@xyflow/react`, `elkjs` | Nothing else | `npm run check` |
| `app/(workspace)/harness/page.tsx` | A link to Flows with `studio.deviceFlows` on | Off → same page | Browser check |
| `AGENTS.md`, `status.md` | Track section, own rows | Others untouched | — |

**Not changed:** `lib/agent/queue.ts`, `lib/agent/run-task.ts`,
`lib/agent/metering.ts`, `lib/agent/policy.ts`, `lib/auth.ts`,
`lib/connectors.ts`, `lib/memory/*`, `TOOL_APPROVALS`.

**New files, no row:** `lib/flows/**`, `actions/flows.ts`, `queries/flows.ts`,
`app/(workspace)/flows/**`, `app/api/flows/**`, `components/flows/**` (styles in
`components/flows/canvas.css`; `app/globals.css` is unchanged),
`tests/flows/**`, `tests/db/flows-rls.test.ts`, `docs/kriya-studio/**`,
`supabase/migrations/20270901000000_flows.sql` and its rollback,
`screenshots/kriya-studio/**`.

## 2. Client repository

Work happens in a new worktree `../kriya-harness-studio` from `main`, on branch
`feat/flows-graph`. The person's `../kriya-harness` checkout has uncommitted
changes and is not touched; `../kriya-harness-upgrade` isn't either.

## 3. Stop conditions

Stop and ask before: anything against the live database, a real model call, a
paid run, a push, a deploy, or a change to a file marked protected beyond its
row here.
