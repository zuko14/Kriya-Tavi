-- Reverses 20270601000000_owner_plan.sql: effective_plan_id as
-- 20261016000000 defined it, and the owner plan removed unless something
-- still names it (a subscription, a task, a voice task, a charge or a
-- harness usage row); then it stays, inactive, and owners simply stop
-- getting it.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270601000000_owner_plan.down.sql

create or replace function kriya.effective_plan_id(uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.plan_id from kriya.subscriptions s
      join kriya.plans p on p.id = s.plan_id
      where s.user_id = uid
        and s.status in ('active', 'past_due')
        and (s.current_period_end is null or s.current_period_end > now())
      order by s.created_at desc limit 1),
    (select id from kriya.plans where is_default limit 1)
  )
$$;

delete from kriya.plans p
where p.id = 'owner'
  and not exists (select 1 from kriya.subscriptions s where s.plan_id = p.id)
  and not exists (select 1 from kriya.tasks t where t.plan_id = p.id)
  and not exists (select 1 from kriya.voice_tasks t where t.plan_id = p.id)
  and not exists (select 1 from kriya.charges c where c.plan_id = p.id)
  and not exists (select 1 from kriya.voice_charges c where c.plan_id = p.id)
  and not exists (select 1 from kriya.harness_usage u where u.plan_id = p.id);
