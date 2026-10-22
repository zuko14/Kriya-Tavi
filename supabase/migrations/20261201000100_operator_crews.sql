-- Crews whose members act (track O, O11; docs/operator/CREW_EXECUTION.md,
-- OD-19). A job's lead splits work into up to 4 parts; each part is an
-- ordinary task in its own thread, run by one squad member with its own
-- tools, approvals and grants. The worker joins the results back into the
-- job's thread. Only the server writes these rows; the person reads them.

create table kriya.crew_runs (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  lead_thread_id text not null,
  lead_agent_id text not null,
  squad_id text not null,
  -- O11 v1 runs crews only inside a job
  mandate_id text not null,
  round integer not null default 1 check (round between 1 and 3),
  status text not null default 'running'
    check (status in ('running', 'joining', 'joined', 'canceled')),
  deadline_at timestamptz not null,
  join_task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (mandate_id, round),
  foreign key (lead_thread_id, user_id) references kriya.threads (id, user_id) on delete cascade,
  foreign key (mandate_id, user_id) references kriya.mandates (id, user_id) on delete cascade
);
create index crew_runs_user_idx on kriya.crew_runs (user_id);
create index crew_runs_lead_thread_idx on kriya.crew_runs (lead_thread_id, user_id);
create index crew_runs_mandate_idx on kriya.crew_runs (mandate_id, user_id);
-- One crew at a time per job
create unique index crew_runs_one_open on kriya.crew_runs (mandate_id)
  where status in ('running', 'joining');
create trigger crew_runs_touch before update on kriya.crew_runs
  for each row execute function kriya.touch_updated_at();
create trigger crew_runs_transition before update of status on kriya.crew_runs
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('crew_run');

create table kriya.crew_parts (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id text not null,
  key text not null check (key ~ '^[A-Za-z0-9_-]{1,12}$'),
  agent_id text not null,
  -- The part's own thread
  thread_id text not null unique,
  brief text not null check (char_length(brief) between 1 and 1500),
  depends_on text[] not null default '{}',
  status text not null default 'waiting' check (status in
    ('waiting', 'queued', 'working', 'needs_approval', 'done', 'failed', 'canceled')),
  task_id uuid,
  result text check (char_length(result) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, key),
  foreign key (run_id, user_id) references kriya.crew_runs (id, user_id) on delete cascade,
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);
create index crew_parts_user_idx on kriya.crew_parts (user_id);
create index crew_parts_run_idx on kriya.crew_parts (run_id, user_id);
create index crew_parts_thread_idx on kriya.crew_parts (thread_id, user_id);
create trigger crew_parts_touch before update on kriya.crew_parts
  for each row execute function kriya.touch_updated_at();
create trigger crew_parts_transition before update of status on kriya.crew_parts
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('crew_part');

/* ───────────────────────────── transitions ──────────────────────── */

-- A part's status follows its thread's latest task (lib/operator/crews.ts),
-- which may finish between two worker passes, so queued may jump ahead
insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('crew_run', 'running', 'joining'),
  ('crew_run', 'running', 'canceled'),
  ('crew_run', 'joining', 'joined'),
  ('crew_run', 'joining', 'canceled'),
  ('crew_part', 'waiting', 'queued'),
  ('crew_part', 'waiting', 'failed'),
  ('crew_part', 'waiting', 'canceled'),
  ('crew_part', 'queued', 'working'),
  ('crew_part', 'queued', 'needs_approval'),
  ('crew_part', 'queued', 'done'),
  ('crew_part', 'queued', 'failed'),
  ('crew_part', 'queued', 'canceled'),
  ('crew_part', 'working', 'needs_approval'),
  ('crew_part', 'working', 'done'),
  ('crew_part', 'working', 'failed'),
  ('crew_part', 'working', 'canceled'),
  ('crew_part', 'needs_approval', 'working'),
  ('crew_part', 'needs_approval', 'done'),
  ('crew_part', 'needs_approval', 'failed'),
  ('crew_part', 'needs_approval', 'canceled');

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.crew_runs enable row level security;
alter table kriya.crew_parts enable row level security;

-- The person reads their own; only the worker (privileged) writes
create policy read_own on kriya.crew_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.crew_runs for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.crew_runs for update to anon, authenticated
  using (false) with check (false);
grant select on kriya.crew_runs to authenticated;

create policy read_own on kriya.crew_parts for select to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.crew_parts for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.crew_parts for update to anon, authenticated
  using (false) with check (false);
grant select on kriya.crew_parts to authenticated;
