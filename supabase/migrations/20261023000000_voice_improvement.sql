-- Governed improvement loop (voice phase 10, D-17, SELF_IMPROVEMENT.md §4).
--
-- Policy versions, per-attempt signals, the owner's corrections and the
-- weekly cases. Signals are numbers and codes only, so they may outlive
-- transcripts and attempts. No foreign key points at a voice table: these
-- rows must survive an attempt's deletion, and such a key would stop the
-- voice core's own rollback (T-MIG-01). Like every voice row they're scoped
-- by user id.

-- Candidate and live behaviour bundles. v1 lives in code
-- (lib/voice/policy/v1.ts) and is the parent of the first stored version.
-- Never selectable by a person's session
create table kriya.voice_policy_versions (
  id text primary key check (id ~ '^v[0-9][a-z0-9.-]*$' and char_length(id) <= 40),
  parent_id text not null default 'v1' check (char_length(parent_id) <= 40),
  bundle jsonb not null,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'draft'
    check (status in ('draft', 'shadow', 'canary', 'active', 'retired', 'rolled_back')),
  canary_percent integer not null default 0 check (canary_percent between 0 and 100),
  -- The voice_cases it targets
  targets uuid[] not null default '{}',
  eval_report jsonb,
  shadow_report jsonb,
  proposed_by text not null check (char_length(proposed_by) between 1 and 120),
  approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active and one canary at a time
create unique index voice_policy_versions_one_active on kriya.voice_policy_versions ((true))
  where status = 'active';
create unique index voice_policy_versions_one_canary on kriya.voice_policy_versions ((true))
  where status = 'canary';
create trigger voice_policy_versions_touch before update on kriya.voice_policy_versions
  for each row execute function kriya.touch_updated_at();

-- One row per verified attempt (§3.1). Null means not measured, never zero
create table kriya.attempt_metrics (
  call_attempt_id uuid primary key,
  user_id uuid references auth.users (id) on delete set null,
  policy_version text not null check (char_length(policy_version) <= 40),
  kind text not null check (kind in ('outreach', 'owner_report', 'verification')),
  attempt_status text not null,
  end_reason text,
  connected boolean not null,
  verifier_status text,
  result text,
  disclosure_played boolean,
  turns integer check (turns >= 0),
  low_conf_turns integer check (low_conf_turns >= 0),
  bargeins integer check (bargeins >= 0),
  latency_p50_ms integer check (latency_p50_ms >= 0),
  latency_p95_ms integer check (latency_p95_ms >= 0),
  opt_out boolean not null default false,
  wrong_person boolean not null default false,
  billable_seconds integer check (billable_seconds >= 0),
  cost_micro_inr bigint,
  created_at timestamptz not null default now()
);
create index attempt_metrics_version_idx on kriya.attempt_metrics (policy_version, created_at);
create index attempt_metrics_user_idx on kriya.attempt_metrics (user_id);

-- The owner's corrections of a checked outcome (§3.2)
create table kriya.voice_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  call_attempt_id uuid not null,
  field text not null
    check (field in ('result', 'agreed_times', 'proposed_times', 'questions', 'other')),
  was text check (char_length(was) <= 500),
  should_be text check (char_length(should_be) <= 500),
  source text not null check (source in ('app', 'voice')),
  created_at timestamptz not null default now()
);
create index voice_feedback_attempt_idx on kriya.voice_feedback (call_attempt_id);
create index voice_feedback_user_idx on kriya.voice_feedback (user_id, created_at desc);

-- Weekly cases from signals and feedback, one code from the fixed taxonomy
-- (§3.3). Severity 1 pauses a canary and rolls back an active version
create table kriya.voice_cases (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code in (
    'false_agreement', 'missed_proposal', 'wrong_time_parse', 'ambiguity_not_asked',
    'stt_entity_error', 'tts_mispronunciation', 'talked_over', 'slow_response',
    'invalid_tool_call', 'disclosure_issue', 'injection_attempt', 'sensitive_request',
    'wrong_person_handling', 'report_not_delivered', 'provider_mismatch', 'cost_overrun',
    'provider_drift', 'other')),
  severity smallint not null check (severity between 1 and 3),
  status text not null default 'open' check (status in ('open', 'fixed', 'wontfix')),
  policy_version text not null check (char_length(policy_version) <= 40),
  -- Monday of the week the signals came from (IST)
  week date not null,
  attempt_ids uuid[] not null default '{}',
  scenario_ids text[] not null default '{}',
  fixed_in_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, policy_version, week)
);
create trigger voice_cases_touch before update on kriya.voice_cases
  for each row execute function kriya.touch_updated_at();

-- The owner's consent to let Kriya review their call content to improve
-- Tavi (§6). Off by default; content is used only after counsel (Q11)
alter table kriya.voice_profiles
  add column improvement_opt_in boolean not null default false;
grant update (improvement_opt_in) on kriya.voice_profiles to authenticated;

alter table kriya.voice_policy_versions enable row level security;
alter table kriya.attempt_metrics enable row level security;
alter table kriya.voice_feedback enable row level security;
alter table kriya.voice_cases enable row level security;

-- Policy versions and cases: no policy, no grant (the console reads them
-- with its own role check). A person sees their own signals and corrections,
-- and corrects only their own attempts
create policy read_own on kriya.attempt_metrics for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.attempt_metrics to authenticated;

create policy read_own on kriya.voice_feedback for select to authenticated
  using (user_id = (select auth.uid()));
create policy insert_own on kriya.voice_feedback for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from kriya.call_attempts a
      where a.id = call_attempt_id and a.user_id = (select auth.uid()))
  );
grant select on kriya.voice_feedback to authenticated;
grant insert (user_id, call_attempt_id, field, was, should_be, source)
  on kriya.voice_feedback to authenticated;
