-- Reverses 20261110000000_files.sql. File metadata, shares and their view
-- log are deleted; switch agents.files off first, and empty the
-- `kriya-files` bucket separately (Storage isn't touched by SQL).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261110000000_files.down.sql

drop table if exists kriya.share_views;
drop table if exists kriya.share_links;
drop table if exists kriya.files;
drop function if exists kriya.share_links_guard();
drop function if exists kriya.shares_within_plan();
drop function if exists kriya.files_within_plan();
delete from kriya.allowed_transitions where entity = 'file';
alter table kriya.plans
  drop column if exists max_file_mb,
  drop column if exists storage_mb,
  drop column if exists max_shares;
delete from supabase_migrations.schema_migrations where version = '20261110000000';
