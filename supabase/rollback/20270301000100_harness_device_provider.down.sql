-- Reverses 20270301000100_harness_device_provider.sql. Refuses while any
-- workspace or session names the 'device' provider, so nothing is lost: close
-- those workspaces first (switch cloud.provider away from device and let the
-- janitor close them, or delete them deliberately).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270301000100_harness_device_provider.down.sql

do $$
begin
  if exists (select 1 from kriya.workspaces where provider = 'device')
     or exists (select 1 from kriya.workspace_sessions where provider = 'device') then
    raise exception 'device workspaces or sessions still exist; close them before this rollback';
  end if;
end $$;

alter table kriya.workspaces drop constraint workspaces_provider_check;
alter table kriya.workspaces add constraint workspaces_provider_check
  check (provider in ('local', 'e2b', 'daytona'));

alter table kriya.workspace_sessions drop constraint workspace_sessions_provider_check;
alter table kriya.workspace_sessions add constraint workspace_sessions_provider_check
  check (provider in ('local', 'e2b', 'daytona'));

delete from supabase_migrations.schema_migrations where version = '20270301000100';
