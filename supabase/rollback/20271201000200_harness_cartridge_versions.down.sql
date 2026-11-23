-- Undoes 20271201000200_harness_cartridge_versions.sql. Outcome counts go
-- with the versions they count; candidates (20271201000100) stay.
drop table kriya.harness_cartridge_outcomes;
drop table kriya.harness_cartridge_versions;
drop function kriya.harness_versions_guard();
delete from kriya.allowed_transitions where entity = 'harness_version';
delete from supabase_migrations.schema_migrations where version = '20271201000200';
