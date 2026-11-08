drop function kriya.reserve_edit_preview(uuid, uuid, uuid, text, bigint, text, bigint, bigint, integer);
drop table kriya.edit_notes;
drop table kriya.edit_questions;
drop table kriya.edit_deliverables;
drop table kriya.edit_jobs;
delete from kriya.allowed_transitions where entity = 'edit_job';
delete from kriya.resource_usage where kind = 'edit_preview_bytes';
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes', 'flow_design'
));
alter table kriya.plans drop column editing_preview_bytes;
delete from supabase_migrations.schema_migrations where version = '20271102000000';
