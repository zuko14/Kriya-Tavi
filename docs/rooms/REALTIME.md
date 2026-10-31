# Realtime for rooms (track R)

## 1. Design

| Piece | Choice | Why |
| --- | --- | --- |
| Transport | Supabase Realtime Broadcast, private channel `room:<roomId>` | Already part of the Supabase project; no new service on Render; scales with the Supabase plan |
| Authorization | RLS policy on `realtime.messages` calling `kriya.is_room_member` (DATA_MODEL §5) | Join-time check, cached per connection (docs) |
| What is sent | A ping `{ seq }` only (event `seq`) | A removed member whose JWT hasn't refreshed learns only that something changed (RF-02); content always comes through `withUser` reads |
| Who sends | Server only, REST `POST /realtime/v1/api/broadcast/room:<id>/events/seq?private=true` with the secret key, from `lib/rooms/realtime.ts` after each committed insert | Clients have no insert policy, so they can't fake pings; REST sends open no server connections (docs: server-side subscriptions are billed as recipients) |
| Client | supabase-js browser client, `channel('room:<id>', { config: { private: true } })`, subscribed only while the room page is open | One connection per tab; one channel per open room |
| Catch-up | `GET /api/rooms/[roomId]/messages?after=<seq>` (`withUser`, ≤ 100 rows) on each ping, on focus and on reconnect | Pings may be dropped; the seq makes reads idempotent |
| Fallback | Poll the same route every 10 s while the channel isn't `SUBSCRIBED`, or always when `rooms.realtime` is off | Works with Realtime disabled, misconfigured or over quota |

## 2. Why not the alternatives

| Option | Problem |
| --- | --- |
| Extend `/api/events` SSE polling | Protected by track A; per-client DB polling every 3 s doesn't suit chat latency or scale |
| Postgres `LISTEN/NOTIFY` in `kriya-web` | `DATABASE_URL` is the transaction pooler (`render.yaml`: port 6543); `LISTEN` needs a session connection per web instance; adds fan-out code we'd own |
| `postgres_changes` subscriptions | Would need `kriya` tables in the Realtime publication and their rows sent to clients; payloads bypass our `withUser` reads |
| A new WebSocket service on Render | Another service to run and scale; Supabase already provides this |

## 3. Owner setup (once per project)

1. Realtime → Settings: turn **off** "Allow public access" (required for
   private channels to be enforced, per the docs). Nothing in Kriya uses
   public Realtime today (RF row 11).
2. Apply the migration (the guarded policy is created only where the
   `realtime` schema exists).
3. Check: as a non-member, joining `room:<id>` is refused (RT-RLT-03 on
   staging).

## 4. Capacity

Supabase limits (docs, 2026-10-31): concurrent connections Free 200 / Pro
500 / Team 10,000; messages per second 100 / 500 / 2,500; 100 channels per
connection.

| Load | Connections | Messages/s (pings) | Plan that fits |
| --- | --- | --- | --- |
| 100 people with a room open | ~100 | low | Free/Pro |
| 400 people with a room open, busy rooms (2 msgs/s total) | ~400 | ~2 × members per room fan-out counted by Supabase per recipient | Pro (watch the 500 cap) |
| > 500 concurrent | > 500 | — | Team or custom limits |

Over the limit, Supabase refuses joins (`too_many_connections`) or
disconnects (`tenant_events`); the client falls back to 10 s polling, so
rooms keep working, slower. The owner watches Realtime reports and moves
plans before the pilot grows past ~400 concurrent viewers. How Supabase
counts broadcast fan-out against "messages per second" is RQ-5 (read the
Realtime pricing page before the pilot).

## 5. Tests

| Id | Behaviour |
| --- | --- |
| RT-RLT-01 | Server ping sent after every committed insert (agent, human, system); failure logged, never fails the action |
| RT-RLT-02 | Client catch-up by seq is idempotent; gaps fetched |
| RT-RLT-03 | Staging: non-member join refused; member receives; removed member stops receiving after token refresh and never reads messages |
| RT-RLT-04 | Polling fallback with `rooms.realtime` off or the channel errored |
