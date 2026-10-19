-- Reverses 20261113000000_radar_watch.sql. Watcher states, obligations and
-- public facts are deleted; watcher schedules end. Switch agents.watchers,
-- agents.radar and agents.facts off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261113000000_radar_watch.down.sql

drop table if exists kriya.public_facts;
drop function if exists kriya.public_facts_guard();
drop table if exists kriya.fact_sources;
drop table if exists kriya.obligations;
delete from kriya.allowed_transitions where entity = 'obligation';
drop table if exists kriya.watch_state;

-- Watchers can't exist without their config: their schedules go
delete from kriya.schedules where kind = 'watch';
alter table kriya.schedules drop constraint if exists schedules_watch_check;
alter table kriya.schedules drop column if exists watch;
update kriya.schedule_runs set outcome = 'failed', error = 'rolled back'
  where outcome = 'unchanged';
alter table kriya.schedule_runs drop constraint schedule_runs_outcome_check;
alter table kriya.schedule_runs add constraint schedule_runs_outcome_check check (outcome in
  ('claimed', 'enqueued', 'skipped_active', 'skipped_limit', 'skipped_budget', 'failed'));

delete from supabase_migrations.schema_migrations where version = '20261113000000';
