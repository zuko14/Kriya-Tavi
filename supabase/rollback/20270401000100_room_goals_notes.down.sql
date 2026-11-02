-- Reverses 20270401000100_room_goals_notes.sql. Every room goal, goal
-- item and room note goes; rooms and their messages stay. Switch
-- rooms.enabled off first; export goals and notes first if wanted.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270401000100_room_goals_notes.down.sql

drop table if exists kriya.room_notes;
drop table if exists kriya.room_goal_items;
drop table if exists kriya.room_goals;
drop function if exists kriya.room_goal_items_guard();
delete from kriya.allowed_transitions where entity = 'room_goal';

delete from supabase_migrations.schema_migrations where version = '20270401000100';
