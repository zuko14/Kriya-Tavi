-- Flows (track S, docs/kriya-studio/). A flow is a graph the person draws or
-- describes; a run is that graph at one immutable version, advanced by the
-- worker. Agent nodes are ordinary tasks in their own threads, so nothing in
-- the queue, approvals, receipts or metering changes. The person edits their
-- own flows; only the server writes runs (after checking the session, or in
-- the worker), scoped by user id. Off with studio.flows.

create table kriya.flows (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 400),
  target text not null default 'cloud' check (target in ('cloud', 'device')),
  -- The work in progress; a run never reads this, only a version
  draft jsonb not null check (pg_column_size(draft) < 262144),
  -- Optimistic lock: two tabs can't overwrite each other
  draft_rev integer not null default 0,
  latest_version integer not null default 0,
  -- Saved inputs for Compare
  cases jsonb not null default '[]'::jsonb
    check (jsonb_typeof(cases) = 'array' and pg_column_size(cases) < 65536),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index flows_user_idx on kriya.flows (user_id, updated_at desc);
create trigger flows_touch before update on kriya.flows
  for each row execute function kriya.touch_updated_at();

create table kriya.flow_versions (
  flow_id text not null,
  version integer not null check (version >= 1),
  user_id uuid not null references auth.users (id) on delete cascade,
  graph jsonb not null check (pg_column_size(graph) < 262144),
  -- sha256 of the graph without positions (lib/flows/compile.ts semanticGraph)
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  source text not null default 'person'
    check (source in ('person', 'copilot', 'improve', 'rollback')),
  note text not null default '' check (char_length(note) <= 400),
  parent_version integer,
  created_at timestamptz not null default now(),
  primary key (flow_id, version),
  unique (flow_id, version, user_id),
  foreign key (flow_id, user_id) references kriya.flows (id, user_id) on delete cascade
);
create index flow_versions_user_idx on kriya.flow_versions (user_id);

-- A version never changes: runs and comparisons point at it (SD-10)
create function kriya.flow_version_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'a flow version never changes';
end $$;
create trigger flow_versions_frozen before update on kriya.flow_versions
  for each row execute function kriya.flow_version_frozen();

create table kriya.flow_runs (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  flow_id text not null,
  version integer not null,
  status text not null default 'queued' check (status in
    ('queued', 'running', 'waiting', 'completed', 'failed', 'canceled')),
  inputs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) < 65536),
  output text check (char_length(output) <= 8000),
  error text check (char_length(error) <= 1000),
  -- Whole-run ₹ cap in micro-INR; null means the plan's limits alone
  budget_micro_inr bigint check (budget_micro_inr is null or budget_micro_inr > 0),
  -- A paired comparison of two versions (SD-13)
  comparison_id text,
  arm text check (arm is null or arm in ('incumbent', 'candidate')),
  case_index integer,
  round integer,
  forked_from text,
  -- A device flow's computer, folder, mode and queued action (SD-14)
  device_id uuid,
  project text,
  mode text check (mode is null or mode in ('ask', 'auto', 'read', 'plan', 'full')),
  dispatch_id uuid,
  -- When a worker may look at this run next; doubles as its lease
  review_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (id, user_id),
  foreign key (flow_id, version, user_id)
    references kriya.flow_versions (flow_id, version, user_id) on delete cascade
);
create index flow_runs_user_idx on kriya.flow_runs (user_id, created_at desc);
create index flow_runs_flow_idx on kriya.flow_runs (flow_id, created_at desc);
create index flow_runs_comparison_idx on kriya.flow_runs (comparison_id)
  where comparison_id is not null;
create index flow_runs_review_idx on kriya.flow_runs (review_at)
  where status in ('queued', 'running', 'waiting');
create trigger flow_runs_touch before update on kriya.flow_runs
  for each row execute function kriya.touch_updated_at();
create trigger flow_runs_transition before update of status on kriya.flow_runs
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('flow_run');

create table kriya.flow_node_runs (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id text not null,
  node_id text not null,
  -- '' or loop#2 or loop#2/inner#1: an iteration is data, not a new graph
  scope text not null default '' check (char_length(scope) <= 200),
  attempt integer not null default 1 check (attempt between 1 and 10),
  status text not null check (status in
    ('running', 'waiting', 'done', 'failed', 'skipped', 'canceled')),
  port text,
  iteration integer not null default 1,
  task_id uuid,
  thread_id text,
  output text check (char_length(output) <= 8000),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  -- Copied from this row of an earlier run, not executed (SD-09)
  reused_from text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (run_id, node_id, scope, attempt),
  foreign key (run_id, user_id) references kriya.flow_runs (id, user_id) on delete cascade,
  foreign key (thread_id, user_id) references kriya.threads (id, user_id)
    on delete set null (thread_id)
);
create index flow_node_runs_user_idx on kriya.flow_node_runs (user_id);
create index flow_node_runs_thread_idx on kriya.flow_node_runs (thread_id)
  where thread_id is not null;
create index flow_node_runs_waiting_idx on kriya.flow_node_runs (user_id)
  where status = 'waiting';
create trigger flow_node_runs_touch before update on kriya.flow_node_runs
  for each row execute function kriya.touch_updated_at();
create trigger flow_node_runs_transition before update of status on kriya.flow_node_runs
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('flow_node_run');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('flow_run', 'queued', 'running'),
  ('flow_run', 'queued', 'failed'),
  ('flow_run', 'queued', 'canceled'),
  ('flow_run', 'running', 'waiting'),
  ('flow_run', 'running', 'completed'),
  ('flow_run', 'running', 'failed'),
  ('flow_run', 'running', 'canceled'),
  ('flow_run', 'waiting', 'running'),
  ('flow_run', 'waiting', 'completed'),
  ('flow_run', 'waiting', 'failed'),
  ('flow_run', 'waiting', 'canceled'),
  -- Retry after a failure
  ('flow_run', 'failed', 'running'),
  ('flow_node_run', 'running', 'waiting'),
  ('flow_node_run', 'running', 'done'),
  ('flow_node_run', 'running', 'failed'),
  ('flow_node_run', 'running', 'canceled'),
  ('flow_node_run', 'waiting', 'running'),
  ('flow_node_run', 'waiting', 'done'),
  ('flow_node_run', 'waiting', 'failed'),
  ('flow_node_run', 'waiting', 'canceled');

alter table kriya.flows enable row level security;
alter table kriya.flow_versions enable row level security;
alter table kriya.flow_runs enable row level security;
alter table kriya.flow_node_runs enable row level security;

-- The person's own flows: read, create, edit. No delete: archived_at
create policy own_flows on kriya.flows for select to authenticated
  using (user_id = (select auth.uid()));
create policy add_flows on kriya.flows for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy edit_flows on kriya.flows for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert on kriya.flows to authenticated;
grant update (name, description, draft, draft_rev, latest_version, cases, archived_at)
  on kriya.flows to authenticated;

-- Versions are appended by the person's own session and never edited
create policy own_versions on kriya.flow_versions for select to authenticated
  using (user_id = (select auth.uid()));
create policy add_versions on kriya.flow_versions for insert to authenticated
  with check (user_id = (select auth.uid()));
grant select, insert on kriya.flow_versions to authenticated;

-- Runs: the person reads; only the server writes
create policy read_own on kriya.flow_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.flow_runs for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.flow_runs for update to anon, authenticated
  using (false) with check (false);
grant select on kriya.flow_runs to authenticated;

create policy read_own on kriya.flow_node_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.flow_node_runs for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.flow_node_runs for update to anon, authenticated
  using (false) with check (false);
grant select on kriya.flow_node_runs to authenticated;

-- flow_design: the copilot's model calls, as Skill Studio's
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes', 'flow_design'
));
