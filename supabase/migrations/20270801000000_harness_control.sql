-- Kriya Harness Control Center (track H, docs/kriya-harness/CONTROL_CENTER.md).
-- The person queues typed actions for one of their own computers from Kriya;
-- the computer's daemon (`kriya daemon`) claims and runs them, and every
-- kriya process reports what it runs. Readable only by the person. The
-- person may queue and cancel; only the server (device routes, after
-- authenticateDevice and scoped by the device's user) claims, runs and
-- finishes. Owner-only: no room or shared access.

/* ─────────────────────────── device state ───────────────────────── */

-- What a computer's daemon last said about itself: when it last asked for
-- work, what it allows from Kriya (set on the computer, never here), its
-- project folders (the only places a task may run) and its learned rules.
create table kriya.harness_device_state (
  device_id uuid primary key references kriya.harness_devices (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  daemon_version text check (char_length(daemon_version) <= 20),
  capabilities jsonb not null default '{}'::jsonb,
  projects jsonb not null default '[]'::jsonb check (jsonb_typeof(projects) = 'array'),
  rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  doctor jsonb,
  polled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index harness_device_state_user_idx on kriya.harness_device_state (user_id);

/* ──────────────────────────── dispatches ────────────────────────── */

create table kriya.harness_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  kind text not null check (kind in (
    'run', 'doctor', 'rule_confirm', 'rule_dismiss', 'handoff', 'pull', 'serve_start', 'serve_stop'
  )),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'running', 'canceling', 'done', 'failed', 'canceled', 'expired'
  )),
  result jsonb check (result is null or pg_column_size(result) <= 32768),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  claimed_at timestamptz,
  finished_at timestamptz
);
create index harness_dispatches_device_idx on kriya.harness_dispatches (device_id, status, created_at);
create index harness_dispatches_user_idx on kriya.harness_dispatches (user_id, created_at desc);
create trigger harness_dispatches_transition before update of status
  on kriya.harness_dispatches
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('harness_dispatch');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('harness_dispatch', 'queued', 'claimed'),
  ('harness_dispatch', 'queued', 'canceled'),
  ('harness_dispatch', 'queued', 'expired'),
  ('harness_dispatch', 'claimed', 'running'),
  ('harness_dispatch', 'claimed', 'done'),
  ('harness_dispatch', 'claimed', 'failed'),
  ('harness_dispatch', 'claimed', 'canceling'),
  ('harness_dispatch', 'running', 'done'),
  ('harness_dispatch', 'running', 'failed'),
  ('harness_dispatch', 'running', 'canceling'),
  ('harness_dispatch', 'canceling', 'canceled'),
  ('harness_dispatch', 'canceling', 'done'),
  ('harness_dispatch', 'canceling', 'failed');

/* ────────────────────────────── runs ────────────────────────────── */

-- What kriya processes on a computer are running, from the terminal or a
-- dispatch: mode, switches, project name and state. No task text from the
-- terminal; a dispatched run's task is the person's own, already here.
create table kriya.harness_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  local_id text not null check (char_length(local_id) between 1 and 80),
  source text not null check (source in ('terminal', 'dispatch')),
  kind text not null check (kind in ('app', 'run', 'acp', 'serve', 'handoff', 'pull')),
  mode text check (mode in ('ask', 'auto', 'read', 'plan', 'full')),
  switches jsonb not null default '{}'::jsonb check (pg_column_size(switches) <= 2048),
  project text check (char_length(project) <= 80),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'blocked', 'stopped')),
  exit_code integer,
  dispatch_id uuid references kriya.harness_dispatches (id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (device_id, local_id)
);
create index harness_runs_user_idx on kriya.harness_runs (user_id, updated_at desc);

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.harness_device_state enable row level security;
create policy read_own on kriya.harness_device_state for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_device_state to authenticated;

alter table kriya.harness_dispatches enable row level security;
create policy read_own on kriya.harness_dispatches for select to authenticated
  using (user_id = (select auth.uid()));
-- The person queues for their own, signed-in computer only
create policy queue_own on kriya.harness_dispatches for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'queued'
    and exists (
      select 1 from kriya.harness_devices d
      where d.id = device_id and d.user_id = (select auth.uid()) and d.revoked_at is null
    )
  );
-- … and may only cancel: never claim, run, finish or rewrite a result
create policy cancel_own on kriya.harness_dispatches for update to authenticated
  using (user_id = (select auth.uid()) and status in ('queued', 'claimed', 'running'))
  with check (user_id = (select auth.uid()) and status in ('canceled', 'canceling'));
grant select on kriya.harness_dispatches to authenticated;
grant insert (user_id, device_id, kind, payload) on kriya.harness_dispatches to authenticated;
grant update (status, finished_at) on kriya.harness_dispatches to authenticated;

alter table kriya.harness_runs enable row level security;
create policy read_own on kriya.harness_runs for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_runs to authenticated;
