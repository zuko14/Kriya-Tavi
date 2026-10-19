-- Reverses 20261114000000_policy_versions.sql. Every policy version and its
-- eval report is deleted; the code baseline (lib/improve.ts BASELINE) is
-- what runs afterwards.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261114000000_policy_versions.down.sql

drop table if exists kriya.policy_task_versions;
drop table if exists kriya.policy_versions;
drop function if exists kriya.policy_versions_frozen();
delete from kriya.allowed_transitions where entity = 'policy_version';

delete from supabase_migrations.schema_migrations where version = '20261114000000';
