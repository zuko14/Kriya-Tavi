# Harness 2.0: data model, settings and API contracts

The SQL migration is the source of truth; `db/schema.ts` mirrors it
(AGENTS.md stack). As built: the Scout's tables in `supabase/migrations/
20271201000000_harness_scout.sql` (W7, with `supabase/rollback/
20271201000000_harness_scout.down.sql`); the candidate, version and outcome
tables below come in W9/W11's own migrations (REAUDIT RA-60). Each has a
rollback tested in
`tests/db/migrations.test.ts` (the existing down/up pattern). The `kriya`
schema stays unexposed (invariant 2).

## 1. Tables

All are platform tables except `harness_cartridge_outcomes`. RLS is enabled
on every one. Platform tables have **no policy for `authenticated`** (deny
all); they are read and written only by server code through `privileged`
after `requireOwner()`, or by the scheduler step, each scoped explicitly
(invariant 1's exception for bookkeeping with its own check).

```sql
create table kriya.harness_scout_sources (
  id uuid primary key default gen_random_uuid(),
  discipline text not null check (discipline in (
    'frontend','designer','backend','fullstack','mobile','game','devops','cloud',
    'systems','data','ml','security','qa','sdet','database','architect','graphics')),
  url text not null unique check (url ~ '^https://[^\s]{4,500}$'),
  kind text not null check (kind in ('changelog','advisory','standard','paper_feed','guideline')),
  active boolean not null default true,
  last_hash text,
  last_fetched_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table kriya.harness_scout_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running','done','failed','cap_reached','frozen')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sources_fetched int not null default 0,
  findings int not null default 0,
  candidates int not null default 0,
  error text check (char_length(error) <= 500)
);
-- The lease: at most one running run
create unique index harness_scout_one_running on kriya.harness_scout_runs ((true)) where status = 'running';

create table kriya.harness_scout_snapshots (
  source_id uuid not null references kriya.harness_scout_sources(id) on delete cascade,
  run_id uuid not null references kriya.harness_scout_runs(id) on delete cascade,
  hash text not null,
  changed_text text check (char_length(changed_text) <= 4000),
  fetched_at timestamptz not null default now(),
  primary key (source_id, run_id)
);

create table kriya.harness_scout_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references kriya.harness_scout_runs(id),
  source_id uuid not null references kriya.harness_scout_sources(id),
  discipline text not null,
  kind text not null check (kind in ('practice','deprecation','vulnerability_class','tool_change','idea')),
  claim text not null check (char_length(claim) <= 300),
  quote text not null check (char_length(quote) between 1 and 400),
  quote_hash text not null,
  first_seen_at timestamptz not null default now(),
  confirmed_at timestamptz,              -- second fetch ≥ 1 h later still had the quote
  corroborated boolean not null default false,
  status text not null default 'new' check (status in ('new','confirmed','drafted','idea','dropped')),
  unique (discipline, quote_hash)
);

create table kriya.harness_cartridge_candidates (
  id uuid primary key default gen_random_uuid(),
  cartridge_id text not null check (cartridge_id ~ '^kriya-role-[a-z]{2,20}$'),
  base_version text not null,
  body text not null check (char_length(body) <= 6000),
  judgement jsonb not null default '[]',
  added_gates text[] not null default '{}',
  added_detectors text[] not null default '{}',
  added_keywords text[] not null default '{}',
  diff text not null,
  body_sha256 text not null,
  finding_ids uuid[] not null,
  lint jsonb not null,
  status text not null check (status in (
    'discarded','awaiting_bench','benched','proposed','held','rejected','approved')),
  verdict jsonb,                          -- gate() output, computed by code only
  evidence jsonb,                         -- report hashes, profileId, seedVersion, model, client version
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

create table kriya.harness_cartridge_versions (
  id uuid primary key default gen_random_uuid(),
  cartridge_id text not null,
  version text not null,                  -- semver; base + 0.0.1 per approval
  candidate_id uuid not null references kriya.harness_cartridge_candidates(id),
  body text not null,
  manifest jsonb not null,                -- the full kriya.json with the cartridge block
  status text not null check (status in ('approved','canary','active','rolled_back','superseded')),
  canary_pct int not null default 0 check (canary_pct between 0 and 100),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (cartridge_id, version)
);
create unique index harness_cartridge_one_active on kriya.harness_cartridge_versions (cartridge_id) where status = 'active';
create unique index harness_cartridge_one_canary on kriya.harness_cartridge_versions (cartridge_id) where status = 'canary';

-- Counts only, from opted-in devices (HD-24); never content
create table kriya.harness_cartridge_outcomes (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  version_id uuid not null references kriya.harness_cartridge_versions(id),
  day date not null,
  verified int not null default 0 check (verified >= 0),
  blocked int not null default 0 check (blocked >= 0),
  not_checked int not null default 0 check (not_checked >= 0),
  undone int not null default 0 check (undone >= 0),
  primary key (user_id, device_id, version_id, day)
);
alter table kriya.harness_cartridge_outcomes enable row level security;
create policy outcomes_own_select on kriya.harness_cartridge_outcomes
  for select to authenticated using (user_id = (select auth.uid()));
create policy outcomes_own_insert on kriya.harness_cartridge_outcomes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy outcomes_own_update on kriya.harness_cartridge_outcomes
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

Immutability: `harness_cartridge_candidates.body`, `diff`, `body_sha256`,
`finding_ids`, `lint`, `evidence` and `harness_cartridge_versions.body`,
`manifest` are protected by a `before update` trigger that raises if any of
them change (the episodes pattern, track N rule 3). Status changes go
through one SQL function each (`kriya.harness_candidate_transition`,
`kriya.harness_version_transition`) that checks the allowed edges of
SELF_EVOLUTION §2 and writes an `audit_events` row.

## 2. Spend

- `kriya.resource_usage.kind` gains `'scout_model'`. The check constraint is
  dropped and re-added with **every existing kind copied verbatim from the
  latest migration that set it** (`20271102000000_editing_tables.sql`) plus
  the new one; WT-DB-02 asserts the constraint accepts every kind in
  `db/schema.ts` and rejects an unknown one.
- `kriya.reserve_scout_spend(p_request_key text, p_estimate_micro_usd
  bigint, p_cap_micro_usd bigint) returns boolean`: takes
  `pg_advisory_xact_lock(hashtext('harness_scout_spend'))`, sums this
  calendar month's (Asia/Kolkata) `scout_model` cost, inserts the
  reservation row only if `sum + estimate ≤ cap`. Settled afterwards to the
  real cost by `request_key`. A cap of 0 refuses every call.
- The cap is set in ₹ (`harness.scoutMonthlyInr`) and converted with
  `fx.usdInr` through `lib/money.ts`; no rate ⇒ refused (invariant 6: never
  invent a rate).

## 3. Settings (`lib/config.ts`, under the Kriya Harness block)

| Key | Env | Fallback | Pattern |
| --- | --- | --- | --- |
| `harness.workforce` | `KRIYA_HARNESS_WORKFORCE` | `off` | `on\|off` |
| `harness.orchestraHead` | `KRIYA_HARNESS_ORCHESTRA_HEAD` | `escalation` | `budget\|balanced\|escalation` |
| `harness.orchestraWorker` | `KRIYA_HARNESS_ORCHESTRA_WORKER` | `budget` | `budget\|balanced\|escalation` |
| `harness.cartridgeOverlay` | `KRIYA_HARNESS_CARTRIDGE_OVERLAY` | `off` | `on\|off` |
| `harness.scout` | `KRIYA_HARNESS_SCOUT` | `off` | `on\|off` |
| `harness.scoutEveryDays` | `KRIYA_HARNESS_SCOUT_EVERY_DAYS` | `7` | `^([1-9]\|[12]\d\|30)$` |
| `harness.scoutMonthlyInr` | `KRIYA_HARNESS_SCOUT_MONTHLY_INR` | `0` | `^(0\|[1-9]\d{0,5})$` |
| `harness.scoutMaxFindings` | `KRIYA_HARNESS_SCOUT_MAX_FINDINGS` | `20` | `^([1-9]\|[1-9]\d\|100)$` |

Cartridges are part of the default set, so `harness.workforce` serves
nothing unless `harness.defaultSkills` is also on; its hint says so, and the
owner page shows the dependency.

`harness.orchestraHead` equal to `harness.orchestraWorker` is allowed and
means "no split" (the advert is withheld; §4). HT-REG-01's list of harness
keys and defaults gains these eight (its file is listed in CHANGE_IMPACT).

## 4. API contract changes (`lib/harness/contract.ts`, all additive)

| Route | Change | Present only when |
| --- | --- | --- |
| `GET /api/harness/v1/models` | `orchestra?: { head: Tier, worker: Tier }` | `harness.workforce` on, head ≠ worker, both in the plan's `allowedTiers` |
| `GET /api/harness/v1/skills` | Item gains `cartridge?: CartridgeBlock` (CARTRIDGES §2) and `invocation?: { modelInvocable: false }` | `harness.workforce` on, item is a `kriya-role-*` cartridge |
| `GET /api/harness/v1/skills/[id]/[version]` | Unchanged shape; with the overlay on, an overlay version's body is served for its version string | `harness.cartridgeOverlay` on |
| `POST /api/harness/v1/sessions/[id]/turns` (mirror) | `TurnRequest` (a `z.strictObject`) gains `cartridgeOutcomes?: [{ cartridgeId, version, verified, blocked, notChecked, undone }]` (≤ 20; as built in W11 the device names the version it ran, `id@version` from its own builder records, and Kriya maps it to the stored version, dropping counts for any version it never stored); written to `harness_cartridge_outcomes` through `withUser(device.id)`, only on a turn's first delivery | `harness.workforce` on, `harness.mirror` on, the device mirrors, **and** the person's sharing opt-in (HD-24) |

Server ships before client (track E rule 17's principle, applied here): the
client reads a field only if present and never sends one the server hasn't
advertised (`/models` carries `workforce: 1` as the advertisement for the
mirror field). `docs/kriya-harness/contract.json` is regenerated by
`scripts/harness-contract.ts` and the client's `contract/` copy updated in
the same release.

## 5. Client-side state (in `~/.kriya`, never in the project)

| File | Holds | Written by |
| --- | --- | --- |
| `progress/<project>/<session>.json` (existing) | Plan, runs; **new** per run: `role`, `tier`, `gates[]`, `contractHashes`, `advice` count, `critic` defects count | `writeProgress` |
| `progress/<project>/milestones.json` (new) | Milestones, status, per-milestone plan hash, cost per tier | `plugins/loop` only |
| `stack.json` (new) | Confirmed loopback app and DB URLs per project | `kriya stack use` only |
| `evidence/<project>/<session>/<step>/<attempt>/` (new) | Gate evidence; sha256 in the run record | Gates |
| `release.json` (new) | Confirmed build/start commands, port, routes, budgets, domains per project | `kriya release use` only |
| `receipts/<project>/<session>.json` + `.md` (new) | Proof receipts (DIFFERENTIATORS §1) | Client code at task end |
| `evidence/<project>/baseline.json` (new) | G-EVAL's recorded baseline | G-EVAL first run, confirmed by `kriya eval baseline confirm` |

The project gets only `.kriya/contracts/*.json` and `.kriya/gates/
tenants.json`, both reviewable files the person can commit or ignore.
