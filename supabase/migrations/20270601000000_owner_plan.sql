-- The platform owner is never asked to pay (owner, 2026-11-03: "for owners
-- also the kriya tavi and the kriya harness was asking to pay, remove the
-- limits to the owners"). An internal plan, `owner`, never sold (inactive,
-- unpriced, not the default), with every model tier and plan limits far
-- beyond any real use; kriya.effective_plan_id returns it for users whose
-- platform role is owner, ahead of any subscription. Every limit already
-- resolves the plan through that function (the app's tasks, goals,
-- schedules, files and skills, and the harness cap in
-- kriya.reserve_harness_spend), so owners pass all of them while their
-- usage is still metered and recorded. Who is an owner comes only from
-- kriya.platform_roles, which no session can write.
--
-- Not raised here, each having its own owner gate: voice (live calls stay
-- behind KRIYA_VOICE_LIVE and the allow-lists), login profiles (AD-05) and
-- the concurrent-answers limit of the harness (HD-16).

insert into kriya.plans (
  id, name, description, price_monthly_paise, included_usage_micro_inr, markup_bps,
  max_agents, max_concurrent_tasks, max_tasks_per_day, max_task_seconds, max_steps,
  max_task_cost_micro_usd, allowed_tiers, browser_minutes, max_goals, max_schedules,
  min_schedule_interval_minutes, max_skills, max_file_mb, storage_mb, max_shares,
  ledger_enabled, overage_allowed, overage_cap_micro_inr, workspace_minutes,
  harness_monthly_micro_inr, is_default, active, sort
) values (
  'owner', 'Owner', 'The platform owner: every model tier and no plan limits. Never sold.',
  null, 1000000000000000, 10000,
  1000, 8, 100000, 3600, 200,
  100000000000, '{budget,balanced,escalation}', 100000, 1000, 1000,
  60, 1000, 100, 100000, 1000,
  true, true, 1000000000000000, 100000,
  1000000000000000, false, false, 1000
) on conflict (id) do nothing;

create or replace function kriya.effective_plan_id(uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    -- The platform owner, while the owner plan exists
    (select p.id from kriya.platform_roles r
      join kriya.plans p on p.id = 'owner'
      where r.user_id = uid and r.role = 'owner'),
    (select s.plan_id from kriya.subscriptions s
      join kriya.plans p on p.id = s.plan_id
      where s.user_id = uid
        and s.status in ('active', 'past_due')
        and (s.current_period_end is null or s.current_period_end > now())
      order by s.created_at desc limit 1),
    (select id from kriya.plans where is_default limit 1)
  )
$$;
