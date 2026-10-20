-- Supabase database advisors (2026-10-20). Two security lints; neither
-- changes who can read or write what.
--
-- 0011 function_search_path_mutable: every function below resolved names
-- through the caller's search_path. Each body already names its tables as
-- kriya.* and uses only built-ins (always found in pg_catalog), so an empty
-- search_path changes nothing but takes the caller's path out of play.
--
-- 0008 rls_enabled_no_policy: these tables are server-only by design
-- (the worker, webhooks and the owner console use the privileged role,
-- which bypasses RLS). With RLS on and no policy, the client roles already
-- see nothing; the policy below says so explicitly. It's permissive, so a
-- deliberate policy added later still works.

alter function kriya.check_transition() set search_path = '';
alter function kriya.episodes_guard() set search_path = '';
alter function kriya.financial_year(date) set search_path = '';
alter function kriya.invoices_guard() set search_path = '';
alter function kriya.issue_invoice(uuid) set search_path = '';
alter function kriya.ledger_entries_guard() set search_path = '';
alter function kriya.open_browser_session(uuid, uuid, text) set search_path = '';
alter function kriya.open_login_session(uuid, uuid, uuid, text) set search_path = '';
alter function kriya.policy_versions_frozen() set search_path = '';
alter function kriya.public_facts_guard() set search_path = '';
alter function kriya.share_links_guard() set search_path = '';
alter function kriya.touch_updated_at() set search_path = '';
alter function kriya.voice_status_guard() set search_path = '';
alter function kriya.voice_transitions_frozen() set search_path = '';

do $$
declare t text;
begin
  foreach t in array array[
    'audit_events', 'billing_events', 'call_suppressions', 'fact_sources',
    'maintenance_jobs', 'models', 'phone_verifications', 'platform_roles',
    'platform_settings', 'policy_task_versions', 'policy_versions', 'rate_limits',
    'voice_access', 'voice_allowed_transitions', 'voice_cases', 'voice_policy_versions',
    'voice_prices', 'workers'
  ] loop
    execute format(
      'create policy server_only on kriya.%I for all to anon, authenticated
         using (false) with check (false)', t);
  end loop;
end $$;
