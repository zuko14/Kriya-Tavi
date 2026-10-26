# Voice assistant upgrade: gap analysis and proposals (2026-10-26)

The owner asked for a voice assistant that is more reliable, more secure and
accessible to everyone, measured against two scenarios. This document is
what the code does today against those scenarios (file references), what
this session built and tested on mocks, and what needs a decision first.
Each new decision is **Proposed** until the owner approves it in
`status.md` → Owner approvals. Session record: `status.md` → Phase 4.

No real call, STT/TTS request or paid model run was made. Nothing here
compares Kriya with a named product; see D-26.

## 1. The scenarios

1. "Call my CA and ask if he's available for a meeting tomorrow." Quick
   setup; when the call ends, a summary in the person's chat thread: who was
   reached, what was asked, what was agreed (date/time), what's left open.
2. During a call, give the CA a contact's phone number. When the CA asks to
   repeat it, or for part of it ("the last four digits?", "after 98 what
   came?"), Tavi answers digit by digit in natural groups, confirms the
   read-back, and never says a wrong or invented digit. Also: barge-in,
   "slower please", a wrong number, voicemail, no answer, busy, and a
   language switch (English, Hindi, Telugu, Hinglish).

## 2. Gap analysis

Status before this session → after it. "Mocks" means proven with the mock
provider, mock STT/TTS and the scripted model only.

| Need | Before | Now | Where |
| --- | --- | --- | --- |
| Draft the call from chat | Works: `propose_call` drafts it; the person confirms on `/calls/[taskId]` (D-09) | Unchanged | `lib/agent/tools.ts` `createProposeCallTool`, `lib/voice/spec.ts`, `components/voice/confirm-card.tsx` |
| Quick setup | The worker claims a confirmed call within ~1 s (`voiceLoop` polls every 1 s) and dials at once. The person's confirmation is required (D-09). Not measured live | Unchanged; setup latency to be measured in Phase 5 | `lib/voice/run-call.ts` `voiceLoop`, `claimNext` |
| Summary after the call | **Gap.** The outcome reached the owner only as the spoken report call (`reportText`) and the `/calls/[taskId]` page; nothing in the thread | **Built**: one assistant message in the task's thread when its outreach call is over (settled, exhausted, needs the owner, blocked), from verified records only; shown when the thread is opened (no notification, D-07). Mocks + database tests | `lib/voice/thread-summary.ts`, hook at the end of `settleCall` (`lib/voice/verify.ts`) |
| Who / asked / agreed / open | The verified outcome had all of it (`call_outcomes.interpreted` + notes) | The summary shows: reached (or wrong number / voicemail), asked (from the owner's own spec), agreed time (guarded agreement only), the callee's suggestions, the number given and its read-back, questions and callback requests; needs-review says so; not reached says when it was tried and why | same |
| Give a contact's number | **Gap.** No spec field; `authority.mayShareOwnerPhone` is fixed false; the contact-request guard refuses "his number"; the model can't speak digits (its replies are redacted) | **Built in the engine**: `spec.share` and a `sharing` state; the number is given in 5 + 5 groups, as words. **Drafts can't set it yet** (D-19) | `lib/voice/dictation.ts`, `lib/voice/dialogue.ts`, `lib/voice/schemas.ts` |
| Repeat / partial / read-back | Gap | **Built, deterministic** (no model): repeat, slower (sticky), last/first *n*, after/before a part, wait ("let me get a pen"), read-back checked digit by digit ("Not quite, after nine eight seven six it's five, not four"); a part said twice or absent gets the whole number, never a guess; a low-confidence read-back is never called wrong. Requests understood in English, Hindi, Telugu, Hinglish, Latin and native script | same; `tests/voice/dictation.test.ts`, S31–S35 |
| The number never stored or shown to a model | — | Stored turns hold `[number withheld]`; the callee's read-back is redacted before storage; model prompts never contain it (tested) | `lib/voice/dialogue.ts` `say(text, end, stored)`; `tests/voice/dialogue-number.test.ts` |
| Barge-in | Works for every turn (`clear`, synthesis aborted, `played_ms`) | A number talked over is given again before moving on | `lib/voice/session.ts` `bargeIn`; S34 |
| Wrong number | English only | + Hindi and Telugu phrases ("galat number", "tappu number", native script) | `lib/voice/languages.ts`; S38 |
| Opt-out | English only | + Hindi and Telugu ("dobara call mat karna", "malli call cheyakandi") | same; S39 |
| Voicemail (outreach) | **Gap.** Only owner calls had the silence rule; a voicemail greeting reached the model as speech | **Built**: a voicemail greeting or network announcement (English, Hindi, Telugu) → Tavi hangs up without another word, `end_reason = voicemail`, summary "reached voicemail". **Deviation from S29**: the attempt is connected, so the call settles and isn't redialled (D-22) | `lib/voice/dialogue.ts`, `lib/voice/session.ts`; S36 |
| No answer / busy | Works: bounded retries, exhausted after `max_attempts` (fault suite, S02/S05) | + the thread summary says how often and when it was tried | `lib/voice/verify.ts` `settleCall` |
| Language switch | **Gap**: English only (D-11); a request for Hindi went to the model | Honest fixed reply ("I can only speak English on this call for now…"), the request recorded for the owner. Real Hindi/Telugu calls: D-21 | `lib/voice/languages.ts` `languageAsked`; S37 |
| Accessibility | Owner report by phone only (D-07); `/calls` screens checked at 360 px; TalkBack open (Phase 7) | "Slower please" on numbers; a written summary in the thread for people who can't rely on a call; numbers grouped as Indians say them | — |

Not built, and why: anything that needs a decision below, live calls, real
STT/TTS (B6), and any competitor comparison.

## 3. Proposed decisions

| Id | Decision | Status |
| --- | --- | --- |
| D-19 | Let a draft carry a contact's number for Tavi to give (`spec.share`) | Proposed |
| D-20 | Ratify the post-call summary in the originating thread | Proposed (built) |
| D-21 | Hindi, Telugu and Hinglish calls as registry entries (D-11) | Proposed |
| D-22 | A voicemail or network announcement counts as "not reached" and may be retried | Proposed |
| D-23 | Live refresh of the thread when the summary arrives | Proposed |
| D-24 | Measure call setup latency (L-setup) | Proposed |
| D-25 | Agents treat voice summaries in a thread as foreign content | Proposed |
| D-26 | No comparison with a named product until a primary-source review | Proposed |

### D-19 Share a contact's number on a call

**Proposal.** `draftFieldsSchema` gains `share: { label, phone }` (a valid
Indian mobile or E.164 number, `parseIndianMobile`), only from the person's
own request; `propose_call` may fill it only from the person's words in the
thread (never from web, email or memory content). The confirmation card
shows "Tavi will give {label}'s number, ending {last 4}" and the person
confirms it with the call (D-09). The number is stored in
`voice_tasks.spec` under RLS like the recipient's number, never logged, and
withheld from turns and prompts (already built). One number per call.

**Why a decision.** It discloses a third person's personal data to another
third party. DPDP: the owner is the one sharing; Kriya processes it on
their instruction. Needs counsel question **Q12** (is the owner's instruction
enough, or must the contact have agreed?) before live use. The engine is
ready; only the draft path is closed.

### D-20 Summary in the originating thread

**Built.** One `assistant` message per finished outreach call
(`voice-<call id>`, idempotent), in the task's own thread, with the
thread's preview and activity time updated. D-07 says outcome reports reach
the owner only by phone and "the web app shows history … when the owner
opens it": this is that history, not a notification (nothing in
`/api/events`). **Owner:** confirm this reading, or ask for it behind a
setting.

### D-21 Hindi, Telugu, Hinglish calls

**Proposal.** Per D-11, each language is a `LANGUAGES` entry plus evaluation
data, never a new code path: the disclosure and fixed lines translated and
reviewed by counsel (Q4 covers the disclosure wording); affirmative and
hedge lexicons per language for the agreement guard ("avunu", "sare",
"theek hai" are not accepted as agreement until reviewed); the time/date
normaliser; digits spoken in the language; STT/TTS vendors that handle
code-mixed speech (B6 benchmark, paid); ≥ 5 phrasings per scenario per
language. A mid-call switch only to a language whose entry and vendors
exist, re-playing the disclosure in that language. Until then: the honest
English-only reply (built). Dictation already understands Hindi and Telugu
requests.

### D-22 Voicemail is "not reached"

**Proposal.** EVALUATION_PLAN S29 says "attempt failed". Today a voicemail
answer connects the stream, so the call settles as `unclear` and is never
redialled (F22: someone who spoke to Tavi is never redialled). Proposed: an
attempt that ended `voicemail` with no callee turn beyond the greeting
moves the call to `retry_wait` within the same caps (per-number daily
limit, window, `max_attempts`). Needs a new `voice_transition` edge
(`in_call → retry_wait` for that case only), so a migration and tests
(T-VER, fault suite) first.

### D-23 Live thread refresh

The summary appears when the thread is next loaded. A live update would use
`/api/events`, which is protected and kept free of voice events (D-07).
**Options:** (a) leave as is; (b) the thread page polls its own messages
while a call drafted from it is in progress. Recommended: (b), UI only.

### D-24 L-setup

Add **L-setup** to EVALUATION_PLAN §3: time from the person's confirmation
to the first ring, p50/p95, on staging and live (Phase 5). Today's budget
on the worker is ≤ ~1 s plus the provider's dial time; nothing is claimed
until measured.

### D-25 Voice summaries are foreign content for agents

The summary quotes the callee's questions (sanitised: no links, headings or
code; ≤ 200 characters each). Agents later read the thread, so the callee's
words reach a model as part of an assistant message. **Proposal:** when an
agent's context includes a message with `metadata.voiceTaskId`, wrap it with
the same `FOREIGN` notice web and email content get (`lib/agent/tools.ts`),
a `lib/agent/run-task.ts` change that needs track A's change list.

### D-26 Competitive claims

The owner wants Tavi to beat competing voice assistants (Grok was named).
This document makes no comparison: ND-20 requires a primary source read
within 30 days for any claim about a named product, and never a claim that a
competitor lacks a feature without that. **Proposal:** a dated research
note (`COMPETITOR_RESEARCH.md` §update) reading each product's own
documentation for outbound calls on a person's behalf, number dictation,
Indian languages and post-call summaries; only then any positioning copy.

## 3a. Built on 2026-10-26 (owner: "implement everything according to the code wise 100%")

Built at the owner's instruction in chat. The decisions stay **Proposed** in
DECISIONS.md until the owner marks them approved there. What each one's
live effect still waits on is listed.

| Id | Built | Switch | Still needed before it's live |
| --- | --- | --- | --- |
| D-19 | `share` in drafts (`draftFieldsSchema`, so `propose_call` too), the free-text extraction (only a number the person typed, never the number being called), the new-call form, the confirmation card (masked until shown); never the owner's own number | `voice.shareContact`, default **off** | Counsel Q12 |
| D-20 | The thread summary | none (history, no notification) | Owner ratifies the D-07 reading |
| D-21 | `hi-IN` and `te-IN` entries: disclosure, fixed lines, Tavi's wording, the time/date normaliser (rewrites to English words, one parser), yes/maybe/no for the agreement guard, read-backs; a draft may choose the language; a mid-call switch to a language that's on replays the AI disclosure and asks who they are again; the model is told the language; a TTS voice per language | `voice.languages`, default **`en-IN`** | A native speaker's review of every line; counsel on the translated disclosure (Q4); STT/TTS vendors that handle code-mixed speech (B6 benchmark, paid) |
| D-22 | Migration `20270102000000_voice_voicemail_retry.sql` (+ rollback); voicemail is retried within the call's attempts, no model is asked to interpret it, the task ends `no_answer`; the owner's report and the summary say "voicemail" | none | Applying the migration (`npm run db:migrate`, owner) |
| D-23 | `ThreadCallWatch` on the `propose_call` card | none | — |
| D-24 | Setup latency (confirm → dial, confirm → ring, p50/p95, 7 days) on `/owner/operations` | none | Real calls to measure (Phase 5) |
| D-25 | The foreign-content notice on voice summaries in agents' model input | none | — |
| D-26 | Not code: a research note with primary sources | — | Owner go-ahead for the research |

Known limits, in the code as comments: Tavi gives a number's digits as
English words on every call; the owner's own calls stay in English; the
Hindi/Telugu normaliser understands common phrasings (tested), not every
dialect.

## 4. Counsel question added

| # | Question |
| --- | --- |
| Q12 | When the owner tells Kriya to give a contact's phone number to the person called, is the owner's instruction a sufficient basis under the DPDP Act, or must the contact have agreed? Does it matter that Kriya's AI, not the owner, speaks it? |

## 5. Test scenarios added (EVALUATION_PLAN §2)

S31–S39, each with 5–6 phrasings in English, Hindi, Telugu and Hinglish, run
by `npm test` on the scripted model and by `npm run voice:eval -- --text`
on a real model (paid, owner-run). S31–S36 and S38–S39 need no model at all
(`maxModelCalls: 0`): the behaviour is code.
