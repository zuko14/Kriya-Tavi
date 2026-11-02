-- Reverses 20270301000000_harness.sql. Every device, sign-in code, gateway
-- usage row, approval request and mirrored-session link goes (export
-- harness_usage first if the history is wanted). Switch harness.api off
-- first so no device is mid-request (DATA_MODEL §5).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270301000000_harness.down.sql

drop function if exists kriya.reserve_harness_spend(uuid, uuid, text, text, text, bigint);
alter table kriya.plans drop column if exists harness_monthly_micro_inr;
drop table if exists kriya.harness_sessions;
delete from kriya.allowed_transitions where entity = 'harness_approval';
drop table if exists kriya.harness_approval_requests;
drop table if exists kriya.harness_usage;
drop table if exists kriya.harness_device_codes;
drop table if exists kriya.harness_devices;

delete from supabase_migrations.schema_migrations where version = '20270301000000';
