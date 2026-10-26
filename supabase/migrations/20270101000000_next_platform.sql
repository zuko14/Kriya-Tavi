-- Next platform data model (track N, N1; docs/next-platform/
-- DATA_MODEL_AND_STATE_MACHINES.md): the owner's registry of remote MCP
-- servers and their pinned tools, which servers a person turned on for
-- their agents, append-only delivery re-checks, and each MCP run's risk
-- class. Nothing reads or writes these yet: N2/N3 add re-checks, N5 the
-- MCP runtime, N6/N7 the person's and the owner's screens.
--
-- No secret lives here: secret_env is the NAME of an environment variable.

/* ───────────────────────────── servers ──────────────────────────── */

-- Platform rows; only the owner writes (requireOwner, privileged)
create table kriya.mcp_servers (
  -- Used in tool names and seal contexts
  id text primary key check (id ~ '^[a-z]{2,12}$'),
  name text not null check (char_length(name) between 1 and 60),
  url text not null check (url ~ '^https://[^\s/]+(/[^\s]*)?$' and char_length(url) <= 300),
  -- OAuth authorization-server origins the client may contact (ND-10)
  allowed_auth_origins text[] not null default '{}'
    check (array_length(allowed_auth_origins, 1) is null or array_length(allowed_auth_origins, 1) <= 4),
  auth text not null check (auth in ('oauth_public', 'oauth_cimd', 'oauth_confidential', 'none')),
  -- Public; never a secret
  client_id text check (char_length(client_id) <= 300),
  secret_env text check (secret_env ~ '^KRIYA_MCP_[A-Z0-9_]{2,40}$'),
  scopes text[] not null default '{}',
  transport text not null default 'http' check (transport in ('http', 'sse')),
  status text not null default 'draft' check (status in ('draft', 'active', 'suspended', 'retired')),
  -- The owner's review notes (MCP_CONNECTIVITY §9)
  review text check (char_length(review) <= 4000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((auth = 'oauth_confidential') = (secret_env is not null)),
  check (auth = 'none' or client_id is not null or auth = 'oauth_cimd')
);
create index mcp_servers_created_by_idx on kriya.mcp_servers (created_by);
create trigger mcp_servers_touch before update on kriya.mcp_servers
  for each row execute function kriya.touch_updated_at();
create trigger mcp_servers_transition before update of status on kriya.mcp_servers
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('mcp_server');

/* ───────────────────────────── tools ────────────────────────────── */

-- Pinned by a hash of the full definition; the worker may only mark drift
create table kriya.mcp_tools (
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  -- The server's own name
  name text not null check (char_length(name) between 1 and 128),
  kriya_name text not null unique check (kriya_name ~ '^mcp_[a-z]{2,12}_[a-z_]{2,22}$'),
  -- name, title, description, inputSchema, outputSchema, annotations
  definition jsonb not null check (pg_column_size(definition) <= 65536),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  -- Kriya's own words, shown to the model and the person
  description text not null check (char_length(description) between 1 and 400),
  owner_risk text not null default 'R4' check (owner_risk in ('R0', 'R1', 'R2', 'R3', 'R4', 'R5')),
  category text check (category in ('payments', 'identity', 'credentials', 'filing')),
  -- Retries only for idempotent reads (ND-05)
  idempotent boolean not null default false,
  -- Read-back spec (ND-12) or null
  verify jsonb,
  status text not null default 'pinned' check (status in ('pinned', 'drifted', 'disabled')),
  -- The new definition's hash the worker saw
  drifted_hash text check (drifted_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (server_id, name),
  check (kriya_name like 'mcp_' || server_id || '\_%'),
  check (idempotent = false or owner_risk = 'R0'),
  check (status <> 'drifted' or drifted_hash is not null)
);
create index mcp_tools_server_idx on kriya.mcp_tools (server_id) where status = 'pinned';
create index mcp_tools_approved_by_idx on kriya.mcp_tools (approved_by);
create trigger mcp_tools_touch before update on kriya.mcp_tools
  for each row execute function kriya.touch_updated_at();
create trigger mcp_tools_transition before update of status on kriya.mcp_tools
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('mcp_tool');

-- An unauthenticated server never acts as the person: nothing above R1
-- pinned on it (NT-DB-04), whichever side changes
create function kriya.mcp_tools_unauthenticated() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'pinned' and new.owner_risk not in ('R0', 'R1') and exists (
    select 1 from kriya.mcp_servers where id = new.server_id and auth = 'none'
  ) then
    raise exception 'a server without sign-in can''t hold % tools', new.owner_risk;
  end if;
  return new;
end $$;
create trigger mcp_tools_unauthenticated before insert or update on kriya.mcp_tools
  for each row execute function kriya.mcp_tools_unauthenticated();

create function kriya.mcp_servers_unauthenticated() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.auth = 'none' and exists (
    select 1 from kriya.mcp_tools
    where server_id = new.id and status = 'pinned' and owner_risk not in ('R0', 'R1')
  ) then
    raise exception 'a server without sign-in can''t hold tools above R1';
  end if;
  return new;
end $$;
create trigger mcp_servers_unauthenticated before update of auth on kriya.mcp_servers
  for each row execute function kriya.mcp_servers_unauthenticated();

-- Pinning again after drift must pin the hash the worker saw, so a
-- re-approval without looking can't keep the old definition (NT-DB-05)
create function kriya.mcp_tools_repin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'pinned' and old.status <> 'pinned' then
    if old.drifted_hash is not null and new.definition_hash is distinct from old.drifted_hash then
      raise exception 'pin the new definition (%) to pin this tool again', old.drifted_hash;
    end if;
    new.drifted_hash := null;
  end if;
  return new;
end $$;
create trigger mcp_tools_repin before update of status on kriya.mcp_tools
  for each row when (old.status is distinct from new.status)
  execute function kriya.mcp_tools_repin();

/* ───────────────────────────── enablements ──────────────────────── */

-- The person's own choice; agent tools never write it (PERSON_ONLY_WRITES)
create table kriya.mcp_enablements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  -- null = all of the person's agents
  agent_id text,
  created_at timestamptz not null default now(),
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade
);
create unique index mcp_enablements_all_key on kriya.mcp_enablements (user_id, server_id)
  where agent_id is null;
create unique index mcp_enablements_agent_key on kriya.mcp_enablements (user_id, server_id, agent_id)
  where agent_id is not null;
create index mcp_enablements_user_idx on kriya.mcp_enablements (user_id);
create index mcp_enablements_server_idx on kriya.mcp_enablements (server_id);
create index mcp_enablements_agent_idx on kriya.mcp_enablements (agent_id, user_id);

/* ───────────────────────────── delivery checks ──────────────────── */

-- Written only by the worker (privileged), never changed (ND-04)
create table kriya.delivery_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  execution_id uuid not null references kriya.tool_executions (id) on delete cascade,
  kind text not null check (kind in ('recheck', 'mcp_readback')),
  -- gone = it was made and is no longer there; never counts as verified
  status text not null check (status in ('verified', 'unverified', 'failed', 'gone')),
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array'),
  note text check (char_length(note) <= 200),
  checked_at timestamptz not null default now(),
  -- One re-check per run
  unique (execution_id, kind)
);
create index delivery_checks_user_idx on kriya.delivery_checks (user_id, checked_at desc);
create index delivery_checks_task_idx on kriya.delivery_checks (task_id);

-- tasks and tool_executions have no unique (id, user_id) for a composite
-- key, so the run's own row decides whose check it is (NT-DB-03)
create function kriya.delivery_checks_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from kriya.tool_executions
    where id = new.execution_id and user_id = new.user_id and task_id = new.task_id
  ) then
    raise exception 'a delivery check belongs to its run''s person and task';
  end if;
  return new;
end $$;
create trigger delivery_checks_owner before insert on kriya.delivery_checks
  for each row execute function kriya.delivery_checks_owner();

-- Append-only for every role, the worker included (it bypasses RLS)
create function kriya.delivery_checks_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'delivery checks are never changed; add a new one';
end $$;
create trigger delivery_checks_frozen before update on kriya.delivery_checks
  for each row execute function kriya.delivery_checks_frozen();

/* ───────────────────────────── tool runs ────────────────────────── */

-- The MCP run's class from classifyMcpTool (ND-22); null for built-in
-- tools; not part of receipts
alter table kriya.tool_executions add column risk text
  check (risk in ('R0', 'R1', 'R2', 'R3', 'R4', 'R5'));

/* ───────────────────────────── transitions ──────────────────────── */

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('mcp_server', 'draft', 'active'),
  ('mcp_server', 'active', 'suspended'),
  ('mcp_server', 'suspended', 'active'),
  ('mcp_server', 'active', 'retired'),
  ('mcp_server', 'suspended', 'retired'),
  ('mcp_server', 'draft', 'retired'),
  ('mcp_tool', 'pinned', 'drifted'),
  ('mcp_tool', 'drifted', 'pinned'),
  ('mcp_tool', 'pinned', 'disabled'),
  ('mcp_tool', 'drifted', 'disabled'),
  ('mcp_tool', 'disabled', 'pinned');

/* ───────────────────────────── access ───────────────────────────── */

-- The Account catalogue: active servers' public columns only; the review,
-- auth origins, client id and secret name stay server-side
alter table kriya.mcp_servers enable row level security;
grant select (id, name, url, scopes, status) on kriya.mcp_servers to authenticated;
create policy read_active on kriya.mcp_servers for select to authenticated
  using (status = 'active');
create policy server_only_writes on kriya.mcp_servers for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.mcp_servers for update to anon, authenticated
  using (false) with check (false);

-- The full definition is read by the worker only
alter table kriya.mcp_tools enable row level security;
grant select (server_id, kriya_name, description, owner_risk, status)
  on kriya.mcp_tools to authenticated;
create policy read_active on kriya.mcp_tools for select to authenticated
  using (exists (select 1 from kriya.mcp_servers s where s.id = server_id and s.status = 'active'));
create policy server_only_writes on kriya.mcp_tools for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.mcp_tools for update to anon, authenticated
  using (false) with check (false);

-- Own rows; only for a server that is active now; never updated
alter table kriya.mcp_enablements enable row level security;
grant select, insert, delete on kriya.mcp_enablements to authenticated;
create policy read_own on kriya.mcp_enablements for select to authenticated
  using (user_id = (select auth.uid()));
create policy insert_own on kriya.mcp_enablements for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from kriya.mcp_servers s where s.id = server_id and s.status = 'active')
  );
create policy delete_own on kriya.mcp_enablements for delete to authenticated
  using (user_id = (select auth.uid()));

alter table kriya.delivery_checks enable row level security;
grant select on kriya.delivery_checks to authenticated;
create policy read_own on kriya.delivery_checks for select to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.delivery_checks for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.delivery_checks for update to anon, authenticated
  using (false) with check (false);
