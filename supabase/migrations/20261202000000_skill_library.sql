-- Skill library (docs/agent-platform/SKILLS_ENGINE.md): curated instruction
-- packs live in the repository (skills/); the database keeps only each
-- agent's assignments and an audit trail of what each task loaded. Skills
-- never grant tools or permissions, so nothing here does either.

-- { auto, on: [skill ids] }, checked by lib/skill-library.ts checkSkillPrefs;
-- null = the defaults for the agent's role. Covered by the agents policies
-- and grants (20261016000000_kriya_core.sql).
alter table kriya.agents add column skills jsonb
  check (skills is null or (jsonb_typeof(skills) = 'object' and pg_column_size(skills) <= 4096));

-- Written only by the worker (privileged, scoped by user id); the person
-- reads their own, the owner console reads all
create table kriya.skill_activations (
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  attempt integer not null check (attempt >= 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id text not null check (char_length(agent_id) between 1 and 32),
  skill_id text not null check (skill_id ~ '^[a-z][a-z0-9-]{2,40}$'),
  version text not null check (version ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}$'),
  status text not null check (status in ('active', 'skipped')),
  mode text check (mode in ('required', 'manual', 'auto')),
  reason text not null check (char_length(reason) between 1 and 200),
  chars integer not null default 0 check (chars between 0 and 100000),
  outcome text check (outcome in ('succeeded', 'failed', 'canceled')),
  created_at timestamptz not null default now(),
  primary key (task_id, attempt, agent_id, skill_id),
  check ((status = 'active') = (mode is not null))
);
create index skill_activations_user_idx on kriya.skill_activations (user_id, created_at);
create index skill_activations_skill_idx on kriya.skill_activations (skill_id, created_at);

alter table kriya.skill_activations enable row level security;
create policy read_own on kriya.skill_activations for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.skill_activations to authenticated;
create policy server_only_writes on kriya.skill_activations for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.skill_activations for update to anon, authenticated
  using (false) with check (false);
