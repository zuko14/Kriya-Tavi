-- Block and report (track R, R9; RD-18, RS-11, RT-MOD-02/03).
--
-- A block is a person's own list: only they see it, add to it or remove
-- from it. It keeps the blocked person out of rooms through invites in
-- either direction (kriya.invite_blocked, checked before kriya.join_room),
-- stops them asking the blocker's agents (lib/rooms/invoke.ts), and
-- collapses their messages for the blocker in rooms both are already in.
--
-- A report goes from a member to the Kriya owner console. The reported
-- message is copied by the trigger below, so a client can't put words in
-- someone's mouth and the owner still sees it if it is deleted later. Only
-- the reporter reads their own reports; the owner console reads them
-- through privileged after requireOwner(); only the server reviews them.

/* ───────────────────────────── blocks ───────────────────────────── */

create table kriya.person_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index person_blocks_blocked_idx on kriya.person_blocks (blocked_id);

/* ──────────────────────────── reports ───────────────────────────── */

create table kriya.room_reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references kriya.rooms (id) on delete cascade,
  -- Null for a report about the whole room
  message_id uuid references kriya.room_messages (id) on delete set null,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reason text not null
    check (reason in ('spam', 'harassment', 'unsafe', 'private_info', 'other')),
  note text check (char_length(note) <= 500),
  -- Copied from the message by room_reports_fill, never from the client
  message_author_kind text check (message_author_kind in ('human', 'agent', 'system')),
  message_user_id uuid references auth.users (id) on delete set null,
  message_agent_id text,
  message_body text check (char_length(message_body) <= 8000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index room_reports_status_idx on kriya.room_reports (status, created_at);
create index room_reports_room_idx on kriya.room_reports (room_id);
create index room_reports_message_idx on kriya.room_reports (message_id);
create index room_reports_message_user_idx on kriya.room_reports (message_user_id);
create index room_reports_reviewed_by_idx on kriya.room_reports (reviewed_by);
-- One open report per person per message (or per room)
create unique index room_reports_once on kriya.room_reports
  (reporter_id, room_id, coalesce(message_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'open';
create trigger room_reports_transition before update of status on kriya.room_reports
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('room_report');

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('room_report', 'open', 'reviewed'),
  ('room_report', 'open', 'dismissed');

-- The reported message must be in the reported room; its author and text
-- (none once deleted) are copied as they are now. A new report is open
create function kriya.room_reports_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_message kriya.room_messages;
begin
  new.message_author_kind := null;
  new.message_user_id := null;
  new.message_agent_id := null;
  new.message_body := null;
  new.status := 'open';
  new.reviewed_by := null;
  new.reviewed_at := null;
  if new.message_id is not null then
    select * into v_message from kriya.room_messages
      where id = new.message_id and room_id = new.room_id;
    if not found then
      raise exception 'that message is not in this room: not allowed';
    end if;
    new.message_author_kind := v_message.author_kind;
    new.message_user_id := v_message.user_id;
    new.message_agent_id := v_message.agent_id;
    new.message_body := case when v_message.deleted_at is null then v_message.body end;
  end if;
  return new;
end $$;
create trigger room_reports_fill before insert on kriya.room_reports
  for each row execute function kriya.room_reports_fill();

/* ───────────────────────────── scale ────────────────────────────── */

-- The owner console counts the last day's messages (queries/rooms.ts
-- roomsOverview) without reading every room's history
create index room_messages_created_idx on kriya.room_messages (created_at);

/* ──────────────────────────── invites ───────────────────────────── */

-- Before joining (RD-18): 'joiner' when the caller blocked the person who
-- made the invite, 'maker' when that person blocked the caller, else null
-- (also for someone already in the room, whom joining doesn't change).
-- Says nothing about anyone's blocks but the caller's own and the maker's
-- about the caller
create function kriya.invite_blocked(p_token_hash text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from kriya.person_blocks b
                 where b.blocker_id = (select auth.uid()) and b.blocked_id = i.created_by)
      then 'joiner'
    when exists (select 1 from kriya.person_blocks b
                 where b.blocker_id = i.created_by and b.blocked_id = (select auth.uid()))
      then 'maker'
  end
  from kriya.room_invites i
  where i.token_hash = p_token_hash
    and not exists (select 1 from kriya.room_members m
                    where m.room_id = i.room_id and m.user_id = (select auth.uid())
                      and m.left_at is null)
$$;
revoke all on function kriya.invite_blocked(text) from public, anon;
grant execute on function kriya.invite_blocked(text) to authenticated;

/* ──────────────────────────── access ────────────────────────────── */

alter table kriya.person_blocks enable row level security;
create policy read_own on kriya.person_blocks for select to authenticated
  using (blocker_id = (select auth.uid()));
create policy add_own on kriya.person_blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()));
create policy remove_own on kriya.person_blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));
grant select, delete on kriya.person_blocks to authenticated;
grant insert (blocker_id, blocked_id) on kriya.person_blocks to authenticated;

alter table kriya.room_reports enable row level security;
create policy read_own on kriya.room_reports for select to authenticated
  using (reporter_id = (select auth.uid()));
create policy report_member on kriya.room_reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and kriya.is_room_member(room_id));
grant select on kriya.room_reports to authenticated;
grant insert (room_id, message_id, reporter_id, reason, note) on kriya.room_reports to authenticated;
