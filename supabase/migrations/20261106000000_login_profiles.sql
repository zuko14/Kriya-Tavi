-- Login profiles and ready-to-apply kits (A6; AD-04, AD-05, AD-35;
-- BROWSER_AND_LOGIN_PROFILES.md §5-6, DATA_MODEL §2.6).
--
-- A login profile is a site session the person signed into themselves, in
-- Kriya's browser, during take-over. Kriya never sees or stores a password:
-- what's kept is the browser's storage state (cookies, localStorage), sealed
-- with lib/secrets.ts (AES-256-GCM, key in KRIYA_TOKEN_KEY) and bound to
-- "<user id>:login:<profile id>". The person's session can see that a
-- profile exists, rename it, allow background use and remove it, but can't
-- select even the ciphertext (invariant 4, as amended for AD-05).
--
-- A kit (K9) is the text an agent prepared for a site where it may not
-- press Save or Submit: copy blocks in field order, within the limits the
-- page itself declares, and a check of the public result afterwards.

create table kriya.login_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Registrable domain, lowercase (linkedin.com)
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  label text not null check (char_length(label) between 1 and 60),
  status text not null default 'pending' check (status in ('pending', 'active', 'expired')),
  -- Only an active profile holds state; expiry deletes it
  state_sealed text check (char_length(state_sealed) <= 1000000),
  background_allowed boolean not null default false,
  confirmed_at timestamptz,
  last_used_at timestamptz,
  -- Re-confirmation is due 90 days after the last sign-in
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, domain, label),
  check ((status = 'active') = (state_sealed is not null))
);
create index login_profiles_active_idx on kriya.login_profiles (user_id, domain)
  where status = 'active';
create trigger login_profiles_touch before update on kriya.login_profiles
  for each row execute function kriya.touch_updated_at();

-- Removal deletes the row (and the state with it); there is no revoked row
insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('login_profile', 'pending', 'active'),
  ('login_profile', 'active', 'expired'),
  ('login_profile', 'expired', 'active');
create trigger login_profiles_transition before update of status on kriya.login_profiles
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('login_profile');

-- Plan limit (invariant 7): every profile counts, pending ones included,
-- so starting sign-ins can't get around it. 0 until the owner sets it.
alter table kriya.plans
  add column max_login_profiles integer not null default 0 check (max_login_profiles >= 0);

create function kriya.login_profiles_within_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max integer;
  v_used integer;
begin
  perform pg_advisory_xact_lock(hashtext('login_profiles:' || new.user_id::text));
  select p.max_login_profiles into v_max
    from kriya.plans p where p.id = kriya.effective_plan_id(new.user_id);
  select count(*) into v_used from kriya.login_profiles where user_id = new.user_id;
  if v_used >= coalesce(v_max, 0) then
    raise exception 'login profiles limit reached for this plan';
  end if;
  return new;
end $$;
create trigger login_profiles_limit before insert on kriya.login_profiles
  for each row execute function kriya.login_profiles_within_plan();

alter table kriya.login_profiles enable row level security;
create policy read_own on kriya.login_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy update_own on kriya.login_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy delete_own on kriya.login_profiles for delete to authenticated
  using (user_id = (select auth.uid()));
-- Never state_sealed. Inserts, status and state are the server's.
grant select (id, user_id, domain, label, status, background_allowed, confirmed_at,
  last_used_at, expires_at, created_at, updated_at) on kriya.login_profiles to authenticated;
grant update (label, background_allowed) on kriya.login_profiles to authenticated;
grant delete on kriya.login_profiles to authenticated;

alter table kriya.browser_sessions
  add constraint browser_sessions_login_profile_fk foreign key (login_profile_id)
  references kriya.login_profiles (id) on delete set null;

-- A take-over session for signing in to a profile's site: no task, the same
-- monthly browser minutes as task sessions (invariant 7). Called by the
-- server only, after requireUser().
create function kriya.open_login_session(p_id uuid, p_user uuid, p_profile uuid, p_provider text)
returns void language plpgsql as $$
declare
  v_minutes integer;
  v_used bigint;
begin
  if not exists (
    select 1 from kriya.login_profiles where id = p_profile and user_id = p_user
  ) then
    raise exception 'login session for an unknown profile';
  end if;
  select p.browser_minutes into v_minutes
    from kriya.plans p where p.id = kriya.effective_plan_id(p_user);
  select coalesce(sum(quantity), 0) into v_used
    from kriya.resource_usage
    where user_id = p_user and kind = 'browser_seconds'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used >= coalesce(v_minutes, 0)::bigint * 60 then
    raise exception 'browser minutes used up for this month';
  end if;
  insert into kriya.browser_sessions (id, user_id, login_profile_id, provider, status)
    values (p_id, p_user, p_profile, p_provider, 'paused');
end
$$;
revoke all on function kriya.open_login_session(uuid, uuid, uuid, text) from public, anon, authenticated;

/* ─────────────────────────── kits (K9) ──────────────────────────── */

create table kriya.kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_id text references kriya.threads (id) on delete set null,
  task_id uuid references kriya.tasks (id) on delete set null,
  domain text not null check (char_length(domain) <= 253),
  title text not null check (char_length(title) between 1 and 120),
  deep_link text not null check (deep_link ~ '^https?://' and char_length(deep_link) <= 2000),
  -- [{ label, text, limit? }] in the site's field order
  fields jsonb not null check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) between 1 and 20),
  checklist jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  -- The public page that shows the result once applied
  verify_url text check (verify_url ~ '^https?://' and char_length(verify_url) <= 2000),
  -- verified/unverified are set by code from the page (lib/browser/kits.ts)
  status text not null default 'ready' check (status in ('ready', 'verified', 'unverified')),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index kits_user_idx on kriya.kits (user_id, created_at desc);

alter table kriya.kits enable row level security;
create policy read_own on kriya.kits for select to authenticated
  using (user_id = (select auth.uid()));
-- Agents prepare kits (withUser); the check result is the server's
create policy insert_ready on kriya.kits for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'ready' and checked_at is null);
create policy delete_own on kriya.kits for delete to authenticated
  using (user_id = (select auth.uid()));
grant select, insert, delete on kriya.kits to authenticated;
