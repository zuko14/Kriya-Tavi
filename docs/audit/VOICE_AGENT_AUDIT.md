# Kriya Tavi — Voice Assistant & Telephony Audit

**Date:** 2026-10-21  
**Auditor:** Principal Voice-AI Systems & Telephony Architect  
**Blueprint Reference:** `docs/voice-assistant/`  
**Execution Services:** `voice/index.ts` (`kriya-voice`), `lib/voice/`, `worker/index.ts`  

---

## 1. Architectural Distinction: In-Browser Voice vs. Real Telephony

A frequent point of confusion in voice AI products is treating browser speech recognition as a telephony voice assistant. Kriya Tavi maintains an **explicit, uncompromised boundary** between the two:

| Dimension | Browser Speech Interface | Outbound Telephony Voice Assistant |
| :--- | :--- | :--- |
| **Execution Surface** | Client-side Chrome browser | Dedicated cloud media server (`kriya-voice`) + Telephony SIP Trunk (Exotel) |
| **Audio Protocol** | Web Audio API / MediaRecorder (Opus/WebM) | Bi-directional WebSocket streaming raw linear PCM (8kHz / 16kHz) or G.711 mu-law |
| **Counterparty** | The authenticated user talking to their laptop/phone | An external third-party contact or the owner receiving a real PSTN/GSM telephone call |
| **Latency Budget** | ~500ms–1,500ms (acceptable for chat input) | <700ms mouth-to-ear target for natural conversational turn-taking |
| **Regulatory Scope** | General Web Application | Indian Telecom (TRAI TCCCPR 2018, DLT, 140/160 CLI) & DPDP Act 2023 |
| **Implementation** | `components/voice/recorder.tsx` | `voice/index.ts`, `lib/voice/dialogue.ts`, `lib/voice/run-call.ts`, `lib/voice/exotel.ts` |

---

## 2. Telephony Streaming & Dialogue Engine Architecture

### 2.1 Media Server (`kriya-voice`)
The `kriya-voice` service (`voice/index.ts`) is a high-performance, single-purpose Node.js service designed to accept Exotel's media WebSocket streams (`/streams`):
1. **Stream Authentication**: Upgrades require both HTTP Basic authentication (`KRIYA_VOICE_STREAM_SECRET`) and an active one-time stream token matching a dialing record in `kriya.call_attempts`. It never accepts arbitrary WebSocket connections.
2. **Audio Framing & Codec (`lib/voice/audio.ts`)**:
   - Frames inbound audio into 20ms chunks (160 samples at 8kHz).
   - Inbound G.711 mu-law is expanded to 16-bit linear PCM for STT processing.
   - Outbound synthesized audio is packed into chunks and encoded back to mu-law.
3. **Interruption & Barge-In (`Call.clear()`)**:
   - When user speech is detected while the bot is speaking, `clear()` is immediately executed.
   - Drops all unplayed audio chunks in the server queue and increments the `generation` counter.
   - Sends a provider `clear` command to purge buffers already in transit.
   - Uses a lead limit (`LEAD = 2` chunks) to bound residual sound to <40ms of playback.

### 2.2 Dialogue State Machine (`lib/voice/dialogue.ts`)
The conversational dialogue runs a finite state machine ensuring compliance and conversational safety:
```
[Call Connect]
       │
       ▼
[AI Identity Disclosure] ── Mandatory: "Hello, I am Kriya, an automated AI assistant calling on behalf of [Owner]..."
       │
       ▼
[Turn-Taking Loop] ◄──► [STT -> LLM Streaming -> TTS Synthesis -> Audio Queue]
       │                    ▲
       │ (User speaks)      │ (Barge-in clears queue)
       ├────────────────────┘
       ▼
[Outcome Extraction] ── Structured Zod Schema: commitments, dates, proposed times, refusal
       │
       ▼
[Call Termination] ── kriya.voice_transition() -> 'completed'
```

---

## 3. Telephony Integration & Outbound Calling (`lib/voice/exotel.ts`)

### 3.1 Exotel Contract & Flow
- **Dialing Method**: `POST https://{api_key}:{api_token}@{subdomain}/v1/Accounts/{account_sid}/Calls/connect`
- **Payload**: Specifies `From` (Owner or verified CLI), `To` (recipient), `CallerId` (DLT-registered number), and `Url` pointing to Exotel Call Flow (Voicebot Applet connecting to `wss://voice.kriya.ai/streams`).
- **Webhook Handlers**: Call status transitions (`busy`, `no-answer`, `failed`, `completed`) are delivered to authenticated endpoints in `app/api/voice/exotel/status/` using per-attempt validation tokens.

### 3.2 State Machine Protection (`kriya.voice_transition()`)
In accordance with AGENTS.md invariant 8, **neither the browser nor an LLM may directly set a call or task to completed**. Transitions must occur through the database stored procedure `kriya.voice_transition()`, which strictly validates allowed state graphs in `kriya.voice_allowed_transitions`.

---

## 4. Safety, Compliance & Indian Telecom Regulations

### 4.1 TRAI TCCCPR (2018) & Regulatory Requirements
1. **Calling Line Identity (CLI)**:
   - Commercial / transactional AI calls must use authorized telecom operator trunks.
   - 140 series is mandated for promotional telemarketing.
   - 160 series is designated for transactional/service communications.
2. **Calling Hours**:
   - Outbound telephone calls are restricted to **09:00 to 21:00 IST** (`lib/voice/schedule.ts`). Calls triggered outside this window are automatically deferred to 09:00 IST the following morning.
3. **National Do Not Disturb (DND) & Global Suppression**:
   - When a recipient utters *"Don't call me again"* or equivalent refusal phrases, the system writes a permanent hash of the number into `kriya.call_suppressions` (`tests/voice/pipeline.test.ts` S24).
   - Suppressed numbers are blocked platform-wide from all future calls by any agent.

### 4.2 DPDP Act (2023) Compliance
1. **Mandatory AI Disclosure**: Every call begins with an unalterable greeting declaring that the caller is an AI speaking on behalf of the owner.
2. **Transcript Retention Policy**: Call audio recordings are scrubbed and transient; transcripts are retained only for the purpose of extracting the structured task outcome, with automated retention expiry (`lib/voice/housekeeping.ts`).

---

## 5. Phone-Only Reminders & Spoken Reports (`lib/voice/tasks.ts`)

In accordance with product invariant 10, **owner reminders are real telephone calls only**.
- Kriya Tavi does **not** send fallback SMS, push notifications, or WhatsApp messages for reminder tasks.
- If the owner sets a reminder: *"Call me at 6 PM to review the quarterly numbers"*, the worker schedules a call task.
- At the scheduled minute, the worker dials the owner's verified phone number.
- When answered, it plays the spoken reminder, confirms receipt, and records the completion status.

---

## 6. Current Implementation Gaps & Blockers

| Blocker ID | Description | Impact | Resolution Requirement |
| :--- | :--- | :--- | :--- |
| **B3** | Active Exotel Account & KYC | Outbound live calls blocked (`voice.liveCalls = "off"`). | Owner must complete Exotel corporate KYC and obtain SIP trunk credentials. |
| **B4** | Legal Counsel Review (TRAI / DPDP) | Third-party calling liability unratified. | Formal legal opinion on 160 series CLI usage for personal assistants. |
| **B5** | A2P Template Pre-Declaration | Risk of telecom carrier spam filtering. | Register standard outbound voicebot script templates on Exotel DLT portal. |
| **B6** | Production STT/TTS Vendor Keys | Live dialogue latency unmeasured on real carriers. | Provision production keys for Deepgram / Sarvam AI / ElevenLabs. |
