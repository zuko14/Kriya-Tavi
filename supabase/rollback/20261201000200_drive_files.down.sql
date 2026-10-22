-- Reverses 20261201000200_drive_files.sql. Files imported from Drive are
-- deleted (their stored objects are left for the bucket's cleanup); the
-- Drive originals are untouched. Turn operator.driveShare off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261201000200_drive_files.down.sql

delete from kriya.files where origin = 'drive';
alter table kriya.files drop constraint files_origin_check;
alter table kriya.files add constraint files_origin_check
  check (origin in ('upload', 'generated', 'screenshot', 'email_attachment'));

delete from supabase_migrations.schema_migrations where version = '20261201000200';
