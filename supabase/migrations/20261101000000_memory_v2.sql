-- Memory v2 (agent platform, phase A1; docs/agent-platform/DATA_MODEL_AND_STATE_MACHINES.md §2.1).
--
-- Notes become typed, scoped, dated and sourced: a note can be shared by all
-- of the person's agents (agent_id null) or private to one, a changed fact
-- supersedes the old one instead of overwriting it, and notes written after
-- the agent read untrusted content wait for the person's confirmation. Full
-- text search uses the 'simple' configuration, so romanised Hindi and Telugu
-- and native scripts are matched as written, not stemmed as English.
--
-- Nothing here changes behaviour while the agents.memoryV2 setting is off:
-- existing rows get the defaults (kind 'fact', trusted, valid, not archived).

/* ───────────────────────────── memories ─────────────────────────── */

-- A composite reference to memories (superseded_by below) needs this first
alter table kriya.memories add constraint memories_id_user_key unique (id, user_id);

-- Null = shared by every agent of the person. The composite foreign key to
-- agents stays and is skipped for nulls.
alter table kriya.memories alter column agent_id drop not null;

alter table kriya.memories
  add column kind text not null default 'fact'
    check (kind in ('profile', 'preference', 'instruction', 'fact', 'decision', 'relationship')),
  -- profile.course, contact.priya, profile.skills[] (a trailing [] = many values)
  add column slot text check (slot ~ '^[a-z][a-z0-9_.\[\]-]{0,63}$'),
  add column trust text not null default 'trusted' check (trust in ('trusted', 'unconfirmed')),
  add column importance smallint not null default 2 check (importance between 1 and 3),
  add column pinned boolean not null default false,
  add column valid_from timestamptz not null default now(),
  -- Set when superseded, or forgotten by an agent; the row stays as history
  add column invalid_at timestamptz,
  add column superseded_by text,
  -- The task that wrote it (provenance)
  add column task_id uuid references kriya.tasks (id) on delete set null,
  add column archived boolean not null default false,
  add column last_used_at timestamptz,
  add column use_count integer not null default 0 check (use_count >= 0),
  -- sha256 of the normalised content, set by lib/memory/write.ts
  add column content_hash text,
  add column search tsvector
    generated always as (to_tsvector('simple', coalesce(slot, '') || ' ' || content)) stored,
  add constraint memories_superseded_by_fkey foreign key (superseded_by, user_id)
    references kriya.memories (id, user_id) on delete set null (superseded_by);

-- 'derived' = written by consolidation. The check's name is looked up rather
-- than assumed.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'kriya.memories'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%source%'
  loop
    execute format('alter table kriya.memories drop constraint %I', c);
  end loop;
end $$;
alter table kriya.memories add constraint memories_source_check
  check (source in ('agent', 'user', 'derived'));

-- One current value per single-valued slot
create unique index memories_slot_current_idx on kriya.memories (user_id, slot)
  where slot is not null and invalid_at is null and slot !~ '\[\]$';
create index memories_scope_idx on kriya.memories (user_id, agent_id)
  where invalid_at is null and not archived;
create index memories_search_idx on kriya.memories using gin (search);

/* ───────────────────────── thread summaries ─────────────────────── */

-- Checkpoints of older turns, so a long thread doesn't resend everything.
-- Written by the worker; the person can read their own.
create table kriya.thread_summaries (
  id text primary key,
  user_id uuid not null,
  thread_id text not null,
  -- created_at of the last message the summary covers
  covers_through timestamptz not null,
  -- { facts, decisions, open_questions, pending_actions, numbers }
  summary jsonb not null,
  chars integer not null check (chars between 1 and 3200),
  model text,
  created_at timestamptz not null default now(),
  unique (thread_id, covers_through),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id) on delete cascade
);

alter table kriya.thread_summaries enable row level security;
create policy read_own on kriya.thread_summaries for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.thread_summaries to authenticated;

/* ───────────────────────── maintenance jobs ─────────────────────── */

-- Background model work (summaries, consolidation). Never a kriya.tasks row:
-- a task would hold the thread's one active slot and refuse the person's
-- next message. Only the worker reads and writes these, so the person's
-- session has no grant and no policy.
create table kriya.maintenance_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('thread_summary', 'episode_summary', 'consolidate')),
  -- The thread or task it is about
  ref text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create unique index maintenance_jobs_open_idx on kriya.maintenance_jobs (kind, ref)
  where status in ('queued', 'running');
create index maintenance_jobs_due_idx on kriya.maintenance_jobs (available_at)
  where status = 'queued';

alter table kriya.maintenance_jobs enable row level security;

/* ───────────────────────── resource usage ───────────────────────── */

-- Platform costs that are not model calls of a task: maintenance model
-- calls, browser time, PDF renders, storage. Never a customer charge, and
-- kept apart from usage_events and charges. Same idempotency as usage_events.
create table kriya.resource_usage (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  task_id uuid references kriya.tasks (id) on delete set null,
  kind text not null check (kind in (
    'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
    'maintenance_model', 'web_fetch'
  )),
  quantity bigint not null check (quantity >= 0),
  -- Null means unpriced; it never means zero
  cost_micro_usd bigint check (cost_micro_usd >= 0),
  created_at timestamptz not null default now()
);
create index resource_usage_user_idx on kriya.resource_usage (user_id, created_at);

alter table kriya.resource_usage enable row level security;
create policy read_own on kriya.resource_usage for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.resource_usage to authenticated;
