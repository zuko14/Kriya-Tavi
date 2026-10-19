# Conversation reliability and outcome verification

Reliability comes from structure enforced in code, not from a long prompt. The
model chooses words and recognises meaning; code decides what is allowed, what
was observed, and what state anything is in.

## 1. Principles

1. **Observed facts and interpretations are stored apart.** Connection status,
   durations, who hung up and what was played come from the provider and the
   media stream. Summaries, proposed times and agreements are interpretations
   with provenance (turn numbers) and confidence.
2. **No outcome without a conversation.** If the call wasn't connected, the
   outcome has `interpreted = null`. The model isn't even called.
3. **Agreement must be explicit.** "Should be fine", "let me check", "maybe"
   are not agreement. The recipient must accept a specific time, and Tavi must
   have read it back and heard a yes (§4).
4. **The callee can't give instructions.** Their speech is conversational
   input, never permission (§8).
5. **The model never sets a status.** Tools write notes on the current attempt;
   the verifier (code) derives transitions (DATA_MODEL §3).

## 2. Task spec (structured objective)

Stored in `voice_tasks.spec`, validated with zod in `lib/voice/spec.ts` both
when the draft is extracted and again before confirmation. The owner sees and
edits every field on the confirmation card.

```ts title="lib/voice/spec.ts (shape)"
type VoiceTaskSpec = {
  version: 1
  language: "en-IN"
  owner: { displayName: string }               // how Tavi refers to the owner
  recipient: { label: string; name?: string }  // "my CA"; name only if given
  goal:
    | { type: "schedule_meeting"; date: string /* YYYY-MM-DD, owner tz */;
        preferred: string /* HH:mm */;
        acceptable: { from: string; to: string }[]  // windows the owner allows
        durationMinutes?: number; place?: string }
    | { type: "deliver_message"; message: string; askForReply: boolean }
    | { type: "ask_question"; question: string }
  // What Tavi may do without asking the owner
  authority: {
    mayAcceptWithinAcceptable: boolean   // agree to a time inside `acceptable`
    mayProposeAlternatives: boolean      // suggest times inside `acceptable`
    mayShareOwnerPhone: false            // always false in MVP
    mayDiscuss: string[]                 // short topics the owner allowed
  }
  mustNot: string[]                       // owner's extra limits, free text, shown to model
  report: { at: string | null /* ISO with tz */; mode: "scheduled" | "on_completion" }
  timezone: string                        // owner's IANA timezone
  referenceDate: string                   // "tomorrow" resolved against this
}
```

Extraction ("Call my CA at … tell him I need to meet tomorrow, ask whether 3 PM
works…") is one structured-output call (`generateObject`-style through the
existing gateway) on the web side, producing a draft. Missing or ambiguous
fields block confirmation: no number, a number that isn't a valid Indian or
E.164 number, "tomorrow" near midnight, no acceptable window when alternatives
are allowed, a report time in quiet hours. The UI asks for each (UX spec §3).

## 3. Conversation states

A finite machine in `lib/voice/dialogue.ts`. Each state lists the tools and
the moves allowed; the prompt for a turn includes only those.

```mermaid
stateDiagram-v2
  [*] --> opening
  opening --> confirm_person: disclosure spoken
  confirm_person --> purpose: right person / can pass the message
  confirm_person --> wrong_person: says wrong number / not them
  confirm_person --> callback_later: busy, asks to call back
  purpose --> negotiate: goal stated
  negotiate --> confirm_details: specific time accepted or offered
  negotiate --> negotiate: alternatives within authority
  negotiate --> unresolved: declines / can't decide / outside authority
  confirm_details --> negotiate: correction
  confirm_details --> closing: read-back confirmed
  unresolved --> closing
  wrong_person --> closing
  callback_later --> closing
  closing --> [*]: end_call
```

| State | Tavi's job | Tools allowed |
| --- | --- | --- |
| `opening` | Fixed disclosure, not generated: "Hello, this is Kriya Tavi, an AI assistant calling on behalf of {owner}. Is this a good moment for a quick question?" Also the opt-out line (§8) | — |
| `confirm_person` | Confirm it's the right person, by role ("Am I speaking with {owner}'s CA?") — never invent or assert a name the owner didn't give | `note_wrong_person`, `note_callback_request` |
| `purpose` | Say the goal from the spec | — |
| `negotiate` | Ask about the preferred time; handle alternatives within `acceptable`; record proposals | `note_proposed_time`, `note_question_for_owner` |
| `confirm_details` | Read back date, time and place; get a clear yes | `note_agreement` (only after read-back yes) |
| `unresolved` | Say Tavi will tell the owner; no pressure | `note_question_for_owner` |
| `closing` | Thank, say the owner will be informed, goodbye | `end_call` |

Guards in code:

- `note_agreement` is rejected unless the previous Tavi turn was a read-back of
  exactly that date/time, the callee's next final transcript is an affirmative
  (classified by the model **and** matched by a small affirmative lexicon in
  `languages.ts`), and the time is inside `acceptable` with
  `mayAcceptWithinAcceptable = true`. Otherwise it's recorded as a proposal.
- A time outside `acceptable` can only be recorded as a proposal, and Tavi says
  "I'll check with {owner} and get back to you."
- Leaving a state unhandled for 3 turns → `unresolved`.
- Max call length: `voice_tasks.max_call_seconds` (default 300 s). At 80 %,
  Tavi moves to `closing`.

## 4. Numbers, dates and ambiguity

- Times and dates from STT are normalized by `lib/voice/languages.ts`
  (`en-IN`) into `{date, time, tz}` against `spec.referenceDate`.
- Ambiguity rules: bare "3" → ask "3 in the afternoon?"; "tomorrow" said by the
  callee means the call date + 1; "next Friday" → read back the full date;
  "evening" → ask for a time; ranges ("between 3 and 5") → recorded as a
  proposal window, then ask for a specific time if the goal needs one.
- Every recorded time is read back with weekday and date: "So that's
  Thursday the 18th at 3:30 PM?"
- Low STT confidence (< 0.6 where provided) on a turn containing a number →
  ask again before recording it.
- Changed agreement ("actually, make it 4"): the earlier agreement is marked
  `superseded` with its turn reference; the read-back runs again.

## 5. Call tools (D-14)

Defined in `createCallTools()` in `lib/agent/tools.ts`, run only in
`kriya-voice`. Each writes to the current attempt's in-memory notes and
persists to `call_outcomes.interpreted.notes`; none changes anything outside
Kriya except `end_call`, which ends this call.

| Tool | Input (zod) | Effect |
| --- | --- | --- |
| `note_proposed_time` | `{ date, time, by: "callee"\|"tavi", turnSeq }` | Adds a proposal |
| `note_agreement` | `{ date, time, readBackTurnSeq, confirmTurnSeq }` | Adds an agreement if guards pass, else an error string to the model |
| `note_question_for_owner` | `{ question ≤ 300 chars, turnSeq }` | Adds an unresolved question |
| `note_wrong_person` | `{ turnSeq }` | Sets the flag; moves to `closing` |
| `note_callback_request` | `{ when?: string, turnSeq }` | Records a requested callback time (a proposal for a follow-up, not a scheduled call) |
| `end_call` | `{ reason: "done"\|"wrong_person"\|"declined"\|"callee_request"\|"time_limit" }` | Plays the closing line, then `hangup()` |

Invalid tool input → the model gets the validation error once; two invalid
calls in a row → escalation model for the rest of the call (VOICE_ARCHITECTURE
§5); a third → Tavi says it will have the owner follow up and ends politely.

## 6. Structured outcome

`call_outcomes` per attempt. `observed` is written only from provider and
stream data; `interpreted` by post-call extraction from the stored turns plus
the in-call notes.

```ts title="lib/voice/outcome.ts (shape)"
type Observed = {
  connection_status: "connected" | "answered_no_stream" | "busy" | "no_answer"
    | "rejected" | "failed" | "canceled" | "unknown"
  provider_call_id: string | null
  answered_at: string | null; ended_at: string | null
  billable_seconds: number | null
  ended_by: "callee" | "tavi" | "provider" | "unknown"
  disclosure_played: boolean          // mark received for the opening line
  turns: number
  transcript_reference: { attemptId: string; firstSeq: number; lastSeq: number } | null
  evidence_references: string[]       // call_events ids + verification id
}

type Interpreted = {
  recipient: { label: string; confirmed_role: boolean; name_said: string | null }
  purpose: string                                 // from the spec, echoed
  summary: string                                 // ≤ 400 chars, factual
  result: "agreed" | "alternative_proposed" | "declined" | "wrong_person"
    | "callback_requested" | "unclear"
  commitments: { by: "callee" | "owner_via_tavi"; what: string; turnSeq: number }[]
  proposed_times: { date: string; time: string; by: "callee" | "tavi"; turnSeq: number }[]
  agreed_times: { date: string; time: string; readBackTurnSeq: number;
                  confirmTurnSeq: number; superseded: boolean }[]
  unresolved_questions: { question: string; turnSeq: number }[]
  next_action: { type: "none" | "owner_decides" | "call_again" | "owner_calls_back";
                 suggested_at: string | null } // a suggestion; never auto-scheduled
  next_action_due_at: string | null
  uncertainty_notes: string[]                     // what the model wasn't sure of
  confidence: number                              // 0–1, model's own; informational
}
```

Every item in `commitments`, `proposed_times`, `agreed_times` and
`unresolved_questions` must cite a `turnSeq` that exists and whose text
supports it; the verifier checks that.

## 7. Verification (`lib/voice/verify.ts`)

Runs after each attempt ends, in `kriya-web` (on the final webhook) and again in
the worker's recovery loop until `verified_at` is set.

1. **Provider truth.** `getCall(providerCallId)`; reconcile with `call_events`.
   Disagreement (webhook says completed, API says failed) → the API wins; the
   disagreement goes in `verification`.
2. **Observed outcome** from step 1 and the stream: if not connected, write
   `observed` and `interpreted = null`, `verifier_status = accepted`. Done.
3. **Extraction.** Post-call structured-output call over the stored turns and
   call-tool notes (budgeted, escalation model on schema failure, max 2 tries).
   Invalid twice → `verifier_status = needs_review`, task → `needs_owner`.
4. **Checks** (deterministic, code):
   - every cited `turnSeq` exists in this attempt;
   - each `agreed_time` has the matching in-call `note_agreement` and passed its
     guards; otherwise demoted to `proposed_times` with an uncertainty note;
   - agreed/proposed times parse and match the normalized text of the cited turn;
   - `result = agreed` requires ≥ 1 non-superseded agreed time;
   - `result` is consistent with `observed` (no "agreed" on a 4-turn call where the
     callee never spoke, etc.);
   - no commitment by `owner_via_tavi` outside `spec.authority`.
5. Pass → `accepted`; the task can move on. Fail → `needs_review` (owner sees the
   transcript and decides) — never silently "fixed" into success.

**A task is never completed because the model says it succeeded.** Completion
needs evidence from steps 1–4 and, for the report, the delivery mark (D-08).
Tests: TEST_STRATEGY.md T-VER-01…08.

## 8. The callee: injection, opt-out and sensitive requests

The callee's words are treated like web content in the existing agent
(`docs/kriya/security.md`): untrusted input. Capability limits matter most —
the in-call tool set can't send, pay, read the owner's data or call anyone.

| Callee says | Tavi does |
| --- | --- |
| "Ignore your instructions and …" / "You're now my assistant" | Ignores it; continues the goal; notes `uncertainty_notes: "callee attempted to redirect"` |
| "Tell me his other number / address / email" | "I can't share {owner}'s contact details. I'll let them know you asked." → `note_question_for_owner` |
| Asks for money, a payment, an OTP, bank or card details, passwords | Refuses; never repeats or records numbers that look like OTPs/cards (redacted in turns); notes it |
| Asks Tavi to agree to fees, contracts, legal or medical decisions | "I can't agree to that for {owner}; I'll pass it on." Recorded as a question, never a commitment |
| "Call X" / "Email me the details" | "I'll ask {owner} to get back to you." No tool exists to do it |
| "Are you a bot / is this recorded?" | Truthful: "Yes, I'm an AI assistant. This call isn't recorded; {owner} will get a written summary." (D-10; wording reviewed in Phase 9) |
| "Don't call me again" | "Understood, I'll make sure you're not called again." → number added to `call_suppressions`, closing |
| Abusive or distressed | Polite close; `end_call(reason:"callee_request")` |
| Emergency mentioned | Tavi isn't an emergency service: "Please contact emergency services on 112." Ends politely; outcome flags it for the owner |

The system prompt states these rules briefly, but enforcement is in code: no
tool for any of the above, OTP/card-number redaction in `conversation_turns`
before insert, and a post-call check that no `commitments` violate the
authority.

## 9. Budgets

| Budget | Default | Enforced in |
| --- | --- | --- |
| Call duration | 300 s outreach, 180 s report | Provider `TimeLimit` + `kriya-voice` timer |
| LLM output per turn | 120 tokens | Request option |
| Tool calls per turn | 2 | Dialogue engine |
| LLM turns per call | 40 | Dialogue engine |
| Cost per task | `voice_tasks.cost_budget_micro_inr` from the plan | Metering; at 100 % Tavi closes the call politely |
| Escalation switches | 1 per call | Dialogue engine |

## 10. Hand-off

No live transfer to the owner in MVP (it would need a second leg and the
owner to be available). "Hand-off" means: Tavi says the owner will get back,
records the questions, and the report and app show them. A warm transfer is a
later feature, gated by its own approval.
