-- Reverses 20261111000000_ledger.sql. Ledger entries, invoices, their
-- number series and cross-check verdicts are deleted (export first); their
-- PDFs stay in the person's files. Switch agents.ledger and
-- agents.crossCheck off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20261111000000_ledger.down.sql

-- issue_invoice() returns the invoices row type, so it goes first
drop function if exists kriya.issue_invoice(uuid);
drop table if exists kriya.claim_checks;
drop table if exists kriya.invoices;
drop table if exists kriya.invoice_series;
drop table if exists kriya.ledger_entries;
drop function if exists kriya.financial_year(date);
drop function if exists kriya.ledger_within_plan();
drop function if exists kriya.invoices_guard();
drop function if exists kriya.ledger_entries_guard();
delete from kriya.allowed_transitions where entity in ('ledger_entry', 'invoice');
alter table kriya.plans drop column if exists ledger_enabled;
delete from supabase_migrations.schema_migrations where version = '20261111000000';
