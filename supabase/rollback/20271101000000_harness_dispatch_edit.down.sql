-- Removes the edit kind. An edit action can't exist without it, so those rows go
-- first; rows of the eight older kinds stay as they are.
delete from kriya.harness_dispatches where kind = 'edit';
alter table kriya.harness_dispatches drop constraint harness_dispatches_kind_check;
alter table kriya.harness_dispatches add constraint harness_dispatches_kind_check check (kind in (
  'run', 'doctor', 'rule_confirm', 'rule_dismiss', 'handoff', 'pull', 'serve_start', 'serve_stop'
));
delete from supabase_migrations.schema_migrations where version = '20271101000000';
