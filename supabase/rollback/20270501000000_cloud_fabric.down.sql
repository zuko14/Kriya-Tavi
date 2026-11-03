-- Reverses 20270501000000_cloud_fabric.sql. Refuses while any workspace or
-- session names the 'selfhosted' provider, so nothing is lost: drain the
-- nodes and let the janitor close those workspaces first
-- (SELF_HOSTED_OPERATIONS_RUNBOOK §8).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270501000000_cloud_fabric.down.sql

do $$
begin
  if exists (select 1 from kriya.workspaces where provider = 'selfhosted')
     or exists (select 1 from kriya.workspace_sessions where provider = 'selfhosted') then
    raise exception 'selfhosted workspaces or sessions still exist; close them before this rollback';
  end if;
end $$;

drop function kriya.exec_metrics();
drop function kriya.exec_admit(bigint, jsonb);
drop function kriya.exec_request(uuid, uuid, integer, integer, integer, integer, text, bigint, integer, jsonb);
drop table kriya.exec_leases;
drop table kriya.exec_nodes;
drop table kriya.exec_state;
drop function kriya.exec_bump();

alter table kriya.workspaces drop constraint workspaces_provider_check;
alter table kriya.workspaces add constraint workspaces_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device'));

alter table kriya.workspace_sessions drop constraint workspace_sessions_provider_check;
alter table kriya.workspace_sessions add constraint workspace_sessions_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device'));

delete from supabase_migrations.schema_migrations where version = '20270501000000';
