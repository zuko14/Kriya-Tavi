-- Memory v2: the person can pause one agent's memory (MEMORY_AND_CONTEXT.md
-- §11; owner's decision of 2026-10-18 on AF-26). While paused, that agent's
-- memory_write and memory_update save nothing. Only the person sets it: the
-- agents table already has row security and the person's own grant, and no
-- agent tool writes this column.

alter table kriya.agents add column memory_paused boolean not null default false;
