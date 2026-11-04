-- Rollback of 20270801000000_harness_control.sql
drop table if exists kriya.harness_runs;
drop table if exists kriya.harness_dispatches;
drop table if exists kriya.harness_device_state;
delete from kriya.allowed_transitions where entity = 'harness_dispatch';
