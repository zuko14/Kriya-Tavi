-- Reverses 20261101000002_browser.sql. Browser session records go; metered
-- browser seconds in kriya.resource_usage stay (they belong to A1's table).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261101000002_browser.down.sql

drop function if exists kriya.open_browser_session(uuid, uuid, text);
drop table if exists kriya.browser_sessions;
delete from supabase_migrations.schema_migrations where version = '20261101000002';
