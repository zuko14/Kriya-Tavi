-- Editing Studio (track E, ED14; docs/kriya-harness/kriya_video_editing): what
-- Kriya holds about an edit made on the person's computer. Footage never comes
-- here. A job's status is set only by the worker, from the dispatch the device
-- reported on: no session and no model can set it. Owner-only tables.

/* ───────────────────────────── plan cap ─────────────────────────── */

-- Bytes of previews a person may keep in Kriya; 0 = none (EDD-26)
alter table kriya.plans add column editing_preview_bytes bigint not null default 0
  check (editing_preview_bytes >= 0);

alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes', 'flow_design', 'edit_preview_bytes'
));

/* ────────────────────────────── jobs ────────────────────────────── */

create table kriya.edit_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  dispatch_id uuid references kriya.harness_dispatches (id) on delete set null,
  thread_id text check (char_length(thread_id) <= 200),
  project text not null check (project ~ '^[a-f0-9]{16}$'),
  revision_of uuid,
  recipe text check (recipe ~ '^[a-z0-9-]{1,48}$'),
  brief text not null check (char_length(brief) between 1 and 4000),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'delivered', 'delivered_with_notes', 'blocked',
    'failed', 'canceled', 'expired', 'lost'
  )),
  stage text check (stage ~ '^[a-z_]{1,32}$'),
  percent smallint check (percent between 0 and 100),
  -- The computer's last progress counter: a new one is how the worker hears it's alive
  beat integer not null default 0,
  verdict jsonb check (verdict is null or pg_column_size(verdict) <= 16384),
  notified_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, user_id),
  -- A revision is of the person's own job (a policy can't read its own table)
  foreign key (revision_of, user_id) references kriya.edit_jobs (id, user_id)
    on delete set null (revision_of)
);
create index edit_jobs_user_idx on kriya.edit_jobs (user_id, created_at desc);
create index edit_jobs_dispatch_idx on kriya.edit_jobs (dispatch_id);
create index edit_jobs_open_idx on kriya.edit_jobs (updated_at)
  where notified_at is null;
create trigger edit_jobs_transition before update of status on kriya.edit_jobs
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('edit_job');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('edit_job', 'queued', 'running'),
  ('edit_job', 'queued', 'expired'),
  ('edit_job', 'queued', 'canceled'),
  ('edit_job', 'running', 'canceled'),
  ('edit_job', 'lost', 'canceled'),
  ('edit_job', 'running', 'delivered'),
  ('edit_job', 'running', 'delivered_with_notes'),
  ('edit_job', 'running', 'blocked'),
  ('edit_job', 'running', 'failed'),
  ('edit_job', 'running', 'lost'),
  ('edit_job', 'lost', 'running');

/* ─────────────────────────── deliverables ───────────────────────── */

create table kriya.edit_deliverables (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references kriya.edit_jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preview', 'poster', 'clip', 'report')),
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  storage_path text not null,
  bytes bigint not null check (bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  duration_flicks bigint check (duration_flicks >= 0),
  -- The device said the upload finished: the worker checks the object from here
  uploaded_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz
);
create index edit_deliverables_job_idx on kriya.edit_deliverables (job_id);
create index edit_deliverables_expiry_idx on kriya.edit_deliverables (expires_at)
  where deleted_at is null;
create index edit_deliverables_user_idx on kriya.edit_deliverables (user_id, status)
  where deleted_at is null;

/* ─────────────── decision cards and notes (used from ED15) ───────── */

create table kriya.edit_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  job_id uuid references kriya.edit_jobs (id) on delete cascade,
  kind text not null check (kind in ('take', 'hook', 'file', 'name', 'taste', 'found')),
  prompt text not null check (char_length(prompt) between 1 and 500),
  options jsonb not null check (pg_column_size(options) <= 8192),
  default_option smallint,
  answer jsonb check (answer is null or pg_column_size(answer) <= 2048),
  status text not null default 'open' check (status in ('open', 'answered', 'defaulted', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz
);
create index edit_questions_user_idx on kriya.edit_questions (user_id, status);

create table kriya.edit_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references kriya.edit_jobs (id) on delete cascade,
  at_flicks bigint not null check (at_flicks >= 0),
  body text not null check (char_length(body) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'sent', 'done', 'removed')),
  created_at timestamptz not null default now()
);
create index edit_notes_job_idx on kriya.edit_notes (job_id, created_at);

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.edit_jobs enable row level security;
create policy read_own on kriya.edit_jobs for select to authenticated
  using (user_id = (select auth.uid()));
-- The person's job, on their own signed-in computer, from their own action and
-- thread. Starts queued; only the server moves it on
create policy create_own on kriya.edit_jobs for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'queued'
    and exists (
      select 1 from kriya.harness_devices d
      where d.id = device_id and d.user_id = (select auth.uid()) and d.revoked_at is null
    )
    and exists (
      select 1 from kriya.harness_dispatches x
      where x.id = dispatch_id and x.user_id = (select auth.uid()) and x.device_id = edit_jobs.device_id
    )
    and (thread_id is null or exists (
      select 1 from kriya.threads t
      where t.id = thread_id and t.user_id = (select auth.uid())
    ))
  );
-- "Looks good": the one thing a person changes on a job (the column grant)
create policy accept_own on kriya.edit_jobs for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select on kriya.edit_jobs to authenticated;
grant insert (id, user_id, device_id, dispatch_id, thread_id, project, revision_of, recipe, brief)
  on kriya.edit_jobs to authenticated;
grant update (accepted_at) on kriya.edit_jobs to authenticated;

alter table kriya.edit_deliverables enable row level security;
create policy read_own on kriya.edit_deliverables for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.edit_deliverables to authenticated;

alter table kriya.edit_questions enable row level security;
create policy read_own on kriya.edit_questions for select to authenticated
  using (user_id = (select auth.uid()));
create policy answer_own on kriya.edit_questions for update to authenticated
  using (user_id = (select auth.uid()) and status = 'open')
  with check (user_id = (select auth.uid()) and status = 'answered');
grant select on kriya.edit_questions to authenticated;
grant update (answer, status, answered_at) on kriya.edit_questions to authenticated;

alter table kriya.edit_notes enable row level security;
create policy own_notes on kriya.edit_notes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from kriya.edit_jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
  );
grant select on kriya.edit_notes to authenticated;
grant insert (user_id, job_id, at_flicks, body) on kriya.edit_notes to authenticated;
grant update (status) on kriya.edit_notes to authenticated;

/* ──────────────────────── the preview limit ──────────────────────── */

-- Invariant 7: per file and per plan, under one per-person lock so parallel
-- requests can't pass together. Only the device route calls it, after
-- authenticateDevice. The same file asked for again gets its own row back, so a
-- retry after a failed upload costs nothing. Bytes are the caller's claim; the
-- worker checks the object before anyone can watch it.
create function kriya.reserve_edit_preview(
  p_user uuid, p_device uuid, p_job uuid, p_kind text, p_bytes bigint, p_sha256 text,
  p_duration_flicks bigint, p_max_bytes bigint, p_days integer
) returns table (id uuid, storage_path text) language plpgsql set search_path = '' as $$
declare
  v_cap bigint;
  v_used bigint;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_row kriya.edit_deliverables;
begin
  if not exists (
    select 1 from kriya.edit_jobs j
    where j.id = p_job and j.user_id = p_user and j.device_id = p_device
      and j.status in ('queued', 'running', 'lost')
  ) then
    raise exception 'edit job not open';
  end if;
  if p_bytes > p_max_bytes then
    raise exception 'edit preview too large';
  end if;
  select editing_preview_bytes into v_cap from kriya.plans
    where kriya.plans.id = kriya.effective_plan_id(p_user);
  if coalesce(v_cap, 0) = 0 then
    raise exception 'edit previews not in plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('edit_preview:' || p_user::text));
  select * into v_row from kriya.edit_deliverables d
    where d.job_id = p_job and d.kind = p_kind and d.deleted_at is null
      and d.status in ('pending', 'ready');
  if found then
    if v_row.status = 'pending' and v_row.sha256 = p_sha256 and v_row.bytes = p_bytes then
      return query select v_row.id, v_row.storage_path;
      return;
    end if;
    raise exception 'edit preview exists';
  end if;
  select coalesce(sum(d.bytes), 0) into v_used from kriya.edit_deliverables d
    where d.user_id = p_user and d.deleted_at is null and d.status in ('pending', 'ready');
  if v_used + p_bytes > v_cap then
    raise exception 'edit preview cap reached';
  end if;
  v_path := p_user::text || '/' || p_job::text || '/' || v_id::text;
  insert into kriya.edit_deliverables
    (id, job_id, user_id, kind, storage_path, bytes, sha256, duration_flicks, expires_at)
    values (v_id, p_job, p_user, p_kind, v_path, p_bytes, p_sha256, p_duration_flicks,
            now() + make_interval(days => p_days));
  return query select v_id, v_path;
end $$;
revoke all on function kriya.reserve_edit_preview(uuid, uuid, uuid, text, bigint, text, bigint, bigint, integer)
  from public, anon, authenticated;
