-- Editing Studio (track E, ED15): which revision a sent note belongs to, and more than
-- one short clip per job, so a decision card can offer two takes.

alter table kriya.edit_notes add column sent_in uuid references kriya.edit_jobs (id) on delete set null;
create index edit_notes_sent_idx on kriya.edit_notes (sent_in) where sent_in is not null;
-- Sending notes is the person's own act, so it stays under their session
grant update (sent_in) on kriya.edit_notes to authenticated;

create or replace function kriya.reserve_edit_preview(
  p_user uuid, p_device uuid, p_job uuid, p_kind text, p_bytes bigint, p_sha256 text,
  p_duration_flicks bigint, p_max_bytes bigint, p_days integer
) returns table (id uuid, storage_path text) language plpgsql set search_path = '' as $$
declare
  v_cap bigint;
  v_used bigint;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_row kriya.edit_deliverables;
begin
  if not exists (
    select 1 from kriya.edit_jobs j
    where j.id = p_job and j.user_id = p_user and j.device_id = p_device
      and j.status in ('queued', 'running', 'lost')
  ) then
    raise exception 'edit job not open';
  end if;
  if p_bytes > p_max_bytes then
    raise exception 'edit preview too large';
  end if;
  select editing_preview_bytes into v_cap from kriya.plans
    where kriya.plans.id = kriya.effective_plan_id(p_user);
  if coalesce(v_cap, 0) = 0 then
    raise exception 'edit previews not in plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('edit_preview:' || p_user::text));
  -- The same file asked for again gets its own row back, so a retry costs nothing
  select * into v_row from kriya.edit_deliverables d
    where d.job_id = p_job and d.kind = p_kind and d.deleted_at is null
      and d.status = 'pending' and d.sha256 = p_sha256 and d.bytes = p_bytes;
  if found then
    return query select v_row.id, v_row.storage_path;
    return;
  end if;
  -- One of each kind; a job may offer several clips, and the plan's room still counts them
  if p_kind <> 'clip' and exists (
    select 1 from kriya.edit_deliverables d
    where d.job_id = p_job and d.kind = p_kind and d.deleted_at is null
      and d.status in ('pending', 'ready')
  ) then
    raise exception 'edit preview exists';
  end if;
  select coalesce(sum(d.bytes), 0) into v_used from kriya.edit_deliverables d
    where d.user_id = p_user and d.deleted_at is null and d.status in ('pending', 'ready');
  if v_used + p_bytes > v_cap then
    raise exception 'edit preview cap reached';
  end if;
  v_path := p_user::text || '/' || p_job::text || '/' || v_id::text;
  insert into kriya.edit_deliverables
    (id, job_id, user_id, kind, storage_path, bytes, sha256, duration_flicks, expires_at)
    values (v_id, p_job, p_user, p_kind, v_path, p_bytes, p_sha256, p_duration_flicks,
            now() + make_interval(days => p_days));
  return query select v_id, v_path;
end $$;
revoke all on function kriya.reserve_edit_preview(uuid, uuid, uuid, text, bigint, text, bigint, bigint, integer)
  from public, anon, authenticated;
