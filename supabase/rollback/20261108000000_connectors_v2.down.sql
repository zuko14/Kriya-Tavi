-- Reverses 20261108000000_connectors_v2.sql. GitHub and Meta connections
-- are deleted (their tokens with them) so the narrower check can return;
-- compensation rows stay as ordinary tool runs.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261108000000_connectors_v2.down.sql

drop index if exists kriya.tool_executions_undo_queue_idx;
alter table kriya.tool_executions
  drop constraint if exists tool_executions_undo_check,
  drop column if exists undo,
  drop column if exists undo_until,
  drop column if exists undone_at;

delete from kriya.connections where provider in ('github', 'meta');
alter table kriya.connections drop constraint connections_provider_check;
alter table kriya.connections add constraint connections_provider_check
  check (provider in ('google', 'notion'));

delete from supabase_migrations.schema_migrations where version = '20261108000000';
