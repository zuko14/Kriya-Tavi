-- Kriya Harness (track H, H1; docs/kriya-harness/DATA_MODEL_AND_STATE_MACHINES.md,
-- HD-07, HD-18): the machines a person signs in from, their pending sign-ins,
-- one ledger row per model-gateway request, local actions waiting for the
-- person, and device sessions mirrored into threads; plus the plan's monthly
-- harness cap, enforced here before any model call (invariant 7).
-- kriya.usage_events and kriya.charges are unchanged.
--
-- Device-authenticated routes write through privileged scoped by the
-- device's user id; the person reads their own rows and may only rename,
-- point, mirror or revoke a device and answer a pending approval. Device
-- tokens and codes are stored only as sha256 and never readable by the
-- person's session.

/* ───────────────────────────── devices ──────────────────────────── */

create table kriya.harness_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The Kriya agent this device works as (memory, mirror threads, handoff)
  agent_id text,
  name text not null check (char_length(name) between 1 and 60),
  platform text not null check (platform in ('darwin', 'linux', 'win32')),
  -- The token is never stored: only its sha256
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  client_version text check (char_length(client_version) <= 40),
  mirror text not null default 'off' check (mirror in ('off', 'summary', 'full')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (agent_id, user_id) references kriya.agents (id, user_id)
    on delete set null (agent_id)
);
create index harness_devices_user_idx on kriya.harness_devices (user_id, created_at);
create index harness_devices_agent_idx on kriya.harness_devices (agent_id, user_id);

-- A pending sign-in. Both codes are short-lived; the device code is stored hashed
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
create index harness_device_codes_approved_by_idx on kriya.harness_device_codes (approved_by);
create index harness_device_codes_device_idx on kriya.harness_device_codes (device_id);

/* ───────────────────────────── usage ────────────────────────────── */

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

/* ─────────────────────────── approvals ──────────────────────────── */

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
create index harness_approvals_pending_idx
  on kriya.harness_approval_requests (user_id, status, created_at);
create index harness_approvals_device_idx on kriya.harness_approval_requests (device_id);
create trigger harness_approvals_transition before update of status
  on kriya.harness_approval_requests
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('harness_approval');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('harness_approval', 'pending', 'approved'),
  ('harness_approval', 'pending', 'declined'),
  ('harness_approval', 'pending', 'expired'),
  ('harness_approval', 'pending', 'canceled');

/* ──────────────────────────── sessions ──────────────────────────── */

-- A device session mirrored into a Kriya thread (turns are ordinary messages)
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
create index harness_sessions_user_idx on kriya.harness_sessions (user_id);

/* ──────────────────────────── plans ─────────────────────────────── */

-- Conservative: no plan gets the harness until the owner sets a cap (HD-07)
alter table kriya.plans
  add column harness_monthly_micro_inr bigint not null default 0
    check (harness_monthly_micro_inr >= 0);

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.harness_devices enable row level security;
create policy read_own on kriya.harness_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy update_own on kriya.harness_devices for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- token_hash is never selectable by the person's session
grant select (id, user_id, agent_id, name, platform, client_version, mirror,
  created_at, last_used_at, revoked_at) on kriya.harness_devices to authenticated;
grant update (name, agent_id, mirror, revoked_at) on kriya.harness_devices to authenticated;

-- Server only (the lint 0008 pattern)
alter table kriya.harness_device_codes enable row level security;
create policy no_access on kriya.harness_device_codes for all to anon, authenticated
  using (false) with check (false);

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

/* ─────────────────────── spend reservation ──────────────────────── */

-- Called by the gateway only, before forwarding a request: reserves an upper
-- estimate against the plan's monthly harness cap (IST month). Reserved rows
-- count at their reservation, settled and estimated ones at their charge
-- (or reservation when unpriced), failed ones not at all. One person's
-- reservations are serialized, so two at the edge can't both pass.
create function kriya.reserve_harness_spend(
  p_user uuid, p_device uuid, p_request_key text, p_tier text, p_model text,
  p_estimate_micro_inr bigint
) returns void language plpgsql set search_path = '' as $$
declare
  v_cap bigint;
  v_used bigint;
  v_plan text;
begin
  v_plan := kriya.effective_plan_id(p_user);
  select harness_monthly_micro_inr into v_cap from kriya.plans where id = v_plan;
  if coalesce(v_cap, 0) = 0 then
    raise exception 'harness not in plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('harness:' || p_user::text));
  select coalesce(sum(case when status = 'reserved' then reserved_micro_inr
                           else coalesce(charge_micro_inr, reserved_micro_inr) end), 0)
    into v_used from kriya.harness_usage
    where user_id = p_user and status <> 'failed'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used + p_estimate_micro_inr > v_cap then
    raise exception 'harness cap reached';
  end if;
  insert into kriya.harness_usage (request_key, user_id, device_id, plan_id, tier, model, reserved_micro_inr)
    values (p_request_key, p_user, p_device, v_plan, p_tier, p_model, p_estimate_micro_inr);
end $$;
revoke all on function kriya.reserve_harness_spend(uuid, uuid, text, text, text, bigint)
  from public, anon, authenticated;
