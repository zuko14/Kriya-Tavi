-- Connected accounts (Google, Notion) that agents can read from and, with
-- the person's approval, write to.
--
-- Tokens are stored only as AES-256-GCM ciphertext made by lib/secrets.ts
-- with a key that lives in the environment (KRIYA_TOKEN_KEY), so a copy of
-- the database alone exposes nothing. The person's own session can see that
-- a connection exists and remove it, but can't read even the ciphertext:
-- only the server writes these rows and only the worker reads the tokens.

create table kriya.connections (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'notion')),
  -- Shown to the person: the Google email or the Notion workspace name
  account text check (char_length(account) <= 200),
  -- What the person granted, e.g. Google's calendar, gmail, drive scopes
  scopes text[] not null default '{}',
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
create trigger connections_touch before update on kriya.connections
  for each row execute function kriya.touch_updated_at();

alter table kriya.connections enable row level security;

grant select (id, user_id, provider, account, scopes, expires_at, created_at, updated_at)
  on kriya.connections to authenticated;
grant delete on kriya.connections to authenticated;

create policy read_own on kriya.connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy delete_own on kriya.connections for delete to authenticated
  using (user_id = (select auth.uid()));
