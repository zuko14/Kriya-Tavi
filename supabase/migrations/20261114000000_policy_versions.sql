-- Governed improvement (A12, AD-25): versioned bundles of the tunable
-- behaviour (prompt wording, retrieval weights, token budgets). A candidate
-- is a complete bundle, never a diff; it moves draft → shadow → canary →
-- active only through kriya.allowed_transitions, and a rollback leaves the
-- previous active version in charge. Safety rules, risk classes, site modes
-- and limits are code and SQL, not part of any bundle. No user grants: only
-- the worker and the owner console (privileged) read or write this table.

create table kriya.policy_versions (
  id text primary key,
  parent_id text references kriya.policy_versions (id),
  bundle jsonb not null check (jsonb_typeof(bundle) = 'object'),
  bundle_hash text not null unique check (bundle_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'draft'
    check (status in ('draft', 'rejected', 'shadow', 'canary', 'active', 'retired', 'rolled_back')),
  -- Hashed share of people on this version while it's the canary
  canary_percent integer not null default 0 check (canary_percent between 0 and 100),
  -- What it should improve (metric names or case ids)
  targets text[] not null default '{}',
  eval_report jsonb,
  proposed_by text not null check (char_length(proposed_by) between 1 and 100),
  approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'canary') = (canary_percent > 0))
);
-- At most one active and one canary at a time
create unique index policy_versions_one_active on kriya.policy_versions ((true)) where status = 'active';
create unique index policy_versions_one_canary on kriya.policy_versions ((true)) where status = 'canary';
create trigger policy_versions_touch before update on kriya.policy_versions
  for each row execute function kriya.touch_updated_at();

-- A bundle never changes once proposed
create function kriya.policy_versions_frozen() returns trigger language plpgsql as $$
begin
  if new.bundle is distinct from old.bundle or new.bundle_hash is distinct from old.bundle_hash then
    raise exception 'a policy version''s bundle can''t change; propose a new version';
  end if;
  return new;
end $$;
create trigger policy_versions_frozen before update on kriya.policy_versions
  for each row execute function kriya.policy_versions_frozen();

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('policy_version', 'draft', 'shadow'),
  ('policy_version', 'draft', 'rejected'),
  ('policy_version', 'shadow', 'canary'),
  ('policy_version', 'shadow', 'rejected'),
  ('policy_version', 'canary', 'active'),
  ('policy_version', 'canary', 'rolled_back'),
  ('policy_version', 'active', 'retired'),
  ('policy_version', 'active', 'rolled_back'),
  -- Rollback of a promoted version puts its parent back in charge
  ('policy_version', 'retired', 'active');
create trigger policy_versions_transition before update of status on kriya.policy_versions
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('policy_version');

alter table kriya.policy_versions enable row level security;

-- Which version each task ran on ('baseline' when none), so canary guard
-- metrics compare like with like, failed tasks included
create table kriya.policy_task_versions (
  task_id uuid primary key references kriya.tasks (id) on delete cascade,
  version text not null check (char_length(version) between 1 and 40),
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index policy_task_versions_version_idx on kriya.policy_task_versions (version, created_at);
alter table kriya.policy_task_versions enable row level security;
