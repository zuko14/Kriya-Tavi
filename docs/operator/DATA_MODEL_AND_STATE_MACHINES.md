# Data model and state machines (operator, track O)

The SQL migration is the source of truth; `db/schema.ts` mirrors it
(AGENTS.md). Everything below is **one** migration in O2:
`supabase/migrations/20261201000000_operator_mandates.sql` with
`supabase/rollback/20261201000000_operator_mandates.down.sql`.

## 0. Migration rules (same as track A, DATA_MODEL §0 there)

1. A new file only; never edit an applied migration. Timestamp claimed on
   the Coordination board; must sort after every existing file
   (`20261115000000_database_lint.sql` is the latest on 2026-10-21).
2. Runs inside one transaction; no extensions; PGlite-compatible
   (`tests/db/harness.ts`).
3. Every new table: `enable row level security` **and** at least one policy
   for `authenticated` (an explicit deny-all policy for server-only tables,
   as `20261115000000_database_lint.sql` does), so `tests/db/lint.test.ts`
   stays at zero.
4. Every new function: `set search_path = ''` and fully qualified names
   (lint 0011, `tests/db/lint.test.ts`).
5. Composite foreign keys `(x_id, user_id)` to the parent's `(id, user_id)`,
   as `kriya.schedules` does, so a row can't point at another person's
   parent.
6. The down file drops what the up file created, in reverse order, and
   deletes its own row from the migrations table, like the existing
   `supabase/rollback/*.down.sql` files. Down + up is tested on PGlite
   (`tests/db/migrations.test.ts`, newest-first rollback order).
7. Money in integer micro-INR `bigint` (invariant 6).

## 1. Tables

> [!NOTE]
> Built in O2 (2026-10-21) as
> `supabase/migrations/20261201000000_operator_mandates.sql`, which is the
> source of truth. It is stricter than the sketches below in five ways
> (OF-14): `origin_thread_id` nullable with `set null`; `mandates_guard`
> (the person's session can't set `needs_person`, `completed`, `expired`
> or change `user_id`); the insert policy also requires `goal_id`,
> `verdict`, `approved_at`, `closed_at` null and `confirmed` empty; an index
> on every new foreign key; `consume_grant`'s same-call shortcut also
> checks `user_id`.

### 1.1 `kriya.mandates`

```sql title="20261201000000_operator_mandates.sql (sketch)"
create table kriya.mandates (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where it was proposed; deleting that chat keeps the job (OF-14)
  origin_thread_id text,
  agent_id text,
  squad_id text,
  goal_id text unique,                      -- set on approval
  playbook_id text check (playbook_id ~ '^OP-[A-Z]{2,12}$'),
  playbook_version integer check (playbook_version > 0),
  title text not null check (char_length(title) between 1 and 200),
  objective text not null check (char_length(objective) between 1 and 2000),
  -- [{ id, text, evidence: EvidenceSpec }] (§3), 1..12 items
  criteria jsonb not null
    check (jsonb_typeof(criteria) = 'array' and jsonb_array_length(criteria) between 1 and 12),
  -- Proposed grants, copied into kriya.grants on approval (§2.2 shapes), ≤ 6
  proposed_grants jsonb not null default '[]'
    check (jsonb_typeof(proposed_grants) = 'array' and jsonb_array_length(proposed_grants) <= 6),
  -- Ledger/invoice ids the job is about (OP-COLLECT: the overdue invoices)
  subjects jsonb not null default '{}',
  -- Criterion ids the person ticked (kind person_confirmed only)
  confirmed text[] not null default '{}',
  status text not null default 'proposed' check (status in
    ('proposed', 'declined', 'active', 'needs_person', 'paused',
     'completed', 'expired', 'revoked', 'closed')),
  status_reason text check (char_length(status_reason) <= 200),
  due_at timestamptz not null,
  budget_micro_inr bigint check (budget_micro_inr > 0),
  check_in jsonb,                           -- a lib/schedules.ts rule
  last_evidence_at timestamptz,
  verdict jsonb,                            -- CriterionResult[] (§3), set by code
  proposed_by text not null check (proposed_by in ('agent', 'person')),
  task_id uuid,                             -- the task that proposed it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  closed_at timestamptz,
  unique (id, user_id),
  foreign key (origin_thread_id, user_id) references kriya.threads (id, user_id)
    on delete set null (origin_thread_id),
  foreign key (goal_id, user_id) references kriya.goals (id, user_id) on delete set null (goal_id),
  check (due_at <= created_at + interval '30 days')
);
create index mandates_user_idx on kriya.mandates (user_id, created_at desc);
create index mandates_open_idx on kriya.mandates (due_at)
  where status in ('active', 'needs_person', 'paused');
```

> [!NOTE]
> `on delete set null (goal_id)` is the column-list form (Postgres ≥ 15;
> the project runs 17, PGlite supports it, voice F1). A plain composite
> `on delete set null` would null `user_id` and fail.

### 1.2 `kriya.grants`

```sql title="(same migration)"
create table kriya.grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mandate_id text not null,
  tool text not null check (tool in
    ('gmail_draft', 'calendar_create_event', 'sheets_append', 'sheets_update')),
  pins jsonb not null,                      -- §2.2
  max_uses integer not null check (max_uses between 1 and 50),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'exhausted', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (mandate_id, user_id) references kriya.mandates (id, user_id) on delete cascade
);
create index grants_mandate_idx on kriya.grants (mandate_id) where status = 'active';
```

The `tool` check is a **second lock** behind the registry (OD-03): even a
bug in `lib/agent/capabilities.ts` can't store a grant for another tool.

### 1.3 `kriya.grant_uses`

```sql title="(same migration)"
create table kriya.grant_uses (
  grant_id uuid not null references kriya.grants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null,
  tool_call_id text not null check (char_length(tool_call_id) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (grant_id, tool_call_id)
);
```

### 1.4 Checked against the live database (2026-10-21, read-only)

Project `kriya-tavi`: 20 migrations applied (`20261016000000` …
`20261115000000`, identical to `supabase/migrations/`), 70 tables in
`kriya`, none of `mandates`, `grants`, `grant_uses`, `crew_runs`,
`crew_parts`; `tool_executions` has no `grant_id`; transition entities
`approval, file, goal, invoice, ledger_entry, login_profile, obligation,
policy_version, schedule, skill` (no `mandate`, `grant`, `crew_*`);
`goals` and `threads` both have `unique (id, user_id)` (the composite FKs
above work); `tasks_one_active_per_thread` exists; `connections` has
`unique (user_id, provider)` and 0 rows. Crew tables: CREW_EXECUTION.md §3
(their own migration in O11, `20261201000100`).

### 1.5 `kriya.tool_executions.grant_id`

```sql title="(same migration)"
alter table kriya.tool_executions add column grant_id uuid;
```

Nullable, no foreign key (a revoked mandate's rows may be deleted with the
person's account; executions are kept by their own rules). Not part of the
receipt hash.

## 2. Shapes

### 2.1 Criterion

```ts
type Criterion = { id: string; text: string; evidence: EvidenceSpec } // id: 1..12 chars
```

### 2.2 Grant pins (per tool)

| Tool                    | `pins` shape (zod)                         | Matches when                                           |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `gmail_draft`           | `{ to: email[1..20], cc?: email[0..20] }`  | every `input.to` ∈ `to`; every `input.cc` ∈ `cc ?? []` |
| `calendar_create_event` | `{ attendees: email[0..20] }`              | every `input.attendees ?? []` ∈ `attendees`            |
| `sheets_append`         | `{ spreadsheetId: string, range: string }` | both equal, byte for byte                              |
| `sheets_update`         | `{ spreadsheetId: string, range: string }` | both equal, byte for byte                              |

Emails compare lower-cased and trimmed. Any input field the matcher
doesn't know about is ignored only if the registry lists it as unpinned
content (`subject`, `body`, `title`, `start`, `end`, `timeZone`,
`description`, `location`, `rows`); anything else → no match.

### 2.3 Proposed grant (inside `mandates.proposed_grants`)

```ts
type ProposedGrant = { tool: GrantableTool; pins: Pins; maxUses: number; why: string }
```

`expires_at` is set at approval to `mandates.due_at`.

### 2.4 `kriya.consume_grant`

```sql title="(same migration)"
create function kriya.consume_grant(
  p_user uuid, p_grant uuid, p_task uuid, p_call text
) returns boolean language plpgsql set search_path = '' as $$
declare g kriya.grants;
begin
  if exists (select 1 from kriya.grant_uses
             where grant_id = p_grant and tool_call_id = p_call) then
    return true;                                    -- same call again: idempotent
  end if;
  select * into g from kriya.grants
    where id = p_grant and user_id = p_user for update;
  if not found or g.status <> 'active' or g.expires_at <= now()
     or g.uses >= g.max_uses
     or not exists (select 1 from kriya.mandates m
                    where m.id = g.mandate_id and m.user_id = p_user
                      and m.status = 'active') then
    return false;
  end if;
  insert into kriya.grant_uses (grant_id, user_id, task_id, tool_call_id)
    values (p_grant, p_user, p_task, p_call);
  update kriya.grants set uses = uses + 1,
    status = case when uses + 1 >= max_uses then 'exhausted' else status end
    where id = p_grant;
  return true;
end $$;
revoke all on function kriya.consume_grant(uuid, uuid, uuid, text)
  from public, anon, authenticated;
```

Called by the worker through `privileged` only. Not executable by
`authenticated` or `anon` (the agent's tools run as the person and must not
be able to call it).

## 3. Evidence kinds (OD-06)

```ts
type EvidenceSpec =
  | { kind: "tool_verified"; tool: string; atLeast?: number } // episodes.done entries
  | { kind: "call_outcome"; results: VoiceTaskResult[] } // accepted outcome in the thread
  | { kind: "invoice_paid" } // every subjects.invoices id has status paid
  | { kind: "ledger_confirmed" } // every subjects.ledger id confirmed
  | { kind: "file_created" } // ≥ 1 file in an episode of the thread
  | { kind: "person_confirmed" } // id ∈ mandates.confirmed

type CriterionResult = {
  id: string
  met: boolean
  refs: { kind: "episode" | "voice_task" | "invoice" | "ledger" | "file"; id: string }[]
  by: "evidence" | "person" | null
}
```

| Kind               | Met when (all rows `user_id = mandate.user_id`)                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_verified`    | Count of `episodes.done[]` with `tool = spec.tool` (verification `verified`) in the goal thread, `deleted_at is null`, ≥ `atLeast ?? 1` |
| `call_outcome`     | A `voice_tasks` row with `thread_id = goal thread`, `result ∈ results`, and its `call_outcomes.verifier_status = 'accepted'`            |
| `invoice_paid`     | `subjects.invoices` non-empty and every listed invoice `status = 'paid'` (only the person marks paid)                                   |
| `ledger_confirmed` | `subjects.ledger` non-empty and every listed entry `status = 'confirmed'` (person-only)                                                 |
| `file_created`     | An episode of the goal thread has a non-empty `files`                                                                                   |
| `person_confirmed` | The criterion id is in `mandates.confirmed`                                                                                             |

## 4. State machines and who may move them

Rows added to `kriya.allowed_transitions` (entity, from, to); triggers
`mandates_transition` and `grants_transition` use the existing
`kriya.check_transition('mandate' | 'grant')`.

| Entity  | From                         | To           | Actor (enforced in code)                                                       |
| ------- | ---------------------------- | ------------ | ------------------------------------------------------------------------------ |
| mandate | proposed                     | active       | person (`approveMandate`)                                                      |
| mandate | proposed                     | declined     | person                                                                         |
| mandate | active                       | needs_person | worker (`reviewMandates`)                                                      |
| mandate | needs_person, paused         | active       | person (`resumeMandate`)                                                       |
| mandate | active                       | paused       | person; worker when the goal's ₹ cap paused it                                 |
| mandate | active, needs_person         | completed    | worker only, verdict all met                                                   |
| mandate | active, needs_person, paused | expired      | worker only, `now() ≥ due_at`                                                  |
| mandate | active, needs_person, paused | revoked      | person                                                                         |
| mandate | active, needs_person, paused | closed       | person                                                                         |
| grant   | active                       | revoked      | person; also every grant of a mandate leaving `active`/`needs_person`/`paused` |
| grant   | active                       | exhausted    | `consume_grant`                                                                |
| grant   | active                       | expired      | worker (`reviewMandates`), `expires_at ≤ now()`                                |

When a mandate leaves for a terminal status, in the same transaction:
its active grants become `revoked` (or `expired` for `expired`); its
schedules are ended; its goal becomes `achieved` (for `completed`) or
`abandoned` (otherwise) through `setGoalStatus` (which already ends the
goal's schedules). Pausing a mandate pauses the goal (`setGoalStatus
'paused'`).

`lib/agent/policy.ts` `PERSON_ONLY_WRITES` gains: `mandates.status:active`,
`mandates.status:declined`, `mandates.status:revoked`,
`mandates.status:closed`, `mandates.confirmed`, `grants`, `grant_uses`.
`TOOL_WRITES` for the new tools: `mandate_propose: ["mandates+"]`,
`mandate_status: []`, `mandate_report: []` (AT-POL-07 checks it).

## 5. RLS and grants

```sql title="(same migration)"
alter table kriya.mandates enable row level security;
alter table kriya.grants enable row level security;
alter table kriya.grant_uses enable row level security;

-- The person reads their own; the agent's tool inserts only proposals
create policy read_own on kriya.mandates for select to authenticated
  using (user_id = (select auth.uid()));
create policy propose_own on kriya.mandates for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'proposed');
create policy change_own on kriya.mandates for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert on kriya.mandates to authenticated;
grant update (status, status_reason, confirmed, approved_at, closed_at, goal_id)
  on kriya.mandates to authenticated;

create policy read_own on kriya.grants for select to authenticated
  using (user_id = (select auth.uid()));
create policy add_own on kriya.grants for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'active' and uses = 0);
create policy revoke_own on kriya.grants for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert on kriya.grants to authenticated;
grant update (status, revoked_at, max_uses) on kriya.grants to authenticated;

create policy read_own on kriya.grant_uses for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.grant_uses to authenticated;
```

A guard trigger `grants_guard` (before update) refuses raising `max_uses`
or changing `status` to anything but `revoked` when the session role is
`authenticated` (reduce-only edits, OD-02). `verdict`, `last_evidence_at`
and worker-only transitions are written through `privileged`.

## 6. Tests this model needs (O2)

OT-DB-01 RLS: another person can't read, insert into or update any of the
three tables, or point a mandate at another person's thread or goal.
OT-DB-02 transitions: every row of §4 allowed; every other pair raises.
OT-DB-03 `consume_grant`: true up to `max_uses`, then false; status
`exhausted` at the limit; false when revoked, expired, or mandate not
active; idempotent for the same `tool_call_id`; 10 concurrent calls with
`max_uses = 3` give exactly 3 trues (PGlite serialises; also asserted on
the local Supabase stack in O10 preflight). OT-DB-04 `authenticated`
can't execute `consume_grant`. OT-DB-05 `grants_guard`: raising
`max_uses` or un-revoking raises. OT-DB-06 down + up on PGlite with data.
OT-DB-07 the `grants.tool` check rejects any other tool. Plus the existing
`tests/db/lint.test.ts` stays green.

## 7. Retention

Mandates, grants and grant uses live as long as the person's account
(cascade on `auth.users`). Deleting a goal sets `mandates.goal_id` null; the
mandate keeps its verdict. Account deletion removes everything. No phone
numbers or email bodies are stored in these tables; pins hold email
addresses the person approved, which the person can see and revoke.
