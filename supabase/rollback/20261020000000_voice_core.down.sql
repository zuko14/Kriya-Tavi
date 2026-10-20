-- Reverses 20261020000000_voice_core.sql. DELETES ALL VOICE DATA (tasks,
-- calls, transcripts, outcomes, voice cost records). Run it before
-- 20261016000000_kriya_core.down.sql: that one drops the whole schema but
-- removes only its own version row (F2).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261020000000_voice_core.down.sql

drop function if exists kriya.voice_transition(text, uuid, text, text, jsonb);

drop table if exists kriya.voice_transitions;
drop table if exists kriya.voice_allowed_transitions;
drop table if exists kriya.voice_charges;
drop table if exists kriya.voice_usage;
drop table if exists kriya.voice_prices;
drop table if exists kriya.call_suppressions;
drop table if exists kriya.call_outcomes;
drop table if exists kriya.conversation_turns;
drop table if exists kriya.call_events;
drop table if exists kriya.call_attempts;
drop table if exists kriya.voice_calls;
drop table if exists kriya.voice_approvals;
drop table if exists kriya.voice_tasks;
drop table if exists kriya.phone_verifications;
drop table if exists kriya.voice_profiles;
drop table if exists kriya.voice_access;

drop function if exists kriya.voice_status_guard();
drop function if exists kriya.voice_transitions_frozen();

alter table kriya.plans
  drop column if exists voice_enabled,
  drop column if exists max_outreach_calls_per_day,
  drop column if exists max_call_seconds,
  drop column if exists max_attempts_per_call,
  drop column if exists max_voice_task_cost_micro_inr;

delete from supabase_migrations.schema_migrations where version = '20261020000000';
