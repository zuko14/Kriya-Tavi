-- Reverses 20270101000200_memory_embeddings.sql. Every note's vector is
-- dropped (notes themselves stay) and open embed_notes jobs are deleted.
-- Turn next.memoryRerank off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270101000200_memory_embeddings.down.sql

delete from kriya.maintenance_jobs where kind = 'embed_notes';
alter table kriya.maintenance_jobs drop constraint if exists maintenance_jobs_kind_check;
alter table kriya.maintenance_jobs add constraint maintenance_jobs_kind_check
  check (kind in ('thread_summary', 'episode_summary', 'consolidate'));
drop trigger if exists memories_vector_guard on kriya.memories;
drop function if exists kriya.memories_vector_guard();
alter table kriya.memories
  drop column if exists embedded_at,
  drop column if exists embedding_model,
  drop column if exists embedding;

delete from supabase_migrations.schema_migrations where version = '20270101000200';
