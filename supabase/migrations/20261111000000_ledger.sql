-- Accounts (A7, AD-16, AD-17): bills and income as single-entry ledger
-- rows, GST invoices with gapless numbers, and the K7 model cross-check's
-- verdicts. Money is integer paise; every total is checked here, not only
-- in code. Only the person confirms entries (no agent tool writes that
-- status, AT-POL-07); reports count confirmed entries only.

/* ───────────────────────────── ledger ───────────────────────────── */

create table kriya.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('expense', 'income')),
  status text not null default 'draft'
    check (status in ('draft', 'needs_review', 'confirmed', 'void')),
  entry_date date not null,
  counterparty text check (char_length(counterparty) <= 200),
  -- 15 characters; the structure by registration type and the check
  -- character are checked in lib/gst.ts (AF-29: not every GSTIN has 'Z')
  counterparty_gstin text check (counterparty_gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  document_no text check (char_length(document_no) <= 40),
  category text check (char_length(category) <= 60),
  place_of_supply text check (place_of_supply ~ '^[0-9]{2}$'),
  taxable_paise bigint not null default 0 check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  -- State tax, or Union territory tax for a Union territory (CGST Act s. 2(114))
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  igst_paise bigint not null default 0 check (igst_paise >= 0),
  cess_paise bigint not null default 0 check (cess_paise >= 0),
  round_off_paise bigint not null default 0 check (round_off_paise between -100 and 100),
  total_paise bigint not null,
  -- [{ description, hsn_sac, qty_milli, rate_paise, amount_paise, tax_rate_bps }]
  line_items jsonb not null default '[]'
    check (case when jsonb_typeof(line_items) = 'array' then jsonb_array_length(line_items) <= 200 else false end),
  review_reasons text[] not null default '{}',
  -- The person's note when confirming an entry that needed review
  review_note text check (char_length(review_note) <= 500),
  file_id uuid references kriya.files (id) on delete set null,
  extraction jsonb,
  created_by text not null check (created_by in ('agent', 'user')),
  task_id uuid references kriya.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise),
  check (status <> 'confirmed' or confirmed_at is not null),
  check (cgst_paise = 0 and sgst_paise = 0 or igst_paise = 0)
);
create index ledger_entries_user_idx on kriya.ledger_entries (user_id, entry_date desc);
-- The same bill twice (AT-LED-04)
create unique index ledger_entries_document_idx
  on kriya.ledger_entries (user_id, kind, counterparty_gstin, document_no)
  where status <> 'void' and counterparty_gstin is not null and document_no is not null;
create trigger ledger_entries_touch before update on kriya.ledger_entries
  for each row execute function kriya.touch_updated_at();

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('ledger_entry', 'draft', 'confirmed'),
  ('ledger_entry', 'draft', 'needs_review'),
  ('ledger_entry', 'draft', 'void'),
  ('ledger_entry', 'needs_review', 'draft'),
  ('ledger_entry', 'needs_review', 'confirmed'),
  ('ledger_entry', 'confirmed', 'void');
create trigger ledger_entries_transition before update of status on kriya.ledger_entries
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('ledger_entry');

-- A confirmed entry is a record: only voiding it is allowed
create function kriya.ledger_entries_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('confirmed', 'void') and (
    (new.kind, new.entry_date, new.counterparty, new.counterparty_gstin, new.document_no,
     new.category, new.place_of_supply, new.taxable_paise, new.cgst_paise, new.sgst_paise,
     new.igst_paise, new.cess_paise, new.round_off_paise, new.total_paise, new.line_items,
     new.confirmed_at)
    is distinct from
    (old.kind, old.entry_date, old.counterparty, old.counterparty_gstin, old.document_no,
     old.category, old.place_of_supply, old.taxable_paise, old.cgst_paise, old.sgst_paise,
     old.igst_paise, old.cess_paise, old.round_off_paise, old.total_paise, old.line_items,
     old.confirmed_at)
  ) then
    raise exception 'a confirmed ledger entry can only be voided';
  end if;
  return new;
end $$;
create trigger ledger_entries_guard before update on kriya.ledger_entries
  for each row execute function kriya.ledger_entries_guard();

/* ──────────────────────────── invoices ──────────────────────────── */

-- One counter per person, series and financial year, locked while an
-- invoice takes its number (AD-17)
create table kriya.invoice_series (
  user_id uuid not null references auth.users (id) on delete cascade,
  series text not null check (series ~ '^[A-Z0-9]{1,4}$'),
  fy text not null check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix text not null check (char_length(prefix) <= 11),
  next_number integer not null default 1 check (next_number >= 1),
  primary key (user_id, series, fy)
);

create table kriya.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  series text not null default 'INV' check (series ~ '^[A-Z0-9]{1,4}$'),
  fy text check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  number integer check (number >= 1),
  -- CGST Rule 46(b): ≤ 16 characters; letters, digits, "-" and "/"
  number_text text check (number_text ~ '^[A-Za-z0-9/-]{1,16}$'),
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'void')),
  issue_date date,
  due_date date,
  supplier jsonb not null,
  -- { name, gstin?, address, state_code }
  client jsonb not null,
  place_of_supply text not null check (place_of_supply ~ '^[0-9]{2}$'),
  items jsonb not null
    check (case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) between 1 and 100 else false end),
  taxable_paise bigint not null default 0 check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  igst_paise bigint not null default 0 check (igst_paise >= 0),
  cess_paise bigint not null default 0 check (cess_paise >= 0),
  round_off_paise bigint not null default 0 check (round_off_paise between -100 and 100),
  total_paise bigint not null,
  notes text check (char_length(notes) <= 2000),
  pdf_file_id uuid references kriya.files (id) on delete set null,
  ledger_entry_id uuid references kriya.ledger_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_at timestamptz,
  paid_at timestamptz,
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise),
  check (cgst_paise = 0 and sgst_paise = 0 or igst_paise = 0),
  -- A draft has no number; anything issued has one, for good
  check ((status = 'draft') = (number is null)),
  check ((number is null) = (number_text is null) and (number is null) = (fy is null))
);
create unique index invoices_number_idx on kriya.invoices (user_id, series, fy, number)
  where number is not null;
create index invoices_user_idx on kriya.invoices (user_id, created_at desc);
create trigger invoices_touch before update on kriya.invoices
  for each row execute function kriya.touch_updated_at();

insert into kriya.allowed_transitions (entity, from_status, to_status) values
  ('invoice', 'draft', 'issued'),
  ('invoice', 'issued', 'paid'),
  ('invoice', 'issued', 'void');
create trigger invoices_transition before update of status on kriya.invoices
  for each row when (old.status is distinct from new.status)
  execute function kriya.check_transition('invoice');

-- An issued invoice keeps its number and contents; it can be paid, voided,
-- linked to its PDF or ledger entry
create function kriya.invoices_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' and (
    (new.series, new.fy, new.number, new.number_text, new.issue_date, new.supplier, new.client,
     new.place_of_supply, new.items, new.taxable_paise, new.cgst_paise, new.sgst_paise,
     new.igst_paise, new.cess_paise, new.round_off_paise, new.total_paise, new.notes)
    is distinct from
    (old.series, old.fy, old.number, old.number_text, old.issue_date, old.supplier, old.client,
     old.place_of_supply, old.items, old.taxable_paise, old.cgst_paise, old.sgst_paise,
     old.igst_paise, old.cess_paise, old.round_off_paise, old.total_paise, old.notes)
  ) then
    raise exception 'an issued invoice can''t be changed';
  end if;
  return new;
end $$;
create trigger invoices_guard before update on kriya.invoices
  for each row execute function kriya.invoices_guard();

-- India's financial year of a date: April to March, e.g. 2026-27
create function kriya.financial_year(d date) returns text language sql immutable as $$
  select case when extract(month from d) >= 4
    then extract(year from d)::int || '-' || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
    else (extract(year from d)::int - 1) || '-' || lpad((extract(year from d)::int % 100)::text, 2, '0')
  end
$$;

-- Issues a draft: the series row is locked, so two issues at once queue
-- and each takes the next number; nothing is skipped or reused (AD-17).
-- Issuing again returns the invoice as it is. Runs as the person
-- (withUser), so RLS applies.
create function kriya.issue_invoice(p_invoice uuid) returns setof kriya.invoices
language plpgsql as $$
declare
  v_inv kriya.invoices;
  v_date date;
  v_fy text;
  v_series kriya.invoice_series;
  v_text text;
begin
  select * into v_inv from kriya.invoices where id = p_invoice for update;
  if not found then
    raise exception 'invoice not found';
  end if;
  if v_inv.status <> 'draft' then
    return next v_inv;
    return;
  end if;
  v_date := coalesce(v_inv.issue_date, (now() at time zone 'Asia/Kolkata')::date);
  v_fy := kriya.financial_year(v_date);
  -- e.g. INV/26-27/ then 001: at most 4 + 7 + 5 = 16 characters
  insert into kriya.invoice_series (user_id, series, fy, prefix)
    values (v_inv.user_id, v_inv.series, v_fy, v_inv.series || '/' || right(v_fy, 5) || '/')
    on conflict do nothing;
  select * into v_series from kriya.invoice_series
    where user_id = v_inv.user_id and series = v_inv.series and fy = v_fy
    for update;
  v_text := v_series.prefix || lpad(v_series.next_number::text, 3, '0');
  if char_length(v_text) > 16 then
    raise exception 'invoice number longer than 16 characters; start a new series';
  end if;
  update kriya.invoice_series set next_number = next_number + 1
    where user_id = v_inv.user_id and series = v_inv.series and fy = v_fy;
  update kriya.invoices
    set number = v_series.next_number, number_text = v_text, fy = v_fy, status = 'issued',
        issue_date = v_date, issued_at = now()
    where id = p_invoice
    returning * into v_inv;
  return next v_inv;
end $$;

-- Plans without the ledger can't add entries or invoices (invariant 7)
create function kriya.ledger_within_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce((select p.ledger_enabled from kriya.plans p
                   where p.id = kriya.effective_plan_id(new.user_id)), false) then
    raise exception 'the ledger isn''t on this plan';
  end if;
  return new;
end $$;
create trigger ledger_entries_plan before insert on kriya.ledger_entries
  for each row execute function kriya.ledger_within_plan();
create trigger invoices_plan before insert on kriya.invoices
  for each row execute function kriya.ledger_within_plan();

alter table kriya.ledger_entries enable row level security;
alter table kriya.invoice_series enable row level security;
alter table kriya.invoices enable row level security;

create policy read_own on kriya.ledger_entries for select to authenticated
  using (user_id = (select auth.uid()));
-- Born a draft or needing review, never confirmed
create policy insert_own on kriya.ledger_entries for insert to authenticated
  with check (user_id = (select auth.uid()) and status in ('draft', 'needs_review')
              and confirmed_at is null);
create policy update_own on kriya.ledger_entries for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Drafts can go; anything confirmed is voided instead
create policy delete_draft on kriya.ledger_entries for delete to authenticated
  using (user_id = (select auth.uid()) and status in ('draft', 'needs_review'));
grant select, insert, update, delete on kriya.ledger_entries to authenticated;

create policy all_own on kriya.invoice_series for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on kriya.invoice_series to authenticated;

create policy read_own on kriya.invoices for select to authenticated
  using (user_id = (select auth.uid()));
create policy insert_draft on kriya.invoices for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'draft');
create policy update_own on kriya.invoices for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- A number, once given, is never freed (AD-17)
create policy delete_draft on kriya.invoices for delete to authenticated
  using (user_id = (select auth.uid()) and status = 'draft');
grant select, insert, update, delete on kriya.invoices to authenticated;
grant execute on function kriya.issue_invoice(uuid) to authenticated;

/* ──────────────────────── K7 model cross-check ──────────────────── */

-- A model's verdict on a cited claim the verbatim check couldn't decide
-- (AD-33): never on money. Episodes are immutable, so verdicts live here.
create table kriya.claim_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id uuid not null references kriya.episodes (id) on delete cascade,
  sentence text not null check (char_length(sentence) <= 300),
  verdict text not null check (verdict in ('supported', 'contradicted', 'not_found')),
  model text not null,
  created_at timestamptz not null default now(),
  unique (episode_id, sentence)
);
alter table kriya.claim_checks enable row level security;
create policy read_own on kriya.claim_checks for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.claim_checks to authenticated;

-- Conservative placeholder; the owner turns it on per plan in /owner
alter table kriya.plans add column ledger_enabled boolean not null default false;
