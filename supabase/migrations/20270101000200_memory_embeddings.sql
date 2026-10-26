-- Memory recall v2: embedding rerank (track N, N9, ND-15; DATA_MODEL §3).
-- A vector per confirmed, current, non-archived note, made by the
-- embed_notes maintenance job; recall reorders its full-text candidates by
-- similarity. No extension: plain real[] and the math in TypeScript.
-- Covered by the memories policies; erasing a note erases its vector.

alter table kriya.memories
  add column embedding real[]
    check (embedding is null or array_length(embedding, 1) between 64 and 4096),
  add column embedding_model text check (char_length(embedding_model) <= 120),
  add column embedded_at timestamptz;

-- The job runs in the existing maintenance loop. The check's name is looked
-- up rather than assumed.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'kriya.maintenance_jobs'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%thread_summary%'
  loop
    execute format('alter table kriya.maintenance_jobs drop constraint %I', c);
  end loop;
end $$;
alter table kriya.maintenance_jobs add constraint maintenance_jobs_kind_check
  check (kind in ('thread_summary', 'episode_summary', 'consolidate', 'embed_notes'));

-- Storing a vector isn't a change to the note: it keeps its updated_at, so
-- recall's recency doesn't move. New text drops the old vector, so the job
-- embeds the new words. Runs after memories_touch (triggers fire by name).
create function kriya.memories_vector_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  derived text[] := array['embedding', 'embedding_model', 'embedded_at', 'updated_at', 'search'];
begin
  if new.content is distinct from old.content then
    new.embedding := null;
    new.embedding_model := null;
    new.embedded_at := null;
  elsif (to_jsonb(new) - derived) = (to_jsonb(old) - derived) then
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
create trigger memories_vector_guard before update on kriya.memories
  for each row execute function kriya.memories_vector_guard();
