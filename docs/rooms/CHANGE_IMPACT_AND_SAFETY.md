# Change impact and safe execution (track R: Rooms)

Read **before editing any existing file**. A change not in §3 needs the
owner's approval and a row here first. Where tracks A, O, N, voice, C or H
also list a file, all rules apply; hold it on the shared board.

Verified against `508bb6a` on 2026-10-31; baseline as track C's
(Test Files 185 passed, 3 skipped; Tests 2289 passed, 42 skipped; exit 0).

## 1. Protected

Everything protected by the other tracks, plus:

| Path | Track R's only exception |
| --- | --- |
| `lib/agent/queue.ts` | **R4, owner-approved (RD-03):** additive `enqueueRoomTurn`, the `enqueuePart` pattern; existing functions unchanged |
| AGENTS.md invariant 1 | **R1, owner applies** the RD-02 sentence |
| `kriya.threads`, `kriya.tasks` and their functions | None: bridge threads are ordinary threads; room tasks are ordinary tasks |
| `lib/agent/policy.ts` values | Additions only (§3) |
| `app/api/events/route.ts`, `components/workspace/notifier.tsx` | Only with PX-03 approved (shared with track H) |
| `lib/delivery/*` (track N) | None: the re-check relay reads `delivery_checks` rows through its own query |
| Every applied migration | None |

## 2. Prerequisites

| Id | Change | Test |
| --- | --- | --- |
| RP-1 | Re-run `env -u OPENROUTER_API_KEY npm run check`; record counts | Exit 0, counts ≥ baseline |

## 3. Existing files that change

| File | Phase | Allowed change | Must stay true | Regression test |
| --- | --- | --- | --- | --- |
| `db/schema.ts` | R1, R4, R7 | R1: the seven room tables. R4: `TaskInput.channel` gains `"room"` and optional `roomId`. R7: `roomGoals`, `roomGoalItems`, `roomNotes` (second migration, used by R8 too) | Existing definitions unchanged | Typecheck; AT-REG-01 |
| `tests/db/migrations.test.ts` | R1, R7 | Down/up cases for track R migrations; older cases roll track R back first | Existing assertions unchanged | Itself |
| `lib/config.ts` | R1 | `rooms.*` block (RD-19) under `// Rooms (track R)` | Existing keys untouched | RT-REG-01 |
| `app/owner/config/page.tsx` | R1 | `GROUPS` entry "Rooms" (`["rooms."]`) | Existing groups unchanged | RT-UI-05 |
| `proxy.ts` | R2 | `"/rooms/"` in `PROTECTED` (with the slash, the voice `"/calls/"` precedent: `startsWithAny` then matches `/rooms` and `/rooms/…`, including `/rooms/join/…`, but not `/roomsx`; keeps `?next=`); `"/api/rooms/"` in `PROTECTED_API` (signed-out requests get the JSON 401 like `/api/threads`) | Other paths unchanged; the origin check stays on for every room action and route | RT-ACT-02; existing proxy behaviour |
| `app/(workspace)/home/page.tsx`, `components/workspace/sidebar.tsx`, `components/workspace/command-palette.tsx` | R3 | A Rooms section / item / entry only with `rooms.enabled` on | Off → identical | RT-REG-01; RT-UI-01 |
| `lib/agent/queue.ts` (protected) | R4 | `enqueueRoomTurn` (RD-03) | Existing exports unchanged | `tests/db/queue.test.ts`, `tests/pipeline.test.ts` unchanged; RT-INV-01 |
| `lib/agent/tools.ts` | R4 | `export { createRoomTools } from "@/lib/rooms/tools"`; `KriyaTools` += `Partial<…>`; `KriyaMetadata.channel` gains `"room"` with `roomId`, `requestedBy`; `untrustedSeen` also matches user texts containing `ROOM_CONTEXT` (imported from `lib/rooms/context.ts`, the `UNTRUSTED_DIFF` pattern) | Existing tools, `FOREIGN`, `PRIVATE_READ_TOOLS`, `SIDE_EFFECT_TOOLS` unchanged | AT-REG-01; `tests/agent/share.test.ts`; RT-AGT-06 |
| `lib/agent/policy.ts` | R4, R7, R8 | R4: `TOOL_CLASSES.room_history = "R0"`, `TOOL_WRITES.room_history = []`; `PERSON_ONLY_WRITES += "rooms", "room_members", "room_invites", "room_agents", "room_disclosures"`. R7: `PERSON_ONLY_WRITES += "room_goals", "room_goal_items"`. R8: `TOOL_CLASSES.room_note_add = "R1"`, `TOOL_WRITES.room_note_add = ["room_notes+"]`, `PERSON_ONLY_WRITES += "room_notes.confirmed_by"` | No existing value changes | AT-POL-01/02/07, `tests/agent/improve.test.ts` |
| `lib/agent/capabilities.ts` | R4, R8 | `FACTS.room_history`, `FACTS.room_note_add` = `{ system: "kriya" }` | `GRANTABLE` unchanged | OT-CAP-* |
| `lib/agent/instructions.ts` | R4 | `Capabilities.room?: { title }` and a `ROOM_LINE` emitted only when set | Not set → byte-identical prompt | AT-REG-01 |
| `lib/agent/run-task.ts` | R4 | ARCHITECTURE §4: room belt filter and `room_history` for `channel === "room"`; `capabilities.room`; skill `ask` = the text after the request marker for room messages; `relayToRoom` after the episode write | Non-room tasks: identical belt, prompt, approvals, records | RT-REG-01, NT-REG-01, OT-REG-01, `tests/agent/runner-*.test.ts` |
| `queries/inbox.ts`, `actions/inbox.ts` (`inboxBadge`), `app/(workspace)/inbox/page.tsx` | R4 | Room disclosure items and count only with `rooms.agents` on | Off → identical | RT-AGT-03; Inbox tests |
| `worker/index.ts` | R5 | One `try` block in `schedulerLoop`: `roomRecheckRelay()` with `rooms.agents` and `next.recheck` on | Other steps untouched | RT-PRF-04 |
| `components/owner/nav.tsx` | R9 | "Rooms" link to `/owner/rooms` (reports) | Existing links unchanged | RT-UI-05 |
| `app/api/events/route.ts` (protected) | R3 | Only with PX-03: mention events | Existing events unchanged | Events tests |
| `AGENTS.md` | R0, R1 | R0: track R section; R1: invariant 1 sentence | Other text unchanged | — |
| `status.md` | every phase | Own section and rows | Others untouched | — |

**New files** (no row needed): `lib/rooms/**`, `actions/rooms.ts`,
`queries/rooms.ts`, `app/(workspace)/rooms/**`, `app/api/rooms/**`,
`app/owner/rooms/**`, `components/rooms/**`, `components/inbox/room-disclosure.tsx`,
`tests/rooms/**`, `tests/db/rooms-rls.test.ts`, migrations
`20270401000000_rooms.sql`, `20270401000100_room_goals_notes.sql` and
rollbacks, `screenshots/rooms/**`.

**Dependencies:** none (supabase-js and `@supabase/ssr` are already used).

## 4. Boundaries

`lib/rooms/*` never imports `lib/connectors` or `lib/agent/metering`;
`lib/rooms/context.ts` is pure (it exports `ROOM_CONTEXT` for
`untrustedSeen`). Client components import only types from `lib/rooms`.

## 5. Cross-track check

| File | Others | Conflict? |
| --- | --- | --- |
| `lib/agent/run-task.ts` | A, O, N, voice, C | Track R's lines are inside `channel === "room"` branches plus one relay call; C's workspace lines are independent (a room task may also have a workspace) |
| `lib/agent/tools.ts` | A, O, N, voice, C | Additive type members and one marker check in `untrustedSeen` |
| `lib/agent/queue.ts` | O (`enqueuePart`) | One additive function, owner-approved |
| `queries/inbox.ts`, `actions/inbox.ts` | A3, N2, H5 | Separate sections behind each track's switch; hold one at a time |
| `proxy.ts` | H (TOKEN_API, `/connect/`), voice, A5 | Separate list entries |
| `app/api/events/route.ts` | A (protected), H | One combined PX-03 change |

## 6. Stop conditions

Stop and ask when you'd touch a §1 file beyond its exception or a file not
in §3; need a real Supabase project, Realtime settings, accounts or a
deploy; or a local run would reach the live database.
