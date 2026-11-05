-- Reverses 20270901000000_flows.sql. Every flow, version and run row is
-- deleted; the threads, tasks and "What I did" records flows made stay with
-- the person. Turn studio.flows off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270901000000_flows.down.sql

drop table if exists kriya.flow_node_runs;
drop table if exists kriya.flow_runs;
drop table if exists kriya.flow_versions;
drop table if exists kriya.flows;
drop function if exists kriya.flow_version_frozen();
delete from kriya.allowed_transitions where entity in ('flow_run', 'flow_node_run');

delete from kriya.resource_usage where kind = 'flow_design';
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes'
));

delete from supabase_migrations.schema_migrations where version = '20270901000000';
