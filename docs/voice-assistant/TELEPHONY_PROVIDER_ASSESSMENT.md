# Telephony provider assessment

Research date 2026-10-17. Facts come from the providers' public docs, read on
that date; **nothing has been checked against a real account**. Every
"account check" below is a blocker for Phase 5 (first live call).

## 1. Shortlist and outcome

| Provider | Can call Indian numbers from an Indian caller ID | Bidirectional stream | Verdict |
| --- | --- | --- | --- |
| **Exotel** | Yes (India-native, ExoPhone as `CallerId`) — account check | Yes: Voicebot applet, `media`/`mark`/`clear`/`dtmf`/`stop` | **Primary** |
| **Plivo** | Plivo India numbers as caller ID — account check; India-registered business required | Yes: `<Stream bidirectional="true">`, `playAudio`/`clearAudio` | **Secondary** |
| Twilio | **No**: +91 → +91 calls stopped working from 1 Aug 2024 per Twilio's India guidance | Yes | Excluded for India |
| Vobiz, Acefone, Airtel SIP | Listed by Bolna as India options | Unknown | Not assessed; revisit only if Exotel and Plivo both fail |

Sources: Exotel Voicebot applet
https://developer.exotel.com/docs/agentstream/stream-voicebot-applet ;
Exotel streaming quick guide
https://developer.exotel.com/docs/agentstream/getting-started and
https://support.exotel.com/support/solutions/articles/3000132268-quick-guide-to-get-started-with-exotel-streaming-services ;
Exotel extension guide (beta)
https://developer.exotel.com/docs/agentstream/stream-voicebot-extension ;
Exotel Connect Two Numbers
https://developer.exotel.com/docs/voice-v3/api-reference/connect-two-numbers ;
Exotel answered/ringing events in CRM
https://support.exotel.com/support/solutions/articles/3000106308-how-to-get-answered-or-ringing-event-in-crm ;
Plivo audio streaming guide
https://plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide ;
Plivo India pricing https://www.plivo.com/voice/pricing/in/ ;
Twilio India voice guidelines https://www.twilio.com/en-us/guidelines/in/voice .

## 2. Exotel (primary)

### 2.1 What the docs say

| Topic | Finding | Confidence |
| --- | --- | --- |
| Outbound call API | `POST /v1/Accounts/{sid}/Calls/connect`, HTTP Basic (API key:token), form-encoded. Required `From`, `To`, `CallerId` (ExoPhone). Optional `TimeLimit` (≤ 14400 s), `TimeOut` (ring time), `StreamUrl`, `CustomField` (≤ 128 chars), `StatusCallback`, `StatusCallbackEvents`, `Record` | Docs |
| API hosts | `api.exotel.com` (Singapore cluster) and `api.in.exotel.com` (Mumbai cluster); the account's cluster decides | Docs + secondary; account check |
| Rings whom first | "Connect two numbers" rings `From` first, then bridges `To` | Docs |
| Call to a flow | A "connect number to call flow" variant rings one number and runs an ExoML/App Bazaar flow, which can contain the Voicebot applet. Details weren't on the page read | **Unverified**: read `/docs/voice-v1/api-reference/connect-to-flow` |
| Status values | `queued`, `in-progress`, `completed`, `failed`, `busy`, `no-answer` | Docs |
| Callback events | `StatusCallbackEvents` selects events; docs disagree on names (`initiated, ringing, answered, completed` vs `terminal, answered`) | Conflicting; account check |
| Callback fields | `CallSid`, `EventType`, `Status`, `From`, `To`, `StartTime`, `EndTime`, `Duration`, `ConversationDuration`, `RecordingUrl`, `Direction`, `CustomField`, `Legs[]` (`OnCallDuration`, `Status`, `AnsweredBy`) | Docs |
| Callback signing | **Not documented** | Gap → mitigated in §2.3 |
| Rate limit | 429 at "20 calls/minute" | Docs |
| Concurrency | Not documented | Account check |
| Stream protocol | WebSocket; Exotel sends `connected`, `start` (`stream_sid`, `call_sid`, `account_sid`, `from`, `to`, `custom_parameters`, `media_format`), `media` (`chunk`, `timestamp`, base64 `payload`), `dtmf`, `mark`, `stop` (`reason`: `stopped` or `callended`) | Docs |
| Sending audio | `media` with `stream_sid` and base64 payload; `mark` asks for a notification when played; `clear` drops queued, not-yet-played audio | Docs |
| Codec | 16-bit mono PCM little-endian ("slin"), 8 kHz default; 16 kHz or 24 kHz via `?sample-rate=` | Docs. The quick guide also mentions mu-law; account check |
| Chunking | Min 3.2 KB (100 ms at 8 kHz), max 100 KB, multiple of 320 bytes; smaller distorts, larger times out | Docs |
| Stream auth | IP allow-listing (via Exotel support) or Basic auth in the URL | Docs |
| Custom parameters | Up to 3 key-value pairs in the URL, ≤ 256 chars total; echoed in `start.custom_parameters`. The applet URL may also be an `https` endpoint that returns the `wss` URL (dynamic) | Docs |
| Access | Applet may not be enabled by default; requires KYC and a request to hello@exotel.com | Docs |
| Stability | Extension guide marked **beta** | Docs |
| STT/TTS | None in the stream path; bring your own | Docs |
| Recording | `Record=true` returns `RecordingUrl` (Kriya never sets it: D-10) | Docs |
| Pricing | Prepaid plans (Dabbler, Believer, Influencer) drawing credits; per-minute rates and any streaming charge **not published** on official pages found | Secondary only; get a written quote |
| SLA | Not found | Ask Exotel |

### 2.2 How Kriya uses it

```mermaid
sequenceDiagram
  participant K as kriya-worker
  participant X as Exotel API
  participant P as Callee's phone
  participant V as kriya-voice (wss)
  participant W as kriya-web (webhook)
  K->>K: claim voice_call, create call_attempt (created)
  K->>X: POST Calls/connect (or connect-to-flow) with CustomField=attempt id, StatusCallback=/api/voice/exotel/status/<token>
  X-->>K: 200 CallSid → attempt initiated
  X->>P: ring
  X->>W: status ringing / answered (if subscribed)
  P-->>X: answered
  X->>V: WebSocket connected, start{call_sid, custom_parameters.t}
  V->>V: check token ↔ attempt ↔ call_sid; attempt connected
  loop conversation
    X->>V: media (caller audio)
    V->>X: media (TTS), mark, clear on barge-in
  end
  X->>V: stop{callended}
  X->>W: status completed + durations
  W->>X: GET call details (verify)
  W->>W: attempt ended; outcome verification
```

The exact API (`Calls/connect` with `StreamUrl`, or connect-to-flow with a
Voicebot applet) is chosen in Phase 5 after reading the connect-to-flow docs and
testing on the account. Both end in the same WebSocket protocol, so Phase 2–4
code doesn't depend on that choice.

### 2.3 Security measures for gaps in the docs

1. **Unsigned status callbacks.** Each attempt gets a random 32-byte callback
   token in the URL path (`/api/voice/exotel/status/<token>`); only its SHA-256
   is stored. A callback with an unknown token is dropped. A callback is never
   trusted for a terminal state on its own: before moving an attempt to a
   terminal state, `kriya-web` calls Exotel's call-details API with Kriya's
   credentials and uses that answer (the verification step of
   `OutcomeVerifier`). If Exotel later documents signatures, verify them too.
2. **Stream authentication.** Use both Basic auth in the URL (a static secret
   from `KRIYA_VOICE_STREAM_SECRET`) and a per-attempt one-time token in the custom
   parameters. `kriya-voice` accepts the stream only if the token matches an
   attempt in state `initiated`/`ringing`/`answered`, hasn't been used, and
   `start.call_sid` equals the attempt's provider call id. Request IP
   allow-listing from Exotel as defence in depth.
3. **Caller ID.** Only ExoPhones registered to Kriya's account; never a
   user-supplied caller ID; never spoofing the owner's number.

### 2.4 Account checks (blockers)

| # | Check | How to verify |
| --- | --- | --- |
| X1 | KYC done for Kriya AI's legal entity; account cluster (Singapore vs Mumbai) | Exotel dashboard; support |
| X2 | AgentStream Voicebot applet enabled for outbound calls | Email hello@exotel.com; test with a call to the owner's own phone |
| X3 | ExoPhone type usable as CLI for calls to Indian mobiles, and whether it must be from a specific series | Exotel support, in writing |
| X4 | A2P pre-declaration under TRAI's Third Amendment: what Exotel needs from Kriya | Exotel support + counsel (SECURITY_AND_COMPLIANCE.md §2) |
| X5 | Status callback event names and whether ringing/answered are sent for this call type | Test call; log raw payloads (redacted) |
| X6 | Callback signing or IP ranges | Support |
| X7 | Concurrency limit per account; 20 calls/min confirmed | Support |
| X8 | Per-minute price for outbound + streaming, rounding (per 30 s/60 s pulse?), charge for unanswered/busy attempts, GST | Written quote |
| X9 | Codec actually delivered (slin vs mu-law) and 16 kHz support on this account | Test call; inspect `start.media_format` |
| X10 | Whether `AnsweredBy` distinguishes human/machine | Test call to voicemail |
| X11 | Restrictions on personal-assistant calls in Exotel's acceptable-use policy | Read the AUP; ask support |

## 3. Plivo (secondary)

| Topic | Finding | Confidence |
| --- | --- | --- |
| Outbound | Call API with `from` (a Plivo number), `to`, `answer_url` returning XML with `<Stream>` | Docs |
| Stream | `bidirectional="true"`, `keepCallAlive="true"`, `wss://`; events `start`, `media`, `dtmf`, `stop`; send `playAudio`, `clearAudio` | Docs |
| Codec | `audio/x-mulaw` or `audio/x-l16`, 8000 or 16000 Hz | Docs |
| Constraint | With bidirectional, `audioTrack` must not be `outbound` or `both` | Docs |
| India numbers | KYC; Certificate of Incorporation and GST certificate; India-registered businesses only; INR account | Docs |
| Price | Local outbound ₹0.40–0.60/min (Plivo's own pages disagree); number rent ~₹250/month | Official pages, inconsistent |
| Callback signing | Plivo documents signature validation for webhooks (`X-Plivo-Signature-V3`) | Recalled, **not re-verified on 2026-10-17**: verify |

Account checks P1–P5 mirror X1, X3, X4, X7, X8. Plivo is implemented only if
Exotel blocks launch, or after launch for redundancy.

## 4. Provider contracts

TypeScript in `lib/voice/providers.ts` (Phase 2). Names follow the repo's
style (plain types and functions, no classes unless state is needed). Where the
brief named a contract that maps onto an existing module, the module is used
instead of a new interface.

```ts title="lib/voice/providers.ts"
// One adapter per provider; Exotel and the mock implement it in Phase 2–5
export type CallStatus =
  | "initiated" | "ringing" | "answered" | "completed"
  | "busy" | "no_answer" | "failed" | "canceled" | "unknown"

export type PlaceCallInput = {
  attemptId: string        // our id, sent as CustomField for correlation
  to: string               // E.164, already verified and allowed
  callerId: string         // a provider number from config, never from the user
  streamUrl: string        // wss://…?t=<one-time token>
  statusUrl: string        // https://…/api/voice/<provider>/status/<token>
  ringTimeoutSeconds: number
  maxDurationSeconds: number
}

export type ProviderCall = {
  providerCallId: string
  status: CallStatus
  answeredAt: Date | null
  endedAt: Date | null
  billableSeconds: number | null    // null = provider didn't say
  reportedCost: { micro: bigint; currency: "INR" | "USD" } | null
  raw: unknown                      // redacted before storing
}

export type TelephonyProvider = {
  name: "exotel" | "plivo" | "mock"
  // Must be safe to call once per attempt; the caller guarantees that
  placeCall(input: PlaceCallInput): Promise<{ providerCallId: string }>
  // Source of truth for verification and recovery
  getCall(providerCallId: string): Promise<ProviderCall | null>
  hangup(providerCallId: string): Promise<void>
  // Parses an untrusted webhook body into a normalized event, or null
  parseStatusEvent(body: string, headers: Headers): StatusEvent | null
  // Media WebSocket framing (Exotel: JSON + base64 slin)
  media: MediaCodec
}

export type StatusEvent = {
  providerCallId: string
  attemptId: string | null          // from CustomField
  status: CallStatus
  occurredAt: Date | null
  dedupeKey: string                 // provider event id, else callSid:status:time
  raw: unknown
}

export type MediaCodec = {
  sampleRate: 8000 | 16000
  parse(message: string): MediaEvent | null
  audio(streamId: string, pcm: Int16Array): string   // one ≤100 ms chunk
  mark(streamId: string, name: string): string
  clear(streamId: string): string
}

export type MediaEvent =
  | { type: "start"; streamId: string; providerCallId: string; params: Record<string, string> }
  | { type: "audio"; pcm: Int16Array; timestampMs: number }
  | { type: "dtmf"; digit: string }
  | { type: "mark"; name: string }
  | { type: "stop"; reason: "stopped" | "callended" | string }

export type SpeechRecognitionProvider = {
  name: string
  // One stream per call leg; partials and finals with confidence when given
  open(opts: { language: string; sampleRate: number; hints: string[] }): RecognitionStream
}
export type RecognitionStream = {
  write(pcm: Int16Array): void
  events: AsyncIterable<
    | { type: "partial"; text: string }
    | { type: "final"; text: string; confidence: number | null; startMs: number; endMs: number }
    | { type: "speech_started" }      // barge-in signal
    | { type: "endpoint" }            // end of utterance
    | { type: "error"; error: Error }
  >
  close(): Promise<{ billedSeconds: number | null }>
}

export type SpeechSynthesisProvider = {
  name: string
  // Streams PCM at the requested rate; stops promptly when signal aborts
  synthesize(text: string, opts: { voice: string; sampleRate: number; signal: AbortSignal }):
    AsyncIterable<Int16Array>
  // For metering: characters billed for this text
  billedUnits(text: string): number
}
```

| Brief's contract | In this repo |
| --- | --- |
| `TelephonyProvider` | As above |
| `SpeechRecognitionProvider` | As above |
| `SpeechSynthesisProvider` | As above |
| `ModelGateway` | Existing `lib/models.ts` (`createGatewayModel`, `modelForTier`, `fallbackModel`). No new interface |
| `TaskRepository` | Functions in `lib/voice/tasks.ts` over Drizzle, like `lib/agent/queue.ts`. No repository class |
| `ReminderScheduler` | The `voice_calls` table + `kriya.claim_voice_call()` + `lib/voice/schedule.ts` (window math). No in-memory scheduler |
| `OutcomeVerifier` | `lib/voice/verify.ts`: `verifyAttempt(attemptId)` reconciles webhook events with `getCall()` and computes allowed transitions (CONVERSATION_AND_VERIFICATION.md §7) |

Mock provider (`lib/voice/mock.ts`, Phase 2) implements all three speech/
telephony contracts with scripted scenarios (busy, no answer, answered with a
transcript, disconnect mid-call, duplicate webhooks), so Phases 3–4 run without
any account.
