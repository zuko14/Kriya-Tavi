-- Restores the one-of-each-kind limit; extra clips stay until their expiry
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
  select * into v_row from kriya.edit_deliverables d
    where d.job_id = p_job and d.kind = p_kind and d.deleted_at is null
      and d.status in ('pending', 'ready')
    limit 1;
  if found then
    if v_row.status = 'pending' and v_row.sha256 = p_sha256 and v_row.bytes = p_bytes then
      return query select v_row.id, v_row.storage_path;
      return;
    end if;
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
revoke update (sent_in) on kriya.edit_notes from authenticated;
alter table kriya.edit_notes drop column sent_in;
delete from supabase_migrations.schema_migrations where version = '20271103000000';
