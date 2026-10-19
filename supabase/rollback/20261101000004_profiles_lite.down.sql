-- Reverses 20261101000004_profiles_lite.sql. The column goes, and its
-- grant with it; the person's other profile grants are untouched.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261101000004_profiles_lite.down.sql

alter table kriya.profiles drop column if exists lite_mode;
delete from supabase_migrations.schema_migrations where version = '20261101000004';
