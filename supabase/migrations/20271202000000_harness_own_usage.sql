-- Own models (track H, docs/kriya-harness/OWN_MODELS.md): what a person's own
-- API keys were used for from Kriya Harness, as counts only: provider, model,
-- requests, tokens, and the cost the provider reported (never estimated by
-- Kriya, never a charge). No prompt, code or key. Kriya never pays these calls.
-- Read only by the person; only the device route writes, after
-- authenticateDevice and scoped by the device's person.

create table kriya.harness_own_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references kriya.harness_devices (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9-]{2,30}$'),
  model text not null check (char_length(model) between 1 and 120),
  requests integer not null default 1 check (requests between 1 and 10000),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  -- As the provider reported it, in micro-USD; null when it didn't say (never zero for unknown)
  reported_cost_micro_usd bigint check (reported_cost_micro_usd >= 0),
  at timestamptz not null default now()
);
create index harness_own_usage_user_idx on kriya.harness_own_usage (user_id, at desc);

alter table kriya.harness_own_usage enable row level security;
create policy read_own on kriya.harness_own_usage for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.harness_own_usage to authenticated;
