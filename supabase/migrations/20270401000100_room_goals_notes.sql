-- Room goals (track R, R7; RD-13) and room notes (R8; RD-14), one
-- migration for both (docs/rooms/DATA_MODEL_AND_STATE_MACHINES.md §7a).
-- Both are room data: readable by the room's active members through the
-- membership functions of 20270401000000_rooms.sql, like every room table.
--
-- A goal item closes only with a proof card in the same room whose chosen
-- action was verified, or with a member's own confirmation ("no proof");
-- the trigger below checks both. A goal's status is computed from its
-- items by lib/rooms/goals.ts (server-written); no client role may set it.
-- Agents' notes are inserted by the worker (room_note_add, R8) and stay
-- unconfirmed until a member confirms them.

/* ───────────────────────────── goals ────────────────────────────── */

create table kriya.room_goals (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_by uuid references auth.users (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done', 'dropped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index room_goals_room_idx on kriya.room_goals (room_id);
create index room_goals_created_by_idx on kriya.room_goals (created_by);
create trigger room_goals_touch before update on kriya.room_goals
  for each row execute function kriya.touch_updated_at();
create trigger room_goals_transition before update of status on kriya.room_goals
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('room_goal');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('room_goal', 'open', 'done'),
  ('room_goal', 'done', 'open'),
  ('room_goal', 'open', 'dropped'),
  ('room_goal', 'done', 'dropped');

create table kriya.room_goal_items (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references kriya.room_goals (id) on delete cascade,
  -- The goal's room, kept here so the policies stay one function call
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 300),
  position integer not null default 0 check (position between 0 and 100),
  created_by uuid references auth.users (id) on delete set null,
  -- Closed with proof: an agent's message in this room and the index of a
  -- verified action on its card
  proof_message_id uuid references kriya.room_messages (id) on delete set null,
  proof_item integer check (proof_item between 0 and 100),
  -- Closed without proof: the member who confirmed it
  confirmed_by uuid references auth.users (id) on delete set null,
  -- Set by room_goal_items_guard from the two above. No table check ties
  -- them: deleting a person's account sets their message or confirmation to
  -- null, which reopens the item instead of blocking the deletion
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index room_goal_items_goal_idx on kriya.room_goal_items (goal_id, position);
create index room_goal_items_room_idx on kriya.room_goal_items (room_id);
create index room_goal_items_created_by_idx on kriya.room_goal_items (created_by);
create index room_goal_items_proof_idx on kriya.room_goal_items (proof_message_id);
create index room_goal_items_confirmed_by_idx on kriya.room_goal_items (confirmed_by);

-- What may close an item (RD-13): the goal's own room; a proof card from
-- this room whose chosen action is verified; a confirmation only as
-- oneself. closed_at follows from those, never from the client. Not
-- security definer, so current_user tells a client's statement from the
-- server's (as room_members_guard); a member reads the goal and the card
-- through the membership policies
create function kriya.room_goal_items_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
  v_actor uuid;
  v_status text;
begin
  -- Who is asking matters only for a client's own statement (a server write
  -- or an account deletion's cascade has no session)
  if v_client then
    v_actor := (select auth.uid());
  end if;
  if (select g.room_id from kriya.room_goals g where g.id = new.goal_id) is distinct from new.room_id then
    raise exception 'that item belongs to another room: not allowed';
  end if;
  if tg_op = 'UPDATE' and (new.goal_id <> old.goal_id or new.room_id <> old.room_id) then
    raise exception 'that change to a goal item is not allowed';
  end if;
  if new.proof_message_id is null then
    new.proof_item := null;
  elsif new.proof_item is null then
    raise exception 'a proof without its action is not allowed';
  end if;
  if new.proof_message_id is not null
     and (tg_op = 'INSERT' or new.proof_message_id is distinct from old.proof_message_id
          or new.proof_item is distinct from old.proof_item) then
    select m.parts -> 'proof' -> 'done' -> new.proof_item ->> 'status' into v_status
      from kriya.room_messages m
      where m.id = new.proof_message_id and m.room_id = new.room_id
        and m.author_kind = 'agent' and m.deleted_at is null;
    if v_status is distinct from 'verified' then
      raise exception 'closing an item is not allowed without a verified action on a proof card in this room';
    end if;
  end if;
  if v_client and new.confirmed_by is not null
     and (tg_op = 'INSERT' or new.confirmed_by is distinct from old.confirmed_by)
     and new.confirmed_by is distinct from v_actor then
    raise exception 'confirming as someone else is not allowed';
  end if;
  if v_client and tg_op = 'INSERT' and new.created_by is distinct from v_actor then
    raise exception 'adding an item as someone else is not allowed';
  end if;
  new.closed_at := case
    when new.proof_message_id is not null or new.confirmed_by is not null
      then case when tg_op = 'UPDATE' then coalesce(old.closed_at, now()) else now() end
    else null
  end;
  return new;
end $$;
create trigger room_goal_items_guard before insert or update on kriya.room_goal_items
  for each row execute function kriya.room_goal_items_guard();

/* ───────────────────────────── notes ────────────────────────────── */

create table kriya.room_notes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  author_kind text not null check (author_kind in ('human', 'agent')),
  -- The person who wrote it, or the agent's owner
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id text,
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((author_kind = 'human') = (agent_id is null)),
  check (confirmed_by is null or confirmed_at is not null)
);
create index room_notes_room_idx on kriya.room_notes (room_id, created_at);
create index room_notes_user_idx on kriya.room_notes (user_id);
create index room_notes_confirmed_by_idx on kriya.room_notes (confirmed_by);

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.room_goals enable row level security;
create policy read_member on kriya.room_goals for select to authenticated
  using (kriya.is_room_member(room_id));
create policy create_member on kriya.room_goals for insert to authenticated
  with check (created_by = (select auth.uid()) and kriya.is_room_member(room_id));
create policy edit_member on kriya.room_goals for update to authenticated
  using (kriya.is_room_member(room_id)) with check (kriya.is_room_member(room_id));
grant select on kriya.room_goals to authenticated;
grant insert (room_id, title, created_by) on kriya.room_goals to authenticated;
-- status isn't granted: lib/rooms/goals.ts computes it
grant update (title) on kriya.room_goals to authenticated;

alter table kriya.room_goal_items enable row level security;
create policy read_member on kriya.room_goal_items for select to authenticated
  using (kriya.is_room_member(room_id));
create policy create_member on kriya.room_goal_items for insert to authenticated
  with check (kriya.is_room_member(room_id));
create policy edit_member on kriya.room_goal_items for update to authenticated
  using (kriya.is_room_member(room_id)) with check (kriya.is_room_member(room_id));
create policy remove_member on kriya.room_goal_items for delete to authenticated
  using (kriya.is_room_member(room_id));
grant select, delete on kriya.room_goal_items to authenticated;
grant insert (goal_id, room_id, text, position, created_by) on kriya.room_goal_items to authenticated;
grant update (text, position, proof_message_id, proof_item, confirmed_by)
  on kriya.room_goal_items to authenticated;

alter table kriya.room_notes enable row level security;
create policy read_member on kriya.room_notes for select to authenticated
  using (kriya.is_room_member(room_id));
create policy add_own on kriya.room_notes for insert to authenticated
  with check (
    author_kind = 'human' and user_id = (select auth.uid()) and kriya.is_room_member(room_id)
  );
-- A member confirms an agent's note as themselves; a person deletes their own note
create policy confirm_member on kriya.room_notes for update to authenticated
  using (kriya.is_room_member(room_id))
  with check (
    kriya.is_room_member(room_id)
    and (confirmed_by is null or confirmed_by = (select auth.uid()))
    and (deleted_at is null or user_id = (select auth.uid()))
  );
grant select on kriya.room_notes to authenticated;
grant insert (room_id, body, author_kind, user_id) on kriya.room_notes to authenticated;
grant update (confirmed_by, confirmed_at, deleted_at) on kriya.room_notes to authenticated;
