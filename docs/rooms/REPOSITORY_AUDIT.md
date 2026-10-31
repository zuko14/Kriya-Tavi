# Repository audit for Rooms (track R)

What Rooms build on, verified in the code at `508bb6a` on 2026-10-31. The
general baseline is `docs/cloud-execution/REPOSITORY_AUDIT.md`. The code is
the fact.

## 1. Facts Rooms depend on

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| 1 | Every table is single-owner: RLS `user_id = auth.uid()`; threads require exactly one agent or squad of the same owner | `kriya_core.sql` (`threads` check `num_nonnulls(agent_id, squad_id) = 1`, composite FKs) | Rooms are the first data several people read together: new tables with **membership-based** RLS; threads stay single-owner; an agent works in its owner's own "bridge" thread (RD-03) |
| 2 | Squads are one person's agent teams (`squads`, `squad_members`, `delegate`, `assign`) | `run-task.ts` | Not reused for multi-person rooms; unchanged |
| 3 | Tasks are queued per thread (`tasks_one_active_per_thread`), per-user concurrency in `claim_task` | queue | A busy agent can't take a second room request at once (RD-08) |
| 4 | `enqueueTurn` keeps only text parts and sets metadata itself (`metadata: thread.squad ? { agentId } : {}`); channel-specific entry points with their own metadata exist for schedules (`enqueueScheduled`) and crews (`enqueuePart`, O11, owner-approved addition to the protected `queue.ts`) | `lib/agent/queue.ts` | Room context needs `enqueueRoomTurn`, the `enqueuePart` pattern (owner-gated, RD-03) |
| 5 | `TaskInput.channel` is `"web" \| "schedule" \| "crew"` | `db/schema.ts` | Gains `"room"` and `roomId` (type only; `input` is `jsonb`) |
| 6 | Untrusted and private content rules: `untrustedSeen` (memory quarantine), `privateContentSeen` (web tools ask), `FOREIGN` notice | `lib/agent/tools.ts` | Room messages from others are untrusted input; private reads in a room task trigger the disclosure gate (RD-06, RD-07) |
| 7 | "What I did": `kriya.episodes` per task (`done` = verified runs with evidence, `unconfirmed`, K7 `checks`), hash-chained receipts; written only with `agents.inbox` on | `20261101000003_goals_schedules.sql`, `run-task.ts` | Proof cards are built from the bridge task's episode by code (RD-09); Rooms require `agents.inbox` |
| 8 | Delivery status (`deliveryOf`, `deliveryView`) and late re-checks (track N) | `lib/delivery/*` | Re-check results reach rooms as follow-up system messages (RD-09) |
| 9 | Creating share links, confirming ledger entries, approving skills, trusting memory are the person's alone (track A rule 11, `PERSON_ONLY_WRITES`) | `lib/agent/policy.ts` | Sharing anything from outside the room is a person's action; tasks run **in** the room are room-visible by consent at invocation (RD-09) |
| 10 | Bearer links stored as sha256 (`share_links.token_hash`) | `20261110000000_files.sql` | Invite links follow the same pattern (RD-11) |
| 11 | Realtime today: SSE `/api/events` polls the person's tasks every 3 s for up to 10 min; no Supabase Realtime use; `/api/events` and the notifier are protected by track A | `app/api/events/route.ts`, track A CHANGE_IMPACT §2 | Rooms use Supabase Realtime Broadcast with payload-free pings (RD-10); mentions in the notifier need the owner-approved PX-03 |
| 12 | `proxy.ts` CSRF origin check on non-GET; `PROTECTED` pages redirect to `/login?next=…` | `proxy.ts` | Browser room actions pass the origin check as they are; `/rooms` joins `PROTECTED` so invite links survive sign-in |
| 13 | Mobile bottom nav has five tabs: Home, Agents, Inbox (with `agents.inbox`), Tasks, You | `components/workspace/bottom-nav.tsx` | A sixth tab would crowd 360 px: Rooms enter from Home, the sidebar and the command palette (RD-15) |
| 14 | Rate limits: `kriya.hit_rate_limit`, `lib/rate-limit.ts` | code | Message, invite and join limits reuse them |
| 15 | Profiles have `display_name` (person-editable) | `kriya_core.sql` grants | Members see each other's display names, never emails |
| 16 | Notifications policy: approvals use the in-app notifier only; reminders are phone calls only (voice rule 10, track A rule 10) | AGENTS.md | No push, SMS or email for rooms |

## 2. Supabase Realtime facts (official docs read 2026-10-31)

| Fact | Source |
| --- | --- |
| Private channels are authorized by RLS policies on `realtime.messages`; `realtime.topic()` gives the topic; clients set `private: true`; "disable the 'Allow public access' setting" to enforce | supabase.com/docs/guides/realtime/authorization |
| Checked when the client joins; "cached for the duration of the connection"; a removed user keeps receiving until the JWT expires or is refreshed | same |
| Don't `ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY` in migrations (already on; the statement fails) | same |
| Server send over REST `POST /realtime/v1/api/broadcast/{topic}/events/{event}` with `?private=true`, or `realtime.send()` from Postgres | supabase.com/docs/guides/realtime/broadcast |
| Limits: concurrent connections Free 200 / Pro 500 / Team 10,000; messages per second 100 / 500 / 2,500; 100 channels per connection; broadcast payload 256 KB / 3,000 KB | supabase.com/docs/guides/realtime/limits |

## 3. Findings (RF-…)

| Id | Finding | Handling |
| --- | --- | --- |
| RF-01 | No multi-person data model exists; invariant 1's wording is about acting on a person's behalf, and every RLS policy is owner-only | New membership policies through a `security definer` membership function (avoids policy recursion); AGENTS.md invariant 1 gains one sentence (RD-02, owner-gated) |
| RF-02 | Realtime revocation lags until JWT refresh | Pings carry no content; every read goes through `withUser` + RLS, so a removed member's client gets pings but no messages (RD-10) |
| RF-03 | Pro plan allows 500 concurrent Realtime connections | One connection per tab, subscribe only to the open room; fallback polling; capacity table for the owner (REALTIME §4) |
| RF-04 | Episodes are written only with `agents.inbox` on | Rooms with agents require `agents.inbox` (like `next.mcp`) |
| RF-05 | `/api/events` and the notifier are protected (track A) | Mentions in the notifier only with PX-03; otherwise unread counts on Home and in the room list |
