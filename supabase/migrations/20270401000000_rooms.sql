-- Rooms (track R, R1; docs/rooms/DATA_MODEL_AND_STATE_MACHINES.md, RD-02,
-- RD-10, RD-19): conversations where people and their own agents work
-- together. Room data is the one shared exception to owner-only access
-- (AGENTS.md invariant 1): it is readable by the room's active members
-- through the membership functions below, which also keep the policies from
-- recursing. Every agent still acts only in its owner's account.
--
-- People write as themselves through these policies and grants; agent and
-- system messages, invocations and disclosures are written by the server
-- (privileged) after its own checks, scoped by room and user. Joining goes
-- only through kriya.join_room(); others' use of an agent is checked in
-- kriya.check_room_invocation().

/* ───────────────────────────── tables ───────────────────────────── */

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
create index rooms_created_by_idx on kriya.rooms (created_by);
create trigger rooms_touch before update on kriya.rooms
  for each row execute function kriya.touch_updated_at();

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
create index room_members_removed_by_idx on kriya.room_members (removed_by);

-- An invite link's token is never stored: only its sha256. At most 7 days
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
create index room_invites_created_by_idx on kriya.room_invites (created_by);

-- An agent in a room: always its owner's, working in a bridge thread of the
-- owner's account. Letting other members ask it needs a daily cap
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
create index room_agents_agent_idx on kriya.room_agents (agent_id, owner_id);
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
  parts jsonb not null default '{}'
    check (jsonb_typeof(parts) = 'object' and pg_column_size(parts) <= 32768),
  task_id uuid references kriya.tasks (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room_id, seq),
  check ((author_kind = 'human' and user_id is not null and agent_id is null)
      or (author_kind = 'agent' and user_id is not null and agent_id is not null)
      or (author_kind = 'system' and agent_id is null))
);
create index room_messages_task_idx on kriya.room_messages (task_id);
create index room_messages_user_idx on kriya.room_messages (user_id);

create table kriya.room_invocations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  agent_id text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  message_id uuid references kriya.room_messages (id) on delete set null,
  chain_depth integer not null default 0 check (chain_depth between 0 and 10),
  task_id uuid references kriya.tasks (id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'dispatched', 'refused', 'done', 'failed')),
  reason text check (char_length(reason) <= 200),
  created_at timestamptz not null default now()
);
create index room_invocations_cap_idx on kriya.room_invocations (room_id, agent_id, created_at);
create index room_invocations_task_idx on kriya.room_invocations (task_id);
create index room_invocations_owner_idx on kriya.room_invocations (owner_id);
create index room_invocations_requested_by_idx on kriya.room_invocations (requested_by);
create index room_invocations_message_idx on kriya.room_invocations (message_id);

-- A reply that touched the owner's private content waits here for the
-- owner's "Share in room" (RD-06)
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
create index room_disclosures_task_idx on kriya.room_disclosures (task_id);
create trigger room_disclosures_transition before update of status on kriya.room_disclosures
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('room_disclosure');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('room_disclosure', 'pending', 'shared'),
  ('room_disclosure', 'pending', 'discarded');

/* ─────────────────────── membership functions ───────────────────── */

-- Security definer, so policies that call them don't recurse into
-- room_members' own policy
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

/* ─────────────────────────── triggers ───────────────────────────── */

-- The creator becomes the owner member (members are otherwise inserted only
-- by join_room)
create function kriya.rooms_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into kriya.room_members (room_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end $$;
create trigger rooms_owner_member after insert on kriya.rooms
  for each row execute function kriya.rooms_owner_member();

-- The next seq under the room's row lock: gap-free and unique
create function kriya.room_messages_seq() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update kriya.rooms set last_seq = last_seq + 1 where id = new.room_id
    returning last_seq into new.seq;
  return new;
end $$;
create trigger room_messages_seq before insert on kriya.room_messages
  for each row execute function kriya.room_messages_seq();

-- What a person may change on a member row (DATA_MODEL §4): their own read
-- marker and leaving; an owner or admin removes others (as themselves) and
-- changes roles; nobody removes, demotes or replaces the owner. Not security
-- definer: it judges only a client's own statements (current_user is
-- `authenticated`); join_room and server writes pass through
create function kriya.room_members_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.room_id <> old.room_id or new.user_id <> old.user_id or new.joined_at <> old.joined_at then
    raise exception 'that change to a room member is not allowed';
  end if;
  if old.role = 'owner' and (new.role <> 'owner' or new.left_at is not null or new.removed_by is not null) then
    raise exception 'the room owner stays in the room; that change is not allowed';
  end if;
  if new.role = 'owner' and old.role <> 'owner' then
    raise exception 'that change to a room member is not allowed';
  end if;
  if old.user_id = v_actor then
    -- Own row: leave and read marker only; rejoining goes through join_room
    if new.role is distinct from old.role or new.removed_by is distinct from old.removed_by
       or (old.left_at is not null and new.left_at is null) then
      raise exception 'that change to a room member is not allowed';
    end if;
    return new;
  end if;
  v_role := kriya.room_role(old.room_id);
  if v_role is null or v_role not in ('owner', 'admin')
     or new.last_read_seq <> old.last_read_seq
     or (new.removed_by is not null and new.removed_by <> v_actor) then
    raise exception 'that change to a room member is not allowed';
  end if;
  return new;
end $$;
create trigger room_members_guard before update on kriya.room_members
  for each row execute function kriya.room_members_guard();

/* ──────────────────────────── joining ───────────────────────────── */

-- Joins the caller through an invite: valid, not revoked or expired or used
-- up, the room active and below p_max_humans (rooms.maxHumans). Joining
-- again while a member uses nothing; a member who left may come back, one
-- who was removed may not
create function kriya.join_room(p_token_hash text, p_max_humans integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_invite kriya.room_invites;
  v_room kriya.rooms;
  v_member kriya.room_members;
  v_humans integer;
begin
  if v_user is null then
    raise exception 'sign in to join a room';
  end if;
  select * into v_invite from kriya.room_invites where token_hash = p_token_hash for update;
  if not found or v_invite.revoked_at is not null or v_invite.expires_at <= now() then
    raise exception 'this invite is not valid';
  end if;
  select * into v_room from kriya.rooms where id = v_invite.room_id for update;
  if v_room.status <> 'active' then
    raise exception 'this room is archived';
  end if;
  select * into v_member from kriya.room_members where room_id = v_room.id and user_id = v_user;
  if found and v_member.left_at is null then
    return v_room.id;
  end if;
  if found and v_member.removed_by is not null then
    raise exception 'you were removed from this room';
  end if;
  if v_invite.uses >= v_invite.max_uses then
    raise exception 'this invite is used up';
  end if;
  select count(*) into v_humans from kriya.room_members where room_id = v_room.id and left_at is null;
  if v_humans >= p_max_humans then
    raise exception 'this room is full';
  end if;
  update kriya.room_invites set uses = uses + 1 where id = v_invite.id;
  if v_member.user_id is not null then
    update kriya.room_members set left_at = null, joined_at = now()
      where room_id = v_room.id and user_id = v_user;
  else
    insert into kriya.room_members (room_id, user_id) values (v_room.id, v_user);
  end if;
  return v_room.id;
end $$;
revoke all on function kriya.join_room(text, integer) from public, anon;
grant execute on function kriya.join_room(text, integer) to authenticated;

/* ───────────────────────── invoking an agent ────────────────────── */

-- Server only, before a room turn is queued (RD-04, RD-08): the agent is in
-- the room; the requester is an active member; anyone but the owner needs
-- the `members` policy and is below the agent's daily cap, counted from the
-- charges of today's room tasks others asked for; one request at a time;
-- the room's agents not paused. Returns 'ok' or a reason code
create function kriya.check_room_invocation(
  p_room uuid, p_agent text, p_requester uuid, p_today_start timestamptz
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_agent kriya.room_agents;
  v_spent bigint;
  v_paused timestamptz;
begin
  select * into v_agent from kriya.room_agents
    where room_id = p_room and agent_id = p_agent and removed_at is null;
  if not found then
    return 'agent_not_in_room';
  end if;
  if not exists (
    select 1 from kriya.room_members
    where room_id = p_room and user_id = p_requester and left_at is null
  ) then
    return 'not_member';
  end if;
  if p_requester <> v_agent.owner_id then
    if v_agent.invoke = 'owner_only' then
      return 'owner_only';
    end if;
    select coalesce(sum(c.charge_micro_inr), 0) into v_spent
      from kriya.room_invocations i
      join kriya.charges c on c.task_id = i.task_id
      where i.room_id = p_room and i.agent_id = p_agent
        and i.requested_by is distinct from v_agent.owner_id
        and i.created_at >= p_today_start;
    if v_spent >= v_agent.daily_cap_micro_inr then
      return 'over_cap';
    end if;
  end if;
  if exists (
    select 1 from kriya.room_invocations
    where room_id = p_room and agent_id = p_agent and status in ('queued', 'dispatched')
  ) then
    return 'busy';
  end if;
  select agents_paused_until into v_paused from kriya.rooms where id = p_room;
  if v_paused is not null and v_paused > now() then
    return 'paused';
  end if;
  return 'ok';
end $$;
revoke all on function kriya.check_room_invocation(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.rooms enable row level security;
-- The creator too: an insert's RETURNING is checked before the owner-member
-- trigger runs, and the creator is the owner, who can't leave (the guard)
create policy read_member on kriya.rooms for select to authenticated
  using (kriya.is_room_member(id) or created_by = (select auth.uid()));
create policy create_own on kriya.rooms for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy manage_admin on kriya.rooms for update to authenticated
  using (kriya.room_role(id) in ('owner', 'admin'))
  with check (kriya.room_role(id) in ('owner', 'admin'));
grant select on kriya.rooms to authenticated;
grant insert (created_by, title, topic) on kriya.rooms to authenticated;
grant update (title, topic, status, agents_paused_until) on kriya.rooms to authenticated;

alter table kriya.room_members enable row level security;
create policy read_member on kriya.room_members for select to authenticated
  using (kriya.is_room_member(room_id));
create policy update_own_or_admin on kriya.room_members for update to authenticated
  using (user_id = (select auth.uid()) or kriya.room_role(room_id) in ('owner', 'admin'))
  with check (user_id = (select auth.uid()) or kriya.room_role(room_id) in ('owner', 'admin'));
grant select on kriya.room_members to authenticated;
grant update (left_at, last_read_seq, removed_by, role) on kriya.room_members to authenticated;

alter table kriya.room_invites enable row level security;
create policy read_admin on kriya.room_invites for select to authenticated
  using (kriya.room_role(room_id) in ('owner', 'admin'));
create policy create_admin on kriya.room_invites for insert to authenticated
  with check (created_by = (select auth.uid()) and kriya.room_role(room_id) in ('owner', 'admin'));
create policy revoke_admin on kriya.room_invites for update to authenticated
  using (kriya.room_role(room_id) in ('owner', 'admin'))
  with check (kriya.room_role(room_id) in ('owner', 'admin'));
-- token_hash isn't selectable
grant select (id, room_id, created_by, max_uses, uses, expires_at, revoked_at, created_at)
  on kriya.room_invites to authenticated;
grant insert (room_id, created_by, token_hash, max_uses, expires_at) on kriya.room_invites to authenticated;
grant update (revoked_at) on kriya.room_invites to authenticated;

alter table kriya.room_agents enable row level security;
create policy read_member on kriya.room_agents for select to authenticated
  using (kriya.is_room_member(room_id));
create policy add_own on kriya.room_agents for insert to authenticated
  with check (owner_id = (select auth.uid()) and kriya.is_room_member(room_id));
create policy manage_own on kriya.room_agents for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select on kriya.room_agents to authenticated;
grant insert (room_id, agent_id, owner_id, bridge_thread_id, invoke, daily_cap_micro_inr, allow_connectors)
  on kriya.room_agents to authenticated;
grant update (invoke, daily_cap_micro_inr, allow_connectors, removed_at) on kriya.room_agents to authenticated;

alter table kriya.room_messages enable row level security;
create policy read_member on kriya.room_messages for select to authenticated
  using (kriya.is_room_member(room_id));
create policy post_own on kriya.room_messages for insert to authenticated
  with check (
    author_kind = 'human' and user_id = (select auth.uid()) and kriya.is_room_member(room_id)
  );
create policy delete_own on kriya.room_messages for update to authenticated
  using (author_kind = 'human' and user_id = (select auth.uid()))
  with check (author_kind = 'human' and user_id = (select auth.uid()));
grant select on kriya.room_messages to authenticated;
grant insert (room_id, author_kind, user_id, body, parts) on kriya.room_messages to authenticated;
grant update (deleted_at) on kriya.room_messages to authenticated;

alter table kriya.room_invocations enable row level security;
create policy read_member on kriya.room_invocations for select to authenticated
  using (kriya.is_room_member(room_id));
grant select on kriya.room_invocations to authenticated;

alter table kriya.room_disclosures enable row level security;
create policy read_own on kriya.room_disclosures for select to authenticated
  using (owner_id = (select auth.uid()));
create policy answer_own on kriya.room_disclosures for update to authenticated
  using (owner_id = (select auth.uid()) and status = 'pending')
  with check (owner_id = (select auth.uid()));
grant select on kriya.room_disclosures to authenticated;
grant update (status, answered_at) on kriya.room_disclosures to authenticated;

/* ─────────────────────── realtime (guarded) ─────────────────────── */

-- Active members receive the room's broadcast pings (RD-10). Clients can't
-- broadcast: there is no insert policy. Skipped where Realtime doesn't
-- exist (PGlite in tests)
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
