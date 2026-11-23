-- Undoes 20271201000100_harness_candidates.sql. Candidates are platform data
-- (no person's); their audit events stay, as every audit record does.
drop function kriya.harness_candidate_transition(uuid, text, uuid, text, jsonb, jsonb);
drop table kriya.harness_cartridge_candidates;
drop function kriya.harness_candidates_guard();
delete from kriya.allowed_transitions where entity = 'harness_candidate';
delete from supabase_migrations.schema_migrations where version = '20271201000100';
