-- Reverses 20261016000000_kriya_core.sql. DESTROYS ALL KRIYA DATA.
-- For staging resets and failed first deploys only; never run on a
-- production database that has customers (restore a backup instead).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261016000000_kriya_core.down.sql

drop trigger if exists on_auth_user_created on auth.users;
drop schema if exists kriya cascade;
delete from supabase_migrations.schema_migrations where version = '20261016000000';
