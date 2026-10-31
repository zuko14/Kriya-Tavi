# Data model (track R: Rooms)

Migration `supabase/migrations/20270401000000_rooms.sql` (R1) with rollback;
`20270401000100_room_goals_notes.sql` (R7/R8) later. Track R claims
`202704DDhhmmss`. Rules as track C DATA_MODEL §0.

## 1. Membership functions (avoid policy recursion)

```sql
create function kriya.room_role(p_room uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from kriya.room_members m
  where m.room_id = p_room and m.user_id = (select auth.uid()) and m.left_at is null
$$;
create function kriya.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kriya.room_role(p_room) is not null
$$;
revoke all on function kriya.room_role(uuid), kriya.is_room_member(uuid) from public, anon;
grant execute on function kriya.room_role(uuid), kriya.is_room_member(uuid) to authenticated;
```

## 2. Tables

```sql
create table kriya.rooms (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  topic text check (char_length(topic) <= 500),
  status text not null default 'active' check (status in ('active', 'archived')),
  last_seq bigint not null default 0,
  agents_paused_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table kriya.room_members (
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  last_read_seq bigint not null default 0,
  primary key (room_id, user_id)
);
create index room_members_user_idx on kriya.room_members (user_id) where left_at is null;

create table kriya.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  max_uses integer not null check (max_uses between 1 and 25),
  uses integer not null default 0 check (uses >= 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index room_invites_room_idx on kriya.room_invites (room_id);

create table kriya.room_agents (
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  agent_id text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  bridge_thread_id text not null,
  invoke text not null default 'owner_only' check (invoke in ('owner_only', 'members')),
  daily_cap_micro_inr bigint check (daily_cap_micro_inr > 0),
  allow_connectors boolean not null default false,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (room_id, agent_id),
  check (invoke = 'owner_only' or daily_cap_micro_inr is not null),
  foreign key (agent_id, owner_id) references kriya.agents (id, user_id) on delete cascade,
  foreign key (bridge_thread_id, owner_id) references kriya.threads (id, user_id) on delete cascade
);
create index room_agents_owner_idx on kriya.room_agents (owner_id);
create index room_agents_bridge_idx on kriya.room_agents (bridge_thread_id, owner_id);

create table kriya.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  seq bigint not null,
  author_kind text not null check (author_kind in ('human', 'agent', 'system')),
  -- The human author, or the agent's owner; null for system lines
  user_id uuid references auth.users (id) on delete cascade,
  agent_id text,
  body text check (char_length(body) <= 8000),
  parts jsonb not null default '{}' check (jsonb_typeof(parts) = 'object' and pg_column_size(parts) <= 32768),
  task_id uuid references kriya.tasks (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room_id, seq),
  check ((author_kind = 'human' and user_id is not null and agent_id is null)
      or (author_kind = 'agent' and user_id is not null and agent_id is not null)
      or (author_kind = 'system' and agent_id is null))
);
create index room_messages_task_idx on kriya.room_messages (task_id);

create table kriya.room_invocations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  agent_id text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  message_id uuid references kriya.room_messages (id) on delete set null,
  chain_depth integer not null default 0 check (chain_depth between 0 and 10),
  task_id uuid references kriya.tasks (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'dispatched', 'refused', 'done', 'failed')),
  reason text check (char_length(reason) <= 200),
  created_at timestamptz not null default now()
);
create index room_invocations_cap_idx on kriya.room_invocations (room_id, agent_id, created_at);
create index room_invocations_task_idx on kriya.room_invocations (task_id);

create table kriya.room_disclosures (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  agent_id text not null,
  task_id uuid references kriya.tasks (id) on delete set null,
  body text check (char_length(body) <= 8000),
  parts jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'shared', 'discarded')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index room_disclosures_owner_idx on kriya.room_disclosures (owner_id, status);
create index room_disclosures_room_idx on kriya.room_disclosures (room_id);
```

Triggers: `touch_updated_at` on `rooms`; `check_transition('room_disclosure')`
on `room_disclosures.status` (`pending → shared | discarded`).

## 3. Functions

```sql
-- Assigns the next seq under a row lock on the room. Called for every insert.
create function kriya.room_messages_seq() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update kriya.rooms set last_seq = last_seq + 1 where id = new.room_id
    returning last_seq into new.seq;
  return new;
end $$;
create trigger room_messages_seq before insert on kriya.room_messages
  for each row execute function kriya.room_messages_seq();
```

| Function | Called by | What it checks |
| --- | --- | --- |
| `kriya.join_room(p_token_hash text) returns uuid` (`security definer`, granted to `authenticated`) | `actions/rooms.ts` | Invite exists, not revoked, not expired, uses < max; room active; humans < `p_max_humans`; not already an active member (re-join clears `left_at` unless `removed_by` set); increments `uses`; inserts the member; returns the room id |
| `kriya.check_room_invocation(p_room, p_agent, p_requester, p_today_start) returns text` (`security definer`, server-only) | `lib/rooms/invoke.ts` | Agent active in room; requester an active member; owner or `members` policy; for a non-owner requester, the total `charges.charge_micro_inr` since `p_today_start` (IST) of tasks in `room_invocations` for that room and agent whose `requested_by` isn't the owner is below `daily_cap_micro_inr` (RD-04); the agent has no `queued`/`dispatched` invocation (RD-08); room not paused. Returns `ok` or a reason code |

## 4. Access (RLS)

| Table | Select | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `rooms` | `is_room_member(id)` | authenticated with `created_by = auth.uid()` (the action also inserts the owner member in the same transaction) | `room_role(id) in ('owner','admin')`, columns `title`, `topic`, `status`, `agents_paused_until` | none |
| `room_members` | `is_room_member(room_id)` | through `join_room` only | own row: `left_at`, `last_read_seq`; admins: `left_at`, `removed_by`, `role` (owner can't be removed) | none |
| `room_invites` | `room_role(room_id) in ('owner','admin')` | same | same, column `revoked_at` | none |
| `room_agents` | `is_room_member(room_id)` | `owner_id = auth.uid()` and member | `owner_id = auth.uid()`: `invoke`, `daily_cap_micro_inr`, `allow_connectors`, `removed_at` | none |
| `room_messages` | `is_room_member(room_id)` | `author_kind = 'human' and user_id = auth.uid() and is_room_member(room_id)` | own human messages: `deleted_at` | none |
| `room_invocations` | `is_room_member(room_id)` | server only | server only | none |
| `room_disclosures` | `owner_id = auth.uid()` | server only | `owner_id = auth.uid()`: `status`, `answered_at` (pending only) | none |

Agent and system messages, invocations and disclosures are inserted by the
worker or the web server through `privileged` after their own authorization
(the requester's membership, the owner's identity), scoped by room and user
(invariant 1).

`PERSON_ONLY_WRITES += "rooms", "room_members", "room_invites", "room_agents",
"room_disclosures"`; the agent tool `room_history` writes nothing.

## 5. Realtime policy (guarded)

```sql
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy kriya_room_members_receive on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and (select realtime.topic()) like 'room:%'
          and kriya.is_room_member(substring((select realtime.topic()) from 6)::uuid)
        )
    $p$;
  end if;
end $$;
```

No insert policy: only the server (secret key, REST) broadcasts. The
rollback drops the policy the same guarded way.

## 6. Retention

Messages live with the room; archiving keeps them readable; a person's
deletion of their account deletes their human messages and their agents'
messages (cascade on `user_id`); a removed member loses read access
immediately (RLS) though their client may get pings until its JWT refreshes
(RF-02).

## 7. Rollback

Drop the realtime policy (guarded), triggers, functions, the seven tables
and the transition rows, in reverse order; `rooms.enabled` off first.

## 7a. Second migration (R7/R8): goals and notes

`20270401000100_room_goals_notes.sql`, same rules and the same membership
functions:

| Table | Columns (sketch) | Access |
| --- | --- | --- |
| `kriya.room_goals` | `id`, `room_id`, `title` (1–120), `created_by`, `status` (`open`, `done`, `dropped`; computed by code from items, written only by `lib/rooms/goals.ts`), timestamps | Members read; members create; status by code |
| `kriya.room_goal_items` | `id`, `goal_id`, `text` (1–300), `proof_message_id` (a room message with a proof card), `confirmed_by` (a member, when closed without proof), `closed_at` | Members read and edit; `proof_message_id` must belong to the same room (check in the action and a trigger) |
| `kriya.room_notes` | `id`, `room_id`, `body` (1–1,000), `author_kind` (`human`, `agent`), `user_id`, `agent_id`, `confirmed_by`, `created_at`, `deleted_at` | Members read; members insert as themselves; agent notes inserted by the worker (`room_note_add`), unconfirmed until a member sets `confirmed_by` |

Tests RT-GOAL-01…03 and RT-NOTE-01…03 (TEST_STRATEGY).

## 8. SQL tests (`tests/db/rooms-rls.test.ts`)

| Id | Assertion |
| --- | --- |
| RT-DB-01 | A non-member sees no room, member, message, agent or invocation rows |
| RT-DB-02 | A member sees their rooms' rows only; a removed or left member sees nothing more |
| RT-DB-03 | A member can insert only human messages as themselves; can't forge `author_kind`, `user_id` or `agent_id` |
| RT-DB-04 | `seq` is gap-free and unique under 20 concurrent inserts |
| RT-DB-05 | `join_room`: expired, revoked, used-up invites and full rooms refused; re-join after leaving works; after removal refused |
| RT-DB-06 | Only an agent's owner adds it or changes its policy; `members` policy needs a cap |
| RT-DB-07 | `check_room_invocation` refuses non-members, non-owners under `owner_only`, over-cap requests, paused rooms |
| RT-DB-08 | Policies don't recurse (membership functions), `lint.test.ts` stays at zero, down + up on PGlite |
