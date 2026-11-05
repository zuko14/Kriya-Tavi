-- Remote Control (track H, docs/kriya-harness/REMOTE_CONTROL.md): a session the
-- person switches on in Kriya Harness streams what it is doing to their Kriya
-- account. Read only by the person; only device routes write, after
-- authenticateDevice and scoped by the device's person. Not agent context.

create table kriya.harness_live_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  device_session_id text not null check (char_length(device_session_id) between 1 and 100),
  title text check (char_length(title) <= 120),
  project text check (char_length(project) <= 80),
  remote boolean not null default true,
  state text not null default 'idle' check (state in ('running', 'waiting', 'idle', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, device_session_id)
);
create index harness_live_sessions_user_idx on kriya.harness_live_sessions (user_id, updated_at desc);

create table kriya.harness_live_events (
  session_id uuid not null references kriya.harness_live_sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('user', 'assistant', 'tool_start', 'tool_end')),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 16384),
  at timestamptz not null,
  primary key (session_id, seq)
);

alter table kriya.harness_live_sessions enable row level security;
create policy read_own on kriya.harness_live_sessions for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_live_sessions to authenticated;

alter table kriya.harness_live_events enable row level security;
create policy read_own on kriya.harness_live_events for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_live_events to authenticated;
