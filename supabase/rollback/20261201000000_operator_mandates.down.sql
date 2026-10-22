-- Reverses 20261201000000_operator_mandates.sql. Every job, grant and
-- grant use is deleted; tool runs keep everything but which grant answered
-- them. Turn operator.* off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261201000000_operator_mandates.down.sql

drop function if exists kriya.consume_grant(uuid, uuid, uuid, text);
alter table kriya.tool_executions drop column if exists grant_id;
drop table if exists kriya.grant_uses;
drop table if exists kriya.grants;
drop table if exists kriya.mandates;
drop function if exists kriya.grants_guard();
drop function if exists kriya.mandates_guard();
delete from kriya.allowed_transitions where entity in ('mandate', 'grant');

delete from supabase_migrations.schema_migrations where version = '20261201000000';
