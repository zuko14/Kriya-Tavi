# APIs and execution contracts

Follows the repo conventions (AGENTS.md): mutations are server actions in
`actions/voice.ts` (`"use server"`: authenticate, validate with zod, write
through `withUser` or a function with its own authorization); reads for pages in
`queries/voice.ts`; route handlers only for streams and provider webhooks.
Timestamps are ISO 8601 with offset; phone numbers E.164.

**No request from the browser places a call.** The browser can only create
drafts, confirm an exact approval, cancel, and change preferences. Calls are
placed by `kriya-worker` from rows in `voice_calls`.

## 1. Common rules

| Concern | Rule |
| --- | --- |
| Authentication | `requireUser()` in actions; `authenticate()` in route handlers (null → 401). Identity, plan and prices never come from the request (invariant 3) |
| Voice access | Every action checks `voice_access` for the user and the plan's `voice_enabled`; else `{ ok:false, code:"voice_unavailable" }` |
| Ownership | Every read and write of an existing task is through `withUser`, so another user's id finds nothing → `not_found` (never "forbidden", to avoid probing) |
| Validation | zod schemas in `lib/voice/schemas.ts`, shared with the UI. Errors returned as `{ ok:false, code:"invalid", fields:{…} }` |
| Idempotency | Create actions take a client `idempotencyKey` (nanoid, ≤ 128); same key → same task. Confirm is idempotent per approval id |
| Rate limits | `allowAll` (`lib/rate-limit.ts`): drafts 20/hour/user; confirmations 10/hour/user; verification calls 3/hour/user and 5/day/number; per-IP 60/min on all voice actions |
| Results | Actions return `{ ok:true, … } \| { ok:false, code, message }`; `message` is safe to show; no provider internals |
| Logging | `log.info("voice …", { taskId, attemptId, code })` — no numbers, no transcript text |
| Transactions | Each action is one transaction; nothing external happens inside it |

Error codes: `invalid`, `not_found`, `voice_unavailable`, `number_unverified`,
`suppressed`, `limit_daily`, `limit_number`, `allowance`, `quiet_hours`,
`outside_calling_hours`, `stale_approval`, `expired`, `already_final`,
`rate_limited`.

## 2. Server actions (`actions/voice.ts`)

### draftCall

```ts
input  { text: string (1..2000), threadId?: string, idempotencyKey: string }
output { ok: true, taskId: string, spec: VoiceTaskSpecDraft, missing: MissingField[] }
```

Creates a `voice_tasks` row in `draft` (privileged insert after the session
check, `user_id` from the session), then one structured-output LLM call on the
web server to extract the spec (metered as `voice_usage` `llm`). `missing` lists
what the UI must ask: `phone`, `recipient`, `date`, `preferred_time`,
`acceptable_window`, `report_time`, `ambiguous_date`. The LLM call is not a side
effect outside Kriya, so it's allowed on web; it has no tools.

### updateDraft

```ts
input  { taskId, patch: Partial<VoiceTaskSpecDraft> & { recipientPhone?: string } }
output { ok: true, spec, missing }
```

Only in `draft`/`awaiting_confirmation` (an edit while awaiting confirmation
supersedes the pending approval and returns to `draft`). Phone parsed to E.164;
refused: owner's own number, emergency/short/toll-free/premium numbers,
non-Indian numbers in MVP (Q-check with counsel before widening), suppressed
numbers (`suppressed`, without saying who suppressed it).

### requestConfirmation

```ts
input  { taskId }
output { ok: true, approvalId, payload: ConfirmationPayload, payloadHash, expiresAt }
```

Requires `missing` empty, verified owner number if a report is requested,
report time outside quiet hours, a calling window that intersects the
third-party calling hours, limits not reached (daily outreach count, per-number
counts, allowance). Creates `voice_approvals(pending)`; task →
`awaiting_confirmation`. `ConfirmationPayload` is exactly what the card shows:
recipient label, full number, purpose sentence, goal and authority in plain
words, the disclosure sentence, earliest call time, report time and timezone,
estimated cost range or "price not yet set".

### confirmCall

```ts
input  { approvalId, payloadHash }
output { ok: true, taskId, status: "authorized" }
```

In one transaction: approval must be `pending`, unexpired, owned, and
`payloadHash` equal to the stored hash (`stale_approval` otherwise); re-check
limits and suppression; approval → `approved`; task → `authorized` via
`voice_transition` (actor `owner`); insert `voice_calls` outreach (`seq` 1,
`not_before` = max(now, window start)) and, if requested, the owner-report call
(`seq` 1). Repeating the call returns the same result.

### declineCall, cancelVoiceTask, emergencyStop

```ts
declineCall      { approvalId }       → { ok: true }
cancelVoiceTask  { taskId }           → { ok: true, status }
emergencyStop    {}                   → { ok: true, cancelled: number }
```

Cancel sets `cancel_requested_at` on the task and its open calls; scheduled
calls cancel immediately; a live call is hung up at the next heartbeat (≤ 5 s)
by whichever service holds it. `emergencyStop` does that for every non-terminal
voice task of the user. Terminal tasks → `already_final`.

### Report management

```ts
rescheduleReport { taskId, reportAt }   → { ok: true }   // new seq, old canceled
cancelReport     { taskId }             → { ok: true }   // task completes when outreach settles
```

### Preferences and verification

```ts
updateVoicePreferences { timezone?, quietStart?, quietEnd?, reportMode?,
                         reportMaxAttempts?, reportRetryMinutes?, transcriptRetentionDays? }
startPhoneVerification { phone }        → { ok: true, verificationId, code, expiresAt }
verificationStatus     { verificationId } → { ok: true, status: "calling"|"verified"|"failed"|"expired" }
```

`startPhoneVerification` returns the code to show on screen and schedules a
`voice_calls(kind='verification')`; the code is checked from DTMF in
`kriya-voice`. Verification calls are owner calls, bounded by their own rate
limits. While D-12's test-number allow-list is in force, the owner's number
must be on it too.

### Data controls

```ts
deleteTranscript { taskId } → { ok: true }   // deletes conversation_turns; outcome kept
deleteVoiceTask  { taskId } → { ok: true }   // terminal tasks only; cascades; charges kept de-identified
createFollowUp   { parentTaskId } → { ok: true, taskId }   // a new draft prefilled from the parent
```

## 3. Agent tool in threads

`propose_call` in `lib/agent/tools.ts` (not in `SIDE_EFFECT_TOOLS`: it changes
nothing outside Kriya). Input mirrors `draftCall`; output is
`{ taskId, missing, href: "/calls/<taskId>" }`. The thread shows a card linking
to the confirmation screen (rendered in `components/thread/tool-call.tsx`,
labelled in `components/workbench/activity.tsx`). The agent can never confirm.

## 4. Route handlers

### GET `/api/voice/tasks/[taskId]/stream`

SSE of task, call and attempt status changes for the owner, modelled on
`/api/events`: `authenticate()`, reads through `withUser`, polls every 1 s while
a call is live and 5 s otherwise, closes after 10 minutes (the client
reconnects). Events:

```ts
{ type: "task", status, result? }
{ type: "call", callId, kind, status, attempts, nextAt? }
{ type: "attempt", attemptId, status, at }
{ type: "turn", seq, speaker, text }      // only if the owner opened the live transcript
{ type: "outcome", verifierStatus }
```

Not used for notifications (D-07).

### POST `/api/voice/exotel/status/[token]`

Provider status webhook. Added to `WEBHOOKS` in `proxy.ts` (no Origin check).

1. Body ≤ 64 KB; find the attempt by `sha256(token)`; unknown → 404, logged at
   warn without the token.
2. `parseStatusEvent`; insert `call_events` with `dedupe_key` (duplicate → 200).
3. Non-terminal statuses → `voice_transition` (actor `webhook`).
4. Terminal statuses → `verifyAttempt` (provider API), then transitions
   (actor `verifier`).
5. 200 on success or duplicate; 500 only on our processing failure so the
   provider retries.

### `kriya-voice` service

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Render health check; reports `accepting: true/false` (drain) |
| `WS /media/exotel?t=<stream token>` | Exotel Voicebot stream; Basic auth required; token one-use |
| `GET /media/exotel/url?t=…` (optional) | Exotel's https-returns-wss mode, if used |

On SIGTERM: stop accepting, let live calls run to `max_call_seconds`, then exit.

## 5. Execution contracts (who does what, in which transaction)

```mermaid
sequenceDiagram
  participant A as actions/voice.ts
  participant DB as Postgres
  participant K as kriya-worker
  participant P as Provider
  A->>DB: tx: approval approved + task authorized + voice_calls inserted
  K->>DB: tx: claim_voice_call (lease) 
  K->>DB: tx: limits/suppression/window re-check; attempt created→requested
  K->>P: placeCall (outside any tx)
  K->>DB: tx: attempt initiated(provider_call_id) or failed/unknown
  P-->>DB: webhooks via kriya-web (each its own tx)
  K->>DB: tx: release lease when attempt is connected or terminal
```

| Step | Retry semantics |
| --- | --- |
| `placeCall` network error / 5xx | Attempt `failed` if the provider definitely didn't create it (4xx or connection refused); `unknown` if the request may have reached it (timeout) → reconcile (DATA_MODEL §4) |
| `placeCall` 429 | Not an attempt; `available_at` + 60 s; doesn't consume attempts |
| Webhook processing error | 500 → provider retries; idempotent by `dedupe_key` |
| Verification can't reach the provider | `verified_at` stays null; recovery retries every minute for 1 h, then the task → `needs_owner` |
| Extraction fails | Escalation model once, then `needs_review` |
| Owner report undelivered | Bounded schedule (VOICE_REMINDERS §3) |

## 6. Backward compatibility

- No existing table changes except new nullable/defaulted columns on
  `kriya.plans`. Existing tasks, threads, metering and billing are untouched.
- `usageSummary` gains a second sum (Phase 8); existing tests must still pass.
- `proxy.ts` gains one webhook prefix and one protected prefix.
- `/api/events`, `notifier.tsx`, `kriya.tasks` and `claim_task` are not
  modified.
- `worker/index.ts` gains a second claim loop behind `KRIYA_VOICE_ENABLED=1`, so
  workers without voice config behave exactly as today.
