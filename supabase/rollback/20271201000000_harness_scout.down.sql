-- Undoes 20271201000000_harness_scout.sql. The Scout's tables go with their
-- sources, runs, snapshots and findings (platform data, no person's); its
-- spend rows go before the narrower kind rule returns.
drop table kriya.harness_scout_findings;
drop table kriya.harness_scout_snapshots;
drop table kriya.harness_scout_runs;
drop table kriya.harness_scout_sources;
drop function kriya.reserve_scout_spend(text, bigint, bigint);
delete from kriya.resource_usage where kind = 'scout_model';
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes', 'flow_design', 'edit_preview_bytes'
));
delete from supabase_migrations.schema_migrations where version = '20271201000000';
