# Competitor and platform research

Research date: **2026-10-17**. All sources were accessed on that date unless
stated otherwise. Vendor pages describe what vendors claim; nothing here was
tested hands-on (no accounts were created, no calls placed). Where public
material is silent, the capability is **unknown**, not absent.

Evidence labels used below:

- **Verified (docs)**: stated in the vendor's own developer documentation or
  product page, specific enough to build against.
- **Claimed**: stated in marketing, a press release or a funding article, not
  independently checked.
- **Unknown**: no public evidence either way.

## 1. Summary

| Product | Who it serves | Outbound on owner's behalf | Owner report by call | Developer API | Relevance to Kriya |
| --- | --- | --- | --- | --- | --- |
| Equal AI | Consumers (Android) | Planned (press, Jun 2026) | Unknown | None found | Shows demand for AI phone help in India; inbound only today |
| Tring ("Ring") | Consumers (Android open beta, iOS invite-only) | Claimed ("Ask Ring to call") | Unknown | None found | Closest consumer competitor; claims its own telephony and voice cloning |
| Truecaller Assistant | Consumers | No (inbound screening) | No | No | Incumbent for inbound; sets user expectations |
| Ring-a-Ding | Developers using OpenClaw (US-focused) | Claimed, task-based calls | Unknown | Skill, BYO key | The "personal errand call" pattern abroad; bans sales use |
| Bolna | Developers, enterprises | Yes, as infrastructure | You build it | Yes; MIT core | Reusable ideas; Python; Exotel "coming soon" in open source |
| Exotel | Businesses in India | Yes, as infrastructure | You build it | Yes | Primary telephony candidate |
| Plivo | Businesses | Yes, as infrastructure | You build it | Yes | Secondary telephony candidate |
| Pipecat | Developers | Framework | You build it | BSD-2 (Python) | Reference for Exotel's wire format |
| LiveKit Agents JS | Developers | Framework (+ SIP) | You build it | Apache-2.0 (TS) | The only TypeScript framework option |

**The opening for Kriya (no "first" claim intended).** None of the consumer
products found publicly documents the whole loop of the canonical scenario: an
owner-authorised outbound call to a third party with bounded authority, a
structured outcome that separates agreement from proposal, and a scheduled
**phone call back to the owner** with the result, with voice commands on that
call. Equal AI and Tring are built around answering incoming calls.
Infrastructure vendors (Bolna, Exotel, Plivo) sell the parts, not the personal
product. This can change quickly: Equal AI announced outbound plans in June 2026.

## 2. Consumer assistants

### 2.1 Equal AI

Sources: TechCrunch, "Equal AI raises $30M to screen calls so Indians don't have
to", 2026-06-11,
https://techcrunch.com/2026/06/11/equal-ai-raises-30m-to-screen-calls-so-indians-dont-have-to ;
The Next Web, https://thenextweb.com/news/equal-ai-india-call-screening-30m-series-b .

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Product | Android app that answers incoming calls, talks to the caller and tells the user why they called | Claimed (press) |
| Outbound calls for the user | "Next steps" include outbound calls to book appointments | Claimed, future |
| Transcripts, summaries | Conversations recorded; transcripts and summaries in the app | Claimed (press) |
| Languages | 10+ claimed | Claimed |
| Scale | ~1M monthly users (self-reported) | Claimed |
| iOS | In development | Claimed |
| Pricing | Paid tier planned | Claimed |
| Barge-in, latency, recovery | No public information | Unknown |
| API | None found | Unknown |
| Privacy | One trade article raised recording and consent concerns | Secondary |

### 2.2 Tring ("Ring")

Source: https://heytring.com/ (product page). The brief's "Ring by Tring" is
this product: the assistant is called Ring, the company Tring (Bengaluru).

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Inbound | "Ring answers the calls you'd rather skip"; take over at any time; spam blocking | Claimed (own page) |
| Outbound | FAQ: Ring "can also make calls for you when you ask"; "Ask Ring to call" listed as free | Claimed |
| Scheduling, reminders, call-back to the owner | Not mentioned | Unknown |
| Languages | "12+ Indian languages"; answers in the caller's language | Claimed |
| Voice cloning | Answers "in your own voice" after a 20-second sample; own voice only, with in-app consent; page inconsistent on free vs Pro | Claimed |
| Telephony | "Phone lines we built ourselves", "telephony we operate rather than resell"; works with the user's existing SIM | Claimed |
| Transcripts | Live transcript; recording stops when the user takes over; handled portion kept encrypted | Claimed |
| Availability | Android open beta; iPhone invite-only | Claimed |
| Pricing | Free; "Tring Pro" extras | Claimed |
| API | None found | Unknown |

### 2.3 Others found

- **Truecaller Assistant** (India): AI screening of incoming calls; English,
  Hindi and Hinglish at launch; paid add-on after a trial. Secondary source:
  https://www.siliconindia.com/news/general/truecaller-launches-aipowered-assistant-in-india-nid-224178-cid-1.html .
  Inbound only.
- **Ring-a-Ding**: an OpenClaw skill that makes outbound calls for everyday tasks
  (quotes, appointments); prohibits sales, marketing and robocalling;
  $19/month with the user's own model key. Press release of 2026-04-18,
  syndicated e.g. at
  https://www.wboc.com/online_features/press_releases/ring-a-ding-launches-openclaw-skill-for-ai-agent-phone-calls/article_0ab14685-b087-551b-b391-77341f26e797.html .
  Not India-specific. Claimed.
- **Mitra** ("AI that calls & answers", App Store,
  https://apps.apple.com/us/app/mitra-ai-that-calls-answers/id6505044002):
  outbound and inbound claims; not clearly India-focused; not examined further.
- **Ringg AI** (https://docs.ringg.ai/get-started/tutorials/voice-calling):
  enterprise voice agents with outbound calling; campaigns, not a personal
  assistant.

## 3. Infrastructure and frameworks

### 3.1 Bolna

Sources: https://github.com/bolna-ai/bolna ;
https://www.bolna.ai/docs/supported-telephony-providers ;
https://www.bolna.ai/docs/exotel .

| Aspect | Finding | Evidence |
| --- | --- | --- |
| License | MIT ("Bolna is released under the MIT license") | Verified (repo) |
| Language | Python (`pyproject.toml`, `from bolna.assistant import Assistant`) | Verified (repo) |
| Activity | 2,927 commits on master, 795 stars; last commit date not visible on the fetched page | Partial |
| Open-source telephony | Twilio, Plivo; Exotel "(coming soon)" | Verified (README) |
| Hosted telephony | Twilio (outside India); Plivo and Exotel (inside India); also Vobiz, Acefone, Airtel SIP, generic SIP | Verified (docs), hosted product only |
| Pipeline | ASR (Deepgram, Azure, self-hosted) → LLM (via LiteLLM, including DeepSeek) → TTS (Polly, ElevenLabs, Cartesia, Deepgram…) over WebSockets | Verified (README) |
| Hosted dashboard and APIs | Closed source | Secondary source only |
| Owner reminders, personal tasks | Not a feature; you build it | — |

**Reuse.** The license allows it. Not adopted as a runtime (D-01): Python, a
separate process model and task concept, and no Exotel in the open-source code.
Useful as a reference for interruption handling and provider adapters. Before
porting any code: clone, read `LICENSE`, run `git log -1 --format=%cI`, check
the file's own history, and credit it in `NOTICE.md`.

### 3.2 Exotel

In depth in `TELEPHONY_PROVIDER_ASSESSMENT.md`. In short: India-native CPaaS.
Its AgentStream "Voicebot" applet streams bidirectional 16-bit PCM over a
WebSocket with `media`, `mark`, `clear`, `dtmf` and `stop` events. There is an
outbound call API with status callbacks. Access needs KYC and a support request
to enable the applet, and the extension guide is marked beta. The stream path
has no STT or TTS of its own.

### 3.3 Plivo

Bidirectional `<Stream>` with `playAudio` and `clearAudio`; mu-law or L16 at
8 or 16 kHz. Indian numbers need KYC and an India-registered business. Details
in the telephony assessment.

### 3.4 Pipecat

Sources: https://reference-server.pipecat.ai/en/stable/_modules/pipecat/serializers/exotel.html ;
https://docs.pipecat.ai/server/services/serializers/exotel .
BSD-2-Clause (SPDX header in the source; copyright Daily). Python. Ships an
`ExotelFrameSerializer` (16-bit linear PCM, 8 kHz default, DTMF frames). Its
docs say that, unlike its Twilio and Plivo serializers, it doesn't end calls
automatically. Use: reference only.

### 3.5 LiveKit Agents JS

Source: https://github.com/livekit/agents-js . Apache-2.0 (the turn-detector
models are under a separate LiveKit Model License). Plugins for Deepgram,
ElevenLabs, Cartesia, OpenAI, Silero VAD and a turn detector. Telephony goes
through LiveKit's separate SIP service. The fetched page didn't show the
current version's release date. Use: the fallback option under D-01.

## 4. Speech and model providers (published prices, unverified)

These prices come mostly from secondary comparison pages that disagree with
each other. The vendor pages are authoritative and must be re-read on
benchmark day.

| Provider | Product | Published price, as found | Source quality |
| --- | --- | --- | --- |
| Deepgram | Nova-3 streaming STT, monolingual | $0.0048/min in several 2026 sources; $0.0077/min in others | Secondary, conflicting |
| Deepgram | Aura-2 TTS | $0.030 per 1K characters | Secondary |
| Sarvam | STT (Saaras), real-time and batch | ₹30/hour base | Official pricing page (https://docs.sarvam.ai/api/pricing) |
| Sarvam | Bulbul v2 / v3 (beta) TTS | ₹15 / ₹30 per 10K characters | Official pricing page |
| ElevenLabs | Flash v2.5 TTS | ~$50 per 1M characters; ~75 ms to first audio claimed | Secondary |
| Cartesia | Sonic TTS | ~$49 per 1M characters (normalised); 90 ms claimed, 166–190 ms measured by a third party | Secondary |
| OpenAI | gpt-realtime-2.x speech-to-speech | $32 / $64 per 1M audio input/output tokens; analyst estimate $0.06–0.11/min | Secondary |
| OpenRouter | `deepseek/deepseek-v4-flash` | $0.091 / $0.182 per 1M tokens; tools and structured output declared | Live catalogue, 2026-10-16, recorded in `docs/kriya/status.md` |

Sources: https://usagepricing.com/blueprint/deepgram ;
https://soniox.com/pricing/stt/soniox-vs-deepgram ;
https://smallest.ai/blog/sarvam-ai-speech-to-text-pricing ;
https://invideo.io/blog/ai-voice-model-pricing/ ;
https://futureagi.com/blog/elevenlabs-vs-cartesia-tts-2026/ ;
https://www.forasoft.com/blog/article/openai-realtime-api-pricing .

## 5. Recommendation

**Hybrid (D-01).** Build orchestration and product logic in Kriya's TypeScript
stack, integrate managed telephony (Exotel) and managed STT/TTS behind
interfaces, and choose the STT and TTS vendors by benchmark. Don't adopt a
managed voice-agent platform (hosted Bolna, Exotel's own bots): the product's
core value (bounded authority, verified outcomes, durable reminders) would then
live outside Kriya's database and audit trail.

## 6. Research gaps and how to close them

| Gap | Verification step | Who |
| --- | --- | --- |
| How Equal AI and Tring behave on outbound calls | Install both on a test Android phone; ask each to call a number you control; note disclosure wording, latency and what the callee hears | Owner (needs a phone) |
| Tring's telephony and caller ID | Note the caller ID shown on the test number in the step above | Owner |
| Whether any competitor calls the owner back with results | Same hands-on test | Owner |
| Bolna repo freshness | `git clone` and `git log -1 --format=%cI` | Coding agent, Phase 2 |
| Exotel per-minute and streaming charges | Ask Exotel sales for a written quote for the Voicebot applet on outbound calls | Owner |
| Deepgram `en-IN` support and current price | Read https://deepgram.com/pricing and the model language list on benchmark day | Coding agent, Phase 4 |
| Sarvam streaming English on telephone audio | Benchmark (EVALUATION_PLAN.md §3) | Coding agent, Phase 4 |
| OpenRouter DeepSeek live price and tool reliability | `npm run models:sync`, then `npm run models:eval` | Owner (costs money) |
