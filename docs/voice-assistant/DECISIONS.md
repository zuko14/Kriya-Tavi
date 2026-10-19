# Kriya Tavi voice: architecture decisions

Each decision has an id that the other documents and `status.md` refer to.
Status is **Proposed** until the owner approves it; a coding agent must not
start a phase whose decisions are still Proposed without that approval being
recorded in `status.md`.

Written 2026-10-17 from the repository at commit `bdf223f` and the research
in `COMPETITOR_RESEARCH.md` and `TELEPHONY_PROVIDER_ASSESSMENT.md`.

| Id   | Decision                                                                           | Status   |
| ---- | ---------------------------------------------------------------------------------- | -------- |
| D-01 | Hybrid build: Kriya's own TypeScript orchestration, managed telephony/STT/TTS      | Proposed |
| D-02 | Exotel primary, Plivo secondary, Twilio excluded for India                         | Proposed |
| D-03 | A new Render web service, `kriya-voice`, terminates call audio                     | Proposed |
| D-04 | Chained STT → LLM → TTS; speech-to-speech deferred                                 | Proposed |
| D-05 | Voice work gets its own tables and queue, beside `kriya.tasks`                     | Proposed |
| D-06 | State transitions only through SQL functions with an allow-list                    | Proposed |
| D-07 | Owner reminders are phone calls only; no fallback channel                          | Proposed |
| D-08 | "Delivered" means the full report was played on a connected call                   | Proposed |
| D-09 | Every call to a third party needs explicit in-app confirmation                     | Proposed |
| D-10 | Recording off; transcripts as text with a retention limit                          | Proposed |
| D-11 | English first; language is data, not code                                          | Proposed |
| D-12 | Live calling behind three switches and an allow-list                               | Proposed |
| D-13 | Owner number verified by a call with a keypad code, not SMS                        | Proposed |
| D-14 | In-call tools live in `lib/agent/tools.ts` as a separate, bounded set              | Proposed |
| D-15 | Phase order changed: durability and dialogue on mocks before live calls            | Proposed |
| D-16 | Automated calls are treated as A2P under TRAI's Third Amendment until counsel says otherwise | Proposed |
| D-17 | Self-improvement is a governed loop: cases → regression scenarios → gated, versioned, rolled-out policy changes; never autonomous | Proposed |
| D-18 | Premium voice UI built only from existing components and tokens; no new UI dependency | Proposed |

---

## D-01 Hybrid build

**Decision.** Build the call orchestration, dialogue engine, state machines and
metering in TypeScript inside this repository. Buy telephony, speech
recognition and speech synthesis as managed APIs behind small provider
interfaces (`lib/voice/providers.ts`). Do not adopt Bolna, Pipecat or LiveKit
Agents as a runtime.

**Why.**

- Kriya's durable queue, leases, RLS, metering and approval rules already exist
  (`lib/agent/queue.ts`, `worker/index.ts`, `kriya.claim_task`,
  `lib/agent/metering.ts`). A second runtime would duplicate them in another
  language and split the source of truth.
- Bolna (MIT, Python) lists Exotel as "coming soon" in its open-source repo
  (github.com/bolna-ai/bolna, read 2026-10-17); its hosted Exotel support is a
  separate, closed product. Pipecat (BSD-2-Clause per its source headers,
  Python) has a working Exotel serializer, but it is Python. LiveKit Agents JS
  is Apache-2.0 and TypeScript, but needs a LiveKit server and a SIP trunk in
  front of Exotel: one more component to operate.
- Reuse is limited to ideas and protocol details, with attribution wherever
  code is ported: Pipecat's `ExotelFrameSerializer` is a good reference for the
  wire format, and LiveKit's turn detector is a reference for endpointing. The
  licenses permit this; record any ported code in `NOTICE.md`.

**Revisit when** a measured latency or barge-in target can't be met with the
in-house loop (EVALUATION_PLAN.md, metric L1). Then evaluate LiveKit Agents JS
first, the only TypeScript option.

## D-02 Exotel primary, Plivo secondary, Twilio excluded

**Decision.** Exotel is the primary provider (Voicebot applet, bidirectional
WebSocket, Mumbai API host). Plivo is the secondary (bidirectional `<Stream>`).
Twilio is excluded for calls to Indian numbers.

**Why.** Twilio's India guidance says calls from a +91 caller ID to +91
destinations stopped working on 1 Aug 2024. Exotel is India-native and
documents a bidirectional stream with `clear` and `mark` events, both needed
for barge-in and for proving delivery. Plivo documents the same capability but
requires an India-registered business for Indian numbers. Details and open
account checks: `TELEPHONY_PROVIDER_ASSESSMENT.md`.

## D-03 A new `kriya-voice` service

**Decision.** Add a third Render service, `kriya-voice`: a plain Node HTTP server
(not Next.js) that accepts the provider's media WebSocket and runs the live
dialogue loop for that call. HTTP status webhooks go to `kriya-web`
(`app/api/voice/...`), like the Razorpay webhook.

**Why.**

- Render background workers (`kriya-worker`) accept no inbound traffic, so they
  can't receive a provider's WebSocket.
- Next.js route handlers don't upgrade connections to WebSockets, and a web
  deploy would cut live calls.
- A separate service can be deployed, scaled and drained on its own (drain:
  stop accepting new streams and let live calls finish).

**Cost.** One more service to run and pay for, and one new dependency (`ws`) to
review in Phase 2. Node 22 has a WebSocket client but no server.

## D-04 Chained pipeline

**Decision.** Streaming STT → OpenRouter LLM (bounded tools, structured output)
→ streaming TTS, orchestrated by Kriya. Real-time speech-to-speech models are
deferred.

**Why.** Every turn becomes text Kriya can store, check, redact and audit. The
LLM stays on the existing OpenRouter gateway and metering. Each part can be
swapped and benchmarked alone. Telephone audio (8–16 kHz) suits STT vendors
that tune for it. Speech-to-speech models promise lower latency, but they
aren't on OpenRouter, are harder to hold to tool schemas mid-utterance, and
cost more per minute on published token prices (VOICE_ARCHITECTURE.md §7).

## D-05 Separate voice tables and queue

**Decision.** New tables (`voice_tasks`, `voice_calls`, `call_attempts`, …) and a
new claim function, `kriya.claim_voice_call`. The existing worker process runs
both loops. `kriya.tasks` is not reused for calls.

**Why.** `kriya.tasks` models one agent turn in a thread: it requires a
`thread_id`, a routing tier and a step budget, allows one active row per
thread, and has a five-value status. A voice task lives for hours (call now,
report at 6 PM), owns several scheduled calls and needs its own states.
Overloading `kriya.tasks` would weaken the invariants the current tests prove.
The new queue copies the proven pattern (`FOR UPDATE SKIP LOCKED`, lease,
heartbeat, recovery).

## D-06 Transitions only through SQL

**Decision.** Users get `select` only on voice tables. Every status change goes
through `kriya.voice_transition(...)` (security definer), which checks a static
allow-list of `(entity, from, to)` and the evidence each one needs. A trigger
rejects any other status change, even from the privileged connection.

**Why.** "Neither the browser nor the model can mark a task completed" must hold
in the database, not only in the code paths someone remembers to use.

## D-07 Phone-only owner reminders

**Decision.** Reminders and outcome reports reach the owner only by a phone call
to their verified number. No push, SMS, WhatsApp or email, and never a silent
switch to one. The web app shows history and failures when the owner opens it.
Other channels may come later only as an explicit, per-owner opt-in.

**Consequence for existing code.** `components/workspace/notifier.tsx` raises
browser notifications from `kriya.tasks` via `/api/events`. Voice state lives in
other tables, so it raises none. Keep it that way: don't add voice events to
`/api/events`.

## D-08 Delivery criterion

**Decision.** An owner report is `delivered` only when the provider confirms the
call was answered, Kriya's media stream was connected, and the provider sent
the `mark` event for the last audio chunk of the report while the call was
still connected. `acknowledged` is a separate, stronger state: after the
report, the owner said or keyed something recognised as "got it". Answered
alone is never delivered.

## D-09 Explicit confirmation for third-party calls

**Decision.** Every call to anyone other than the owner needs the owner to
confirm, in the app and through a server action, the exact number, recipient
description, purpose, authority limits and report time. A follow-up asked for
by voice ("call him again tomorrow") becomes a draft that waits for in-app
confirmation. Cancelling, postponing or asking about a reminder can be done by
voice on the owner's own call.

## D-10 Recording and transcripts

**Decision.** No audio recording (Exotel's `Record` is never set). Transcripts
are the STT text of each turn, kept for 30 days by default (owner-configurable
down to 0, meaning outcome only), and deletable at any time. Structured
outcomes stay until the owner deletes the task.

## D-11 Language

**Decision.** English (`en-IN`) only at launch. `language` is a column on voice
tasks and owner settings. Prompts, STT model, TTS voice and number/date parsing
are looked up per language in one registry (`lib/voice/languages.ts`). Adding
Hindi later means a registry entry and evaluation data, not new code paths.

## D-12 Live-call switches

**Decision.** A real call is placed only if all of these hold: env
`KRIYA_VOICE_LIVE=1` on `kriya-worker`; platform setting `voice.liveCalls` is
`on` (owner console); the user is on the voice allow-list
(`kriya.voice_access`); and, until Phase 9 signs off, the destination is on the
test-number allow-list. If any one is off, calls go to the mock provider or are
refused.

## D-13 Owner number verification by call

**Decision.** The owner verifies their number by taking a call that asks them to
key in a 6-digit code shown on screen (DTMF). No SMS, consistent with D-07.
Codes expire in 10 minutes, are stored hashed and allow 3 tries.

## D-14 In-call tools

**Decision.** The live dialogue model gets a small, separate tool set,
`createCallTools()` in `lib/agent/tools.ts` (AGENTS.md: agents act only through
tools there). These tools only write Kriya state for the current call attempt
(`note_proposed_time`, `note_agreement`, `note_question_for_owner`,
`note_wrong_person`, `note_callback_request`, `end_call`; full list in
CONVERSATION_AND_VERIFICATION.md §5). None places a call, sends a message or reads other data. The call
itself is the side effect the owner approved under D-09, and `end_call` only
ends that call. The tools run in `kriya-voice`, never on the web server.
AGENTS.md is updated to say so.

## D-15 Phase order

**Decision.** The brief's roadmap is reordered so that durable call orchestration
(brief Phase 5) and the dialogue engine (brief Phase 4) are built and tested on
mocks before the first real outbound call (brief Phase 3). The mapping is in
IMPLEMENTATION_PLAN.md.

**Why.** AGENTS.md and the brief both require tests before new external side
effects. A real call placed before idempotency and recovery are proven could
ring someone twice. Exotel account approval (KYC, AgentStream enablement, A2P
declaration) is an external dependency that shouldn't block the work that
doesn't need it.

## D-16 A2P treatment

**Decision.** Until qualified telecom counsel advises otherwise, treat every
call Kriya places as an Application-to-Person (A2P) call under TRAI's
Telecom Commercial Communications Customer Preference (Third Amendment)
Regulations, 2026 (gazette dated 18 Sep 2026): declare the automated use and
the caller IDs to the provider before going live, and keep the content strictly
non-promotional.

**Why.** Secondary analyses of that amendment describe A2P as any call started
by software without a person dialling each number, explicitly including AI voice
bots, and say undeclared automated traffic is treated as unsolicited commercial
communication. Kriya's calls are started by software. The primary text could
not be read during this research (scanned PDF), so this is a precaution, not a
legal conclusion. See SECURITY_AND_COMPLIANCE.md §2.

## D-17 Governed improvement loop

**Decision.** Tavi improves through SELF_IMPROVEMENT.md's loop: automatic
signals and owner feedback become labelled cases; every confirmed case becomes
a permanent de-identified regression scenario; candidate policy bundles
(prompts, wording, normaliser rules, thresholds, vendor choices) are proposed
offline, must beat the active version on the full evaluation, then go through
shadow and canary stages with automatic rollback. Safety guards, limits, the
state machines and the disclosure are outside the loop. Every attempt records
its `policy_version`.

**Why.** A system that changed its own production behaviour could start
agreeing to things or skip the disclosure before any test saw it. A gated loop
keeps the improvement compounding (the regression set only grows) while every
change stays reviewable and reversible. Fine-tuning waits for the conditions in
SELF_IMPROVEMENT.md §8.

## D-18 Premium UI from existing parts

**Decision.** The voice screens (UX_AND_INTERACTION_SPEC.md §11) use the
existing `Mascot`, glass tokens, `btn-liquid`, keyframes and theme system, with
CSS-only motion and Web Audio for the level ring. Phase 7 adds no UI dependency.

**Why.** Consistency with the current Kriya UI, no bundle growth, and the
existing reduced-motion and dark-mode handling apply automatically.
