# Test strategy (track R)

`npm test` stays offline: PGlite (no `realtime` schema, so the guarded
policy is skipped), the scripted model for agent turns, a fake Realtime
REST endpoint, two or more test users. Staging checks need the owner.
Baseline as track C (Test Files 185 passed, 3 skipped; Tests 2289 passed,
42 skipped); no existing assertion changes.

| Id | Behaviour | File |
| --- | --- | --- |
| RT-REG-01 | `rooms.*` off: room routes 404; no room query runs; agents' prompts, belts and `TOOL_APPROVALS` identical; Inbox and Home unchanged | `tests/rooms/regression.test.ts` |
| RT-IMP-01 | `lib/rooms` imports: no `lib/connectors`, no `lib/agent/metering`; client components import no `lib/rooms` server modules | `tests/rooms/imports.test.ts` |
| RT-DB-01…08 | DATA_MODEL §8 | `tests/db/rooms-rls.test.ts` |
| RT-ACT-01 | Actions validate input with zod, use `withUser`, enforce rate limits | `tests/rooms/actions.test.ts` |
| RT-ACT-02 | Invite create/revoke by admins only; join through a token; capacity | same |
| RT-INV-01 | A permitted mention creates one task in the owner's bridge thread with `channel: "room"` metadata and one invocation row | `tests/rooms/invoke.test.ts` |
| RT-INV-02 | `owner_only` refuses others with a system line | same |
| RT-INV-03 | Members' cap: refused once the day's charges of others' requests reach it | same |
| RT-INV-04 | Busy agent (409) → system line, no task | same |
| RT-INV-05 | Bridge message quotes at most `rooms.contextMessages`, marks them untrusted, names the requester | same |
| RT-INV-06 | Skill selection uses only the request text | same |
| RT-AGT-01 | Room belt omits connector and app tools unless `allow_connectors`; adds `room_history` | `tests/rooms/runner.test.ts` |
| RT-AGT-02 | Room prompt line present only for room tasks; other tasks byte-identical | same |
| RT-AGT-03 | Reply after a private read → disclosure row, room "waiting" line, nothing posted | same |
| RT-AGT-04 | Share posts the exact stored text and card; Discard posts nothing | same |
| RT-AGT-05 | Side-effect tool in a room task → approval in the owner's Inbox only | same |
| RT-AGT-06 | `room_history` reads only the bridge thread's room; output carries `FOREIGN`; memory saved after a room task is unconfirmed | same |
| RT-PRF-01 | Card built only from episode `done` items; claims in text without runs count as `unconfirmed` | `tests/rooms/proof.test.ts` |
| RT-PRF-02 | `file` evidence dropped; only `url`/`provider_id` copied | same |
| RT-PRF-03 | Independent verification marks `verifiedBy` only on matching verified evidence | same |
| RT-PRF-04 | Re-check relay posts a system line when a room task's run changes status | same |
| RT-CND-01 | Follow-on within the budget; refused at the budget | `tests/rooms/conductor.test.ts` |
| RT-CND-02 | No self-follow-on; repeat-text guard | same |
| RT-CND-03 | Mentioned agent's policy checked against the chain's original requester | same |
| RT-CND-04 | Stop agents pauses follow-ons for 10 minutes | same |
| RT-GOAL-01 | A goal item closes only with an attached card whose matching `done` item is verified, or by a member's confirmation labelled "no proof" | `tests/rooms/goals.test.ts` |
| RT-GOAL-02 | The goal's state is computed from items; no tool or model writes it | same |
| RT-GOAL-03 | Only members edit goals; RLS as other room tables | `tests/db/rooms-rls.test.ts` |
| RT-NOTE-01 | Agent notes (`room_note_add`, R1) are saved unconfirmed; a member confirms | `tests/rooms/notes.test.ts` |
| RT-NOTE-02 | Only confirmed notes join the bridge context; nothing is copied into personal memory | same |
| RT-NOTE-03 | `room_note_add` has `TOOL_CLASSES`, `TOOL_WRITES` (`room_notes+`) and capability rows; no person-only column written | same |
| RT-RLT-01…04 | REALTIME §5 | `tests/rooms/realtime.test.ts`, staging |
| RT-MOD-01…03 | Remove, block, report; rate limits | `tests/rooms/moderation.test.ts` |
| RT-UI-01…05 | UX_SPEC §5 browser checks | isolated stack |
