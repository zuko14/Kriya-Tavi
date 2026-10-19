# Tools, actions and contracts

Every new tool lives in `lib/agent/tools.ts` (invariant 5), is rendered in
`components/thread/tool-call.tsx` and labelled in
`components/workbench/activity.tsx` (AGENTS.md conventions). Inputs are zod
schemas with explicit maxima. Outputs that contain outside content carry the
existing `UNTRUSTED` or `FOREIGN` notice.

## 1. Common output contract for R2–R4 tools

```ts title="lib/agent/tools.ts (shared type)"
export type Verification = {
  status: "verified" | "unverified" | "failed"
  method: "api_readback" | "page_check" | "file" | "none"
  evidence: { kind: "file" | "url" | "provider_id"; value: string }[]
  note?: string // what was checked, in one line
}
// Every R2–R4 tool result includes { verification }
```

The worker copies `verification` from the tool result into the new column
`tool_executions.verification` (jsonb, A3) in `onToolExecutionEnd`.
`lib/agent/episodes.ts` reads it from there. It is **not** read from
`output_summary`: `summarize()` keeps only the first 500 characters
(`run-task.ts:724`) and would cut the object (AF-10). `summarize()` itself
doesn't change.

## 2. Tool catalogue

Class = the default from `lib/agent/policy.ts`. "Loadout" = which role packs
get the tool by default (all = every pack).

### 2.1 Memory (A1)

| Tool                      | Input (zod)                                                                                       | Class | Notes                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `memory_write` (extended) | `{ note: string(1..1000), kind?: enum, slot?: string(≤64), shared?: boolean, importance?: 1..3 }` | R1    | Returns `{ id, saved, trust, similar: [{ id, content }] (≤ 3), superseded?: id }`; refuses sensitive patterns |
| `memory_update`           | `{ id, note }`                                                                                    | R1    | Supersedes `id` with a new note (history kept)                                                                |
| `memory_forget`           | `{ id }` (existing)                                                                               | R1    | Now invalidates instead of deleting                                                                           |
| `memory_search`           | `{ query: string(1..300), kinds?: enum[], includeHistory?: boolean, limit?: 1..20 }`              | R0    | For deliberate deeper recall                                                                                  |
| `recall_episodes`         | `{ query?: string, since?: date, goalId?: string, limit?: 1..10 }`                                | R0    | "What did you do about…"                                                                                      |

### 2.2 Goals and schedules (A3)

| Tool              | Input                                                                                                     | Class                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal_create`     | `{ title, successCriteria, plan: [{ text }] (≤ 30), checkIn?: rule }`                                     | R1 (creating a goal costs nothing by itself)                                                                                                               |
| `goal_update`     | `{ goalId, planUpdates?: [{ id, status, evidenceEpisodeId? }], note? , status?: "achieved" \| "paused" }` | R1; `achieved` refused unless every item has evidence                                                                                                      |
| `schedule_create` | `{ prompt, kind, rule, goalId?, backgroundAllowed?: boolean }`                                            | **R2** (spends money later); approval card shows cadence, next 3 run times in IST, the estimated runs per month, and that each run counts against the plan |
| `schedule_update` | `{ scheduleId, status?: "paused" \| "ended", rule? }`                                                     | R1 for pause/end; R2 for a new rule                                                                                                                        |

### 2.3 Files and documents (A5)

| Tool                   | Input                                                                                                       | Class                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `file_list`            | `{ query?, origin?, limit? }`                                                                               | R0                                                                                    |
| `file_read`            | `{ fileId, pages?: { from, to } }`                                                                          | R0; returns extracted text (capped) with `FOREIGN` notice; marks private content seen |
| `file_save_attachment` | `{ gmailMessageId, attachmentId }`                                                                          | R1; Gmail attachment → `kriya.files`                                                  |
| `document_render`      | `{ template: "report" \| "invoice" \| "resume" \| "media_kit" \| "letter", data: <template schema>, name }` | R1; returns `{ fileId, pages, verification: { method: "file" } }`                     |

### 2.4 Browser (A4, A6)

See BROWSER_AND_LOGIN_PROFILES.md §3.2 for the tools and §3.3 for
classification.

### 2.5 Ledger and invoices (A7)

| Tool             | Input                                                                                                    | Class                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bill_extract`   | `{ fileId }`                                                                                             | R0; returns extracted fields (no write) + reconciliation computed by `lib/ledger.ts`      |
| `ledger_add`     | `{ entries: [extracted entry] (≤ 50) }`                                                                  | R1; writes `draft` or `needs_review` (code decides)                                       |
| `ledger_query`   | `{ from, to, kind?, category?, counterparty?, status?: "confirmed" \| "all" }`                           | R0; rows + **totals computed in SQL**                                                     |
| `ledger_summary` | `{ period: "month" \| "quarter" \| "fy", of: date, groupBy: ("category" \| "counterparty" \| "tax")[] }` | R0; numbers only from SQL                                                                 |
| `invoice_draft`  | `{ client, items, dueDays?, notes?, series? }`                                                           | R1; totals and taxes computed by code (CGST+SGST vs IGST from supplier and client states) |
| `invoice_issue`  | `{ invoiceId }`                                                                                          | **R2**; assigns the number, renders the PDF; verification = `file`                        |

Not tools, by design: confirm entries, mark paid, void (the person does
these in the UI).

### 2.6 Connectors (A8), official APIs only

| Tool                                                                                 | Class        | Scope needed                               |
| ------------------------------------------------------------------------------------ | ------------ | ------------------------------------------ |
| `github_notifications`, `github_search`, `github_read_pr`, `github_read_issue`       | R0           | read                                       |
| `github_comment`, `github_create_issue`, `github_label`                              | R4           | write (per-repo grant)                     |
| `github_open_pr` (from a branch the agent prepares via the API's contents endpoints) | R4           | contents:write; small text changes only    |
| `sheets_read` (Drive already reads sheets as CSV), `sheets_append`, `sheets_update`  | R0 / R3 / R3 | `spreadsheets`                             |
| `youtube_stats`, `youtube_upload`                                                    | R0 / R4      | YouTube Data API scopes                    |
| `instagram_insights`, `instagram_publish`                                            | R0 / R4      | Instagram Graph API (professional account) |

Each R4 connector tool verifies by API read-back (the created comment, issue,
row or media id) and returns `verification.method = "api_readback"`.

Sheets and YouTube use **extra scopes on the existing Google connection**
(incremental consent, `googleServices()`), not new providers. GitHub and Meta
are new providers (DATA_MODEL §2.8, AF-15). Each tool appears only when its
scope was granted, like today's `NEEDS` map.

### 2.7 Skills (A9)

| Tool            | Input                                      | Class                                                               |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `skill_propose` | `{ fromTaskId, name, description, slots }` | R1 (creates a draft; approval is a separate R2 step in the inbox)   |
| `skill_run`     | `{ skillId, slots }`                       | Class = the skill's `max_risk`; each step re-classified at run time |

### 2.8 Handoff

`browser_handoff` (browser) and `ask_person` (any task) are listed here. The
existing behaviour already covers `ask_person`: a reply that asks one question
and ends. For background runs, that reply lands in the Inbox as "Needs your
answer".

### 2.9 Signature features (SIGNATURE_FEATURES.md)

| Tool              | Input                                                                              | Class                                                                          | Phase |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| `facts_lookup`    | `{ key?: string, query?: string(≤ 200) }`                                          | R0; returns `{ value, quote, source_url, fetched_at }` or "not in the commons" | A13   |
| `obligation_add`  | `{ kind, title, dueAt, quote, sourceKind, sourceRef, readAt, leadDays? }`          | R1; code runs the verbatim-quote check and sets `verified`                     | A13   |
| `obligation_list` | `{ from?, to?, status? }`                                                          | R0                                                                             | A13   |
| Watchers          | `schedule_create` with `kind: "watch"` and `watch: { url, selector?, condition? }` | R2 (same approval as any schedule)                                             | A13   |

There are deliberately **no** tools for quotes and caps, shares, undo, or
confirming entries. Those are person actions (DATA_MODEL §4, "Same identity,
different powers").

## 3. Tool loadouts (AD-12, AD-14)

`lib/templates.ts` gives each template a `loadout`: a list of capability
groups (`memory`, `web`, `accounts`, `goals`, `files`, `browser`, `ledger`,
`github`, `social`, `skills`). `run-task.ts` builds the tool belt from:

1. the agent's loadout (custom agents get `memory`, `web`, `accounts`,
   `goals`, `files`);
2. what's connected (as `createConnectorTools` does today);
3. switches and plan (ARCHITECTURE §5);
4. `writes` (assign parts: no R2–R4 tools, as today).

The `instructions.ts` capability lines are generated from the same final
tool belt, so the prompt never claims a tool the agent doesn't have (voice F4
lesson).

## 4. Server actions (mutations, `"use server"`)

Each one authenticates (`requireUser`), validates with zod, and writes
through `withUser`.

| Action file                   | Functions                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/memory.ts` (extend)  | `confirmMemory`, `pinMemory`, `forgetMemory` (hard delete + chain), `exportMemory`, `pauseMemory(agentId, paused)`                                                                  |
| `actions/goals.ts`            | `createGoal`, `updateGoal`, `pauseGoal`, `resumeGoal`, `closeGoal`                                                                                                                  |
| `actions/schedules.ts`        | `pauseSchedule`, `resumeSchedule`, `endSchedule` (creation is through an approved tool call or `createSchedule` with the same R2 confirmation dialog)                               |
| `actions/inbox.ts`            | `listInbox` (via `queries/inbox.ts`). Answering an approval stays on the existing route `/api/threads/[threadId]/approvals`                                                         |
| `actions/files.ts`            | `createUploadUrl(name, mime, size)` → signed URL + `fileId`; `confirmUpload(fileId)` (checks object size, type sniffing, sha256 in the worker); `deleteFile`; `downloadUrl(fileId)` |
| `actions/profiles.ts`         | `startLogin(domain)` → creates a `pending` profile + a take-over task; `renameProfile`, `setBackgroundAllowed`, `revokeProfile`                                                     |
| `actions/ledger.ts`           | `confirmEntries(ids)`, `editEntry`, `voidEntry`, `markInvoicePaid`, `voidInvoice`, `exportPeriod(from, to)` (CSV + PDFs as one generated file)                                      |
| `actions/skills.ts`           | `approveSkill(id, version)`, `retireSkill`                                                                                                                                          |
| `actions/share.ts`            | `createShare(kind, ref, expiresInDays)` (renders the snapshot, returns the link once), `revokeShare`, `listShares`                                                                  |
| `actions/undo.ts`             | `undoExecution(executionId)`: checks ownership, `undo_until`, not already undone; queues the compensation in the worker                                                             |
| `actions/radar.ts`            | `markObligation(id, "done" \| "dismissed")`, `addObligation` (the person's own, `source_kind = 'person'`)                                                                           |
| `actions/quotes.ts`           | `quoteFor(workflowId \| skillId)`, `setCap(target, capMicroInr)`                                                                                                                    |
| `actions/account.ts` (extend) | `setLiteMode(on)`                                                                                                                                                                   |

## 5. Routes

| Route                                 | Method | Purpose                                | Protection                                                                                                                                                                                                               |
| ------------------------------------- | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/browser/live/[sessionId]/token` | POST   | Mint a one-time live-view token        | `requireUser` + task ownership + rate limit; add to `PROTECTED_API` in `proxy.ts`                                                                                                                                        |
| `/api/files/[fileId]`                 | GET    | Redirect to a 60 s signed download URL | `requireUser` + RLS lookup                                                                                                                                                                                               |
| `/share/[token]`                      | GET    | Read-only share snapshot (K8)          | **Public on purpose**: lookup by sha256 of the token through `privileged`, scoped to that one row; rate limit per IP hash; `noindex`; `Referrer-Policy: no-referrer`; must **not** be added to `PROTECTED` in `proxy.ts` |

There is no new webhook in A1–A9. Connector OAuth callbacks reuse the
existing `app/api/connect/*` pattern.

## 6. SQL functions

| Function                                                                                                           | Called by                                   | Contract                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kriya.claim_due_schedules(max integer)` returns setof `(schedule_id, due_at, user_id, thread_id, agent_id, kind)` | worker                                      | Locks due schedules (`skip locked`), inserts `schedule_runs (…, 'claimed')`, advances `next_run_at` (computed in SQL from `rule` in the schedule's timezone), pauses schedules over their goal's ₹ cap or plan schedule limit. **Doesn't insert tasks**: the worker calls `enqueueScheduled()` in `queue.ts`, which reuses `prepare()` (AF-11) |
| `kriya.claim_maintenance_job(worker text, lease_seconds integer)`                                                  | worker                                      | `for update skip locked` on the oldest available `queued` job; sets `running` + lease                                                                                                                                                                                                                                                          |
| Approval expiry                                                                                                    | worker timer (TS, `lib/agent/approvals.ts`) | Per thread, one transaction: `pending` past `expires_at` → `expired`, and the message part rewritten to declined (DATA_MODEL §2.3, AF-14)                                                                                                                                                                                                      |
| `kriya.check_transition()`                                                                                         | triggers                                    | §1 of DATA_MODEL                                                                                                                                                                                                                                                                                                                               |
| `kriya.memory_candidates(uid uuid, agent text, q text, k integer)`                                                 | `lib/memory/retrieve.ts`                    | `security invoker`; returns ranked candidates per MEMORY_AND_CONTEXT §5.1; runs under `withUser`                                                                                                                                                                                                                                               |

## 7. Retries and idempotency

| Operation         | Idempotency                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schedule fire     | `(schedule_id, due_at)` primary key + task idempotency key `schedule:<id>:<due_at>`; `claimed` runs older than 2 min are re-enqueued with the same key       |
| Maintenance job   | Unique `(kind, ref)` while queued or running; lease; ≤ 3 attempts                                                                                            |
| Watcher check     | `watch_state` updated in one statement; a changed page enqueues one task keyed `watch:<schedule>:<new hash>`                                                 |
| Undo              | `undone_at` set in the same transaction that queues the compensation; a second click finds it set                                                            |
| Receipt chain     | Per-user advisory lock + unique `(user_id, seq)`                                                                                                             |
| Memory write      | `content_hash` duplicate check                                                                                                                               |
| File upload       | `fileId` chosen server-side; confirm is idempotent                                                                                                           |
| Extraction        | `sha256` cache (T8)                                                                                                                                          |
| Invoice issue     | Locked series row; issuing an already-issued invoice returns its number                                                                                      |
| Connector R4 call | Tool call id recorded before the call (`onToolExecutionStart`); a task that ran a side effect is never retried automatically (existing `recover_tasks` rule) |
| Browser commit    | Same; plus the after-screenshot proves what happened even if the worker dies right after the click                                                           |
| Usage rows        | `request_key` unique (as `usage_events`)                                                                                                                     |
