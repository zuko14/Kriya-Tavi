-- Harness 2.0, W11: cartridge versions and outcome counts (docs/kriya-harness/
-- upgrade_2.0/SELF_EVOLUTION.md §6, DATA_MODEL_AND_CONTRACTS.md §1; WD-09,
-- WD-15). An approved candidate becomes an immutable version. With
-- harness.cartridgeOverlay off (the default) versions are stored, never
-- served. With it on, the active version is served, or a canary to a stable
-- share of devices; rollback is one status change. Outcome counts come only
-- from devices whose person turned sharing on (HD-24), counts only.

create table kriya.harness_cartridge_versions (
  id uuid primary key default gen_random_uuid(),
  cartridge_id text not null check (cartridge_id ~ '^kriya-role-[a-z]{2,20}$'),
  version text not null check (version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
  candidate_id uuid not null unique references kriya.harness_cartridge_candidates (id),
  body text not null check (char_length(body) between 1 and 6000),
  -- The full kriya.json, with the cartridge block, as served
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  status text not null default 'approved' check (status in ('approved', 'canary', 'active', 'rolled_back', 'superseded')),
  canary_pct int not null default 0 check (canary_pct between 0 and 100),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (cartridge_id, version)
);
create unique index harness_cartridge_one_active on kriya.harness_cartridge_versions (cartridge_id) where status = 'active';
create unique index harness_cartridge_one_canary on kriya.harness_cartridge_versions (cartridge_id) where status = 'canary';

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('harness_version', 'approved', 'canary'),
  ('harness_version', 'approved', 'active'),
  ('harness_version', 'approved', 'rolled_back'),
  ('harness_version', 'canary', 'active'),
  ('harness_version', 'canary', 'rolled_back'),
  ('harness_version', 'active', 'superseded'),
  ('harness_version', 'active', 'rolled_back'),
  -- A rollback of the active version brings back the one it replaced
  ('harness_version', 'superseded', 'active');

create trigger harness_versions_transition
  before update of status on kriya.harness_cartridge_versions
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('harness_version');

-- What was approved is never edited; a canary's share only grows; a share
-- exists only on a canary; a rolled-back version stays rolled back
create function kriya.harness_versions_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.cartridge_id is distinct from old.cartridge_id or new.version is distinct from old.version
    or new.candidate_id is distinct from old.candidate_id or new.body is distinct from old.body
    or new.manifest is distinct from old.manifest or new.created_at is distinct from old.created_at then
    raise exception 'an approved version never changes';
  end if;
  if old.status = 'canary' and new.status = 'canary' and new.canary_pct < old.canary_pct then
    raise exception 'a canary''s share only grows; roll it back instead';
  end if;
  if new.status = 'canary' and new.canary_pct not between 1 and 100 then
    raise exception 'a canary serves 1 to 100 percent';
  end if;
  if new.status <> 'canary' then
    new.canary_pct := 0;
  end if;
  return new;
end $$;

create trigger harness_versions_guard
  before update on kriya.harness_cartridge_versions
  for each row execute function kriya.harness_versions_guard();

alter table kriya.harness_cartridge_versions enable row level security;
create policy server_only on kriya.harness_cartridge_versions for all to anon, authenticated
  using (false) with check (false);

-- Counts only, from opted-in devices (HD-24); never content. Written by the
-- mirror as the person (withUser), so only their own rows
create table kriya.harness_cartridge_outcomes (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  version_id uuid not null references kriya.harness_cartridge_versions (id) on delete cascade,
  day date not null,
  verified int not null default 0 check (verified >= 0),
  blocked int not null default 0 check (blocked >= 0),
  not_checked int not null default 0 check (not_checked >= 0),
  undone int not null default 0 check (undone >= 0),
  primary key (user_id, device_id, version_id, day)
);
create index harness_outcomes_version on kriya.harness_cartridge_outcomes (version_id);
alter table kriya.harness_cartridge_outcomes enable row level security;
create policy outcomes_own_select on kriya.harness_cartridge_outcomes
  for select to authenticated using (user_id = (select auth.uid()));
create policy outcomes_own_insert on kriya.harness_cartridge_outcomes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy outcomes_own_update on kriya.harness_cartridge_outcomes
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on kriya.harness_cartridge_outcomes to authenticated;
