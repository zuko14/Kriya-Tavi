-- Reverses 20261109000000_skills.sql. Saved skills are deleted; the tasks
-- they ran stay. Switch agents.skills off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261109000000_skills.down.sql

drop table if exists kriya.skills;
delete from kriya.allowed_transitions where entity = 'skill';
alter table kriya.plans drop column if exists max_skills;
delete from supabase_migrations.schema_migrations where version = '20261109000000';
