-- Cloud workspaces (track C, C1; docs/cloud-execution/DATA_MODEL_AND_STATE_MACHINES.md,
-- CD-14, CD-15): one durable workspace per thread that outlives every
-- provider sandbox, one row per running interval of a sandbox, the plan's
-- monthly workspace minutes and the platform's running cap enforced here when
-- a session opens (invariant 7). Compute time is metered in
-- kriya.resource_usage (workspace_seconds); kriya.charges is unchanged.
--
-- Only the worker writes (privileged, scoped by user id). The person reads
-- their own rows and may only ask to close a workspace (close_requested_at;
-- PERSON_ONLY_WRITES keeps tools off it). No code, logs, archives or patches
-- are stored here: checkpoints live in Storage, this holds their path.

/* ───────────────────────────── workspaces ───────────────────────── */

create table kriya.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The thread it serves; a deleted thread leaves the row for the janitor
  thread_id text,
  -- The agent that opened it (provenance; squads share the thread's workspace)
  agent_id text,
  -- owner/name, the lib/connectors/github.ts REPO pattern; null = blank workspace
  repo text check (repo ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  base_ref text check (char_length(base_ref) <= 100),
  base_sha text check (base_sha ~ '^[0-9a-f]{40}$'),
  provider text not null check (provider in ('local', 'e2b', 'daytona')),
  -- The provider's sandbox id; not a secret, never shown to the person
  provider_ref text check (char_length(provider_ref) <= 200),
  image text not null check (char_length(image) between 1 and 200),
  size text not null check (size ~ '^[1-8]c-[1-9][0-9]?g$'),
  network text not null default 'registries' check (network in ('registries', 'offline')),
  status text not null default 'new'
    check (status in ('new', 'starting', 'running', 'paused', 'closing', 'closed', 'failed')),
  -- +1 for every fresh sandbox (create or restore); part of the runner token
  generation integer not null default 0 check (generation >= 0),
  -- Latest checkpoint in kriya-files: workspaces/<user_id>/<id>/<generation>-<seq>.patch
  checkpoint_path text check (char_length(checkpoint_path) <= 300),
  checkpoint_sha256 text check (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_bytes bigint check (checkpoint_bytes >= 0),
  checkpoint_at timestamptz,
  checkpoint_seq integer not null default 0 check (checkpoint_seq >= 0),
  -- Set when an upload failed; the sandbox is never destroyed while set
  checkpoint_failed_at timestamptz,
  -- For the strip: { files, added, removed } since base, written by code
  changes jsonb check (changes is null or jsonb_typeof(changes) = 'object'),
  -- The person asked to close it (their only write, column grant below)
  close_requested_at timestamptz,
  error text check (char_length(error) <= 500),
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (thread_id, user_id) references kriya.threads (id, user_id)
    on delete set null (thread_id)
);
create unique index workspaces_one_open_per_thread on kriya.workspaces (thread_id)
  where status not in ('closed', 'failed');
create index workspaces_user_idx on kriya.workspaces (user_id, last_active_at);
create index workspaces_janitor_idx on kriya.workspaces (status, last_active_at);
create trigger workspaces_touch before update on kriya.workspaces
  for each row execute function kriya.touch_updated_at();
create trigger workspaces_transition before update of status on kriya.workspaces
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('workspace');

-- failed → starting only with a checkpoint or for a blank workspace;
-- TaskWorkspace checks that (DATA_MODEL §5)
insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('workspace', 'new', 'starting'),
  ('workspace', 'starting', 'running'),
  ('workspace', 'starting', 'failed'),
  ('workspace', 'starting', 'paused'),
  ('workspace', 'running', 'paused'),
  ('workspace', 'running', 'failed'),
  ('workspace', 'running', 'closing'),
  ('workspace', 'paused', 'starting'),
  ('workspace', 'paused', 'closing'),
  ('workspace', 'failed', 'starting'),
  ('workspace', 'failed', 'closing'),
  ('workspace', 'closing', 'closed');

/* ──────────────────────────── sessions ──────────────────────────── */

-- One row per running interval of a sandbox (the browser-session pattern)
create table kriya.workspace_sessions (
  id uuid primary key,
  workspace_id uuid not null references kriya.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references kriya.tasks (id) on delete set null,
  provider text not null check (provider in ('local', 'e2b', 'daytona')),
  generation integer not null check (generation >= 0),
  status text not null default 'open' check (status in ('open', 'closed', 'failed')),
  opened_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  closed_at timestamptz,
  seconds integer check (seconds >= 0),
  close_reason text check (close_reason in
    ('end', 'canceled', 'deadline', 'budget', 'shutdown', 'lease_lost', 'orphan', 'error', 'closed'))
);
create unique index workspace_sessions_one_open on kriya.workspace_sessions (workspace_id)
  where status = 'open';
create index workspace_sessions_open_idx on kriya.workspace_sessions (status, heartbeat_at);
create index workspace_sessions_user_idx on kriya.workspace_sessions (user_id, opened_at);
-- Covers the task foreign key (the P-2 advisor finding class)
create index workspace_sessions_task_idx on kriya.workspace_sessions (task_id);

/* ──────────────────────── plans and metering ────────────────────── */

-- Conservative: no plan gets workspaces until the owner sets minutes (CD-14)
alter table kriya.plans
  add column workspace_minutes integer not null default 0 check (workspace_minutes >= 0);

-- workspace_storage_bytes: checkpoint bytes stored, one row per checkpoint
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes'
));

/* ───────────────────────── opening a session ────────────────────── */

-- Called by the worker only, before the provider is asked for compute.
-- Refuses when the IST month's metered seconds plus the running sessions'
-- elapsed time reach the plan's minutes, when the platform cap of running
-- sandboxes is reached, or when the workspace already has an open session
-- (the unique index). Unlike the browser function, open sessions count.
create function kriya.open_workspace_session(
  p_id uuid, p_task uuid, p_workspace uuid, p_provider text, p_max_running integer
) returns void language plpgsql set search_path = '' as $$
declare
  v_user uuid;
  v_minutes integer;
  v_used bigint;
  v_generation integer;
begin
  select t.user_id, p.workspace_minutes into v_user, v_minutes
    from kriya.tasks t join kriya.plans p on p.id = t.plan_id
    where t.id = p_task;
  if v_user is null then
    raise exception 'workspace session for an unknown task';
  end if;
  select w.generation into v_generation from kriya.workspaces w
    where w.id = p_workspace and w.user_id = v_user
    for update;
  if v_generation is null then
    raise exception 'workspace session for another person''s workspace';
  end if;
  -- One lock for the platform-wide count, so two workers can't both pass it
  perform pg_advisory_xact_lock(hashtext('kriya.workspace_sessions'));
  if (select count(*) from kriya.workspace_sessions where status = 'open') >= p_max_running then
    raise exception 'cloud workspaces are all busy';
  end if;
  select coalesce(sum(quantity), 0) into v_used from kriya.resource_usage
    where user_id = v_user and kind = 'workspace_seconds'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  v_used := v_used + coalesce((select sum(extract(epoch from now() - opened_at))::bigint
    from kriya.workspace_sessions where user_id = v_user and status = 'open'), 0);
  if v_used >= v_minutes::bigint * 60 then
    raise exception 'cloud workspace minutes used up for this month';
  end if;
  insert into kriya.workspace_sessions (id, workspace_id, user_id, task_id, provider, generation)
    values (p_id, p_workspace, v_user, p_task, p_provider, v_generation);
end $$;
revoke all on function kriya.open_workspace_session(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.workspaces enable row level security;
alter table kriya.workspace_sessions enable row level security;

create policy read_own on kriya.workspaces for select to authenticated
  using (user_id = (select auth.uid()));
create policy close_own on kriya.workspaces for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on kriya.workspaces to authenticated;
-- The person's only write: asking to close (the worker does the rest)
grant update (close_requested_at) on kriya.workspaces to authenticated;

create policy read_own on kriya.workspace_sessions for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.workspace_sessions to authenticated;
