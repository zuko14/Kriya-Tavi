-- Reverses 20270101000000_next_platform.sql. The MCP registry, its pinned
-- tools, the people's app choices and every delivery re-check are deleted;
-- tool runs keep everything but their MCP risk class. Turn next.* off
-- first (and roll back 20270101000100_mcp_connections, if applied).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270101000000_next_platform.down.sql

alter table kriya.tool_executions drop column if exists risk;
drop table if exists kriya.delivery_checks;
drop table if exists kriya.mcp_enablements;
drop table if exists kriya.mcp_tools;
drop table if exists kriya.mcp_servers;
drop function if exists kriya.delivery_checks_frozen();
drop function if exists kriya.delivery_checks_owner();
drop function if exists kriya.mcp_tools_repin();
drop function if exists kriya.mcp_servers_unauthenticated();
drop function if exists kriya.mcp_tools_unauthenticated();
delete from kriya.allowed_transitions where entity in ('mcp_server', 'mcp_tool');

delete from supabase_migrations.schema_migrations where version = '20270101000000';
