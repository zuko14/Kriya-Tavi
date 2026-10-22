# Tools, actions and contracts (operator, track O)

New tools live in `lib/agent/tools.ts` (invariant 5), are rendered in
`components/thread/tool-call.tsx` and labelled in
`components/workbench/activity.tsx`. Inputs are zod schemas with explicit
maxima. None of these tools changes anything outside Kriya, so none is in
`SIDE_EFFECT_TOOLS`.

## 1. Tools

Factory: `createMandateTools(env: ToolEnv, options: { reports: boolean })`,
added to the belt in `runTask` only with `operator.mandates` on.

| Tool              | Class | Input (zod)                                                                                                                                                                                                                                                                                                                        | Output                                                                                                 |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mandate_propose` | R1    | `{ title: str(1..200), objective: str(1..2000), playbookId?: OP-id, criteria: [{ text: str(1..300), evidence: EvidenceSpec }] (1..12), grants: [{ tool, pins, maxUses: 1..50, why: str(1..200) }] (0..6), dueInDays: 1..30, budgetInr?: int(1..100000), checkIn?: rule, subjects?: { invoices?: uuid[≤20], ledger?: uuid[≤50] } }` | `{ mandateId, href, quote: Quote \| null, note }` or `{ error, fields }`. Never activates anything     |
| `mandate_status`  | R0    | `{ mandateId?: str }` (default: the mandate of this goal thread)                                                                                                                                                                                                                                                                   | `{ status, dueAt, criteria: [{ id, text, met, refs }], grants: [{ tool, uses, maxUses, status }] }`    |
| `mandate_report`  | R1    | `{ mandateId?: str }` — only with `operator.reports` on                                                                                                                                                                                                                                                                            | `{ verdict: CriterionResult[], allMet }`; writes `mandates.verdict` through the worker, never `status` |

### 1.1 `mandate_propose` validation (all in code, in this order)

1. `operator.mandates` on (otherwise the tool isn't in the belt).
2. Every `grants[].tool` is `grantable` in `CAPABILITIES` (OD-03); its `pins`
   parse with that tool's pin schema (DATA_MODEL §2.2); no empty recipient
   list for `gmail_draft`.
3. Every `criteria[].evidence` parses as an `EvidenceSpec`; a
   `tool_verified` spec names a tool that exists in `TOOL_CLASSES` and is
   R2–R3 or has a verification method (otherwise it can never be met).
4. `subjects` ids exist and belong to the person (`withUser` select). For
   `invoice_paid`, every invoice is `issued` (not draft, paid or void).
5. Limit: open proposals by this person ≤ 5 (setting not needed; constant
   in code, tested).
6. Quote: `quoteFor(userId, { workflowId: playbookId })` when a playbook is
   given; otherwise `null` ("No estimate yet" in the UI, invariant 6).
7. Insert with `status = 'proposed'`, `proposed_by = 'agent'`,
   `task_id = env.taskId`, `origin_thread_id = env.threadId`.

The tool result tells the model plainly: "A proposal. The person reviews
and approves it in Kriya; nothing is granted until then. You can't approve
it."

### 1.2 Grant-aware approval (not a tool)

`withGrants(base, grants, consume)` in `lib/operator/grants.ts`, composed
in `runTask` (ARCHITECTURE §5). Contract:

```ts
export function grantMatches(grant: ActiveGrant, tool: string, input: unknown): boolean // pure
export function withGrants(
  base: typeof TOOL_APPROVALS,
  grants: ActiveGrant[],
  consume: (grantId: string, toolCallId: string) => Promise<boolean>
): ToolApprovalConfiguration
```

Order of grants tried: fewest remaining uses first, then earliest expiry
(spend the narrowest first). Exactly one grant is consumed per call.

## 2. Server actions (`actions/mandates.ts`, `"use server"`)

Each: `requireUser()`, zod-validate, write through `withUser`, return a
plain result; nothing returns a secret.

| Action                                                                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approveMandate(id, { drop?: number[], maxUses?: Record<number, number> })` | In one transaction: check `operator.mandates`, `agents.goals` and `agents.inbox` are on (OD-21); count open mandates ≤ `operator.maxActive` (OD-14); create the goal (title, `success_criteria` = criteria text, plan = criteria as items) with `createGoal` for a single agent, or for a squad by inserting the thread with `squad_id` and the goal with `squad_id` in `lib/operator/mandates.ts` (`createGoal` sets no squad; `lib/goals.ts` stays unchanged); insert grants from `proposed_grants` minus `drop`, with `max_uses` lowered only (reduce-only), `expires_at = due_at`; create, with `createSchedule`, the kickoff (`once`, `startAt` = now + 60 s: a `once` at "now" can be refused with "That time has already passed") and the check-in (`recurring`) schedules in the goal thread, agent = the lead, `goalId` set; then `setScheduleCap` on each when a budget is given (`createSchedule` takes no cap); set goal `monthlyBudgetMicroInr` from `budget_micro_inr`; status → `active`, `approved_at`, `goal_id` |
| `declineMandate(id)`                                                        | `proposed` → `declined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pauseMandate(id)` / `resumeMandate(id)`                                    | Status change plus `setGoalStatus` paused/active; resuming also resumes the mandate's paused schedules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `revokeMandate(id)` / `closeMandate(id)`                                    | Terminal; revokes grants, ends schedules, goal abandoned (DATA_MODEL §4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `revokeGrant(grantId)`                                                      | `active` → `revoked`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `confirmCriterion(id, criterionId)`                                         | Only for `person_confirmed` criteria; appends to `confirmed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stopAllMandates()`                                                         | Emergency: every open mandate of the person → `revoked`; one transaction; audited (`audit_events`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mandateReportPdf(id)`                                                      | Renders the verdict with the existing `report` template; requires `operator.reports` and `agents.files`; returns a file id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Schedules created by `approveMandate` need `KRIYA_SCHEDULES_ENABLED` on the
worker to run. If it's unset the action still succeeds and the mandate page
says "Background runs are off on this server; open the job to work on it."

## 3. Queries (`queries/mandates.ts`)

`getMandates(userId)`, `getMandate(userId, id)` (with grants, uses,
schedules' next run, pending approvals of the goal thread, verdict),
`mandateForThread(userId, threadId)`. All through `withUser`.

`queries/inbox.ts` gains two lists, behind `operator.mandates`: proposed
mandates (Review) and needs-person mandates (Unblock).

## 4. Worker

| Function                                        | Where                                  | Switch              |
| ----------------------------------------------- | -------------------------------------- | ------------------- |
| `activeGrants(userId, threadId)`                | `lib/operator/grants.ts`, from runTask | `operator.grants`   |
| `consumeGrant(userId, grantId, taskId, callId)` | same, calls `kriya.consume_grant`      | `operator.grants`   |
| `reviewMandates(now)`                           | `lib/operator/loop.ts`, schedulerLoop  | `operator.checkIns` |

`reviewMandates` processes at most 100 mandates per tick, ordered by
`updated_at`, each in its own transaction, errors logged and skipped (one
bad row never stops the pass).

## 5. Owner

`app/owner/operator/page.tsx` (O8): OM1–OM8 for 7 and 30 days, counts by
status, grants by tool with uses, the kill list currently set. Read-only;
the kill list is edited in `/owner/config` like every setting.

## 6. Idempotency summary

| Operation                           | Key                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Grant use                           | `(grant_id, tool_call_id)` primary key                |
| Kickoff and check-in runs           | Existing `schedule_runs (schedule_id, due_at)`        |
| Mandate approval twice              | Status check inside the transaction (`proposed` only) |
| `reviewMandates` twice              | Transitions are no-ops from the target state          |
| `mandate_propose` twice in one task | Same `(task_id, title)` returns the existing proposal |
