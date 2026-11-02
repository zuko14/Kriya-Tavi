-- Reverses 20270301000200_harness_open_cap.sql: reserve_harness_spend as
-- 20270301000000 defined it (the open-answers limit back in application code
-- only). Data is untouched.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270301000200_harness_open_cap.down.sql

create or replace function kriya.reserve_harness_spend(
  p_user uuid, p_device uuid, p_request_key text, p_tier text, p_model text,
  p_estimate_micro_inr bigint
) returns void language plpgsql set search_path = '' as $$
declare
  v_cap bigint;
  v_used bigint;
  v_plan text;
begin
  v_plan := kriya.effective_plan_id(p_user);
  select harness_monthly_micro_inr into v_cap from kriya.plans where id = v_plan;
  if coalesce(v_cap, 0) = 0 then
    raise exception 'harness not in plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('harness:' || p_user::text));
  select coalesce(sum(case when status = 'reserved' then reserved_micro_inr
                           else coalesce(charge_micro_inr, reserved_micro_inr) end), 0)
    into v_used from kriya.harness_usage
    where user_id = p_user and status <> 'failed'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used + p_estimate_micro_inr > v_cap then
    raise exception 'harness cap reached';
  end if;
  insert into kriya.harness_usage (request_key, user_id, device_id, plan_id, tier, model, reserved_micro_inr)
    values (p_request_key, p_user, p_device, v_plan, p_tier, p_model, p_estimate_micro_inr);
end $$;
revoke all on function kriya.reserve_harness_spend(uuid, uuid, text, text, text, bigint)
  from public, anon, authenticated;

delete from supabase_migrations.schema_migrations where version = '20270301000200';
