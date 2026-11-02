-- Reverses 20270201000000_cloud_workspaces.sql. Every workspace row, its
-- sessions and the workspace usage rows go (the old kind check would reject
-- them; export them first if the history is wanted). Switch cloud.workspaces
-- off and let the janitor close every workspace first, so no provider
-- sandbox or Storage checkpoint is left behind (DATA_MODEL §8, runbook).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270201000000_cloud_workspaces.down.sql

delete from kriya.allowed_transitions where entity = 'workspace';
drop function if exists kriya.open_workspace_session(uuid, uuid, uuid, text, integer);
drop table if exists kriya.workspace_sessions;
drop table if exists kriya.workspaces;

delete from kriya.resource_usage where kind in ('workspace_seconds', 'workspace_storage_bytes');
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design'
));
alter table kriya.plans drop column if exists workspace_minutes;

delete from supabase_migrations.schema_migrations where version = '20270201000000';
