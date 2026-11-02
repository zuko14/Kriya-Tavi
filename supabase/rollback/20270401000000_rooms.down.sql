-- Reverses 20270401000000_rooms.sql. Every room, member, invite, agent link,
-- message, invocation and disclosure goes. Switch rooms.enabled off first
-- (DATA_MODEL §7); export the messages first if the history is wanted.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270401000000_rooms.down.sql

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists kriya_room_members_receive on realtime.messages';
  end if;
end $$;

drop function if exists kriya.check_room_invocation(uuid, text, uuid, timestamptz);
drop function if exists kriya.join_room(text, integer);
drop table if exists kriya.room_disclosures;
drop table if exists kriya.room_invocations;
drop table if exists kriya.room_messages;
drop table if exists kriya.room_agents;
drop table if exists kriya.room_invites;
drop table if exists kriya.room_members;
drop table if exists kriya.rooms;
drop function if exists kriya.room_members_guard();
drop function if exists kriya.room_messages_seq();
drop function if exists kriya.rooms_owner_member();
drop function if exists kriya.is_room_member(uuid);
drop function if exists kriya.room_role(uuid);
delete from kriya.allowed_transitions where entity = 'room_disclosure';

delete from supabase_migrations.schema_migrations where version = '20270401000000';
