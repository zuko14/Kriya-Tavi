-- Reverses 20261023000000_voice_improvement.sql. Deletes policy versions,
-- attempt signals, the owners' corrections and the cases. Run it before
-- 20261022000000_voice_verification.down.sql (newest first). Set
-- voice.policyVersion back to v1 first, or the worker loads v1 anyway.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261023000000_voice_improvement.down.sql

drop table if exists kriya.voice_cases;
drop table if exists kriya.voice_feedback;
drop table if exists kriya.attempt_metrics;
drop table if exists kriya.voice_policy_versions;
alter table kriya.voice_profiles drop column if exists improvement_opt_in;

delete from supabase_migrations.schema_migrations where version = '20261023000000';
