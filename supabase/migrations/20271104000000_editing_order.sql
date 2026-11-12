-- Editing Studio (track E, TP11): a decision card asking which order of the clips a Tavi brief
-- meant. Only the allowed kinds widen; the table, its RLS and its grants are as they were.

alter table kriya.edit_questions drop constraint edit_questions_kind_check;
alter table kriya.edit_questions add constraint edit_questions_kind_check
  check (kind in ('take', 'hook', 'file', 'name', 'taste', 'found', 'order'));
