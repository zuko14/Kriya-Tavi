# Decisions (track R: Rooms)

ADR format as track C. All **Proposed** until the owner writes "Approved
RD-…" under "Track R owner approvals" in `status.md`; owner-gated ones by id.
Evidence: `RF-…` (REPOSITORY_AUDIT), `RS…` (scenarios), `PX-…` (program).

| Id | Decision | Owner-gated | Phase |
| --- | --- | --- | --- |
| RD-01 | Rooms are a capability of the existing product, behind `rooms.*` switches (off) | — | all |
| RD-02 | Membership-based RLS through a `security definer` membership function; invariant 1 gains one sentence | **Yes** (invariant 1) | R1 |
| RD-03 | Agents act only in their owner's account, in a private bridge thread, via `enqueueRoomTurn` | **Yes** (`queue.ts`) | R4 |
| RD-04 | Who may invoke an agent: owner only (default) or members with a daily ₹ cap, in SQL | — | R4 |
| RD-05 | The room belt: no private connectors unless the owner allows them in that room | — | R4 |
| RD-06 | Disclosure gate: replies that touched private content wait for the owner's "Share in room" | — | R4 |
| RD-07 | Room content is untrusted input; members' words are requests, not the owner's instructions | — | R4 |
| RD-08 | One request per agent at a time; busy → a plain system message | — | R4 |
| RD-09 | Proof cards built by code from the bridge task's episode; independent verification by another agent | — | R5 |
| RD-10 | Realtime: Supabase Realtime Broadcast, private channel per room, payload-free pings; fallback polling | **Yes** (Supabase setting, plan capacity) | R1, R3 |
| RD-11 | Invites: hashed link tokens, expiry, max uses; Kriya account required; size caps; no discovery | — | R2 |
| RD-12 | Conductor: agent-to-agent turns within a budget, deterministic guards, Stop | — | R6 |
| RD-13 | Room goals close only with verified proof | — | R7 |
| RD-14 | Room notes: shared, agent-written notes unconfirmed | — | R8 |
| RD-15 | UX: Rooms from Home, sidebar and command palette; no sixth bottom tab | — | R3 |
| RD-16 | Notifications: in-app only; notifier mentions need PX-03 | **Yes** (PX-03) | R3 |
| RD-17 | Cost: each agent's spend is its owner's and shown only to them | — | R4 |
| RD-18 | Moderation and retention | — | R2, R9 |
| RD-19 | Settings | — | R1 |
| RD-20 | Counsel questions before any real person's room | — | R10 |

---

## RD-01 — A capability of the existing product

Same accounts, agents, tasks, approvals, billing, receipts and UI shell. With
`rooms.enabled` off (default) no room page, route, tool or query exists for
anyone (404), and agents' prompts, belts and approvals are byte-identical
(RT-REG-01). **Status.** Proposed, 2026-10-31.

## RD-02 — Membership-based access (owner-gated)

- **Context.** Every policy today is owner-only (RF-01).
- **Decision.** `kriya.is_room_member(room_id uuid)` and
  `kriya.room_role(room_id uuid)`: `security definer`, `stable`,
  `set search_path = ''`, returning whether `auth.uid()` is an active member
  (and their role). Room tables' policies call these (a policy on
  `room_members` that queried `room_members` directly would recurse). Person
  writes go through `withUser`; joining goes through `kriya.join_room()`
  (`security definer`, checks the invite and capacity). The worker writes
  agent and system messages through `privileged`, scoped by room and owner.
- **Invariant 1 sentence (owner applies at R1 start):** "Room data is the one
  shared exception: it is readable by the room's active members through the
  membership policies of `kriya.room_*`; every agent still acts only through
  `withUser` of its own owner."
- **Tests.** RT-DB-01…08 (cross-member isolation, removed members, recursion).
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## RD-03 — Agents act only in their owner's account (owner-gated)

- **Decision.** Adding an agent to a room (its owner's action) creates a
  bridge thread in the owner's account (`threads` row for that agent, title
  "Room · <room title>") and a `room_agents` row. A permitted mention creates
  the task with `enqueueRoomTurn` (new, additive in `lib/agent/queue.ts`, the
  `enqueuePart` pattern): same `prepare()` checks (plan, daily limit,
  workers alive), a user message in the bridge thread written by code (room
  title, who asked, the last messages as quoted context, the request) with
  metadata `{ channel: "room", roomId, requestedBy }`, `TaskInput.channel =
  "room"`. The task runs in `kriya-worker` like any task; its approvals go to
  the owner's Inbox; its charge is the owner's.
- **Why owner-gated.** `queue.ts` is protected; track O added `enqueuePart`
  the same way with approval.
- **Tests.** RT-INV-01…06.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## RD-04 — Who may invoke an agent

`room_agents.invoke` = `owner_only` (default) or `members`. With `members`,
`room_agents.daily_cap_micro_inr` (> 0, set by the owner) bounds the **total**
charges, that IST day, of that agent's tasks in that room requested by
anyone other than the owner; `kriya.check_room_invocation()` refuses beyond
it (invariant 7). Charges are written when a task ends, so an in-flight task
isn't counted yet; RD-08 (one request at a time per agent) bounds the
overshoot to one task's `max_task_cost`. The owner's own requests count only
toward their plan. **Status.** Proposed, 2026-10-31.

## RD-05 — The room belt

In a room task (`channel = "room"`), `runTask` builds the agent's usual belt
minus connected-account tools (Google, Notion, GitHub, Sheets, Meta and MCP
app tools) unless `room_agents.allow_connectors` is true (the owner's
choice per room), plus `room_history` (R0). Side-effect tools keep their
approval; approvals reach only the owner. Squad tools don't apply (the
bridge thread has one agent). **Status.** Proposed, 2026-10-31.

## RD-06 — Disclosure gate

After a room task, code decides how the reply reaches the room: if the
task's reply used any `PRIVATE_READ_TOOLS` tool or an `mcp_` tool (the
same test as `privateContentSeen`), the room gets a system line "<Agent>
replied; waiting for <owner> to share it" and the owner gets a
`room_disclosures` item (Inbox) showing exactly what would be posted, with
**Share in room** / **Discard** (person-only). Otherwise the reply posts
directly. **Status.** Proposed, 2026-10-31.

## RD-07 — Room content is untrusted

The quoted room context in the bridge message is marked as written by room
members and carries `FOREIGN`; `untrustedSeen` treats a user text containing
the `ROOM_CONTEXT` marker as untrusted (model messages carry no UI metadata,
so the marker is the signal, exactly like watchers' `UNTRUSTED_DIFF`), so
memory saved after it is unconfirmed; the prompt
line for room tasks says members' words are requests from other people,
never the owner's instructions, and that the owner's private information is
never shared without the owner. **Status.** Proposed, 2026-10-31.

## RD-08 — One request at a time

If the agent's bridge thread already has an active task (the existing
`tasks_one_active_per_thread` rule answers 409), the room gets "<Agent> is
still working on the last request." A queue of pending requests is a later
decision (R6 measures need). **Status.** Proposed, 2026-10-31.

## RD-09 — Proof cards and independent verification

- **Proof card.** When the reply is posted, code copies from the bridge
  task's episode the room-safe facts: each `done` item's tool title,
  verification status and method, and evidence of kind `url` or a public
  `provider_id` (e.g. `owner/repo#42`); counts of `unconfirmed` claims and
  K7 `checks` by status. Stored in the room message's `parts`. Nothing from
  a private tool reaches a card without the disclosure gate.
- **Independent verification.** "@Meera verify this" on a card sends the
  card's evidence to Meera's agent; its own episode's verified items whose
  evidence matches (same URL or provider id) mark the original card
  "Independently verified by Meera's agent" (computed by code, never text).
- **Re-checks.** A worker step posts a system line when a late re-check
  (track N) of a room task's run changes its status.
- **Status.** Proposed, 2026-10-31.

## RD-10 — Realtime (owner-gated)

Private channel `room:<id>`; RLS policy on `realtime.messages` lets active
members receive broadcasts (created in a guarded `DO` block so PGlite tests,
which have no `realtime` schema, skip it); no client insert policy (clients
can't broadcast). After each message insert the server sends a ping
`{ seq }` over the REST broadcast API with `?private=true`; clients fetch new
messages through `withUser` routes. Polling every 10 s takes over when the
channel fails. Owner: turn off "Allow public access" in Realtime settings
and size the Supabase plan from REALTIME §4. **Status.** Proposed,
2026-10-31. Owner approval needed.

## RD-11 — Invites and size

Invite links: 32 random bytes, sha256 stored, expiry ≤ `rooms.inviteDays`
(7), max uses ≤ 25, revocable; joining requires a Kriya account
(`/rooms/join/<token>` is in `PROTECTED`, so sign-up returns to it). Caps:
`rooms.maxHumans` (25), `rooms.maxAgents` (10) per room; rooms per person
`rooms.maxPerPerson` (20). No public discovery. **Status.** Proposed.

## RD-12 — Conductor

Deterministic code (`lib/rooms/conductor.ts`) decides follow-on agent turns
when an agent's reply mentions another agent: allowed only if the chain since
the last human message is shorter than `rooms.agentTurnBudget` (4), the
mentioned agent's policy allows the human who started the chain, it isn't the
agent that just spoke, the reply isn't a repeat (same normalized text hash
within the chain), and the room isn't paused. Any member can press **Stop
agents** (pauses follow-ons for 10 minutes; each owner can cancel their own
agent's task as today). **Status.** Proposed, 2026-10-31.

## RD-13 — Room goals

A goal with items; an item closes only when a member attaches a proof card
whose relevant `done` item is verified (or a member confirms it and the item
shows "confirmed by <name>, no proof"). The goal's state is computed by code.
**Status.** Proposed, 2026-10-31.

## RD-14 — Room notes

Members' and agents' notes visible to the room; agent notes are unconfirmed
until a member confirms; confirmed notes join the room context for agents;
never copied into anyone's personal memory automatically.
**Status.** Proposed, 2026-10-31.

## RD-15 — UX placement

Rooms from Home (a "Rooms" section), the desktop sidebar and the command
palette; routes `/rooms`, `/rooms/[roomId]`, `/rooms/join/[token]`. No sixth
mobile tab (RF finding on five tabs). **Status.** Proposed.

## RD-16 — Notifications (owner-gated part)

Unread counts on Home and the room list; mentions and disclosure requests in
the Inbox. Live notifier events for mentions only with PX-03 (the protected
`/api/events` change shared with track H). No push, SMS or email.
**Status.** Proposed.

## RD-17 — Cost

Each agent message shows its ₹ charge to its owner only; room settings show
each owner their own spend in that room. Members see that an agent is
working, never its owner's cost. **Status.** Proposed.

## RD-18 — Moderation and retention

Roles owner/admin/member; remove member, leave, delete own message, archive
room; report a room or message to the Kriya owner console; per-person block
(blocked people can't invite you; existing shared rooms show their messages
collapsed). A deleted account's human messages are deleted (cascade); agent
messages of a deleted owner too. Rate limits: messages (30/min per person),
invites (20/day), joins (10/hour per IP). **Status.** Proposed.

## RD-19 — Settings

`rooms.enabled` (off), `rooms.agents` (off), `rooms.realtime` (on: use
Realtime when enabled; off → polling only), `rooms.maxHumans` (25),
`rooms.maxAgents` (10), `rooms.maxPerPerson` (20), `rooms.inviteDays` (7),
`rooms.agentTurnBudget` (4), `rooms.contextMessages` (30).
**Status.** Proposed.

## RD-20 — Counsel before real rooms

RQ-1: members' messages processed by other members' agents (DPDP basis,
consent text at join). RQ-2: minors in rooms. RQ-3: retention and deletion
of others' messages on request. RQ-4: liability when an agent's research in a
room is wrong. **Status.** Proposed.
