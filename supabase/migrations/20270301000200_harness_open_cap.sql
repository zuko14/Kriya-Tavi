-- Kriya Harness (track H, re-audit 2026-11-02, invariant 7): the concurrent
-- answers a person may have open (HD-16, 3) are counted in SQL, under the
-- same per-person lock as the monthly cap, so parallel requests can't pass a
-- check made outside it. A reservation older than 15 minutes is abandoned
-- (the janitor estimates it) and doesn't count. Same signature and grants.

create or replace function kriya.reserve_harness_spend(
  p_user uuid, p_device uuid, p_request_key text, p_tier text, p_model text,
  p_estimate_micro_inr bigint
) returns void language plpgsql set search_path = '' as $$
declare
  v_cap bigint;
  v_used bigint;
  v_plan text;
  v_open integer;
begin
  v_plan := kriya.effective_plan_id(p_user);
  select harness_monthly_micro_inr into v_cap from kriya.plans where id = v_plan;
  if coalesce(v_cap, 0) = 0 then
    raise exception 'harness not in plan';
  end if;
  perform pg_advisory_xact_lock(hashtext('harness:' || p_user::text));
  select count(*) into v_open from kriya.harness_usage
    where user_id = p_user and status = 'reserved'
      and created_at > now() - interval '15 minutes';
  if v_open >= 3 then
    raise exception 'harness too many open';
  end if;
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
