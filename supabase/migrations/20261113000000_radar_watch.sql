-- Watchers, Radar and the public facts commons (A13: K5, K4, K6;
-- AD-31, AD-30, AD-32). A watcher is a schedule of kind 'watch': an
-- unchanged page costs no task and no model call. An obligation is shown
-- only with the exact quote and source its date came from. A public fact
-- has no owner, comes only from allow-listed official domains, and is
-- served only after two agreeing fetches.

/* ───────────────────────────── watchers ─────────────────────────── */

-- { url, condition? } for kind = 'watch', nothing otherwise
alter table kriya.schedules add column watch jsonb;
alter table kriya.schedules add constraint schedules_watch_check
  check ((kind = 'watch') = (watch is not null));

-- A watcher check that found the page unchanged made no task
alter table kriya.schedule_runs drop constraint schedule_runs_outcome_check;
alter table kriya.schedule_runs add constraint schedule_runs_outcome_check check (outcome in
  ('claimed', 'enqueued', 'skipped_active', 'skipped_limit', 'skipped_budget', 'failed', 'unchanged'));

create table kriya.watch_state (
  schedule_id text primary key references kriya.schedules (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_hash text check (last_hash ~ '^[0-9a-f]{64}$'),
  -- The normalised text, to diff the next change against
  last_text text check (char_length(last_text) <= 20000),
  checked_at timestamptz,
  changed_at timestamptz,
  failures integer not null default 0 check (failures >= 0)
);
alter table kriya.watch_state enable row level security;
create policy read_own on kriya.watch_state for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.watch_state to authenticated;

/* ───────────────────────────── radar ────────────────────────────── */

create table kriya.obligations (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id text,
  kind text not null check (kind ~ '^[a-z0-9_]{1,40}$'),
  title text not null check (char_length(title) between 1 and 200),
  due_at timestamptz not null,
  -- The exact text the date came from
  quote text not null check (char_length(quote) between 1 and 500),
  source_kind text not null check (source_kind in ('official_page', 'public_fact', 'gmail', 'person')),
  -- URL, fact key, Gmail message id, or 'person'
  source_ref text not null check (char_length(source_ref) between 1 and 500),
  read_at timestamptz not null,
  -- Set by code: the quote was found word for word and holds the date
  verified boolean not null,
  lead_days integer[] not null default '{7,1}'
    check (cardinality(lead_days) <= 5 and 0 <= all (lead_days) and 60 >= all (lead_days)),
  status text not null default 'upcoming' check (status in ('upcoming', 'done', 'dismissed', 'missed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, due_at, source_ref),
  foreign key (goal_id, user_id) references kriya.goals (id, user_id) on delete set null (goal_id)
);
create index obligations_due_idx on kriya.obligations (user_id, due_at) where status = 'upcoming';
create trigger obligations_touch before update on kriya.obligations
  for each row execute function kriya.touch_updated_at();

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('obligation', 'upcoming', 'done'),
  ('obligation', 'upcoming', 'dismissed'),
  ('obligation', 'upcoming', 'missed'),
  ('obligation', 'missed', 'done');
create trigger obligations_transition before update of status on kriya.obligations
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('obligation');

alter table kriya.obligations enable row level security;
create policy read_own on kriya.obligations for select to authenticated
  using (user_id = (select auth.uid()));
-- Born upcoming
create policy insert_own on kriya.obligations for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'upcoming');
create policy update_own on kriya.obligations for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy delete_own on kriya.obligations for delete to authenticated
  using (user_id = (select auth.uid()));
grant select, insert, delete on kriya.obligations to authenticated;
-- The person marks done or dismissed; 'missed' is the worker's
grant update (status) on kriya.obligations to authenticated;

/* ─────────────────────────── facts commons ──────────────────────── */

-- Official domains facts may come from: the domain itself or any
-- subdomain of it. Changed only by migration or the owner's audited action.
create table kriya.fact_sources (
  domain text primary key check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  note text check (char_length(note) <= 200),
  added_at timestamptz not null default now()
);
insert into kriya.fact_sources (domain, note) values
  ('gov.in', 'Government of India and State government sites'),
  ('nic.in', 'National Informatics Centre hosted government sites');
alter table kriya.fact_sources enable row level security;

-- No user_id by design: nothing personal is ever stored here
create table kriya.public_facts (
  key text primary key check (key ~ '^[a-z0-9_.-]{3,120}$'),
  value text not null check (char_length(value) between 1 and 500),
  quote text not null check (char_length(quote) between 1 and 500),
  source_url text not null check (source_url ~ '^https://'),
  source_domain text not null,
  -- The fetch that last counted as a confirmation (≥ 1 hour after the one before)
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  confirmations integer not null default 1 check (confirmations >= 1),
  retracted_at timestamptz,
  retracted_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  check (position(value in quote) > 0)
);

-- The URL's host must be the stated domain, and that domain must be on
-- the allow-list (itself or a subdomain of an allowed one)
create function kriya.public_facts_guard() returns trigger language plpgsql as $$
declare
  v_host text := lower(substring(new.source_url from '^https://([^/:?#]+)'));
begin
  if v_host is null or v_host <> new.source_domain then
    raise exception 'fact source URL and domain don''t match';
  end if;
  if not exists (
    select 1 from kriya.fact_sources s
    where new.source_domain = s.domain or new.source_domain like '%.' || s.domain
  ) then
    raise exception 'fact source % is not an allowed official domain', new.source_domain;
  end if;
  return new;
end $$;
create trigger public_facts_guard before insert or update on kriya.public_facts
  for each row execute function kriya.public_facts_guard();

alter table kriya.public_facts enable row level security;
-- Anyone signed in reads served facts only: confirmed, current, not retracted
create policy read_served on kriya.public_facts for select to authenticated
  using (confirmations >= 2 and expires_at > now() and retracted_at is null);
grant select on kriya.public_facts to authenticated;
