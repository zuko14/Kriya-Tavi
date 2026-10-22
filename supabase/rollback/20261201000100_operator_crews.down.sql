-- Reverses 20261201000100_operator_crews.sql. Every crew run and part row
-- is deleted; the part threads, their messages, tasks and "What I did"
-- records stay with the person. Turn operator.crews off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261201000100_operator_crews.down.sql

drop table if exists kriya.crew_parts;
drop table if exists kriya.crew_runs;
delete from kriya.allowed_transitions where entity in ('crew_run', 'crew_part');

delete from supabase_migrations.schema_migrations where version = '20261201000100';
