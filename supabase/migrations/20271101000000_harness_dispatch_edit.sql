-- Editing Studio (track E, ED14, EDD-28): Tavi reaches a computer through a
-- new dispatch kind. Only lib/harness/control.ts queueEdit() queues one; the
-- person's own queue() refuses it (EH-06).

alter table kriya.harness_dispatches drop constraint harness_dispatches_kind_check;
alter table kriya.harness_dispatches add constraint harness_dispatches_kind_check check (kind in (
  'run', 'doctor', 'rule_confirm', 'rule_dismiss', 'handoff', 'pull', 'serve_start', 'serve_stop',
  'edit'
));
