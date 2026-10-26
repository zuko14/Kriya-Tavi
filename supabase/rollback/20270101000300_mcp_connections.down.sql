-- Reverses 20270101000300_mcp_connections.sql. Every person's sign-in to an
-- app (the sealed tokens) is deleted; their app choices (mcp_enablements)
-- stay but have nothing to use until they connect again. Turn next.mcpConnect
-- and next.mcp off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270101000300_mcp_connections.down.sql

drop table if exists kriya.mcp_connections;

delete from supabase_migrations.schema_migrations where version = '20270101000300';
