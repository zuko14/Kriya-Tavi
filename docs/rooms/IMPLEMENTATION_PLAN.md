# Implementation plan (track R: Rooms)

| Phase | Name | Depends on | Decisions | Holds (existing files) | Exit checks |
| --- | --- | --- | --- | --- | --- |
| R0 | Blueprint and decisions | — | — | `AGENTS.md`, `status.md` | Documents consistent (REAUDIT); owner marks RD-01…RD-20 |
| RP-1 | Baseline re-check | R0 | — | — | `npm run check` exit 0 |
| R1 | Data model (one migration `20270401000000`) | RP-1; tracks C and H migrations merged first if they run earlier (timestamp order) | RD-02 (owner-gated), RD-10 (owner-gated), RD-19 | `db/schema.ts`, `tests/db/migrations.test.ts`, `lib/config.ts`, `app/owner/config/page.tsx` | RT-DB-01…08 |
| R2 | Room core: create, invite, join, leave, remove, post, read | R1 | RD-11, RD-18 | `proxy.ts` | RT-ACT-01/02, RT-MOD-01…03 (server side) |
| R3 | Room UI, realtime, polling | R2 | RD-10, RD-15, RD-16 | `app/(workspace)/home/page.tsx`, `components/workspace/sidebar.tsx`, `components/workspace/command-palette.tsx` (+ `app/api/events/route.ts` with PX-03) | RT-RLT-01/02/04, RT-UI-01…03; browser check with two accounts |
| R4 | Agents in rooms | R3; `agents.inbox` on in the environment | RD-03 (owner-gated), RD-04…RD-08, RD-17 | `lib/agent/{queue,tools,policy,capabilities,instructions,run-task}.ts`, `db/schema.ts`, `queries/inbox.ts`, `actions/inbox.ts`, `app/(workspace)/inbox/page.tsx` | RT-REG-01, RT-INV-01…06, RT-AGT-01…06; NT-REG-01, OT-REG-01, AT-REG-01 unchanged |
| R5 | Proof cards, independent verification, re-check relay | R4 | RD-09 | `worker/index.ts` | RT-PRF-01…04 |
| R6 | Conductor | R5 | RD-12 | none | RT-CND-01…04 |
| R7 | Room goals | R5 | RD-13 | `tests/db/migrations.test.ts` (second migration) | Goal tests (RT-GOAL-01…03 written in R7) |
| R8 | Room notes | R4 | RD-14 | same migration as R7 | Note tests (RT-NOTE-01…03 written in R8) |
| R9 | Safety, moderation, scale readiness | R6 | RD-18 | `components/owner/nav.tsx` | RC-1…RC-5; RT-RLT-03 on staging |
| R10 | Controlled pilot | R9; RQ-1, RQ-2 | new decision for public copy (RG-9) | — | 14 days, named users, numbers in `status.md` |

Lanes: R7 and R8 can run in parallel after their dependencies (one
migration holds both: whichever starts first writes it, the other adds to
it before it is applied anywhere; or they serialize on the migration file).
R4 holds the agent hot spots; nothing else on any track may hold
`lib/agent/run-task.ts`, `tools.ts`, `policy.ts` at the same time.

## Rollout

1. Code ships with `rooms.*` off.
2. Owner: staging migration; Realtime "Allow public access" off; two test
   accounts; `rooms.enabled` on (humans only) → R3 checks; then
   `rooms.agents` on → R4/R5 checks.
3. Production after RC gates and counsel answers, for named pilot users.

## Rollback

| Level | Action |
| --- | --- |
| Agents only | `rooms.agents` off → mentions don't invoke; room belts gone; rooms stay for people |
| Everything | `rooms.enabled` off → room pages and routes 404 |
| Realtime | `rooms.realtime` off → polling only |
| Data | Down migration after switches are off (DATA_MODEL §7) |
