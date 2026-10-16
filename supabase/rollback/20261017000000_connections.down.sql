-- Reverses 20261017000000_connections.sql. Deletes every connected account;
-- people have to connect again.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261017000000_connections.down.sql

drop table if exists kriya.connections;
delete from supabase_migrations.schema_migrations where version = '20261017000000';
