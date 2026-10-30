-- Skill Studio (docs/next-platform/SKILL_STUDIO.md, next.skillStudio): a
-- person describes a skill in a few words, Kriya designs it with a model,
-- and the person reads, edits and approves it before any agent uses it. A
-- personal skill is text, like a library skill: nothing here grants a tool,
-- an account, a permission or an approval.
--
-- The person's own rows (withUser, RLS). No agent tool writes this table
-- (PERSON_ONLY_WRITES "user_skills", AT-POL-07). Assignments stay on
-- kriya.agents.skills, covered by the agents policies.

create table kriya.user_skills (
  -- my-<10 lowercase letters or digits>: random, never the person's words,
  -- so skill_activations and the owner's views carry no private text
  id text primary key check (id ~ '^my-[a-z0-9]{10}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  version integer not null default 1 check (version between 1 and 999),
  intent text not null check (char_length(intent) between 3 and 500),
  name text not null check (char_length(name) between 1 and 60),
  description text not null check (char_length(description) between 1 and 240),
  body text not null check (char_length(body) between 200 and 6000),
  manifest jsonb not null
    check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 16384),
  design jsonb not null default '{}'
    check (jsonb_typeof(design) = 'object' and pg_column_size(design) <= 32768),
  model text check (char_length(model) <= 120),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Active only once the person approved it
  check (status <> 'active' or approved_at is not null)
);
create index user_skills_user_idx on kriya.user_skills (user_id, created_at);
create trigger user_skills_touch before update on kriya.user_skills
  for each row execute function kriya.touch_updated_at();

alter table kriya.user_skills enable row level security;
grant select, insert, update, delete on kriya.user_skills to authenticated;
create policy own_rows on kriya.user_skills for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The design's model calls: a platform cost, never a customer charge, and
-- kept apart from maintenance_model so it can't use up memory upkeep's cap
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design'
));
