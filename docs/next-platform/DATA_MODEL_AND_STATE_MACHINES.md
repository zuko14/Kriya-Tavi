# Data model and state machines (next platform, track N)

New tables only, all in `kriya`, all with RLS and at least one policy,
each in a **new** migration (invariant 2). The SQL migration is the source
of truth; `db/schema.ts` mirrors it (AGENTS.md).

| Migration (claim on the board)                             | Phase | Contents                                                                                              |
| ---------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20270101000000_next_platform.sql`     | N1    | `mcp_servers`, `mcp_tools`, `mcp_enablements`, `delivery_checks`, `tool_executions.risk`, transitions |
| `supabase/migrations/20270101000100_mcp_connections.sql`   | N6    | `mcp_connections`: sealed MCP tokens, grants mirroring `kriya.connections` (ND-09, owner gate)        |
| `supabase/migrations/20270101000200_memory_embeddings.sql` | N9    | `memories.embedding`, `embedding_model`, `embedded_at` (ND-15, owner gate)                            |

Each has `supabase/rollback/<same name>.down.sql` and a down + up case in
`tests/db/migrations.test.ts` (newest first). The timestamps above are
reservations; the phase agent re-checks that its file sorts last when it
claims the board.

## 0. Migration rules (same as track A §0 and track O §0)

1. New files only; one migration writer at a time across all tracks.
2. One transaction; **no extensions**; PGlite-compatible
   (`tests/db/harness.ts`).
3. `enable row level security` and at least one policy per table; server-only
   writes get explicit deny policies for `anon` and `authenticated`
   (`server_only_writes`, `server_only_changes`, as
   `20261202000000_skill_library.sql`), so `tests/db/lint.test.ts` stays
   at zero.
4. Every new function: `set search_path = ''`, fully qualified names.
5. Composite foreign keys `(x_id, user_id)` → parent `(id, user_id)` for
   per-person rows; an index on every new foreign key (P-2's finding).
6. The down file drops what the up file created, in reverse, and deletes
   its row from `supabase_migrations.schema_migrations`.
7. Money, if any, in integer `bigint` (none of these tables holds money).
8. No secret value in any column. `mcp_servers.secret_env` holds an
   environment variable **name** matching `^KRIYA_MCP_[A-Z0-9_]{2,40}$`.

## 1. Tables (N1)

### 1.1 `kriya.mcp_servers` (platform; owner writes)

```sql title="20270101000000_next_platform.sql (sketch)"
create table kriya.mcp_servers (
  id text primary key check (id ~ '^[a-z]{2,12}$'),          -- used in tool names and seal contexts
  name text not null check (char_length(name) between 1 and 60),
  url text not null check (url ~ '^https://[^\s/]+(/[^\s]*)?$' and char_length(url) <= 300),
  -- OAuth authorization-server origins the client may contact (ND-10)
  allowed_auth_origins text[] not null default '{}'
    check (array_length(allowed_auth_origins, 1) is null or array_length(allowed_auth_origins, 1) <= 4),
  auth text not null check (auth in ('oauth_public', 'oauth_cimd', 'oauth_confidential', 'none')),
  client_id text check (char_length(client_id) <= 300),       -- public; never a secret
  secret_env text check (secret_env ~ '^KRIYA_MCP_[A-Z0-9_]{2,40}$'),
  scopes text[] not null default '{}',
  transport text not null default 'http' check (transport in ('http', 'sse')),
  status text not null default 'draft' check (status in ('draft', 'active', 'suspended', 'retired')),
  review text check (char_length(review) <= 4000),             -- MCP_CONNECTIVITY §9 notes
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((auth = 'oauth_confidential') = (secret_env is not null)),
  check (auth = 'none' or client_id is not null or auth = 'oauth_cimd')
);
```

RLS: `select` for `authenticated` where `status = 'active'` (the Account
catalogue; columns returned by `queries/apps.ts` are `id, name, url host,
scopes, status`); deny policies for insert/update/delete. Owner writes go
through `actions/owner-apps.ts` with `requireOwner()` and `privileged`,
each audited in `audit_events`.

> [!NOTE]
> `auth = 'none'` exists for the **test fixture** server and public,
> unauthenticated read-only servers. A `none` server whose pinned tools
> include anything above R1 is refused by the owner action (and by a
> trigger, NT-DB-04): no unauthenticated writes as "the person".

### 1.2 `kriya.mcp_tools` (platform; owner writes; worker may mark drift)

```sql
create table kriya.mcp_tools (
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 128),          -- the server's name
  kriya_name text not null unique check (kriya_name ~ '^mcp_[a-z]{2,12}_[a-z_]{2,22}$'),
  definition jsonb not null check (pg_column_size(definition) <= 65536),  -- name, title, description, inputSchema, outputSchema, annotations
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  description text not null check (char_length(description) between 1 and 400), -- Kriya-side, shown to the model and the person
  owner_risk text not null default 'R4' check (owner_risk in ('R0','R1','R2','R3','R4','R5')),
  category text check (category in ('payments', 'identity', 'credentials', 'filing')),
  idempotent boolean not null default false,                               -- ND-05, reads only
  verify jsonb,                                                            -- ND-12 spec or null
  status text not null default 'pinned' check (status in ('pinned', 'drifted', 'disabled')),
  drifted_hash text check (drifted_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (server_id, name),
  check (kriya_name like 'mcp_' || server_id || '\_%'),
  check (idempotent = false or owner_risk in ('R0'))
);
create index mcp_tools_server_idx on kriya.mcp_tools (server_id) where status = 'pinned';
```

RLS: `select` for `authenticated` on `server_id, kriya_name, description,
owner_risk, status` of active servers (for the Account list; the full
`definition` is read by the worker through `privileged`, never sent to the
browser); deny policies for writes.

### 1.3 `kriya.mcp_enablements` (per person; the person writes)

```sql
create table kriya.mcp_enablements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  agent_id text,                                   -- null = all of the person's agents
  created_at timestamptz not null default now(),
  -- agents has unique (id, user_id) (20261016000000_kriya_core.sql:185, checked 2026-10-24)
  foreign key (agent_id, user_id) references kriya.agents (id, user_id) on delete cascade
);
-- Two partial indexes instead of `nulls not distinct` (no migration uses it yet)
create unique index mcp_enablements_all_key on kriya.mcp_enablements (user_id, server_id)
  where agent_id is null;
create unique index mcp_enablements_agent_key on kriya.mcp_enablements (user_id, server_id, agent_id)
  where agent_id is not null;
create index mcp_enablements_agent_idx on kriya.mcp_enablements (agent_id, user_id);
```

RLS: select, insert, delete own (`user_id = auth.uid()`); no update. Agent
tools never write it (PERSON_ONLY_WRITES `mcp_enablements`, AT-POL-07).

### 1.4 `kriya.delivery_checks` (per person; worker writes)

```sql
create table kriya.delivery_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references kriya.tasks (id) on delete cascade,
  execution_id uuid not null references kriya.tool_executions (id) on delete cascade,
  kind text not null check (kind in ('recheck', 'mcp_readback')),
  status text not null check (status in ('verified', 'unverified', 'failed', 'gone')),
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array'),
  note text check (char_length(note) <= 200),
  checked_at timestamptz not null default now(),
  unique (execution_id, kind)                      -- one re-check per run (ND-04)
);
create index delivery_checks_user_idx on kriya.delivery_checks (user_id, checked_at desc);
create index delivery_checks_task_idx on kriya.delivery_checks (task_id);
```

`kriya.tasks` and `kriya.tool_executions` have no `unique (id, user_id)`
(checked 2026-10-24 in `20261016000000_kriya_core.sql`), so rule 5's
composite key isn't possible here; plain foreign keys, as
`kriya.skill_activations` does. The worker copies `user_id` from the run's
own row, and a trigger `delivery_checks_owner` refuses a row whose
`user_id` differs from its execution's (NT-DB-03).

RLS: select own; deny writes for `anon`/`authenticated`. Append-only: no
update policy, and the worker never updates (NT-DB-06). `gone` = the
object no longer exists (e.g. the person deleted the event) — shown as
"Was created; no longer there", never as "verified".

### 1.5 `kriya.tool_executions.risk` (ND-22)

```sql
alter table kriya.tool_executions add column risk text
  check (risk in ('R0', 'R1', 'R2', 'R3', 'R4', 'R5'));
```

Nullable; written only for MCP runs. Not in the receipt hash body.

### 1.6 Transitions

```sql
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
create trigger mcp_servers_transition before update of status on kriya.mcp_servers
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('mcp_server');
create trigger mcp_tools_transition before update of status on kriya.mcp_tools
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('mcp_tool');
```

`drifted → pinned` also requires `definition_hash` to change to the
approved new hash in the same statement (trigger `mcp_tools_repin`,
NT-DB-05): re-approving without looking can't silently keep the old hash.

## 2. N6: `kriya.mcp_connections` (`20270101000100_mcp_connections.sql`)

`kriya.connections` is **not** touched: five readers assume its four
providers (NF-08, ND-09).

```sql
-- Mirrors 20261017000000_connections.sql: ciphertext from lib/secrets.ts
-- only; the person's session sees that a connection exists and can remove
-- it, never the tokens; only the server writes.
create table kriya.mcp_connections (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  server_id text not null references kriya.mcp_servers (id) on delete cascade,
  account text check (char_length(account) <= 200),
  scopes text[] not null default '{}',
  access_token text not null,                 -- sealed, context mcp_connections:<server_id>
  refresh_token text,                         -- sealed
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, server_id)
);
create index mcp_connections_server_idx on kriya.mcp_connections (server_id);
create trigger mcp_connections_touch before update on kriya.mcp_connections
  for each row execute function kriya.touch_updated_at();
alter table kriya.mcp_connections enable row level security;
grant select (id, user_id, server_id, account, scopes, expires_at, created_at, updated_at)
  on kriya.mcp_connections to authenticated;
grant delete on kriya.mcp_connections to authenticated;
create policy read_own on kriya.mcp_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy delete_own on kriya.mcp_connections for delete to authenticated
  using (user_id = (select auth.uid()));
create policy server_only_writes on kriya.mcp_connections for insert to anon, authenticated
  with check (false);
create policy server_only_changes on kriya.mcp_connections for update to anon, authenticated
  using (false) with check (false);
```

Down: drop the table (connections to apps are lost; switch `next.mcp` and
`next.mcpConnect` off first). `kriya.touch_updated_at()` exists
(`20261016000000_kriya_core.sql`, used by `connections_touch`).

## 3. N9: embeddings (`20270101000200_memory_embeddings.sql`)

```sql
alter table kriya.memories
  add column embedding real[] check (embedding is null or array_length(embedding, 1) between 64 and 4096),
  add column embedding_model text check (char_length(embedding_model) <= 120),
  add column embedded_at timestamptz;
-- The embedding job runs in the existing maintenance loop (lib/memory/maintenance.ts)
alter table kriya.maintenance_jobs drop constraint maintenance_jobs_kind_check;
alter table kriya.maintenance_jobs add constraint maintenance_jobs_kind_check
  check (kind in ('thread_summary', 'episode_summary', 'consolidate', 'embed_notes'));
```

The constraint name above is Postgres's default for the inline check in
`20261101000000_memory_v2.sql:102`; N9 verifies the real name on PGlite
and on the live database (read-only) before writing the migration. The
down file deletes `embed_notes` jobs, then restores the three-kind check.

Covered by the existing `memories` policies. The maintenance job fills it
only for valid, confirmed, non-archived notes. Down drops the three
columns. Embeddings are derived data: erasing a note erases its vector;
export (DPDP access) leaves vectors out (they are not the person's words).

## 4. Who writes what

| Table / column         | Person (server actions, `withUser`)      | Owner (`requireOwner`, `privileged`) | Worker (`privileged`, user id explicit)                         | Agent tools |
| ---------------------- | ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------- | ----------- |
| `mcp_servers`          | —                                        | insert, update, status               | —                                                               | never       |
| `mcp_tools`            | —                                        | insert, update, status               | `status: pinned → drifted`, `drifted_hash`                      | never       |
| `mcp_enablements`      | insert, delete own                       | —                                    | —                                                               | never       |
| `mcp_connections`      | Disconnect (through `lib/connectors.ts`) | —                                    | insert at callback, token refresh (through `lib/connectors.ts`) | never       |
| `delivery_checks`      | —                                        | —                                    | insert                                                          | never       |
| `tool_executions.risk` | —                                        | —                                    | insert (runner)                                                 | never       |
| `memories.embedding*`  | erased with the note                     | —                                    | maintenance job                                                 | never       |

`PERSON_ONLY_WRITES` gains `mcp_enablements` and `mcp_connections`; the
AT-POL-07 table check (`tests/agent/tool-policy.test.ts`) proves no tool's
`TOOL_WRITES` names them. MCP tools have no `TOOL_WRITES` entries (they
change nothing in Kriya's tables).

## 5. Retention

| Data                   | Kept                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `delivery_checks`      | With the task (cascade); same as `tool_executions`              |
| `mcp_enablements`      | Until the person removes it, disconnects, or the agent goes     |
| `mcp_tools.definition` | While the server exists; a retired server's rows stay for audit |
| Embeddings             | With the note                                                   |

## 6. SQL tests (`tests/db/next-*.test.ts`)

| Id        | Proves                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NT-DB-01  | A person can't insert, update or delete `mcp_servers` / `mcp_tools`; reads only active servers' public columns                                                                |
| NT-DB-02  | `mcp_enablements`: own rows only; can't enable for another person's agent (composite FK)                                                                                      |
| NT-DB-03  | `delivery_checks`: select own; no insert/update by `authenticated`; one row per `(execution_id, kind)`                                                                        |
| NT-DB-04  | An `auth = 'none'` server can't hold a pinned tool above R1; `idempotent` only on R0                                                                                          |
| NT-DB-05  | Transitions outside the table raise; `drifted → pinned` without a new hash raises                                                                                             |
| NT-DB-06  | `kriya_name` must start with `mcp_<server_id>_`; unique across servers                                                                                                        |
| NT-DB-07  | `mcp_connections` (N6): the session can select only the non-token columns and delete its own row; insert/update refused; `kriya.connections` grants, check and rows unchanged |
| NT-DB-08  | `tests/db/lint.test.ts` still reports zero tables without RLS or a policy, zero unpinned functions                                                                            |
| NT-MIG-01 | Down + up of each track-N migration on PGlite with rows present; older cases unchanged                                                                                        |
