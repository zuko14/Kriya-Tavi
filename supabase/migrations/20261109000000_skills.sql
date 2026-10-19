-- Skills (A9, AD-21): a finished turn saved as a versioned procedure the
-- person approves, then replayed step by step without the model. Agents
-- create drafts and count runs (through withUser); only the person's action
-- approves or retires one (DATA_MODEL §4, AT-POL-07), and the insert policy
-- makes sure nothing is born approved.

create table kriya.skills (
  id text not null,
  version integer not null check (version >= 1),
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id text,
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  site_domain text,
  max_risk text not null check (max_risk in ('R0', 'R1', 'R2', 'R3', 'R4')),
  -- [{ name, description, required }]
  slots jsonb not null default '[]'
    check (case when jsonb_typeof(slots) = 'array' then jsonb_array_length(slots) <= 10 else false end),
  -- [{ tool, input with {{slot}} placeholders, expect?, locator? }]
  steps jsonb not null
    check (case when jsonb_typeof(steps) = 'array' then jsonb_array_length(steps) between 1 and 30 else false end),
  acceptance jsonb,
  source_task_id uuid references kriya.tasks (id) on delete set null,
  approved_at timestamptz,
  runs integer not null default 0 check (runs >= 0),
  successes integer not null default 0 check (successes >= 0 and successes <= runs),
  -- Replays in a row that no longer matched; at 2 it waits for the person
  failures integer not null default 0 check (failures >= 0),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id, version),
  unique (user_id, name, version),
  check ((status = 'draft') or approved_at is not null),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete set null (agent_id)
);
create index skills_user_idx on kriya.skills (user_id, status);

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('skill', 'draft', 'approved'),
  ('skill', 'draft', 'retired'),
  ('skill', 'approved', 'retired');
create trigger skills_transition before update of status on kriya.skills
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('skill');

alter table kriya.skills enable row level security;
create policy read_own on kriya.skills for select to authenticated
  using (user_id = (select auth.uid()));
-- Born a draft, never approved
create policy insert_draft on kriya.skills for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'draft' and approved_at is null);
create policy update_own on kriya.skills for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy delete_own on kriya.skills for delete to authenticated
  using (user_id = (select auth.uid()));
grant select, insert, delete on kriya.skills to authenticated;
grant update (status, approved_at, runs, successes, failures, last_run_at)
  on kriya.skills to authenticated;

-- Conservative placeholder: nobody saves skills until the owner sets a value
alter table kriya.plans
  add column max_skills integer not null default 0 check (max_skills >= 0);
