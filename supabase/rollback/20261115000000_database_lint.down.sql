-- Reverses 20261115000000_database_lint.sql: the functions follow the
-- caller's search_path again and the explicit server-only policies go (the
-- tables stay closed to client roles: RLS stays on, with no policy).
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261115000000_database_lint.down.sql

alter function kriya.check_transition() reset search_path;
alter function kriya.episodes_guard() reset search_path;
alter function kriya.financial_year(date) reset search_path;
alter function kriya.invoices_guard() reset search_path;
alter function kriya.issue_invoice(uuid) reset search_path;
alter function kriya.ledger_entries_guard() reset search_path;
alter function kriya.open_browser_session(uuid, uuid, text) reset search_path;
alter function kriya.open_login_session(uuid, uuid, uuid, text) reset search_path;
alter function kriya.policy_versions_frozen() reset search_path;
alter function kriya.public_facts_guard() reset search_path;
alter function kriya.share_links_guard() reset search_path;
alter function kriya.touch_updated_at() reset search_path;
alter function kriya.voice_status_guard() reset search_path;
alter function kriya.voice_transitions_frozen() reset search_path;

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
    execute format('drop policy if exists server_only on kriya.%I', t);
  end loop;
end $$;

delete from supabase_migrations.schema_migrations where version = '20261115000000';
