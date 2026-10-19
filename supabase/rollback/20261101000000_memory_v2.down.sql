-- Reverses 20261101000000_memory_v2.sql. Turn agents.memoryV2 off first.
--
-- DELETES shared notes (agent_id null), which the old schema can't hold,
-- and superseded or forgotten notes, which would otherwise come back as
-- current ones: export them first. Notes written by consolidation become
-- agent notes. Thread summaries, maintenance jobs and resource usage are
-- dropped.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261101000000_memory_v2.down.sql

drop table if exists kriya.resource_usage;
drop table if exists kriya.maintenance_jobs;
drop table if exists kriya.thread_summaries;

delete from kriya.memories where agent_id is null;
delete from kriya.memories where invalid_at is not null;
update kriya.memories set source = 'agent' where source = 'derived';

drop index if exists kriya.memories_slot_current_idx;
drop index if exists kriya.memories_scope_idx;
drop index if exists kriya.memories_search_idx;

alter table kriya.memories
  drop column if exists search,
  drop column if exists content_hash,
  drop column if exists use_count,
  drop column if exists last_used_at,
  drop column if exists archived,
  drop column if exists task_id,
  drop column if exists superseded_by,
  drop column if exists invalid_at,
  drop column if exists valid_from,
  drop column if exists pinned,
  drop column if exists importance,
  drop column if exists trust,
  drop column if exists slot,
  drop column if exists kind;

alter table kriya.memories drop constraint if exists memories_source_check;
alter table kriya.memories add constraint memories_source_check
  check (source in ('agent', 'user'));
alter table kriya.memories alter column agent_id set not null;
alter table kriya.memories drop constraint if exists memories_id_user_key;

delete from supabase_migrations.schema_migrations where version = '20261101000000';
