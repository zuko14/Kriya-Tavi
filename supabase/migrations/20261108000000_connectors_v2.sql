-- Official-API connectors and the Undo window (A8; AD-07, AD-29, K3).
--
-- GitHub and Meta (Instagram) become providers. Sheets and YouTube are not:
-- they are extra Google scopes on the existing google row, since
-- unique (user_id, provider) allows one Google row per person (AF-15).
-- Nothing else in connections changes.

alter table kriya.connections drop constraint connections_provider_check;
alter table kriya.connections add constraint connections_provider_check
  check (provider in ('google', 'notion', 'github', 'meta'));

-- K3: a reversible tool records how to reverse it (provider ids, never
-- tokens) and until when. undone_at is set by the person's Undo in the same
-- transaction that queues the compensation, so a second click finds it set.
-- The compensation is its own tool_executions row (tool_call_id
-- 'undo:<original>', side_effect), run and checked by the worker.
alter table kriya.tool_executions
  add column undo jsonb,
  add column undo_until timestamptz,
  add column undone_at timestamptz,
  add constraint tool_executions_undo_check
    check ((undo is null) = (undo_until is null) and (undone_at is null or undo is not null));

create index tool_executions_undo_queue_idx on kriya.tool_executions (started_at)
  where status = 'running' and tool_call_id like 'undo:%';
