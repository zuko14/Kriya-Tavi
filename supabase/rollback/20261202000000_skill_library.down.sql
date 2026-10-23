-- Reverses 20261202000000_skill_library.sql. Agents lose their skill
-- assignments and the activation audit trail is deleted; agents, tasks and
-- messages stay. Switch agents.skillLibrary off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261202000000_skill_library.down.sql

drop table if exists kriya.skill_activations;
alter table kriya.agents drop column if exists skills;
delete from supabase_migrations.schema_migrations where version = '20261202000000';
