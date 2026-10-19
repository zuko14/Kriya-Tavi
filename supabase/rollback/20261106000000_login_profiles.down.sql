-- Reverses 20261106000000_login_profiles.sql. Login profiles (and their
-- sealed state) and kits are deleted; switch agents.loginProfiles and
-- agents.kits off first. Browser session records stay (A4's table).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261106000000_login_profiles.down.sql

drop table if exists kriya.kits;
drop function if exists kriya.open_login_session(uuid, uuid, uuid, text);
alter table if exists kriya.browser_sessions
  drop constraint if exists browser_sessions_login_profile_fk;
drop table if exists kriya.login_profiles;
drop function if exists kriya.login_profiles_within_plan();
delete from kriya.allowed_transitions where entity = 'login_profile';
alter table kriya.plans drop column if exists max_login_profiles;
delete from supabase_migrations.schema_migrations where version = '20261106000000';
