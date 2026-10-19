# Usage accounting and operating cost

Voice follows the existing money rules (AGENTS.md invariant 6,
`lib/money.ts`, `lib/agent/metering.ts`): integers only, provider-reported cost
kept apart from Kriya's estimate and from the customer charge, missing usage
recorded as missing (null), never as zero, and no invented prices or rates.

## 1. What costs money on a voice task

| Component | Unit | Reported by provider? | Notes |
| --- | --- | --- | --- |
| Telephony, connected | Billable seconds/pulses | Exotel: `Duration`/`ConversationDuration` in callbacks; price per call **unknown** (X8) | Pulse rounding (30 s/60 s) to confirm |
| Telephony, unanswered/busy/failed attempt | Per attempt, possibly zero | Unknown | Never assumed free: recorded with null cost until priced |
| A2P termination charge | Per minute (up to ₹0.05/min reported, secondary) | Unknown | Counsel/Exotel to confirm (Q1, X4) |
| Phone number rental | Per month | Invoice | Infrastructure, not per task |
| Streaming add-on | Per minute? | Unknown | X8 |
| STT | Audio seconds streamed | Some vendors report per request; else from Kriya's own count | Billed per stream duration, including silence |
| TTS | Characters synthesized | Usually not per request; Kriya counts | Count text actually sent, including retries |
| LLM (in-call and extraction) | Tokens | OpenRouter `usage.cost` per request (existing extractor) | Reuses `usageFromMetadata` |
| Infrastructure | Monthly | Owner enters (`finance.infraMonthlyInr`) | Shown in owner finance as overhead, not charged per task |

## 2. Price registry

`kriya.voice_prices` (owner-maintained in `/owner/config`, never seeded with
guesses):

| Column | Notes |
| --- | --- |
| `id` | text pk, e.g. `exotel:outbound_minute` |
| `provider`, `product`, `unit` | `unit` ∈ `second`, `minute_pulse_60`, `minute_pulse_30`, `attempt`, `character`, `audio_second` |
| `price_micro` | bigint, micro-units per unit |
| `currency` | `INR` or `USD` |
| `effective_from` | timestamptz |
| `source` | text, e.g. "Exotel quote 2026-10-20, email" — required |
| `checked_at` | timestamptz |

No row → no estimate for that component (null), counted as unmetered.

## 3. Tables

### voice_usage (one row per billable unit of work)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `request_key` | text unique | Idempotency: `<attempt>:telephony`, `<attempt>:stt:<n>`, `<attempt>:tts:<turn>:<try>`, `<attempt>:llm:<call>`, `<task>:extract:<try>` |
| `user_id` | uuid → auth.users on delete set null | |
| `voice_task_id` | uuid on delete set null | |
| `call_attempt_id` | uuid on delete set null | |
| `component` | text check in (`telephony`, `stt`, `tts`, `llm`) | |
| `provider`, `product` | text | e.g. `exotel`/`outbound`, `openrouter`/`deepseek/deepseek-v4-flash` |
| `quantity`, `unit` | bigint, text | seconds, characters, or null for LLM |
| `input_tokens`, `output_tokens` | int | LLM only; null = not reported |
| `usage_status` | text check in (`reported`, `counted`, `missing`) | `counted` = Kriya's own measurement |
| `reported_cost_micro`, `reported_currency` | bigint, text | What the provider says it charged |
| `estimated_cost_micro`, `estimated_currency` | bigint, text | From `voice_prices`, only when nothing was reported |
| `price_id` | text | Which price row produced the estimate |
| `cost_source` | text check in (`provider`, `estimate`, `reconciled`) | Like `usage_events` |
| `reconciliation` | text check in (`pending`, `matched`, `mismatch`, `unavailable`) | Against provider invoices/CDRs |
| `raw` | jsonb | Normalized provider usage, no content |
| `created_at` | timestamptz | |

### voice_charges (one per voice task)

Same shape and rules as `kriya.charges`, keyed by `voice_task_id unique`:
`provider_cost_micro_inr` (USD items converted with `fx.usdInr`, INR items
as-is), `cost_basis` (`provider` / `estimate` / `none`), `unmetered_items`,
`fx_usd_inr`, `fx_source`, `markup_bps`, `charge_micro_inr`, `status`
(`final` / `estimated` / `unpriced`). Written once when the task reaches a
terminal state, including `failed`, `cancelled` and `unreported` — those tasks
can still have cost. Repricing after reconciliation only changes `estimated` or
`unpriced` charges, like `repriceTask`.

`lib/money.ts` needs one addition: summing mixed-currency items into micro-INR
(`toMicroInr(item, rateE4)`), tested in `tests/money.test.ts`.

## 4. Recording points

| When | Row | By |
| --- | --- | --- |
| Each attempt ends (any status) | `telephony` with `billable_seconds`, provider cost if any | Verifier, after `getCall()` |
| STT stream closes | `stt` with streamed seconds | `kriya-voice` |
| Each TTS request (including retries and cancelled ones) | `tts` with characters sent | `kriya-voice` |
| Each LLM request | `llm` via the OpenRouter extractor | `kriya-voice`, web (spec extraction), verifier (outcome extraction) |
| Task terminal | `voice_charges` | Worker |

Spec extraction on the web side happens before a task exists; it is recorded
against the draft task id once created (draft created first, then extraction).

## 5. Budgets, limits and alerts

All values configurable; none is a price.

| Control | Default | Behaviour |
| --- | --- | --- |
| Per-task cost budget | Plan `max_voice_task_cost_micro_inr` (0 = voice off) | Checked before each dial (projected: priced minutes × max duration) and during the call; at 100 % Tavi closes politely |
| Per-owner allowance | Existing plan allowance, now including `voice_charges` (`usageSummary`, Phase 8) | Confirmation refused when exhausted |
| Platform daily spend cap | `voice.dailySpendCapMicroInr` (unset = no live calls) | Claim refuses new calls once today's voice cost (reported + estimated) reaches it |
| Alert | 80 % of the daily cap or any owner at 80 % allowance | Shown in `/owner/operations`; log line at `warn` for a log-drain alert |
| Unpriced components | Any `unmetered_items > 0` on today's charges | Banner in `/owner/finance` |

## 6. Reports

`/owner/finance` (existing page) gains a voice section, all from SQL aggregates:

- Cost by component and provider, reported vs estimated vs unmetered.
- Attempts per task; cost of failed attempts (busy/no answer) separately.
- **Cost per successful task** = total voice cost of all tasks finished in the
  period ÷ number of tasks that ended `completed` with an accepted outcome whose
  `result` is not `call_failed`. Failed and unreported tasks' costs are in the
  numerator.
- Customer charge vs provider cost (contribution), using the existing
  `finance.paymentFeeBps` estimate.

The owner's `/usage` page shows per-task estimated cost in INR, labelled
"estimated" until final.

## 7. Planning numbers

No estimate in this document is a commitment. Using the published-but-unverified
prices in COMPETITOR_RESEARCH.md §4, a 3-minute connected call might cost, before
telephony: STT ≈ 3 min × $0.005 ≈ $0.015; TTS ≈ 1,300 characters × $0.03–0.05/1K ≈
$0.04–0.065; LLM ≈ 25 short turns on a budget model ≈ < $0.01. Telephony is the
unknown that likely dominates (X8). Replace with measured numbers in Phase 8
(EVALUATION_PLAN.md metric C1).
