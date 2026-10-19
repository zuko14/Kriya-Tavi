-- Reverses 20261101000001_memory_pause.sql. Paused agents start saving
-- memory again.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261101000001_memory_pause.down.sql

alter table kriya.agents drop column if exists memory_paused;
delete from supabase_migrations.schema_migrations where version = '20261101000001';
