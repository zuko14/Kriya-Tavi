-- Kriya Harness (track H, H10, HD-12, PX-06): a person's own machine running
-- `kriya serve` as the execution world of a cloud workspace. Widens track C's
-- provider checks with 'device' (drop and recreate, the resource_usage
-- precedent); nothing else changes, and existing rows already satisfy the
-- wider check.

alter table kriya.workspaces drop constraint workspaces_provider_check;
alter table kriya.workspaces add constraint workspaces_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device'));

alter table kriya.workspace_sessions drop constraint workspace_sessions_provider_check;
alter table kriya.workspace_sessions add constraint workspace_sessions_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device'));
