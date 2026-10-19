-- Reverses 20261101000003_goals_schedules.sql. Goals, schedules, their
-- runs, approval index rows and episodes (receipts) are deleted; tasks and
-- messages they produced stay. Pause every schedule and unset
-- KRIYA_SCHEDULES_ENABLED first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261101000003_goals_schedules.down.sql

drop table if exists kriya.episodes;
drop function if exists kriya.episodes_guard();
drop table if exists kriya.approvals;
drop table if exists kriya.schedule_runs;
drop table if exists kriya.schedules;
drop table if exists kriya.goals;
drop function if exists kriya.check_transition();
drop table if exists kriya.allowed_transitions;
alter table kriya.tool_executions drop column if exists verification;
alter table kriya.plans
  drop column if exists max_goals,
  drop column if exists max_schedules,
  drop column if exists min_schedule_interval_minutes;
delete from supabase_migrations.schema_migrations where version = '20261101000003';
