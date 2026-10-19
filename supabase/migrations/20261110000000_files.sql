-- Files and documents (A5, AD-18, AD-19) and Kriya Share (K8, AD-34).
-- File bytes live in the private Storage bucket `kriya-files` at
-- <user id>/<file id>; this table holds their metadata and extracted text.
-- Uploads are untrusted content. A share is a person-made, expiring,
-- revocable snapshot; only the sha256 of its token is stored, and the
-- person's session can't read even that.

create table kriya.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 255),
  mime text not null check (mime in (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  size_bytes bigint not null check (size_bytes >= 0),
  -- Content-hash cache for extraction (T8); set once the bytes are checked
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin in ('upload', 'generated', 'screenshot', 'email_attachment')),
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'extracted', 'rejected', 'failed')),
  text text check (char_length(text) <= 200000),
  -- { model?, pages?, warnings?, reason?, lease?, leaseUntil? }
  extraction jsonb,
  task_id uuid references kriya.tasks (id) on delete set null,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  check (status in ('pending', 'rejected') or sha256 is not null)
);
create index files_user_idx on kriya.files (user_id, created_at desc);
create index files_hash_idx on kriya.files (user_id, sha256) where status = 'extracted';
create index files_ready_idx on kriya.files (created_at) where status = 'ready';

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('file', 'pending', 'ready'),
  ('file', 'pending', 'rejected'),
  ('file', 'ready', 'extracted'),
  ('file', 'ready', 'failed');
create trigger files_transition before update of status on kriya.files
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('file');

-- Plan limits (invariant 7): one file's size, and everything kept. The
-- advisory lock stops two uploads at once from both fitting.
create function kriya.files_within_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max_mb integer;
  v_storage_mb integer;
  v_used bigint;
begin
  perform pg_advisory_xact_lock(hashtext('files:' || new.user_id::text));
  select p.max_file_mb, p.storage_mb into v_max_mb, v_storage_mb
    from kriya.plans p where p.id = kriya.effective_plan_id(new.user_id);
  if new.size_bytes > coalesce(v_max_mb, 0)::bigint * 1048576 then
    raise exception 'file larger than the plan allows';
  end if;
  select coalesce(sum(size_bytes), 0) into v_used from kriya.files
    where user_id = new.user_id and status <> 'rejected';
  if v_used + new.size_bytes > coalesce(v_storage_mb, 0)::bigint * 1048576 then
    raise exception 'file storage used up';
  end if;
  return new;
end $$;
create trigger files_limit before insert on kriya.files
  for each row execute function kriya.files_within_plan();

alter table kriya.files enable row level security;
create policy read_own on kriya.files for select to authenticated
  using (user_id = (select auth.uid()));
-- The person's upload starts pending; checking it and extraction are the
-- server's (privileged, scoped by user id)
create policy insert_upload on kriya.files for insert to authenticated
  with check (
    user_id = (select auth.uid()) and origin = 'upload' and status = 'pending'
    and sha256 is null and text is null and extraction is null and task_id is null
  );
create policy update_own on kriya.files for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy delete_own on kriya.files for delete to authenticated
  using (user_id = (select auth.uid()));
grant select, insert, delete on kriya.files to authenticated;
grant update (name) on kriya.files to authenticated;

/* ───────────────────────────── shares ───────────────────────────── */

create table kriya.share_links (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- sha256 of 32 random bytes; the token itself is shown once and never kept
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('receipt', 'report', 'goal', 'ledger_export')),
  ref text not null check (char_length(ref) between 1 and 64),
  title text not null check (char_length(title) between 1 and 200),
  snapshot_file_id uuid not null references kriya.files (id) on delete cascade,
  file_ids uuid[] not null default '{}' check (cardinality(file_ids) <= 20),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  views integer not null default 0 check (views >= 0),
  created_at timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days')
);
create index share_links_user_idx on kriya.share_links (user_id, created_at desc);

-- Revoking is final
create function kriya.share_links_guard() returns trigger language plpgsql as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked share stays revoked';
  end if;
  return new;
end $$;
create trigger share_links_guard before update on kriya.share_links
  for each row execute function kriya.share_links_guard();

-- At most plans.max_shares live links per person
create function kriya.shares_within_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max integer;
  v_live integer;
begin
  perform pg_advisory_xact_lock(hashtext('shares:' || new.user_id::text));
  select p.max_shares into v_max
    from kriya.plans p where p.id = kriya.effective_plan_id(new.user_id);
  select count(*) into v_live from kriya.share_links
    where user_id = new.user_id and revoked_at is null and expires_at > now();
  if v_live >= coalesce(v_max, 0) then
    raise exception 'share limit reached';
  end if;
  return new;
end $$;
create trigger share_links_limit before insert on kriya.share_links
  for each row execute function kriya.shares_within_plan();

alter table kriya.share_links enable row level security;
create policy read_own on kriya.share_links for select to authenticated
  using (user_id = (select auth.uid()));
create policy insert_own on kriya.share_links for insert to authenticated
  with check (user_id = (select auth.uid()) and revoked_at is null and views = 0);
create policy update_own on kriya.share_links for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy delete_own on kriya.share_links for delete to authenticated
  using (user_id = (select auth.uid()));
-- Everything but the token hash
grant select (id, user_id, kind, ref, title, snapshot_file_id, file_ids, expires_at,
  revoked_at, views, created_at) on kriya.share_links to authenticated;
grant insert, delete on kriya.share_links to authenticated;
grant update (revoked_at) on kriya.share_links to authenticated;

-- Who opened a share: when, and an HMAC of the address (never the address)
create table kriya.share_views (
  id uuid primary key default gen_random_uuid(),
  share_id text not null references kriya.share_links (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  ip_hash text check (char_length(ip_hash) <= 64)
);
create index share_views_share_idx on kriya.share_views (share_id, at desc);

alter table kriya.share_views enable row level security;
create policy read_own on kriya.share_views for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.share_views to authenticated;

-- Conservative placeholders; the owner sets real values in /owner
alter table kriya.plans
  add column max_file_mb integer not null default 10 check (max_file_mb >= 0),
  add column storage_mb integer not null default 100 check (storage_mb >= 0),
  add column max_shares integer not null default 5 check (max_shares >= 0);
