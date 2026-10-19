-- Goals, schedules, approvals and episodes (phase A3, DATA_MODEL §1, §2.3).
--
-- Goals have their own thread. Schedules exist only once the person
-- approved them, and fire as ordinary tasks through lib/agent/queue.ts
-- (AD-15): the worker records each fire in schedule_runs, keyed by
-- (schedule, due time). Approvals index the tool calls waiting for the
-- person (the decision itself stays in the message parts). Episodes are
-- the "What I did" records derived from verified tool runs, hash-chained
-- per person (K1) and immutable except for the person's delete.
-- Status changes follow kriya.allowed_transitions.

/* ───────────────────────────── transitions ──────────────────────── */

create table kriya.allowed_transitions (
  entity text not null,
  from_status text not null,
  to_status text not null,
  primary key (entity, from_status, to_status)
);
insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('goal', 'active', 'paused'),
  ('goal', 'paused', 'active'),
  ('goal', 'active', 'achieved'),
  ('goal', 'active', 'abandoned'),
  ('goal', 'paused', 'abandoned'),
  ('goal', 'achieved', 'active'),
  ('schedule', 'active', 'paused'),
  ('schedule', 'paused', 'active'),
  ('schedule', 'active', 'ended'),
  ('schedule', 'paused', 'ended'),
  ('approval', 'pending', 'approved'),
  ('approval', 'pending', 'declined'),
  ('approval', 'pending', 'expired');

-- Raises unless (entity, old status, new status) is listed above
create function kriya.check_transition() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from kriya.allowed_transitions
    where entity = tg_argv[0] and from_status = old.status and to_status = new.status
  ) then
    raise exception '% can''t go from % to %', tg_argv[0], old.status, new.status;
  end if;
  return new;
end $$;

/* ───────────────────────────── goals ────────────────────────────── */

create table kriya.goals (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Lead agent or team; the goal outlives either
  agent_id text,
  squad_id text,
  thread_id text not null unique,
  title text not null check (char_length(title) between 1 and 200),
  success_criteria text check (char_length(success_criteria) <= 2000),
  -- [{ id, text, status: todo|doing|done|blocked, evidence?: episode id }]
  plan jsonb not null default '[]'
    check (case when jsonb_typeof(plan) = 'array' then jsonb_array_length(plan) <= 30 else false end),
  status text not null default 'active'
    check (status in ('active', 'paused', 'achieved', 'abandoned')),
  check_in jsonb,
  monthly_budget_micro_inr bigint check (monthly_budget_micro_inr > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, user_id),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete set null (agent_id),
  foreign key (squad_id, user_id) references kriya.squads (id, user_id) on delete set null (squad_id),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);
create index goals_user_idx on kriya.goals (user_id, created_at desc);
create trigger goals_touch before update on kriya.goals
  for each row execute function kriya.touch_updated_at();
create trigger goals_transition before update of status on kriya.goals
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('goal');

/* ───────────────────────────── schedules ────────────────────────── */

create table kriya.schedules (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id text not null,
  thread_id text not null,
  goal_id text,
  kind text not null check (kind in ('once', 'recurring', 'watch')),
  -- What each run should do; written into the thread as the run's message
  prompt text not null check (char_length(prompt) between 1 and 2000),
  -- { freq, at?, days?, dayOfMonth?, everyMinutes?, startAt? }, checked by
  -- lib/schedules.ts
  rule jsonb not null,
  timezone text not null default 'Asia/Kolkata',
  -- Null when ended or paused
  next_run_at timestamptz,
  last_run_at timestamptz,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  pause_reason text check (char_length(pause_reason) <= 40),
  -- Required to use a login profile when the person isn't present (A6)
  background_allowed boolean not null default false,
  runs integer not null default 0 check (runs >= 0),
  max_runs integer check (max_runs > 0),
  -- The person's ₹ cap per run (K2); converted into the task's budget
  cap_micro_inr bigint check (cap_micro_inr > 0),
  -- A schedule spends money later, so it exists only once approved (R2)
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade,
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade,
  foreign key (goal_id, user_id) references kriya.goals (id, user_id) on delete cascade
);
create index schedules_due_idx on kriya.schedules (next_run_at) where status = 'active';
create index schedules_user_idx on kriya.schedules (user_id, created_at desc);
create trigger schedules_touch before update on kriya.schedules
  for each row execute function kriya.touch_updated_at();
create trigger schedules_transition before update of status on kriya.schedules
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('schedule');

-- One row per due time: the primary key makes each fire happen once
create table kriya.schedule_runs (
  schedule_id text not null references kriya.schedules (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  due_at timestamptz not null,
  task_id uuid references kriya.tasks (id) on delete set null,
  outcome text not null check (outcome in
    ('claimed', 'enqueued', 'skipped_active', 'skipped_limit', 'skipped_budget', 'failed')),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (schedule_id, due_at)
);
create index schedule_runs_claimed_idx on kriya.schedule_runs (created_at) where outcome = 'claimed';
create index schedule_runs_user_idx on kriya.schedule_runs (user_id, due_at desc);
create trigger schedule_runs_touch before update on kriya.schedule_runs
  for each row execute function kriya.touch_updated_at();

/* ───────────────────────────── approvals ────────────────────────── */

create table kriya.approvals (
  -- The AI SDK's approval id
  id text not null check (char_length(id) <= 128),
  user_id uuid not null,
  thread_id text not null,
  task_id uuid references kriya.tasks (id) on delete cascade,
  tool_name text not null,
  risk_class text not null check (risk_class in ('R2', 'R3', 'R4')),
  title text not null check (char_length(title) <= 200),
  -- Redacted input (and a screenshot file id for browser steps, A6)
  preview jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '72 hours',
  decided_at timestamptz,
  primary key (thread_id, id),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);
create index approvals_user_idx on kriya.approvals (user_id, status, created_at desc);
create index approvals_expiry_idx on kriya.approvals (expires_at) where status = 'pending';
create trigger approvals_transition before update of status on kriya.approvals
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('approval');

/* ───────────────────────────── episodes ─────────────────────────── */

create table kriya.episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid unique references kriya.tasks (id) on delete cascade,
  thread_id text not null,
  agent_id text,
  goal_id text,
  -- [{ executionId, tool, title, risk, verification, evidence }]: verified runs only
  done jsonb not null default '[]',
  -- Runs that weren't re-checked, and claims in the reply with no matching run
  unconfirmed jsonb not null default '[]',
  -- K7 citation checks on the reply: [{ sentence, status, reason }]
  checks jsonb not null default '[]',
  files uuid[] not null default '{}',
  titles text,
  summary text check (char_length(summary) <= 300),
  search tsvector generated always as
    (to_tsvector('simple', coalesce(summary, '') || ' ' || coalesce(titles, ''))) stored,
  -- Receipt chain (K1): hash = sha256(prev_hash ‖ canonical record), per person
  seq bigint not null check (seq > 0),
  prev_hash text,
  hash text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, seq)
);
create index episodes_user_idx on kriya.episodes (user_id, created_at desc);
create index episodes_search_idx on kriya.episodes using gin (search);

-- An episode never changes, which keeps the chain checkable. Two updates
-- pass: the person's delete (content cleared, chain kept), and the worker
-- filling an empty summary once.
create function kriya.episodes_guard() returns trigger language plpgsql as $$
declare
  same_chain boolean := (new.id, new.user_id, new.task_id, new.thread_id, new.agent_id,
    new.goal_id, new.files, new.seq, new.prev_hash, new.hash, new.created_at)
    is not distinct from (old.id, old.user_id, old.task_id, old.thread_id, old.agent_id,
    old.goal_id, old.files, old.seq, old.prev_hash, old.hash, old.created_at);
begin
  if same_chain and old.deleted_at is null and new.deleted_at is not null
    and new.done = '[]'::jsonb and new.unconfirmed = '[]'::jsonb and new.checks = '[]'::jsonb
    and new.titles is null and new.summary is null then
    return new;
  end if;
  if same_chain and current_user <> 'authenticated' and old.deleted_at is null
    and new.deleted_at is null and old.summary is null and new.summary is not null
    and new.done = old.done and new.unconfirmed = old.unconfirmed
    and new.checks = old.checks and new.titles is not distinct from old.titles then
    return new;
  end if;
  raise exception 'episodes are immutable';
end $$;
create trigger episodes_guard before update on kriya.episodes
  for each row execute function kriya.episodes_guard();

/* ───────────────────────────── existing tables ──────────────────── */

-- The tool's own check of what it did (TOOLS_AND_CONTRACTS §1); kept whole,
-- unlike output_summary, which is cut at 500 characters (AF-10)
alter table kriya.tool_executions add column verification jsonb;

-- Conservative placeholders; the owner sets real values in /owner
alter table kriya.plans
  add column max_goals integer not null default 3 check (max_goals >= 0),
  add column max_schedules integer not null default 3 check (max_schedules >= 0),
  add column min_schedule_interval_minutes integer not null default 1440
    check (min_schedule_interval_minutes >= 60);

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.allowed_transitions enable row level security;
alter table kriya.goals enable row level security;
alter table kriya.schedules enable row level security;
alter table kriya.schedule_runs enable row level security;
alter table kriya.approvals enable row level security;
alter table kriya.episodes enable row level security;

create policy read_all on kriya.allowed_transitions for select to authenticated using (true);
grant select on kriya.allowed_transitions to authenticated;

-- The person's own goals and schedules, changed through server actions
create policy own_rows on kriya.goals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on kriya.schedules for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on kriya.goals, kriya.schedules to authenticated;

-- Written by the worker; the person reads their own
create policy read_own on kriya.schedule_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy read_own on kriya.approvals for select to authenticated
  using (user_id = (select auth.uid()));
create policy read_own on kriya.episodes for select to authenticated
  using (user_id = (select auth.uid()));
create policy delete_own on kriya.episodes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on kriya.schedule_runs, kriya.approvals, kriya.episodes to authenticated;
-- Only for the content-clearing delete; episodes_guard refuses anything else
grant update (deleted_at, done, unconfirmed, checks, titles, summary)
  on kriya.episodes to authenticated;
