-- Reverses 20261021000000_voice_queue.sql. Run it before
-- 20261020000000_voice_core.down.sql (newest first). Tasks already moved
-- authorized → failed keep that status.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261021000000_voice_queue.down.sql

drop function if exists kriya.recover_voice_calls(text, integer);
drop function if exists kriya.heartbeat_voice_call(uuid, text, integer);
drop function if exists kriya.claim_voice_call(text, integer, integer);
drop index if exists kriya.call_attempts_callback_token_idx;
drop index if exists kriya.call_attempts_stream_token_idx;
delete from kriya.voice_allowed_transitions
where (entity, from_status, to_status) in
  (('task', 'authorized', 'failed'), ('call', 'scheduled', 'exhausted'),
   ('call', 'dialing', 'blocked'));

delete from supabase_migrations.schema_migrations where version = '20261021000000';
