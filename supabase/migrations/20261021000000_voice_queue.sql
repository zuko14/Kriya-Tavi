-- Voice call queue (voice phase 3, DATA_MODEL_AND_STATE_MACHINES.md §4).
--
-- The worker claims due calls with a lease it renews while it dials, like
-- kriya.claim_task. Status changes still go only through
-- kriya.voice_transition(). The functions return call ids, not rows, so they
-- don't depend on the table's row type (the voice core rollback can drop it).

-- Webhooks and streams find their attempt by token hash
create unique index call_attempts_stream_token_idx on kriya.call_attempts (stream_token_hash);
create unique index call_attempts_callback_token_idx on kriya.call_attempts (callback_token_hash);

-- Ways out that DATA_MODEL §3 lacked: an authorized task whose outreach
-- window closed before any dial; a call never claimed before its window
-- closed (no worker running); and a call blocked by the re-check the worker
-- makes after claiming it (suppression, unverified owner number)
insert into kriya.voice_allowed_transitions (entity, from_status, to_status, actors, evidence)
values
  ('task', 'authorized', 'failed', '{worker,janitor}', '{error_code}'),
  ('call', 'scheduled', 'exhausted', '{worker,janitor}', '{}'),
  ('call', 'dialing', 'blocked', '{worker}', '{error_code}');

-- Claims one due call: scheduled or waiting to retry, past available_at and
-- not_before (database time), not cancelled. At most p_max_live calls live
-- across the platform, and one live outreach call per person; their report
-- calls aren't held up by it. ponytail: one global lock serializes claims,
-- which keeps the cap exact; per-user locks if claim volume ever matters.
create function kriya.claim_voice_call(p_worker text, p_lease_seconds integer, p_max_live integer)
returns table (id uuid) language plpgsql security definer set search_path = '' as $$
declare picked uuid;
begin
  perform pg_advisory_xact_lock(hashtext('kriya.claim_voice_call'));
  if (select count(*) from kriya.voice_calls l where l.status in ('dialing', 'in_call'))
     >= p_max_live then
    return;
  end if;
  select c.id into picked
  from kriya.voice_calls c
  where c.status in ('scheduled', 'retry_wait')
    and c.available_at <= now()
    and c.not_before <= now()
    and c.cancel_requested_at is null
    and (c.kind <> 'outreach' or not exists (
      select 1 from kriya.voice_calls l
      where l.user_id = c.user_id and l.kind = 'outreach' and l.status in ('dialing', 'in_call')))
  order by c.available_at
  for update of c skip locked
  limit 1;
  if picked is null then return; end if;

  perform kriya.voice_transition('call', picked, 'dialing', 'worker', '{}');
  update kriya.voice_calls c set
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now()
  where c.id = picked;
  return query select picked;
end $$;

-- Extends a lease. No row back means the lease was lost: stop working on it
create function kriya.heartbeat_voice_call(p_call uuid, p_worker text, p_lease_seconds integer)
returns table (cancel_requested boolean) language sql security definer set search_path = '' as $$
  update kriya.voice_calls set
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now()
  where id = p_call and lease_owner = p_worker and status in ('dialing', 'in_call')
  returning cancel_requested_at is not null
$$;

-- Bookkeeping the database can do alone, then hands the caller the calls
-- whose worker stopped renewing its lease. The caller reconciles each with
-- the provider (lib/voice/run-call.ts): an attempt that may have rung a
-- third party is never dialled again on its own.
create function kriya.recover_voice_calls(p_worker text, p_lease_seconds integer)
returns table (id uuid) language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  update kriya.voice_approvals set status = 'expired', decided_at = now()
  where status = 'pending' and expires_at < now();

  for r in
    select t.id from kriya.voice_tasks t
    where t.status = 'awaiting_confirmation'
      and not exists (select 1 from kriya.voice_approvals a
                      where a.voice_task_id = t.id and a.status = 'pending')
    for update skip locked
  loop
    perform kriya.voice_transition('task', r.id, 'expired', 'janitor', '{}');
  end loop;

  return query
  update kriya.voice_calls c set
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now()
  where c.id in (
    select l.id from kriya.voice_calls l
    where l.status in ('dialing', 'in_call') and l.lease_owner is not null
      and l.lease_expires_at < now()
    for update skip locked)
  returning c.id;
end $$;

revoke all on function kriya.claim_voice_call(text, integer, integer) from public;
revoke all on function kriya.heartbeat_voice_call(uuid, text, integer) from public;
revoke all on function kriya.recover_voice_calls(text, integer) from public;
