-- Voice D-22 (docs/voice-assistant/UPGRADE_PROPOSAL.md, S29): an outreach
-- call whose last attempt reached only voicemail or a network announcement
-- reached nobody, so it may go settled -> retry_wait like an undelivered
-- owner report, within the call's own attempts and window. A call where
-- someone spoke to Tavi is still never redialled. Replaces
-- kriya.voice_transition() with that one rule added; nothing else changes.

create or replace function kriya.voice_transition(
  p_entity text, p_id uuid, p_to text, p_actor text, p_evidence jsonb default '{}'
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_user uuid;
  v_task uuid;
  v_rule kriya.voice_allowed_transitions;
  v_key text;
  v_evidence jsonb := coalesce(p_evidence, '{}');
begin
  if p_entity = 'task' then
    select status, user_id, id into v_from, v_user, v_task
    from kriya.voice_tasks where id = p_id for update;
  elsif p_entity = 'call' then
    select status, user_id, voice_task_id into v_from, v_user, v_task
    from kriya.voice_calls where id = p_id for update;
  elsif p_entity = 'attempt' then
    select a.status, a.user_id, c.voice_task_id into v_from, v_user, v_task
    from kriya.call_attempts a join kriya.voice_calls c on c.id = a.voice_call_id
    where a.id = p_id for update of a;
  else
    raise exception 'unknown voice entity %', p_entity;
  end if;
  if v_from is null then
    raise exception 'voice % % not found', p_entity, p_id;
  end if;
  if jsonb_typeof(v_evidence) <> 'object' then
    raise exception 'evidence must be a JSON object';
  end if;

  select * into v_rule from kriya.voice_allowed_transitions
  where entity = p_entity and from_status = v_from and to_status = p_to;
  if not found then
    return false;
  end if;
  if not p_actor = any (v_rule.actors) then
    raise exception '% can''t move a voice % from % to %', p_actor, p_entity, v_from, p_to;
  end if;
  foreach v_key in array v_rule.evidence loop
    if coalesce(jsonb_typeof(v_evidence -> v_key), 'null') = 'null' then
      raise exception 'voice % % -> % needs evidence %', p_entity, v_from, p_to, v_key;
    end if;
  end loop;

  -- Evidence the database must agree with
  if p_entity = 'task' then
    if p_to = 'authorized' and not exists (
      select 1 from kriya.voice_approvals
      where id = (v_evidence ->> 'approval_id')::uuid and voice_task_id = p_id
        and user_id = v_user and status = 'approved'
        and payload_hash = v_evidence ->> 'payload_hash'
    ) then
      raise exception 'the approval doesn''t match what this task is waiting for';
    end if;
    if v_from = 'in_progress' and p_to = 'awaiting_report' and not exists (
      select 1 from kriya.call_attempts a
      join kriya.voice_calls c on c.id = a.voice_call_id
      left join kriya.call_outcomes o on o.call_attempt_id = a.id
      where a.id = (v_evidence ->> 'attempt_id')::uuid and c.voice_task_id = p_id
        and c.kind = 'outreach' and a.verified_at is not null
        and a.attempt = (select max(l.attempt) from kriya.call_attempts l
                         where l.voice_call_id = c.id)
        and (o.verifier_status = 'accepted' or c.status = 'exhausted')
    ) then
      raise exception 'awaiting_report needs the last outreach attempt as a verified attempt with an accepted outcome';
    end if;
    if p_to = 'completed' and exists (
      select 1 from kriya.voice_tasks where id = p_id and report_requested
    ) and not exists (
      select 1 from kriya.voice_calls
      where id = (v_evidence ->> 'voice_call_id')::uuid and voice_task_id = p_id
        and kind = 'owner_report' and delivered_at is not null
    ) then
      raise exception 'completed needs a delivered report call';
    end if;
    if p_to = 'unreported' and not exists (
      select 1 from kriya.voice_calls
      where id = (v_evidence ->> 'voice_call_id')::uuid and voice_task_id = p_id
        and kind = 'owner_report' and status = 'exhausted'
    ) then
      raise exception 'unreported needs the exhausted report call';
    end if;
    if p_to = 'cancelled' then
      if not exists (
        select 1 from kriya.voice_tasks where id = p_id and cancel_requested_at is not null
      ) then
        raise exception 'cancel wasn''t requested for this task';
      end if;
      if exists (
        select 1 from kriya.call_attempts a join kriya.voice_calls c on c.id = a.voice_call_id
        where c.voice_task_id = p_id
          and a.status in ('requested', 'initiated', 'ringing', 'answered', 'connected')
      ) then
        raise exception 'a call for this task is still live; hang up first';
      end if;
    end if;
  elsif p_entity = 'call' then
    if p_to = 'canceled' and not exists (
      select 1 from kriya.voice_calls where id = p_id and cancel_requested_at is not null
    ) then
      raise exception 'cancel wasn''t requested for this call';
    end if;
    -- D-22: an outreach call goes round again only when its last attempt,
    -- verified, reached voicemail or a network message (nobody spoke)
    if v_from = 'settled' and not exists (
      select 1 from kriya.voice_calls
      where id = p_id and kind = 'owner_report' and delivered_at is null
    ) and not exists (
      select 1 from kriya.voice_calls c
      join kriya.call_attempts a on a.voice_call_id = c.id
      where c.id = p_id and c.kind = 'outreach'
        and a.end_reason = 'voicemail' and a.verified_at is not null
        and a.attempt = (select max(l.attempt) from kriya.call_attempts l
                         where l.voice_call_id = c.id)
    ) then
      raise exception 'only an undelivered owner report, or an outreach call that reached voicemail, goes round again';
    end if;
  end if;

  perform set_config('kriya.transition', 'on', true);
  if p_entity = 'task' then
    update kriya.voice_tasks set
      status = p_to,
      result = case when p_to in ('completed', 'unreported') then v_evidence ->> 'result' else result end,
      approval_id = case when p_to = 'authorized' then (v_evidence ->> 'approval_id')::uuid else approval_id end,
      authorized_at = case when p_to = 'authorized' then now() else authorized_at end,
      error_code = case when p_to = 'failed' then v_evidence ->> 'error_code' else error_code end,
      finished_at = case when p_to in ('completed', 'unreported', 'failed', 'cancelled', 'expired')
        then now() else finished_at end
    where id = p_id;
  elsif p_entity = 'call' then
    update kriya.voice_calls set
      status = p_to,
      last_error_code = coalesce(v_evidence ->> 'error_code', last_error_code)
    where id = p_id;
  else
    update kriya.call_attempts set
      status = p_to,
      provider_call_id = coalesce(provider_call_id, v_evidence ->> 'provider_call_id'),
      requested_at = case when p_to = 'requested' then coalesce(requested_at, now()) else requested_at end,
      initiated_at = case when p_to = 'initiated' then coalesce(initiated_at, now()) else initiated_at end,
      ringing_at = case when p_to = 'ringing' then coalesce(ringing_at, now()) else ringing_at end,
      answered_at = case when p_to = 'answered' then coalesce(answered_at, now()) else answered_at end,
      connected_at = case when p_to = 'connected' then coalesce(connected_at, now()) else connected_at end,
      ended_at = case when p_to in ('ended', 'busy', 'no_answer', 'rejected', 'failed', 'canceled')
        then coalesce(ended_at, now()) else ended_at end
    where id = p_id;
  end if;
  perform set_config('kriya.transition', 'off', true);

  insert into kriya.voice_transitions
    (user_id, voice_task_id, entity, entity_id, from_status, to_status, actor, evidence)
  values (v_user, v_task, p_entity, p_id, v_from, p_to, p_actor, v_evidence);
  return true;
end $$;

revoke all on function kriya.voice_transition(text, uuid, text, text, jsonb) from public;
