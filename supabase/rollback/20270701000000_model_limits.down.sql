-- Reverses 20270701000000_model_limits.sql: the two columns go; the harness
-- then reports no model limits and clients keep DeepSeek Harness's defaults.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270701000000_model_limits.down.sql

alter table kriya.models
  drop column if exists context_window,
  drop column if exists max_output_tokens;
