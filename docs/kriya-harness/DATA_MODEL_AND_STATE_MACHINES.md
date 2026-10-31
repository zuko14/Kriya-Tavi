# Data model (track H)

One migration, `supabase/migrations/20270301000000_harness.sql`, with its
rollback (phase H1). Track H claims the `202703DDhhmmss` range; it sorts
after track C's `202702…`. Rules are track C's DATA_MODEL §0 (RLS + policy on
every table, pinned functions, no blobs, integer money, add-only).

## 1. Tables

```sql
-- A machine the person signed in from. The token is never stored: only its sha256.
create table kriya.harness_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The Kriya agent this device works as (memory, mirror threads, handoff)
  agent_id text,
  name text not null check (char_length(name) between 1 and 60),
  platform text not null check (platform in ('darwin', 'linux', 'win32')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  client_version text check (char_length(client_version) <= 40),
  mirror text not null default 'off' check (mirror in ('off', 'summary', 'full')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete set null (agent_id)
);
create index harness_devices_user_idx on kriya.harness_devices (user_id, created_at);

-- A pending sign-in. Both codes are short-lived; the device code is stored hashed.
create table kriya.harness_device_codes (
  device_code_hash text primary key check (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code text not null unique check (user_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  device_name text not null check (char_length(device_name) between 1 and 60),
  platform text not null check (platform in ('darwin', 'linux', 'win32')),
  client_version text check (char_length(client_version) <= 40),
  expires_at timestamptz not null,
  approved_by uuid references auth.users (id) on delete cascade,
  agent_id text,
  approved_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  device_id uuid references kriya.harness_devices (id) on delete cascade,
  last_polled_at timestamptz,
  created_at timestamptz not null default now()
);
create index harness_device_codes_expiry_idx on kriya.harness_device_codes (expires_at);

-- One row per gateway request: reported cost, estimate and customer charge apart
create table kriya.harness_usage (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  device_id uuid references kriya.harness_devices (id) on delete set null,
  plan_id text,
  tier text not null check (tier in ('budget', 'balanced', 'escalation')),
  model text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'estimated', 'failed')),
  reserved_micro_inr bigint not null check (reserved_micro_inr >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cached_tokens integer check (cached_tokens >= 0),
  -- Null means the provider didn't say; never zero
  cost_micro_usd bigint check (cost_micro_usd >= 0),
  estimated_cost_micro_usd bigint check (estimated_cost_micro_usd >= 0),
  charge_micro_inr bigint check (charge_micro_inr >= 0),
  charge_status text check (charge_status in ('final', 'estimated', 'unpriced')),
  fx_rate text,
  markup_bps integer,
  generation_id text,
  finish_reason text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index harness_usage_user_month_idx on kriya.harness_usage (user_id, created_at);
create index harness_usage_device_idx on kriya.harness_usage (device_id);
create index harness_usage_reserved_idx on kriya.harness_usage (status, created_at)
  where status = 'reserved';

-- A local action waiting for the person
create table kriya.harness_approval_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  session_ref text check (char_length(session_ref) <= 100),
  tool text not null check (char_length(tool) between 1 and 60),
  summary text not null check (char_length(summary) between 1 and 300),
  input jsonb,
  cwd text check (char_length(cwd) <= 300),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'expired', 'canceled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz
);
create index harness_approvals_pending_idx on kriya.harness_approval_requests (user_id, status, created_at);
create index harness_approvals_device_idx on kriya.harness_approval_requests (device_id);

-- A device session mirrored into a Kriya thread
create table kriya.harness_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  thread_id text not null,
  device_session_id text not null check (char_length(device_session_id) <= 100),
  project text check (char_length(project) <= 80),
  last_seq integer not null default -1,
  created_at timestamptz not null default now(),
  unique (device_id, device_session_id),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);
create index harness_sessions_thread_idx on kriya.harness_sessions (thread_id, user_id);

alter table kriya.plans
  add column harness_monthly_micro_inr bigint not null default 0
    check (harness_monthly_micro_inr >= 0);
```

Mirror turns are written as ordinary assistant `messages` in the mirror
thread (text part + a compact tool list in metadata), so the existing thread
UI shows them; nothing new stores transcripts.

## 2. Transitions

`kriya.allowed_transitions` rows for entity `harness_approval`:
`pending → approved | declined | expired | canceled`, trigger
`check_transition('harness_approval')` on `status`. `harness_usage.status`:
`reserved → settled | estimated | failed`, enforced inside the two functions
below (no other writer).

## 3. Access

```sql
alter table kriya.harness_devices enable row level security;
create policy read_own on kriya.harness_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy update_own on kriya.harness_devices for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select (id, user_id, agent_id, name, platform, client_version, mirror,
  created_at, last_used_at, revoked_at) on kriya.harness_devices to authenticated;
grant update (name, agent_id, mirror, revoked_at) on kriya.harness_devices to authenticated;
-- token_hash is never selectable by the person's session

alter table kriya.harness_device_codes enable row level security;
create policy no_access on kriya.harness_device_codes for all to anon, authenticated
  using (false) with check (false);  -- server only (the lint 0008 pattern)

alter table kriya.harness_usage enable row level security;
create policy read_own on kriya.harness_usage for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_usage to authenticated;

alter table kriya.harness_approval_requests enable row level security;
create policy read_own on kriya.harness_approval_requests for select to authenticated
  using (user_id = (select auth.uid()));
create policy answer_own on kriya.harness_approval_requests for update to authenticated
  using (user_id = (select auth.uid()) and status = 'pending')
  with check (user_id = (select auth.uid()));
grant select on kriya.harness_approval_requests to authenticated;
grant update (status, answered_at) on kriya.harness_approval_requests to authenticated;

alter table kriya.harness_sessions enable row level security;
create policy read_own on kriya.harness_sessions for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_sessions to authenticated;
```

Device-authenticated routes write through `privileged` scoped by the
device's `user_id` (invariant 1, "bookkeeping that has its own authorization
check": `authenticateDevice`). Person actions (approve device, answer,
revoke, rename, mirror mode) use `withUser`.

## 4. Spend reservation (cap in SQL, invariant 7)

```sql
-- Reserves an upper estimate against the plan's monthly harness cap (IST month).
create function kriya.reserve_harness_spend(
  p_user uuid, p_device uuid, p_request_key text, p_tier text, p_model text,
  p_estimate_micro_inr bigint
) returns void language plpgsql set search_path = '' as $$
declare v_cap bigint; v_used bigint; v_plan text;
begin
  v_plan := kriya.effective_plan_id(p_user);
  select harness_monthly_micro_inr into v_cap from kriya.plans where id = v_plan;
  if coalesce(v_cap, 0) = 0 then raise exception 'harness not in plan'; end if;
  perform pg_advisory_xact_lock(hashtext('harness:' || p_user::text));
  select coalesce(sum(case when status = 'reserved' then reserved_micro_inr
                           else coalesce(charge_micro_inr, reserved_micro_inr) end), 0)
    into v_used from kriya.harness_usage
    where user_id = p_user and status <> 'failed'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used + p_estimate_micro_inr > v_cap then raise exception 'harness cap reached'; end if;
  insert into kriya.harness_usage (request_key, user_id, device_id, plan_id, tier, model, reserved_micro_inr)
    values (p_request_key, p_user, p_device, v_plan, p_tier, p_model, p_estimate_micro_inr);
end $$;
revoke all on function kriya.reserve_harness_spend(uuid, uuid, text, text, text, bigint)
  from public, anon, authenticated;
```

Settling is an `update … where request_key = $1 and status = 'reserved'`
from `lib/harness/metering.ts` (actual tokens, costs, charge,
`charge_status`). A janitor step (the worker's existing hourly `janitor()`,
one new statement) turns reservations older than 15 minutes into
`estimated` at their reserved amount (never zero) for reconciliation.

`usageSummary` adds `sum(coalesce(charge_micro_inr, reserved_micro_inr))` of
the period's non-failed harness rows, as it adds voice charges.

## 5. Rollback (`20270301000000_harness.down.sql`)

Drop the function, the five tables, the transition rows and the plan column,
in reverse order. Before running it on a project: `harness.api` off, export
`harness_usage` if the owner wants the history.

## 6. Tests (`tests/db/harness-rls.test.ts`)

| Id | Assertion |
| --- | --- |
| HT-DB-01 | A person reads only their devices, usage, approvals, sessions; `token_hash` isn't selectable; codes table unreadable |
| HT-DB-02 | The person can update only `name`, `agent_id`, `mirror`, `revoked_at` on devices and `status`, `answered_at` on pending approvals |
| HT-DB-03 | Approval transitions as listed; answered requests can't change |
| HT-DB-04 | `reserve_harness_spend` refuses at the cap, counting reserved, settled and estimated rows of the IST month; two concurrent reservations at the edge: exactly one passes |
| HT-DB-05 | Plan cap 0 refuses |
| HT-DB-06 | Down + up on PGlite; older migration cases roll track H back first |
| HT-DB-07 | `lint.test.ts` stays at zero |
