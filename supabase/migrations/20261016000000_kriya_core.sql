-- Kriya Bots core schema.
--
-- Everything lives in the `kriya` schema, which must NOT be listed in
-- Supabase's "Exposed schemas" (API settings). The browser therefore cannot
-- reach these tables through PostgREST with the publishable key; only the
-- Kriya server can, over a direct Postgres connection. User requests still
-- run as the `authenticated` role with the user's id in `request.jwt.claims`
-- (see db/index.ts withUser), so Row Level Security applies to them.
--
-- Money is stored as integer micro-units (bigint): micro_usd = 1e-6 USD,
-- micro_inr = 1e-6 INR. Plan prices are in paise.

create schema if not exists kriya;
grant usage on schema kriya to authenticated;

/* ───────────────────────────── helpers ──────────────────────────── */

create or replace function kriya.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

/* ───────────────────────────── accounts ─────────────────────────── */

create table kriya.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  locale text not null default 'en-IN' check (char_length(locale) <= 16),
  use_case text check (char_length(use_case) <= 40),
  status text not null default 'active' check (status in ('active', 'suspended')),
  suspended_reason text,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on kriya.profiles
  for each row execute function kriya.touch_updated_at();

-- Every new auth user gets a profile
create or replace function kriya.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into kriya.profiles (id, display_name)
  values (new.id, left(new.raw_user_meta_data ->> 'display_name', 60))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function kriya.handle_new_user();

-- Platform roles are granted only by the bootstrap script or another owner,
-- never by anything a user can write (no client grants, no policies)
create table kriya.platform_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

/* ───────────────────────────── plans ────────────────────────────── */

create table kriya.plans (
  id text primary key check (id ~ '^[a-z0-9-]{1,32}$'),
  name text not null,
  description text,
  -- Null until the owner sets a price; an unpriced paid plan can't be sold
  price_monthly_paise bigint check (price_monthly_paise >= 0),
  included_usage_micro_inr bigint not null default 0 check (included_usage_micro_inr >= 0),
  -- Customer charge = provider cost (INR) * markup_bps / 10000
  markup_bps integer not null default 10000 check (markup_bps between 0 and 1000000),
  max_agents integer not null default 3 check (max_agents >= 0),
  max_concurrent_tasks integer not null default 1 check (max_concurrent_tasks >= 0),
  max_tasks_per_day integer not null default 20 check (max_tasks_per_day >= 0),
  max_task_seconds integer not null default 300 check (max_task_seconds > 0),
  max_steps integer not null default 20 check (max_steps between 1 and 200),
  max_task_cost_micro_usd bigint not null default 50000 check (max_task_cost_micro_usd > 0),
  allowed_tiers text[] not null default '{budget}',
  browser_minutes integer not null default 0 check (browser_minutes >= 0),
  overage_allowed boolean not null default false,
  overage_cap_micro_inr bigint not null default 0 check (overage_cap_micro_inr >= 0),
  warn_at_pct integer not null default 80 check (warn_at_pct between 1 and 100),
  is_default boolean not null default false,
  active boolean not null default false,
  sort integer not null default 0,
  razorpay_plan_id text,
  updated_at timestamptz not null default now()
);
create unique index plans_one_default on kriya.plans (is_default) where is_default;
create trigger plans_touch before update on kriya.plans
  for each row execute function kriya.touch_updated_at();

-- Launch defaults. Limits are conservative placeholders and paid plans stay
-- inactive and unpriced until the owner configures them in /owner.
insert into kriya.plans (id, name, description, price_monthly_paise, included_usage_micro_inr,
  max_agents, max_concurrent_tasks, max_tasks_per_day, max_task_seconds, max_steps,
  allowed_tiers, is_default, active, sort)
values
  ('free', 'Free', 'Try Kriya Bots with everyday tasks.', 0, 0,
    3, 1, 20, 300, 20, '{budget}', true, true, 0),
  ('starter', 'Starter', 'More tasks and the balanced model.', null, 0,
    10, 2, 200, 900, 40, '{budget,balanced}', false, false, 1),
  ('pro', 'Pro', 'Heavy use, every model tier.', null, 0,
    30, 4, 1000, 1800, 80, '{budget,balanced,escalation}', false, false, 2);

create table kriya.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id text not null references kriya.plans (id),
  status text not null check (status in ('pending', 'active', 'past_due', 'halted', 'canceled', 'expired')),
  provider text not null check (provider in ('razorpay', 'test')),
  provider_subscription_id text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Provider timestamp of the last applied event: older events are ignored
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
create index subscriptions_user_idx on kriya.subscriptions (user_id, created_at desc);
create trigger subscriptions_touch before update on kriya.subscriptions
  for each row execute function kriya.touch_updated_at();

create table kriya.payments (
  id uuid primary key default gen_random_uuid(),
  -- Kept (de-identified) after account deletion for accounting
  user_id uuid references auth.users (id) on delete set null,
  subscription_id uuid references kriya.subscriptions (id) on delete set null,
  provider text not null,
  provider_payment_id text not null,
  amount_paise bigint not null check (amount_paise >= 0),
  fee_paise bigint,
  tax_paise bigint,
  currency text not null default 'INR',
  status text not null check (status in ('captured', 'refunded', 'failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create index payments_paid_idx on kriya.payments (paid_at);

-- Raw provider webhooks, deduplicated by the provider's event id
create table kriya.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (provider, event_id)
);

-- The plan a user is on right now: a live subscription, else the default
create or replace function kriya.effective_plan_id(uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.plan_id from kriya.subscriptions s
      join kriya.plans p on p.id = s.plan_id
      where s.user_id = uid
        and s.status in ('active', 'past_due')
        and (s.current_period_end is null or s.current_period_end > now())
      order by s.created_at desc limit 1),
    (select id from kriya.plans where is_default limit 1)
  )
$$;

/* ───────────────────────────── agents ───────────────────────────── */

create table kriya.agents (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  role text not null check (char_length(role) between 1 and 120),
  instructions text check (char_length(instructions) <= 6000),
  -- A routing tier (budget · balanced · escalation) or null for the default
  model text,
  glyph text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index agents_user_idx on kriya.agents (user_id, created_at);
create trigger agents_touch before update on kriya.agents
  for each row execute function kriya.touch_updated_at();

create table kriya.squads (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index squads_user_idx on kriya.squads (user_id, created_at);

-- Composite keys make a squad and its agents share one owner, in the database
create table kriya.squad_members (
  squad_id text not null,
  agent_id text not null,
  user_id uuid not null,
  position integer not null default 0,
  primary key (squad_id, agent_id),
  foreign key (squad_id, user_id) references kriya.squads (id, user_id) on delete cascade,
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade
);
create index squad_members_agent_idx on kriya.squad_members (agent_id);

/* ───────────────────────────── threads ──────────────────────────── */

create table kriya.threads (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id text,
  squad_id text,
  title text check (char_length(title) <= 80),
  preview text,
  active_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (num_nonnulls(agent_id, squad_id) = 1),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade,
  foreign key (squad_id, user_id) references kriya.squads (id, user_id) on delete cascade
);
create index threads_user_active_idx on kriya.threads (user_id, active_at desc);
create index threads_agent_idx on kriya.threads (agent_id, active_at desc);
create index threads_squad_idx on kriya.threads (squad_id, active_at desc);

-- Message ids come from the client, so they are only unique within a thread
create table kriya.messages (
  thread_id text not null,
  id text not null check (char_length(id) <= 64),
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  parts jsonb not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  primary key (thread_id, id),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);
create index messages_thread_idx on kriya.messages (thread_id, created_at);

/* ───────────────────────────── memory ───────────────────────────── */

create table kriya.memories (
  id text primary key,
  user_id uuid not null,
  agent_id text not null,
  content text not null check (char_length(content) between 1 and 2000),
  -- Who wrote it: the agent during a task, or the person
  source text not null default 'agent' check (source in ('agent', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade
);
create index memories_agent_idx on kriya.memories (agent_id, created_at);
create trigger memories_touch before update on kriya.memories
  for each row execute function kriya.touch_updated_at();

/* ───────────────────────────── tasks ────────────────────────────── */

create table kriya.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  thread_id text not null,
  agent_id text,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  -- { messageId, agentId, channel }
  input jsonb not null,
  plan_id text not null,
  tier text not null check (tier in ('budget', 'balanced', 'escalation')),
  -- Model of the current or last attempt
  model text,
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  idempotency_key text check (char_length(idempotency_key) <= 128),
  step_budget integer not null check (step_budget between 1 and 200),
  cost_budget_micro_usd bigint not null check (cost_budget_micro_usd > 0),
  error_code text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade,
  unique (user_id, idempotency_key)
);
-- One active task per thread, enforced atomically
create unique index tasks_one_active_per_thread on kriya.tasks (thread_id)
  where status in ('queued', 'running');
create index tasks_queue_idx on kriya.tasks (available_at) where status = 'queued';
create index tasks_running_idx on kriya.tasks (user_id) where status = 'running';
create index tasks_user_idx on kriya.tasks (user_id, created_at desc);
create index tasks_status_idx on kriya.tasks (status, finished_at desc);
create trigger tasks_touch before update on kriya.tasks
  for each row execute function kriya.touch_updated_at();

create table kriya.task_attempts (
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  attempt integer not null,
  user_id uuid not null,
  worker_id text not null,
  tier text not null,
  model text not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'canceled', 'lost')),
  error_code text,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (task_id, attempt)
);

-- Stream chunks, batched. A page following a task reads these in order.
create table kriya.task_events (
  id bigserial primary key,
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  user_id uuid not null,
  attempt integer not null,
  seq integer not null,
  chunks jsonb not null,
  created_at timestamptz not null default now(),
  unique (task_id, attempt, seq)
);

create table kriya.tool_executions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  user_id uuid not null,
  attempt integer not null,
  tool_call_id text not null,
  tool_name text not null,
  -- Changes something outside Kriya: such a task is never retried blindly
  side_effect boolean not null default false,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  input jsonb,
  output_summary text,
  evidence jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  unique (task_id, attempt, tool_call_id)
);
create index tool_executions_task_idx on kriya.tool_executions (task_id, started_at);

/* ───────────────────────────── metering ─────────────────────────── */

-- One row per model request. request_key makes retries and duplicate
-- deliveries idempotent: <task>:<attempt>:<step>.
create table kriya.usage_events (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  task_id uuid references kriya.tasks (id) on delete set null,
  attempt integer,
  step integer,
  provider text not null,
  model text not null,
  tier text,
  generation_id text,
  -- Null means the provider didn't say; it never means zero
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cached_tokens integer,
  usage_status text not null check (usage_status in ('reported', 'missing')),
  -- What the provider reported it charged (OpenRouter credits are USD)
  cost_micro_usd bigint,
  cost_source text check (cost_source in ('provider', 'estimate', 'reconciled')),
  -- Calculated from catalogue prices when the provider gave no cost
  estimated_cost_micro_usd bigint,
  latency_ms integer,
  finish_reason text,
  error text,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index usage_events_user_idx on kriya.usage_events (user_id, created_at desc);
create index usage_events_task_idx on kriya.usage_events (task_id);
create index usage_events_created_idx on kriya.usage_events (created_at);

-- What a task cost and what the customer is charged for it. One per task.
create table kriya.charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  task_id uuid unique references kriya.tasks (id) on delete set null,
  plan_id text,
  provider_cost_micro_usd bigint not null default 0,
  -- provider: every request reported a cost · estimate: some were estimated
  -- none: no usage at all (e.g. failed before the first model call)
  cost_basis text not null check (cost_basis in ('provider', 'estimate', 'none')),
  unmetered_requests integer not null default 0,
  fx_usd_inr numeric(12, 4),
  fx_source text,
  provider_cost_micro_inr bigint,
  markup_bps integer not null,
  charge_micro_inr bigint,
  -- final: from provider-reported costs · estimated: includes estimates
  -- unpriced: no exchange rate configured, so nothing could be charged
  status text not null check (status in ('final', 'estimated', 'unpriced')),
  created_at timestamptz not null default now()
);
create index charges_user_idx on kriya.charges (user_id, created_at desc);
create index charges_created_idx on kriya.charges (created_at);

/* ───────────────────────────── platform ─────────────────────────── */

create table kriya.models (
  id text primary key,
  label text not null,
  provider text not null default 'openrouter',
  enabled boolean not null default false,
  supports_tools boolean not null default false,
  supports_structured boolean not null default false,
  supports_images boolean not null default false,
  input_micro_usd_per_mtok bigint,
  output_micro_usd_per_mtok bigint,
  prices_checked_at timestamptz,
  eval_status text not null default 'untested' check (eval_status in ('untested', 'passed', 'failed')),
  eval_notes text,
  evaluated_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger models_touch before update on kriya.models
  for each row execute function kriya.touch_updated_at();

create table kriya.platform_settings (
  key text primary key,
  value text not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table kriya.audit_events (
  id bigserial primary key,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created_idx on kriya.audit_events (created_at desc);

create table kriya.workers (
  id text primary key,
  version text,
  concurrency integer not null,
  running integer not null default 0,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  stopped_at timestamptz
);

create table kriya.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- Fixed-window limiter: true while `key` is under `max_hits` per window
create or replace function kriya.hit_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare hits integer;
begin
  insert into kriya.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning count into hits;
  return hits <= p_max;
end $$;

/* ───────────────────────────── queue ────────────────────────────── */

-- Claims one runnable task. Users with fewer running tasks go first, and a
-- user at their plan's concurrency limit is skipped. The advisory lock keeps
-- two workers from claiming the same user's tasks at the same moment.
create or replace function kriya.claim_task(p_worker text, p_lease_seconds integer)
returns setof kriya.tasks language plpgsql security definer set search_path = '' as $$
declare picked uuid;
begin
  select t.id into picked
  from kriya.tasks t
  join kriya.plans p on p.id = t.plan_id
  where t.status = 'queued'
    and t.available_at <= now()
    and pg_try_advisory_xact_lock(hashtext(t.user_id::text))
    and (select count(*) from kriya.tasks r where r.user_id = t.user_id and r.status = 'running')
        < greatest(p.max_concurrent_tasks, 1)
  order by (select count(*) from kriya.tasks r where r.user_id = t.user_id and r.status = 'running'),
           t.available_at
  for update of t skip locked
  limit 1;

  if picked is null then return; end if;

  return query
  update kriya.tasks t set
    status = 'running',
    attempts = t.attempts + 1,
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now(),
    started_at = coalesce(t.started_at, now())
  where t.id = picked
  returning t.*;
end $$;

-- Extends a lease. No row back means the lease was lost: stop working.
create or replace function kriya.heartbeat_task(p_task uuid, p_worker text, p_lease_seconds integer)
returns table (cancel_requested boolean) language sql security definer set search_path = '' as $$
  update kriya.tasks set
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now()
  where id = p_task and lease_owner = p_worker and status = 'running'
  returning cancel_requested_at is not null
$$;

-- Tasks whose worker died. Requeued with backoff while attempts remain and
-- nothing with side effects ran; otherwise failed, so nothing repeats twice.
-- Also expires tasks that waited past their deadline.
create or replace function kriya.recover_tasks() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; c integer;
begin
  update kriya.task_attempts a set status = 'lost', finished_at = now(), error_code = 'worker_lost'
  from kriya.tasks t
  where a.task_id = t.id and a.attempt = t.attempts and a.status = 'running'
    and t.status = 'running' and t.lease_expires_at < now();

  update kriya.tasks t set
    status = case
      when t.cancel_requested_at is not null then 'canceled'
      when t.attempts < t.max_attempts
        and t.deadline_at > now()
        and not exists (select 1 from kriya.tool_executions e
                        where e.task_id = t.id and e.side_effect)
      then 'queued' else 'failed' end,
    available_at = now() + make_interval(secs => least(300, 5 * power(2, t.attempts)::integer)),
    error_code = 'worker_lost',
    error = 'The worker running this task stopped responding.',
    lease_owner = null,
    lease_expires_at = null,
    finished_at = case when t.attempts >= t.max_attempts or t.deadline_at <= now() then now() end
  where t.status = 'running' and t.lease_expires_at < now();
  get diagnostics c = row_count; n := n + c;

  update kriya.tasks set status = 'failed', error_code = 'deadline',
    error = 'The task waited longer than its deadline.', finished_at = now()
  where status = 'queued' and deadline_at < now();
  get diagnostics c = row_count; n := n + c;

  return n;
end $$;

revoke all on function kriya.claim_task(text, integer) from public;
revoke all on function kriya.heartbeat_task(uuid, text, integer) from public;
revoke all on function kriya.recover_tasks() from public;
revoke all on function kriya.hit_rate_limit(text, integer, integer) from public;
revoke all on function kriya.effective_plan_id(uuid) from public;
grant execute on function kriya.effective_plan_id(uuid) to authenticated;

/* ───────────────────────────── access ───────────────────────────── */

-- Content the person owns: full access to their own rows
grant select, insert, update, delete on
  kriya.agents, kriya.squads, kriya.squad_members, kriya.threads,
  kriya.messages, kriya.memories
to authenticated;

-- Written by the server and worker only; readable by the owner
grant select on
  kriya.tasks, kriya.task_attempts, kriya.task_events, kriya.tool_executions,
  kriya.usage_events, kriya.charges, kriya.subscriptions, kriya.payments,
  kriya.plans
to authenticated;

-- Profiles: a person edits their own, except their status
grant select on kriya.profiles to authenticated;
grant update (display_name, locale, use_case, onboarded_at) on kriya.profiles to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'platform_roles', 'plans', 'subscriptions', 'payments', 'billing_events',
    'agents', 'squads', 'squad_members', 'threads', 'messages', 'memories',
    'tasks', 'task_attempts', 'task_events', 'tool_executions',
    'usage_events', 'charges', 'models', 'platform_settings', 'audit_events',
    'workers', 'rate_limits'
  ] loop
    execute format('alter table kriya.%I enable row level security', t);
  end loop;

  -- Owner-only rows: one policy per table, for every command
  foreach t in array array[
    'agents', 'squads', 'squad_members', 'threads', 'messages', 'memories'
  ] loop
    execute format(
      'create policy own_rows on kriya.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
  end loop;

  foreach t in array array[
    'tasks', 'task_attempts', 'task_events', 'tool_executions',
    'usage_events', 'charges', 'subscriptions', 'payments'
  ] loop
    execute format(
      'create policy read_own on kriya.%I for select to authenticated
         using (user_id = (select auth.uid()))', t);
  end loop;
end $$;

create policy read_own on kriya.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy update_own on kriya.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy read_active on kriya.plans for select to authenticated
  using (active);

-- The privileged server connection (the postgres role) bypasses RLS, as in
-- every Supabase project; it is used only by the worker and for operations
-- that are explicitly authorized in code (lib/auth.ts, lib/owner.ts).
