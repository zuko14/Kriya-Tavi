-- Jobs and standing grants (track O, O2; docs/operator/
-- DATA_MODEL_AND_STATE_MACHINES.md). A mandate is a job the person
-- approves once: done criteria, deadline, budget, and grants that let the
-- agent repeat a pinned R2/R3 action without asking each time. Nothing
-- calls these tables yet: O3 adds proposals and approval, O4 spends grants.
--
-- Who may move a job is enforced here as far as SQL can tell the person's
-- session (role authenticated) from the server (privileged), and in code
-- for the rest (lib/agent/policy.ts PERSON_ONLY_WRITES).

/* ───────────────────────────── mandates ─────────────────────────── */

create table kriya.mandates (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where it was proposed; deleting that chat keeps the job (OF-14)
  origin_thread_id text,
  agent_id text,
  squad_id text,
  -- The job's own goal and thread, set on approval
  goal_id text unique,
  playbook_id text check (playbook_id ~ '^OP-[A-Z]{2,12}$'),
  playbook_version integer check (playbook_version > 0),
  title text not null check (char_length(title) between 1 and 200),
  objective text not null check (char_length(objective) between 1 and 2000),
  -- [{ id, text, evidence }], 1 to 12
  criteria jsonb not null check (case when jsonb_typeof(criteria) = 'array'
    then jsonb_array_length(criteria) between 1 and 12 else false end),
  -- Grants asked for, copied into kriya.grants on approval, at most 6
  proposed_grants jsonb not null default '[]' check (case when jsonb_typeof(proposed_grants) = 'array'
    then jsonb_array_length(proposed_grants) <= 6 else false end),
  -- { invoices?: uuid[], ledger?: uuid[] }: what the job is about
  subjects jsonb not null default '{}' check (jsonb_typeof(subjects) = 'object'),
  -- Criteria the person ticked (person_confirmed only)
  confirmed text[] not null default '{}',
  status text not null default 'proposed' check (status in
    ('proposed', 'declined', 'active', 'needs_person', 'paused',
     'completed', 'expired', 'revoked', 'closed')),
  status_reason text check (char_length(status_reason) <= 200),
  due_at timestamptz not null,
  budget_micro_inr bigint check (budget_micro_inr > 0),
  -- A lib/schedules.ts rule for the check-ins
  check_in jsonb,
  last_evidence_at timestamptz,
  -- Per-criterion results, written by the server only
  verdict jsonb,
  proposed_by text not null check (proposed_by in ('agent', 'person')),
  task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  closed_at timestamptz,
  unique (id, user_id),
  foreign key (origin_thread_id, user_id) references kriya.threads (id, user_id)
    on delete set null (origin_thread_id),
  foreign key (goal_id, user_id) references kriya.goals (id, user_id)
    on delete set null (goal_id),
  check (due_at <= created_at + interval '30 days')
);
create index mandates_user_idx on kriya.mandates (user_id, created_at desc);
create index mandates_origin_idx on kriya.mandates (origin_thread_id);
create index mandates_open_idx on kriya.mandates (due_at)
  where status in ('active', 'needs_person', 'paused');
create trigger mandates_touch before update on kriya.mandates
  for each row execute function kriya.touch_updated_at();
create trigger mandates_transition before update of status on kriya.mandates
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('mandate');

-- The person's session may approve, decline, pause, resume, revoke and
-- close; needing the person, completing and expiring are the server's
create function kriya.mandates_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    if new.user_id is distinct from old.user_id then
      raise exception 'a job stays with its person';
    end if;
    if new.status is distinct from old.status
       and new.status in ('needs_person', 'completed', 'expired') then
      raise exception 'only Kriya can mark a job %', new.status;
    end if;
  end if;
  return new;
end $$;
create trigger mandates_guard before update on kriya.mandates
  for each row execute function kriya.mandates_guard();

/* ───────────────────────────── grants ───────────────────────────── */

create table kriya.grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mandate_id text not null,
  -- A second lock behind lib/agent/capabilities.ts GRANTABLE (OD-03)
  tool text not null check (tool in
    ('gmail_draft', 'calendar_create_event', 'sheets_append', 'sheets_update')),
  -- The pinned targets (DATA_MODEL §2.2)
  pins jsonb not null check (jsonb_typeof(pins) = 'object'),
  max_uses integer not null check (max_uses between 1 and 50),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'exhausted', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (mandate_id, user_id) references kriya.mandates (id, user_id) on delete cascade
);
create index grants_mandate_idx on kriya.grants (mandate_id);
create index grants_user_idx on kriya.grants (user_id);
create trigger grants_transition before update of status on kriya.grants
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('grant');

-- The person's edits are reduce-only: fewer uses, or revoked (OD-02)
create function kriya.grants_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    if new.max_uses > old.max_uses then
      raise exception 'a grant can only be narrowed';
    end if;
    if new.status is distinct from old.status and new.status <> 'revoked' then
      raise exception 'a person can only revoke a grant';
    end if;
  end if;
  return new;
end $$;
create trigger grants_guard before update on kriya.grants
  for each row execute function kriya.grants_guard();

-- One row per tool call a grant answered: the key makes a retry free
create table kriya.grant_uses (
  grant_id uuid not null references kriya.grants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null,
  tool_call_id text not null check (char_length(tool_call_id) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (grant_id, tool_call_id)
);
create index grant_uses_user_idx on kriya.grant_uses (user_id);

-- Which grant, if any, answered a run's approval (not part of receipts)
alter table kriya.tool_executions add column grant_id uuid;

/* ───────────────────────────── transitions ──────────────────────── */

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('mandate', 'proposed', 'active'),
  ('mandate', 'proposed', 'declined'),
  ('mandate', 'active', 'needs_person'),
  ('mandate', 'needs_person', 'active'),
  ('mandate', 'active', 'paused'),
  ('mandate', 'paused', 'active'),
  ('mandate', 'active', 'completed'),
  ('mandate', 'needs_person', 'completed'),
  ('mandate', 'active', 'expired'),
  ('mandate', 'needs_person', 'expired'),
  ('mandate', 'paused', 'expired'),
  ('mandate', 'active', 'revoked'),
  ('mandate', 'needs_person', 'revoked'),
  ('mandate', 'paused', 'revoked'),
  ('mandate', 'active', 'closed'),
  ('mandate', 'needs_person', 'closed'),
  ('mandate', 'paused', 'closed'),
  ('grant', 'active', 'revoked'),
  ('grant', 'active', 'exhausted'),
  ('grant', 'active', 'expired');

/* ───────────────────────────── spending ─────────────────────────── */

-- The worker's only way to answer an approval with a grant. True when this
-- tool call may run: the grant is the person's, active, unexpired, has a
-- use left and its job is active; or the same call already spent a use.
create function kriya.consume_grant(p_user uuid, p_grant uuid, p_task uuid, p_call text)
returns boolean language plpgsql set search_path = '' as $$
declare g kriya.grants;
begin
  if exists (select 1 from kriya.grant_uses
             where grant_id = p_grant and user_id = p_user and tool_call_id = p_call) then
    return true;
  end if;
  select * into g from kriya.grants where id = p_grant and user_id = p_user for update;
  if not found or g.status <> 'active' or g.expires_at <= now() or g.uses >= g.max_uses
     or not exists (select 1 from kriya.mandates m
                    where m.id = g.mandate_id and m.user_id = p_user and m.status = 'active') then
    return false;
  end if;
  insert into kriya.grant_uses (grant_id, user_id, task_id, tool_call_id)
    values (p_grant, p_user, p_task, p_call);
  update kriya.grants
    set uses = uses + 1,
        status = case when uses + 1 >= max_uses then 'exhausted' else status end
    where id = p_grant;
  return true;
end $$;
revoke all on function kriya.consume_grant(uuid, uuid, uuid, text)
  from public, anon, authenticated;

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.mandates enable row level security;
alter table kriya.grants enable row level security;
alter table kriya.grant_uses enable row level security;

-- The person reads their own jobs; an agent's tool (running as the person)
-- may only propose one, with nothing decided yet
create policy read_own on kriya.mandates for select to authenticated
  using (user_id = (select auth.uid()));
create policy propose_own on kriya.mandates for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'proposed'
    and goal_id is null and verdict is null and approved_at is null
    and closed_at is null and confirmed = '{}');
create policy change_own on kriya.mandates for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert on kriya.mandates to authenticated;
grant update (status, status_reason, confirmed, approved_at, closed_at, goal_id)
  on kriya.mandates to authenticated;

create policy read_own on kriya.grants for select to authenticated
  using (user_id = (select auth.uid()));
create policy add_own on kriya.grants for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'active' and uses = 0);
create policy narrow_own on kriya.grants for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert on kriya.grants to authenticated;
grant update (status, revoked_at, max_uses) on kriya.grants to authenticated;

-- Written only by consume_grant
create policy read_own on kriya.grant_uses for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.grant_uses to authenticated;
