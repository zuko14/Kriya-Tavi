-- Verification calls (voice phase 6, D-13; owner decision 2026-10-20).
--
-- Verifying the owner's number is a call with no task, so a verification
-- call, and the transitions voice_transition() records for it, carry no
-- voice_task_id. Every other call still must have one. The composite
-- foreign keys to voice_tasks aren't checked while voice_task_id is null.

alter table kriya.voice_calls alter column voice_task_id drop not null;
alter table kriya.voice_calls add constraint voice_calls_task_unless_verification
  check ((voice_task_id is null) = (kind = 'verification'));

alter table kriya.voice_transitions alter column voice_task_id drop not null;

-- phone_verifications.voice_call_id stays a plain uuid, set in the same
-- transaction as the call: a foreign key would stop the voice core's
-- rollback (it drops voice_calls first) while this migration is applied
