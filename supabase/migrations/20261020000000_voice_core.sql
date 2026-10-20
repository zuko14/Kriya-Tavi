-- Voice assistant core (voice phase 1, docs/voice-assistant/DATA_MODEL_AND_STATE_MACHINES.md).
--
-- Voice tasks, the calls planned for them and each dial, with what the
-- provider and each side said, the structured outcome, cost, and an
-- append-only audit of every state change. Nothing calls these yet.
--
-- Status changes go only through kriya.voice_transition() (D-06): it checks
-- kriya.voice_allowed_transitions, the actor and the evidence, then writes
-- the change and its audit row. People have no update grant on these tables;
-- a trigger refuses any other status change, even from the privileged role.
-- Composite foreign keys that set null name their column (F1), so deleting a
-- thread or a parent task never nulls user_id.

/* ───────────────────────────── access ───────────────────────────── */

-- The voice allow-list (D-12): written from the owner console only
create table kriya.voice_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  test_numbers_only boolean not null default true,
  created_at timestamptz not null default now()
);

-- The owner's verified number and call preferences
create table kriya.voice_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Set only by the verification flow (D-13)
  owner_phone_e164 text check (owner_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  owner_phone_verified_at timestamptz,
  timezone text not null default 'Asia/Kolkata' check (char_length(timezone) <= 64),
  language text not null default 'en-IN' check (char_length(language) <= 16),
  -- Owner calls never start inside these hours
  quiet_start time not null default '21:30',
  quiet_end time not null default '08:00',
  report_mode text not null default 'scheduled'
    check (report_mode in ('scheduled', 'on_completion')),
  report_max_attempts integer not null default 3 check (report_max_attempts between 1 and 5),
  report_retry_minutes integer not null default 10 check (report_retry_minutes between 5 and 120),
  -- 0 = only the outcome is kept
  transcript_retention_days integer not null default 30
    check (transcript_retention_days between 0 and 365),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger voice_profiles_touch before update on kriya.voice_profiles
  for each row execute function kriya.touch_updated_at();

-- One-time keypad codes for verifying the owner's number. The code is an
-- HMAC made in application code (no pgcrypto)
create table kriya.phone_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text not null check (char_length(code_hash) <= 128),
  tries integer not null default 0 check (tries between 0 and 3),
  expires_at timestamptz not null,
  verified_at timestamptz,
  -- The verification call (voice phase 6)
  voice_call_id uuid,
  created_at timestamptz not null default now()
);
create index phone_verifications_user_idx on kriya.phone_verifications (user_id, created_at desc);

/* ───────────────────────────── tasks ────────────────────────────── */

create table kriya.voice_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- A follow-up of another task (D-09)
  parent_task_id uuid,
  -- Where it was asked, if from a thread
  thread_id text,
  status text not null default 'draft' check (status in (
    'draft', 'awaiting_confirmation', 'authorized', 'in_progress', 'needs_owner',
    'awaiting_report', 'completed', 'unreported', 'failed', 'cancelled', 'expired')),
  -- What happened, set with the terminal transition. completed means the
  -- owner was told, not that the callee agreed
  result text check (result in (
    'agreed', 'alternative_proposed', 'declined', 'no_answer', 'busy',
    'wrong_person', 'unclear', 'call_failed')),
  language text not null default 'en-IN' check (char_length(language) <= 16),
  -- "my CA": a description, not an identity
  recipient_label text not null check (char_length(recipient_label) between 1 and 80),
  recipient_name text check (char_length(recipient_name) <= 80),
  recipient_phone_e164 text not null check (recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- HMAC of the number, for suppression and per-number limits
  recipient_phone_hash text not null check (char_length(recipient_phone_hash) <= 128),
  purpose text not null check (char_length(purpose) between 1 and 600),
  -- Objective and authority, validated by zod before insert
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  spec_version integer not null default 1 check (spec_version >= 1),
  report_at timestamptz,
  report_requested boolean not null default true,
  -- Limits copied from the plan at creation
  plan_id text not null,
  max_call_seconds integer not null check (max_call_seconds > 0),
  cost_budget_micro_inr bigint not null check (cost_budget_micro_inr > 0),
  -- The approval that authorized it
  approval_id uuid,
  cancel_requested_at timestamptz,
  idempotency_key text check (char_length(idempotency_key) <= 128),
  -- Human-readable, no provider internals
  error_code text check (char_length(error_code) <= 40),
  error text check (char_length(error) <= 500),
  authorized_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, idempotency_key),
  check (result is null or status in ('completed', 'unreported')),
  foreign key (parent_task_id, user_id) references kriya.voice_tasks (id, user_id)
    on delete set null (parent_task_id),
  foreign key (thread_id, user_id) references kriya.threads (id, user_id)
    on delete set null (thread_id)
);
create index voice_tasks_user_idx on kriya.voice_tasks (user_id, created_at desc);
create index voice_tasks_open_idx on kriya.voice_tasks (status)
  where status not in ('completed', 'unreported', 'failed', 'cancelled', 'expired');
create index voice_tasks_parent_idx on kriya.voice_tasks (parent_task_id);
create index voice_tasks_thread_idx on kriya.voice_tasks (thread_id);
create trigger voice_tasks_touch before update on kriya.voice_tasks
  for each row execute function kriya.touch_updated_at();

-- Exactly what the owner was shown and approved or declined
create table kriya.voice_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  voice_task_id uuid not null,
  kind text not null check (kind in ('outreach_call', 'follow_up_call', 'scope_change')),
  -- Number, recipient, purpose, authority, report time, calling window
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- SHA-256 of the canonical payload; the approve action sends it back
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'expired', 'superseded')),
  expires_at timestamptz not null default now() + interval '30 minutes',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (voice_task_id, user_id) references kriya.voice_tasks (id, user_id) on delete cascade
);
-- One open approval per task
create unique index voice_approvals_one_pending on kriya.voice_approvals (voice_task_id)
  where status = 'pending';

/* ───────────────────────────── calls ────────────────────────────── */

-- One planned call (to the recipient, a report to the owner, or a
-- verification call) with its schedule, retries and lease
create table kriya.voice_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  voice_task_id uuid not null,
  kind text not null check (kind in ('outreach', 'owner_report', 'verification')),
  -- (task, kind, seq) is the idempotency key
  seq integer not null check (seq >= 1),
  -- The owner's number for reports and verification, copied when scheduled
  -- and checked again at dial time
  to_phone_e164 text not null check (to_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null default 'scheduled' check (status in (
    'scheduled', 'dialing', 'in_call', 'retry_wait', 'settled', 'exhausted',
    'canceled', 'blocked', 'needs_owner')),
  not_before timestamptz not null,
  -- After this the call is exhausted
  window_end timestamptz,
  available_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts between 1 and 5),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  -- Owner reports only (D-08)
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  last_error_code text check (char_length(last_error_code) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (voice_task_id, kind, seq),
  foreign key (voice_task_id, user_id) references kriya.voice_tasks (id, user_id) on delete cascade
);
create index voice_calls_due_idx on kriya.voice_calls (available_at)
  where status in ('scheduled', 'retry_wait');
create index voice_calls_user_idx on kriya.voice_calls (user_id, created_at desc);
create trigger voice_calls_touch before update on kriya.voice_calls
  for each row execute function kriya.touch_updated_at();

-- One dial. Its id is sent to the provider (CustomField)
create table kriya.call_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  voice_call_id uuid not null,
  attempt integer not null check (attempt >= 1),
  status text not null default 'created' check (status in (
    'created', 'requested', 'initiated', 'ringing', 'answered', 'connected',
    'ended', 'busy', 'no_answer', 'rejected', 'failed', 'canceled', 'unknown')),
  -- The behaviour bundle this attempt ran on (D-17)
  policy_version text not null check (char_length(policy_version) between 1 and 40),
  -- Provenance, resolved from settings at dial time
  telephony_provider text,
  stt_provider text,
  tts_provider text,
  tts_voice text,
  llm_model text,
  provider_call_id text,
  -- SHA-256 of 32 random bytes; not granted to people
  callback_token_hash text not null check (callback_token_hash ~ '^[0-9a-f]{64}$'),
  stream_token_hash text not null check (stream_token_hash ~ '^[0-9a-f]{64}$'),
  stream_token_used_at timestamptz,
  -- Which kriya-voice instance holds the media
  stream_owner text,
  stream_heartbeat_at timestamptz,
  -- Each set once, by voice_transition()
  requested_at timestamptz,
  initiated_at timestamptz,
  ringing_at timestamptz,
  answered_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  -- callee_hangup, tavi_hangup, max_duration, voice_lost, provider, …
  end_reason text check (char_length(end_reason) <= 40),
  -- From the provider; null = not reported
  billable_seconds integer check (billable_seconds >= 0),
  -- Owner reports: mark of the final chunk (D-08)
  last_report_mark_at timestamptz,
  verified_at timestamptz,
  -- Normalized provider snapshot, redacted
  provider_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (voice_call_id, attempt),
  unique (telephony_provider, provider_call_id),
  foreign key (voice_call_id, user_id) references kriya.voice_calls (id, user_id) on delete cascade
);
create index call_attempts_user_idx on kriya.call_attempts (user_id, created_at desc);
create trigger call_attempts_touch before update on kriya.call_attempts
  for each row execute function kriya.touch_updated_at();

-- Raw provider events, deduplicated. user_id is null until correlated;
-- numbers in the payload are masked to their last 4 digits
create table kriya.call_events (
  id bigserial primary key,
  user_id uuid references auth.users (id) on delete cascade,
  call_attempt_id uuid,
  provider text not null,
  source text not null check (source in ('status_webhook', 'stream', 'verify')),
  dedupe_key text not null check (char_length(dedupe_key) <= 200),
  status text,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  payload jsonb,
  unique (provider, dedupe_key),
  foreign key (call_attempt_id, user_id) references kriya.call_attempts (id, user_id) on delete cascade
);
create index call_events_attempt_idx on kriya.call_events (call_attempt_id, received_at);

-- What each side said: final STT text and the text sent to TTS. No audio
-- is ever stored (D-10)
create table kriya.conversation_turns (
  id bigserial primary key,
  user_id uuid not null,
  call_attempt_id uuid not null,
  seq integer not null check (seq >= 0),
  speaker text not null check (speaker in ('tavi', 'callee', 'owner')),
  text text not null check (char_length(text) <= 4000),
  -- Relative to connected_at
  start_ms integer check (start_ms >= 0),
  end_ms integer check (end_ms >= 0),
  stt_confidence numeric(4, 3) check (stt_confidence between 0 and 1),
  -- Tavi's speech cut by barge-in, and how much of it was played
  interrupted boolean not null default false,
  played_ms integer check (played_ms >= 0),
  created_at timestamptz not null default now(),
  unique (call_attempt_id, seq),
  foreign key (call_attempt_id, user_id) references kriya.call_attempts (id, user_id) on delete cascade
);

-- The structured outcome: what was observed (provider and media stream)
-- kept apart from what the model interpreted, and the verifier's verdict
create table kriya.call_outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  call_attempt_id uuid not null unique,
  voice_task_id uuid not null,
  schema_version integer not null default 1 check (schema_version >= 1),
  observed jsonb not null check (jsonb_typeof(observed) = 'object'),
  interpreted jsonb,
  extraction_model text,
  verifier_status text not null default 'pending'
    check (verifier_status in ('pending', 'accepted', 'needs_review', 'rejected')),
  verifier_notes text check (char_length(verifier_notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (call_attempt_id, user_id) references kriya.call_attempts (id, user_id) on delete cascade,
  foreign key (voice_task_id, user_id) references kriya.voice_tasks (id, user_id) on delete cascade
);
create index call_outcomes_task_idx on kriya.call_outcomes (voice_task_id);
create trigger call_outcomes_touch before update on kriya.call_outcomes
  for each row execute function kriya.touch_updated_at();

-- Numbers that must never be called. Cross-tenant and without user_id, so
-- one owner can't learn another's contacts; no grants
create table kriya.call_suppressions (
  phone_hash text primary key check (char_length(phone_hash) <= 128),
  reason text not null check (reason in ('recipient_opt_out', 'abuse_report', 'owner_block')),
  source_attempt_id uuid,
  created_at timestamptz not null default now()
);

/* ───────────────────────────── metering ─────────────────────────── */

-- The owner's price sheet (COST_AND_METERING §2). Never seeded: no row
-- means no estimate for that component
create table kriya.voice_prices (
  id text primary key check (char_length(id) between 1 and 80),
  provider text not null,
  product text not null,
  unit text not null check (unit in (
    'second', 'minute_pulse_60', 'minute_pulse_30', 'attempt', 'character', 'audio_second')),
  price_micro bigint not null check (price_micro >= 0),
  currency text not null check (currency in ('INR', 'USD')),
  effective_from timestamptz not null,
  -- Where the price came from, e.g. "Exotel quote 2026-10-20, email"
  source text not null check (char_length(source) between 1 and 300),
  checked_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create trigger voice_prices_touch before update on kriya.voice_prices
  for each row execute function kriya.touch_updated_at();

-- One row per billable unit of work. request_key makes duplicates
-- idempotent; kept de-identified after account deletion, like usage_events.
-- The three keys are checked at commit: deleting an account nulls them one
-- by one, and an immediate check would see the others still pointing at
-- rows the same delete already removed
create table kriya.voice_usage (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique check (char_length(request_key) <= 200),
  user_id uuid references auth.users (id) on delete set null
    deferrable initially deferred,
  voice_task_id uuid references kriya.voice_tasks (id) on delete set null
    deferrable initially deferred,
  call_attempt_id uuid references kriya.call_attempts (id) on delete set null
    deferrable initially deferred,
  component text not null check (component in ('telephony', 'stt', 'tts', 'llm')),
  provider text not null,
  product text not null,
  -- Seconds or characters; null for LLM requests
  quantity bigint check (quantity >= 0),
  unit text,
  -- Null means not reported, never zero
  input_tokens integer,
  output_tokens integer,
  -- counted = Kriya's own measurement
  usage_status text not null check (usage_status in ('reported', 'counted', 'missing')),
  reported_cost_micro bigint,
  reported_currency text check (reported_currency in ('INR', 'USD')),
  -- From voice_prices, only when nothing was reported
  estimated_cost_micro bigint,
  estimated_currency text check (estimated_currency in ('INR', 'USD')),
  price_id text,
  cost_source text check (cost_source in ('provider', 'estimate', 'reconciled')),
  reconciliation text not null default 'pending'
    check (reconciliation in ('pending', 'matched', 'mismatch', 'unavailable')),
  -- Normalized provider usage, no content
  raw jsonb,
  created_at timestamptz not null default now()
);
create index voice_usage_user_idx on kriya.voice_usage (user_id, created_at desc);
create index voice_usage_task_idx on kriya.voice_usage (voice_task_id);
create index voice_usage_attempt_idx on kriya.voice_usage (call_attempt_id);
create index voice_usage_created_idx on kriya.voice_usage (created_at);

-- What a voice task cost and what the customer is charged. One per task,
-- written at any terminal state; same rules as kriya.charges
create table kriya.voice_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  voice_task_id uuid unique references kriya.voice_tasks (id) on delete set null,
  plan_id text,
  -- USD items converted with fx.usdInr, INR items as they are
  provider_cost_micro_inr bigint,
  cost_basis text not null check (cost_basis in ('provider', 'estimate', 'none')),
  unmetered_items integer not null default 0 check (unmetered_items >= 0),
  fx_usd_inr numeric(12, 4),
  fx_source text,
  markup_bps integer not null,
  charge_micro_inr bigint,
  status text not null check (status in ('final', 'estimated', 'unpriced')),
  created_at timestamptz not null default now()
);
create index voice_charges_user_idx on kriya.voice_charges (user_id, created_at desc);
create index voice_charges_created_idx on kriya.voice_charges (created_at);

/* ───────────────────────────── plans ────────────────────────────── */

-- 0 and false mean voice is off on a plan until the owner sets values
alter table kriya.plans
  add column voice_enabled boolean not null default false,
  add column max_outreach_calls_per_day integer not null default 0
    check (max_outreach_calls_per_day >= 0),
  add column max_call_seconds integer not null default 300 check (max_call_seconds > 0),
  -- Outreach calls; owner reports use voice_profiles.report_max_attempts
  add column max_attempts_per_call integer not null default 2
    check (max_attempts_per_call between 1 and 5),
  add column max_voice_task_cost_micro_inr bigint not null default 0
    check (max_voice_task_cost_micro_inr >= 0);

/* ───────────────────────────── transitions ──────────────────────── */

-- Every edge of the three state machines (DATA_MODEL §3), who may take it
-- and the evidence keys it needs. Edges not listed are no-ops
create table kriya.voice_allowed_transitions (
  entity text not null check (entity in ('task', 'call', 'attempt')),
  from_status text not null,
  to_status text not null,
  actors text[] not null,
  evidence text[] not null default '{}',
  primary key (entity, from_status, to_status)
);
insert into kriya.voice_allowed_transitions (entity, from_status, to_status, actors, evidence) values
  ('task', 'draft', 'awaiting_confirmation', '{owner}', '{}'),
  ('task', 'draft', 'cancelled', '{owner,worker}', '{}'),
  ('task', 'awaiting_confirmation', 'draft', '{owner}', '{}'),
  ('task', 'awaiting_confirmation', 'authorized', '{owner}', '{approval_id,payload_hash}'),
  ('task', 'awaiting_confirmation', 'expired', '{worker,janitor}', '{}'),
  ('task', 'awaiting_confirmation', 'cancelled', '{owner,worker}', '{}'),
  ('task', 'authorized', 'in_progress', '{worker}', '{voice_call_id}'),
  ('task', 'authorized', 'cancelled', '{owner,worker}', '{}'),
  ('task', 'in_progress', 'awaiting_report', '{verifier}', '{attempt_id,verified_at}'),
  ('task', 'in_progress', 'needs_owner', '{worker,verifier,janitor}', '{attempt_id}'),
  ('task', 'in_progress', 'cancelled', '{owner,worker}', '{}'),
  ('task', 'in_progress', 'failed', '{worker}', '{error_code}'),
  ('task', 'needs_owner', 'awaiting_report', '{owner}', '{}'),
  ('task', 'needs_owner', 'cancelled', '{owner,worker}', '{}'),
  ('task', 'awaiting_report', 'completed', '{verifier}', '{result}'),
  ('task', 'awaiting_report', 'unreported', '{worker}', '{voice_call_id,result}'),
  ('task', 'awaiting_report', 'cancelled', '{owner,worker}', '{}'),

  ('call', 'scheduled', 'dialing', '{worker}', '{}'),
  ('call', 'scheduled', 'canceled', '{owner,worker}', '{}'),
  ('call', 'scheduled', 'blocked', '{worker}', '{error_code}'),
  ('call', 'dialing', 'in_call', '{worker,voice}', '{}'),
  ('call', 'dialing', 'retry_wait', '{worker,webhook,verifier}', '{}'),
  ('call', 'dialing', 'exhausted', '{worker,verifier,janitor}', '{}'),
  ('call', 'dialing', 'needs_owner', '{worker,janitor}', '{}'),
  ('call', 'dialing', 'canceled', '{owner,worker}', '{}'),
  ('call', 'in_call', 'settled', '{verifier}', '{}'),
  ('call', 'in_call', 'canceled', '{owner,worker,voice}', '{}'),
  ('call', 'retry_wait', 'dialing', '{worker}', '{}'),
  ('call', 'retry_wait', 'exhausted', '{worker,janitor}', '{}'),
  ('call', 'retry_wait', 'canceled', '{owner,worker}', '{}'),
  -- An owner report the owner hung up on goes round again (VOICE_REMINDERS §4)
  ('call', 'settled', 'retry_wait', '{worker}', '{}'),

  ('attempt', 'created', 'requested', '{worker}', '{}'),
  ('attempt', 'requested', 'initiated', '{worker,janitor}', '{provider_call_id}'),
  ('attempt', 'requested', 'unknown', '{worker,janitor}', '{}'),
  ('attempt', 'requested', 'failed', '{worker}', '{}'),
  ('attempt', 'initiated', 'ringing', '{webhook,verifier}', '{}'),
  ('attempt', 'initiated', 'answered', '{webhook,verifier}', '{}'),
  ('attempt', 'initiated', 'busy', '{webhook,verifier}', '{}'),
  ('attempt', 'initiated', 'no_answer', '{webhook,verifier}', '{}'),
  ('attempt', 'initiated', 'failed', '{webhook,verifier}', '{}'),
  ('attempt', 'initiated', 'canceled', '{worker,voice,webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'answered', '{webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'busy', '{webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'no_answer', '{webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'rejected', '{webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'failed', '{webhook,verifier}', '{}'),
  ('attempt', 'ringing', 'canceled', '{worker,voice,webhook,verifier}', '{}'),
  ('attempt', 'answered', 'connected', '{voice}', '{}'),
  -- Answered but no stream: counts as a failed conversation
  ('attempt', 'answered', 'ended', '{webhook,verifier,voice}', '{}'),
  ('attempt', 'connected', 'ended', '{voice,webhook,verifier,janitor}', '{}'),
  -- Late reconciliation found the call after all
  ('attempt', 'unknown', 'initiated', '{worker,verifier,janitor}', '{provider_call_id}');

-- Append-only audit of every state change, with actor and evidence
create table kriya.voice_transitions (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The task the entity belongs to, so deleting a task removes its history
  voice_task_id uuid not null,
  entity text not null check (entity in ('task', 'call', 'attempt')),
  entity_id uuid not null,
  from_status text not null,
  to_status text not null,
  actor text not null check (actor in ('owner', 'worker', 'voice', 'webhook', 'verifier', 'janitor')),
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (voice_task_id, user_id) references kriya.voice_tasks (id, user_id) on delete cascade
);
create index voice_transitions_entity_idx on kriya.voice_transitions (entity_id, id);
create index voice_transitions_task_idx on kriya.voice_transitions (voice_task_id);
create index voice_transitions_user_idx on kriya.voice_transitions (user_id, created_at desc);

create function kriya.voice_transitions_frozen() returns trigger language plpgsql as $$
begin
  raise exception 'voice transitions are append-only';
end $$;
create trigger voice_transitions_frozen before update on kriya.voice_transitions
  for each row execute function kriya.voice_transitions_frozen();

-- Refuses a status (or result) change made outside voice_transition(), and
-- a row that starts at anything but its first status (tg_argv[0]). Updates
-- that leave both alone, like cascaded set nulls and heartbeats, pass.
-- kriya.transition is a session setting, so this stops mistakes on the
-- privileged connection; people are stopped by having no update grant.
create function kriya.voice_status_guard() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('kriya.transition', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status is distinct from tg_argv[0] or to_jsonb(new) -> 'result' <> 'null' then
      raise exception '% starts at %; later statuses are set by kriya.voice_transition()',
        tg_table_name, tg_argv[0];
    end if;
  elsif new.status is distinct from old.status
    or to_jsonb(new) -> 'result' is distinct from to_jsonb(old) -> 'result' then
    raise exception '% status changes only through kriya.voice_transition()', tg_table_name;
  end if;
  return new;
end $$;
create trigger voice_tasks_status before insert or update on kriya.voice_tasks
  for each row execute function kriya.voice_status_guard('draft');
create trigger voice_calls_status before insert or update on kriya.voice_calls
  for each row execute function kriya.voice_status_guard('scheduled');
create trigger call_attempts_status before insert or update on kriya.call_attempts
  for each row execute function kriya.voice_status_guard('created');

-- Moves a task, call or attempt to p_to. Returns false (and records
-- nothing) for an edge that isn't allowed: an out-of-order or repeated
-- event. Raises for a wrong actor, missing evidence, or evidence the
-- database doesn't back up. The model is never an actor: code maps
-- verified facts to calls of this function.
create function kriya.voice_transition(
  p_entity text, p_id uuid, p_to text, p_actor text, p_evidence jsonb default '{}'
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_user uuid;
  v_task uuid;
  v_rule kriya.voice_allowed_transitions;
  v_key text;
  v_evidence jsonb := coalesce(p_evidence, '{}');
begin
  if p_entity = 'task' then
    select status, user_id, id into v_from, v_user, v_task
    from kriya.voice_tasks where id = p_id for update;
  elsif p_entity = 'call' then
    select status, user_id, voice_task_id into v_from, v_user, v_task
    from kriya.voice_calls where id = p_id for update;
  elsif p_entity = 'attempt' then
    select a.status, a.user_id, c.voice_task_id into v_from, v_user, v_task
    from kriya.call_attempts a join kriya.voice_calls c on c.id = a.voice_call_id
    where a.id = p_id for update of a;
  else
    raise exception 'unknown voice entity %', p_entity;
  end if;
  if v_from is null then
    raise exception 'voice % % not found', p_entity, p_id;
  end if;
  if jsonb_typeof(v_evidence) <> 'object' then
    raise exception 'evidence must be a JSON object';
  end if;

  select * into v_rule from kriya.voice_allowed_transitions
  where entity = p_entity and from_status = v_from and to_status = p_to;
  if not found then
    return false;
  end if;
  if not p_actor = any (v_rule.actors) then
    raise exception '% can''t move a voice % from % to %', p_actor, p_entity, v_from, p_to;
  end if;
  foreach v_key in array v_rule.evidence loop
    if coalesce(jsonb_typeof(v_evidence -> v_key), 'null') = 'null' then
      raise exception 'voice % % -> % needs evidence %', p_entity, v_from, p_to, v_key;
    end if;
  end loop;

  -- Evidence the database must agree with
  if p_entity = 'task' then
    if p_to = 'authorized' and not exists (
      select 1 from kriya.voice_approvals
      where id = (v_evidence ->> 'approval_id')::uuid and voice_task_id = p_id
        and user_id = v_user and status = 'approved'
        and payload_hash = v_evidence ->> 'payload_hash'
    ) then
      raise exception 'the approval doesn''t match what this task is waiting for';
    end if;
    if v_from = 'in_progress' and p_to = 'awaiting_report' and not exists (
      select 1 from kriya.call_attempts a
      join kriya.voice_calls c on c.id = a.voice_call_id
      left join kriya.call_outcomes o on o.call_attempt_id = a.id
      where a.id = (v_evidence ->> 'attempt_id')::uuid and c.voice_task_id = p_id
        and c.kind = 'outreach' and a.verified_at is not null
        and a.attempt = (select max(l.attempt) from kriya.call_attempts l
                         where l.voice_call_id = c.id)
        and (o.verifier_status = 'accepted' or c.status = 'exhausted')
    ) then
      raise exception 'awaiting_report needs the last outreach attempt as a verified attempt with an accepted outcome';
    end if;
    if p_to = 'completed' and exists (
      select 1 from kriya.voice_tasks where id = p_id and report_requested
    ) and not exists (
      select 1 from kriya.voice_calls
      where id = (v_evidence ->> 'voice_call_id')::uuid and voice_task_id = p_id
        and kind = 'owner_report' and delivered_at is not null
    ) then
      raise exception 'completed needs a delivered report call';
    end if;
    if p_to = 'unreported' and not exists (
      select 1 from kriya.voice_calls
      where id = (v_evidence ->> 'voice_call_id')::uuid and voice_task_id = p_id
        and kind = 'owner_report' and status = 'exhausted'
    ) then
      raise exception 'unreported needs the exhausted report call';
    end if;
    if p_to = 'cancelled' then
      if not exists (
        select 1 from kriya.voice_tasks where id = p_id and cancel_requested_at is not null
      ) then
        raise exception 'cancel wasn''t requested for this task';
      end if;
      if exists (
        select 1 from kriya.call_attempts a join kriya.voice_calls c on c.id = a.voice_call_id
        where c.voice_task_id = p_id
          and a.status in ('requested', 'initiated', 'ringing', 'answered', 'connected')
      ) then
        raise exception 'a call for this task is still live; hang up first';
      end if;
    end if;
  elsif p_entity = 'call' then
    if p_to = 'canceled' and not exists (
      select 1 from kriya.voice_calls where id = p_id and cancel_requested_at is not null
    ) then
      raise exception 'cancel wasn''t requested for this call';
    end if;
    if v_from = 'settled' and not exists (
      select 1 from kriya.voice_calls
      where id = p_id and kind = 'owner_report' and delivered_at is null
    ) then
      raise exception 'only an undelivered owner report goes round again';
    end if;
  end if;

  perform set_config('kriya.transition', 'on', true);
  if p_entity = 'task' then
    update kriya.voice_tasks set
      status = p_to,
      result = case when p_to in ('completed', 'unreported') then v_evidence ->> 'result' else result end,
      approval_id = case when p_to = 'authorized' then (v_evidence ->> 'approval_id')::uuid else approval_id end,
      authorized_at = case when p_to = 'authorized' then now() else authorized_at end,
      error_code = case when p_to = 'failed' then v_evidence ->> 'error_code' else error_code end,
      finished_at = case when p_to in ('completed', 'unreported', 'failed', 'cancelled', 'expired')
        then now() else finished_at end
    where id = p_id;
  elsif p_entity = 'call' then
    update kriya.voice_calls set
      status = p_to,
      last_error_code = coalesce(v_evidence ->> 'error_code', last_error_code)
    where id = p_id;
  else
    update kriya.call_attempts set
      status = p_to,
      provider_call_id = coalesce(provider_call_id, v_evidence ->> 'provider_call_id'),
      requested_at = case when p_to = 'requested' then coalesce(requested_at, now()) else requested_at end,
      initiated_at = case when p_to = 'initiated' then coalesce(initiated_at, now()) else initiated_at end,
      ringing_at = case when p_to = 'ringing' then coalesce(ringing_at, now()) else ringing_at end,
      answered_at = case when p_to = 'answered' then coalesce(answered_at, now()) else answered_at end,
      connected_at = case when p_to = 'connected' then coalesce(connected_at, now()) else connected_at end,
      ended_at = case when p_to in ('ended', 'busy', 'no_answer', 'rejected', 'failed', 'canceled')
        then coalesce(ended_at, now()) else ended_at end
    where id = p_id;
  end if;
  perform set_config('kriya.transition', 'off', true);

  insert into kriya.voice_transitions
    (user_id, voice_task_id, entity, entity_id, from_status, to_status, actor, evidence)
  values (v_user, v_task, p_entity, p_id, v_from, p_to, p_actor, v_evidence);
  return true;
end $$;

revoke all on function kriya.voice_transition(text, uuid, text, text, jsonb) from public;

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.voice_access enable row level security;
alter table kriya.voice_profiles enable row level security;
alter table kriya.phone_verifications enable row level security;
alter table kriya.voice_tasks enable row level security;
alter table kriya.voice_approvals enable row level security;
alter table kriya.voice_calls enable row level security;
alter table kriya.call_attempts enable row level security;
alter table kriya.call_events enable row level security;
alter table kriya.conversation_turns enable row level security;
alter table kriya.call_outcomes enable row level security;
alter table kriya.call_suppressions enable row level security;
alter table kriya.voice_prices enable row level security;
alter table kriya.voice_usage enable row level security;
alter table kriya.voice_charges enable row level security;
alter table kriya.voice_allowed_transitions enable row level security;
alter table kriya.voice_transitions enable row level security;

-- Written by the server, worker, voice service and verifier; the person
-- reads their own. voice_access, phone_verifications, call_suppressions,
-- voice_prices and voice_allowed_transitions have no policy and no grant.
do $$
declare t text;
begin
  foreach t in array array[
    'voice_profiles', 'voice_tasks', 'voice_approvals', 'voice_calls', 'call_attempts',
    'call_events', 'conversation_turns', 'call_outcomes', 'voice_transitions',
    'voice_usage', 'voice_charges'
  ] loop
    execute format(
      'create policy read_own on kriya.%I for select to authenticated
         using (user_id = (select auth.uid()))', t);
  end loop;
end $$;

grant select on
  kriya.voice_profiles, kriya.voice_tasks, kriya.voice_approvals, kriya.voice_calls,
  kriya.call_events, kriya.conversation_turns, kriya.call_outcomes, kriya.voice_transitions,
  kriya.voice_usage, kriya.voice_charges
to authenticated;

-- Everything but the two token hashes and which voice instance holds the call
grant select (
  id, user_id, voice_call_id, attempt, status, policy_version, telephony_provider,
  stt_provider, tts_provider, tts_voice, llm_model, provider_call_id, stream_token_used_at,
  stream_heartbeat_at, requested_at, initiated_at, ringing_at, answered_at, connected_at,
  ended_at, end_reason, billable_seconds, last_report_mark_at, verified_at, provider_snapshot,
  created_at, updated_at
) on kriya.call_attempts to authenticated;

-- The person's own preferences; the number and its verification are set by
-- the verification flow only
create policy update_own on kriya.voice_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (
  timezone, language, quiet_start, quiet_end, report_mode, report_max_attempts,
  report_retry_minutes, transcript_retention_days
) on kriya.voice_profiles to authenticated;

-- The person may delete their transcripts at any time (D-10)
create policy delete_own on kriya.conversation_turns for delete to authenticated
  using (user_id = (select auth.uid()));
grant delete on kriya.conversation_turns to authenticated;
