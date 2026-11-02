-- Reverses 20270401000200_room_moderation.sql. Every block and report goes;
-- rooms, members and messages stay. Export open reports first if they are
-- still being looked at.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270401000200_room_moderation.down.sql

drop function if exists kriya.invite_blocked(text);
drop index if exists kriya.room_messages_created_idx;
drop table if exists kriya.room_reports;
drop table if exists kriya.person_blocks;
drop function if exists kriya.room_reports_fill();
delete from kriya.allowed_transitions where entity = 'room_report';

delete from supabase_migrations.schema_migrations where version = '20270401000200';
