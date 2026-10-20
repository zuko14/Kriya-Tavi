-- Reverses 20261022000000_voice_verification.sql. Run it before
-- 20261021000000_voice_queue.down.sql (newest first). Verification calls
-- (their attempts cascade) and their transitions are deleted; the codes
-- stay, without their call.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261022000000_voice_verification.down.sql

update kriya.phone_verifications set voice_call_id = null where voice_call_id is not null;

delete from kriya.voice_transitions where voice_task_id is null;
alter table kriya.voice_transitions alter column voice_task_id set not null;

delete from kriya.voice_calls where kind = 'verification';
alter table kriya.voice_calls drop constraint if exists voice_calls_task_unless_verification;
alter table kriya.voice_calls alter column voice_task_id set not null;

delete from supabase_migrations.schema_migrations where version = '20261022000000';
