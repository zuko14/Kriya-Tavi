-- Undoes 20271104000000_editing_order.sql. An order card can't exist under the narrower rule:
-- the open and answered ones go (each is a question about a job, never the person's own content)
delete from kriya.edit_questions where kind = 'order';
alter table kriya.edit_questions drop constraint edit_questions_kind_check;
alter table kriya.edit_questions add constraint edit_questions_kind_check
  check (kind in ('take', 'hook', 'file', 'name', 'taste', 'found'));
delete from supabase_migrations.schema_migrations where version = '20271104000000';
