-- Harness 2.0, W9: cartridge candidates (docs/kriya-harness/upgrade_2.0/
-- SELF_EVOLUTION.md §2–4 and §7, DATA_MODEL_AND_CONTRACTS.md §1; WD-07, WD-08).
-- A candidate is a linted replacement for one role cartridge, drafted from a
-- confirmed Scout finding. It is benchmarked off Kriya's servers, judged by
-- gate() in code, and changes status only along SELF_EVOLUTION §2's edges.
-- Approval stores a decision; nothing is served (versions and the overlay are
-- W11). Platform table: no person's data, read and written only by server
-- code after requireOwner() or by the scheduler step (server_only policy).

create table kriya.harness_cartridge_candidates (
  id uuid primary key default gen_random_uuid(),
  cartridge_id text not null check (cartridge_id ~ '^kriya-role-[a-z]{2,20}$'),
  base_version text not null check (base_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
  body text not null check (char_length(body) between 1 and 6000),
  judgement jsonb not null default '[]' check (jsonb_typeof(judgement) = 'array' and jsonb_array_length(judgement) <= 12),
  added_gates text[] not null default '{}' check (cardinality(added_gates) <= 12),
  added_detectors text[] not null default '{}' check (cardinality(added_detectors) <= 20),
  added_keywords text[] not null default '{}' check (cardinality(added_keywords) <= 20),
  diff text not null check (char_length(diff) <= 20000),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  finding_ids uuid[] not null check (cardinality(finding_ids) between 1 and 10),
  lint jsonb not null,
  status text not null check (status in (
    'discarded', 'awaiting_bench', 'benched', 'proposed', 'held', 'rejected', 'approved')),
  -- gate() output, computed by code only (set once, with the evidence)
  verdict jsonb,
  -- report hashes, seed version, profile id: set once
  evidence jsonb,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  -- A candidate is benched with its verdict and evidence together
  check ((verdict is null) = (evidence is null)),
  check (status in ('discarded', 'awaiting_bench') or verdict is not null)
);
create index harness_candidates_recent on kriya.harness_cartridge_candidates (created_at desc);
create index harness_candidates_open on kriya.harness_cartridge_candidates (status)
  where status in ('awaiting_bench', 'proposed', 'held');

-- SELF_EVOLUTION §2: the only edges a candidate's status may take
insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('harness_candidate', 'awaiting_bench', 'benched'),
  ('harness_candidate', 'benched', 'proposed'),
  ('harness_candidate', 'benched', 'held'),
  ('harness_candidate', 'benched', 'rejected'),
  ('harness_candidate', 'proposed', 'approved'),
  ('harness_candidate', 'proposed', 'rejected'),
  ('harness_candidate', 'held', 'approved'),
  ('harness_candidate', 'held', 'rejected');

create trigger harness_candidates_transition
  before update of status on kriya.harness_cartridge_candidates
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('harness_candidate');

-- What was drafted, linted and measured never changes afterwards; the verdict
-- and the evidence are written once; the status follows the verdict; a held
-- candidate is approved only with a typed reason
create function kriya.harness_candidates_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.cartridge_id is distinct from old.cartridge_id
    or new.base_version is distinct from old.base_version
    or new.body is distinct from old.body
    or new.judgement is distinct from old.judgement
    or new.added_gates is distinct from old.added_gates
    or new.added_detectors is distinct from old.added_detectors
    or new.added_keywords is distinct from old.added_keywords
    or new.diff is distinct from old.diff
    or new.body_sha256 is distinct from old.body_sha256
    or new.finding_ids is distinct from old.finding_ids
    or new.lint is distinct from old.lint
    or new.created_at is distinct from old.created_at then
    raise exception 'a candidate''s content never changes';
  end if;
  if (old.verdict is not null and new.verdict is distinct from old.verdict)
    or (old.evidence is not null and new.evidence is distinct from old.evidence) then
    raise exception 'a candidate''s verdict and evidence are written once';
  end if;
  if new.verdict is not null and old.verdict is null and not (old.status = 'awaiting_bench' and new.status = 'benched') then
    raise exception 'a verdict comes only with the benchmark';
  end if;
  if new.status = 'proposed' and old.status = 'benched' and coalesce(new.verdict ->> 'verdict', '') not in ('adopt', 'canary') then
    raise exception 'only an adopt or canary verdict is proposed';
  end if;
  if new.status = 'held' and old.status = 'benched' and (new.verdict ->> 'verdict') is distinct from 'hold' then
    raise exception 'only a hold verdict is held';
  end if;
  if new.status = 'rejected' and old.status = 'benched' and (new.verdict ->> 'verdict') is distinct from 'reject' then
    raise exception 'only a reject verdict is rejected by the benchmark';
  end if;
  if new.status = 'approved' and old.status = 'held' and char_length(coalesce(btrim(new.reason), '')) < 10 then
    raise exception 'a held candidate is approved only with a typed reason';
  end if;
  if new.status in ('approved', 'rejected') and old.status in ('proposed', 'held') and new.decided_by is null then
    raise exception 'an owner decision names the owner';
  end if;
  return new;
end $$;

create trigger harness_candidates_guard
  before update on kriya.harness_cartridge_candidates
  for each row execute function kriya.harness_candidates_guard();

-- One status change, with its audit record (SELF_EVOLUTION §4: every action is
-- an audit event with the owner's id). The trigger above decides whether it is
-- allowed; this function only applies it.
create function kriya.harness_candidate_transition(
  p_id uuid, p_to text, p_actor uuid, p_reason text, p_verdict jsonb, p_evidence jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  v_from text;
begin
  select status into v_from from kriya.harness_cartridge_candidates where id = p_id for update;
  if v_from is null then
    raise exception 'no such candidate';
  end if;
  update kriya.harness_cartridge_candidates set
    status = p_to,
    verdict = coalesce(p_verdict, verdict),
    evidence = coalesce(p_evidence, evidence),
    reason = coalesce(p_reason, reason),
    decided_by = case when p_to in ('approved', 'rejected') and v_from in ('proposed', 'held') then p_actor else decided_by end,
    decided_at = case when p_to in ('approved', 'rejected') and v_from in ('proposed', 'held') then now() else decided_at end
  where id = p_id;
  insert into kriya.audit_events (actor_id, action, target_type, target_id, details)
    values (p_actor, 'harness.candidate.' || p_to, 'harness_cartridge_candidate', p_id::text,
      jsonb_build_object('from', v_from, 'to', p_to));
end $$;
revoke all on function kriya.harness_candidate_transition(uuid, text, uuid, text, jsonb, jsonb) from public, anon, authenticated;

alter table kriya.harness_cartridge_candidates enable row level security;
create policy server_only on kriya.harness_cartridge_candidates for all to anon, authenticated
  using (false) with check (false);
