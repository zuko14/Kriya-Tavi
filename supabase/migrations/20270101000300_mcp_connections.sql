-- A person's sign-in to an app (an MCP server in the owner's registry), track
-- N, N6 (ND-09; docs/next-platform/DATA_MODEL_AND_STATE_MACHINES.md §2).
-- A separate table from kriya.connections, which is untouched: five readers
-- of that table assume its four providers.
--
-- Mirrors 20261017000000_connections.sql: tokens are ciphertext from
-- lib/secrets.ts only (context mcp_connections:<server_id>); the person's
-- own session can see that a connection exists and remove it, but can't read
-- even the ciphertext; only the server writes, and only lib/connectors.ts
-- opens a token.

create table kriya.mcp_connections (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  -- Shown to the person when the server says who they are; usually null
  account text check (char_length(account) <= 200),
  scopes text[] not null default '{}',
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  -- Which authorization server issued the tokens (issuer, authorization_server,
  -- token_endpoint, token_type): URLs, no secret. The SDK needs it to refresh.
  pin jsonb not null default '{}' check (jsonb_typeof(pin) = 'object'),
  -- The refresh failed: the person reconnects (set by the worker, cleared on save)
  needs_reconnect boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, server_id)
);
create index mcp_connections_server_idx on kriya.mcp_connections (server_id);
create trigger mcp_connections_touch before update on kriya.mcp_connections
  for each row execute function kriya.touch_updated_at();

alter table kriya.mcp_connections enable row level security;

grant select (id, user_id, server_id, account, scopes, expires_at, needs_reconnect,
  created_at, updated_at) on kriya.mcp_connections to authenticated;
grant delete on kriya.mcp_connections to authenticated;

create policy read_own on kriya.mcp_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy delete_own on kriya.mcp_connections for delete to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.mcp_connections for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.mcp_connections for update to anon, authenticated
  using (false) with check (false);
