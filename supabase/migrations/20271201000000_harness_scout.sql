-- Harness 2.0, W7: the R&D Scout's own tables (docs/kriya-harness/upgrade_2.0/
-- SELF_EVOLUTION.md §2, DATA_MODEL_AND_CONTRACTS.md §1–2; WD-07, WD-14).
-- Platform tables: no person's data, read and written only by server code
-- after requireOwner() or by the scheduler step, never by a client role
-- (server_only policies). The candidate, version and outcome tables come with
-- W9 and W11 in their own migrations. Off (harness.scout, the default) none
-- of this is read or written.

/* ───────────────────────────── spend ────────────────────────────── */

alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch', 'skill_design',
  'workspace_seconds', 'workspace_storage_bytes', 'flow_design', 'edit_preview_bytes',
  'scout_model'
));

-- One scout model call, reserved before it is sent: refused (false) when this
-- calendar month's scout spend (India time) plus the estimate would pass the
-- cap; a cap of 0 refuses everything (WD-14's default). Serialized, so two
-- reservations at the edge can't both pass. Settled later by request_key.
create function kriya.reserve_scout_spend(
  p_request_key text, p_estimate_micro_usd bigint, p_cap_micro_usd bigint
) returns boolean language plpgsql set search_path = '' as $$
declare
  v_used bigint;
begin
  if p_cap_micro_usd is null or p_cap_micro_usd <= 0 or p_estimate_micro_usd is null or p_estimate_micro_usd < 0 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('harness_scout_spend'));
  select coalesce(sum(cost_micro_usd), 0) into v_used from kriya.resource_usage
    where kind = 'scout_model'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used + p_estimate_micro_usd > p_cap_micro_usd then
    return false;
  end if;
  insert into kriya.resource_usage (request_key, kind, quantity, cost_micro_usd)
    values (p_request_key, 'scout_model', 1, p_estimate_micro_usd);
  return true;
end $$;
revoke all on function kriya.reserve_scout_spend(text, bigint, bigint) from public, anon, authenticated;

/* ───────────────────────────── tables ───────────────────────────── */

create table kriya.harness_scout_sources (
  id uuid primary key default gen_random_uuid(),
  discipline text not null check (discipline in (
    'frontend', 'designer', 'backend', 'fullstack', 'mobile', 'game', 'devops', 'cloud',
    'systems', 'data', 'ml', 'security', 'qa', 'sdet', 'database'
  )),
  -- (Postgres caps a regex repetition at 255, so the length is its own check)
  url text not null unique check (char_length(url) between 12 and 500 and url ~ '^https://[^[:space:]]+$'),
  kind text not null check (kind in ('changelog', 'advisory', 'standard', 'paper_feed', 'guideline')),
  active boolean not null default true,
  last_hash text check (last_hash is null or last_hash ~ '^[a-f0-9]{64}$'),
  -- sha256 of each paragraph of the last fetch, so the next keeps only new ones
  last_paragraphs text[] not null default '{}' check (cardinality(last_paragraphs) <= 500),
  last_fetched_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table kriya.harness_scout_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'cap_reached', 'frozen')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sources_fetched int not null default 0 check (sources_fetched >= 0),
  findings int not null default 0 check (findings >= 0),
  error text check (char_length(error) <= 500)
);
-- The lease: at most one running run
create unique index harness_scout_one_running on kriya.harness_scout_runs ((true)) where status = 'running';
create index harness_scout_runs_recent on kriya.harness_scout_runs (finished_at desc nulls first);

-- What one run did with one source: the content hash, the changed paragraphs
-- (kept 30 days), and whether the source still has a step to do
create table kriya.harness_scout_snapshots (
  run_id uuid not null references kriya.harness_scout_runs (id) on delete cascade,
  source_id uuid not null references kriya.harness_scout_sources (id) on delete cascade,
  hash text check (hash is null or hash ~ '^[a-f0-9]{64}$'),
  changed_text text check (char_length(changed_text) <= 4000),
  stage text not null default 'fetched' check (stage in ('fetched', 'unchanged', 'distilled', 'failed', 'skipped')),
  fetched_at timestamptz not null default now(),
  primary key (run_id, source_id)
);

create table kriya.harness_scout_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references kriya.harness_scout_runs (id) on delete cascade,
  source_id uuid not null references kriya.harness_scout_sources (id) on delete cascade,
  discipline text not null,
  kind text not null check (kind in ('practice', 'deprecation', 'vulnerability_class', 'tool_change', 'idea')),
  claim text not null check (char_length(claim) between 1 and 300),
  quote text not null check (char_length(quote) between 1 and 400),
  quote_hash text not null check (quote_hash ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz not null default now(),
  -- A second fetch at least an hour later still had the quote
  confirmed_at timestamptz,
  corroborated boolean not null default false,
  status text not null default 'new' check (status in ('new', 'confirmed', 'drafted', 'idea', 'dropped')),
  unique (discipline, quote_hash)
);

do $$
declare t text;
begin
  foreach t in array array['harness_scout_sources', 'harness_scout_runs', 'harness_scout_snapshots', 'harness_scout_findings'] loop
    execute format('alter table kriya.%I enable row level security', t);
    execute format(
      'create policy server_only on kriya.%I for all to anon, authenticated
         using (false) with check (false)', t);
  end loop;
end $$;
