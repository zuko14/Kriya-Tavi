-- Harness upgrade U9 (owner, 2026-11-04: "I approve Phase U9: go ahead with
-- the database migration for kriya.models (context_window and
-- max_output_tokens)"): what each model can hold, from the provider's public
-- catalogue (lib/models.ts syncCatalogue), so the harness gateway's GET
-- /models tells the client each tier's real window and output cap
-- (lib/harness/model-limits.ts). Unknown stays null, never a guess; existing
-- rows are filled by the owner's next catalogue refresh. The table's RLS and
-- grants are unchanged (it stays owner/server-only).

alter table kriya.models
  add column context_window integer check (context_window is null or context_window > 0),
  add column max_output_tokens integer check (max_output_tokens is null or max_output_tokens > 0);
