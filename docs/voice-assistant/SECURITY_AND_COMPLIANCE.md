# Security, privacy and Indian telephony compliance

**This is not legal advice.** It's an engineering reading of public sources as
of 2026-10-17, to design safeguards and frame questions for qualified Indian
telecom and data-protection counsel. Live calls to third parties stay disabled
(D-12) until the questions in §8 are answered in writing.

It extends `docs/kriya/security.md`; everything there still applies.

## 1. What kind of calls Kriya makes

| Call type | Example | Kriya MVP? |
| --- | --- | --- |
| Personal, owner-directed, to a person the owner knows | "Call my CA and ask about 3 PM" | **Yes**, the only third-party call type |
| Owner's own report / verification call | 6 PM outcome call to the owner | Yes |
| Transactional/service (a business informing its customer) | OTPs, bank alerts | No |
| Promotional / commercial | Offers, sales, surveys to lists | **Never.** Refused by policy and by limits |

An owner asking for a call doesn't remove telecom or privacy obligations for
Kriya, which is the entity actually placing it through its provider.

## 2. TRAI regulations (TCCCPR)

What sources say (primary where marked):

- **Feb 2025 amendment** (TRAI press release No. 11 of 2025,
  https://cms.trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf —
  primary): the 140 series continues for promotional calls; 1600 series for
  transactional/service calls; ordinary 10-digit numbers barred from
  telemarketing.
- **1600 series mandates** (NSE circular / NSDL notice citing TRAI directions,
  https://nsearchives.nseindia.com/content/circulars/COMP74037.pdf): 1600xx for
  service/transactional calls by RBI/SEBI/PFRDA-regulated entities, later
  IRDAI and government. Not applicable to Kriya's sector as far as found.
- **Third Amendment Regulations, 2026** (gazette dated 18 Sep 2026,
  https://www.trai.gov.in/sites/default/files/2026-09/Regulation_18092026.pdf ;
  press release https://www.trai.gov.in/sites/default/files/2026-09/PR_No119of2026.pdf).
  The PDFs are scanned images and **could not be read in this research**.
  Secondary analyses (https://cloudconnect.in/blogs/what-trais-third-amendment-regulations-mean-for-your-outbound-calling ;
  https://www.policyedge.in/p/trai-draft-telecom-commercial-communications-customer-preference-third-amendment-regulations-2026)
  report: A2P calls are those started by an application or automated platform
  without direct human dialling, explicitly including AI voice bots; users of
  A2P calling must pre-declare it and the CLIs to their operator; undeclared
  automated calls are treated as unsolicited commercial communication; A2P
  termination charge up to ₹0.05/min except via designated series;
  AI-based spam detection; commencement 30 days after publication, some
  provisions 60 days.

**Engineering position (D-16):** treat Kriya's calls as A2P; declare through
Exotel before any live third-party call; keep content non-commercial; keep
volumes per number and per owner very low; honour opt-outs globally. Whether a
personal, owner-directed call is "commercial communication" at all is a legal
question (§8, Q1).

## 3. DPDP Act 2023 and Rules 2025

Per secondary sources (https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified ;
https://anantamias.com/current-affairs/dpdp-rules-2025-notified/): Rules
notified 13/14 Nov 2025; Board provisions immediate; consent-manager
provisions ~Nov 2026 (one source says by a later notification); most
obligations (notice, consent, security safeguards, breach reporting,
children's data) from ~13/14 May 2027. Verify against the gazette.

What it means for the design:

| Data principal | Data | Basis (to confirm, Q3) | Safeguard |
| --- | --- | --- | --- |
| Owner | Account, phone number, tasks, outcomes, transcripts | Consent at sign-up + voice opt-in | Notice in app, retention controls, deletion |
| Recipient (callee) | Phone number, label, what they said | The owner provided it; Kriya processes it to make the call. Whether this needs the recipient's consent or another basis is open | Minimise: no recording; transcripts kept 30 days default; outcome only after; delete on request; disclose AI and purpose at the start |
| Anyone who answers by mistake | Their voice/words | — | Wrong-person path ends quickly; turns deleted at task end for wrong-person calls |

Breach reporting, a grievance contact and a published privacy notice covering
voice are needed before launch (Phase 9).

## 4. Caller ID, recording, AI disclosure

- **Caller ID:** only Kriya's own provisioned provider numbers. Never the
  owner's number, never a spoofed CLI. Which series/number type Exotel requires
  for A2P is account check X3/X4.
- **Recording:** off (D-10). If ever enabled: separate legal review, explicit
  announcement at call start, consent from the owner, separate retention.
  Indian rules on one-/two-party consent for recording weren't confirmed in this
  research (Q5).
- **AI disclosure:** the fixed opening line says Tavi is an AI assistant calling
  on behalf of the owner (CONVERSATION_AND_VERIFICATION §3). It's not generated
  by the model and the `mark` for it is recorded as `disclosure_played`. If the
  callee interrupts before it finishes, it's repeated before anything else.
- **No impersonation, no voice cloning.** Tavi never claims to be the owner or a
  human, never uses a cloned voice of anyone (competitors offer owner-voice
  cloning; Kriya deliberately doesn't). Synthetic-media labelling rules under
  the IT Rules weren't researched (Q6).

## 5. Abuse prevention and limits

All server-side (`lib/entitlements.ts`, SQL), never only in the UI.

| Limit | Default | Where |
| --- | --- | --- |
| Voice enabled | Allow-listed users only (D-12) | `kriya.voice_access` |
| Outreach calls per owner per day | 5 recommended (plan `max_outreach_calls_per_day`; migration default 0 = off) | Confirmation + claim |
| Concurrent live outreach calls per owner | 1 | `claim_voice_call` |
| Attempts per outreach call | 2 (busy/no answer retry once after ≥ 15 min) | `voice_calls.max_attempts` |
| Calls to the same number, any owner, per day | 3 | Claim, by `recipient_phone_hash` |
| Calls to the same number by one owner per 7 days | 5 | Confirmation |
| Third-party calling hours | 09:00–21:00 IST, Mon–Sat; Sundays and national holidays off in MVP | `lib/voice/schedule.ts` |
| Global live-call concurrency | `voice.maxConcurrentCalls` (start at 2) | Claim |
| Suppressed numbers | Never called | `call_suppressions`, checked twice |
| Bulk | No lists, no CSV, no "call these numbers" — one recipient per task | Spec schema |
| Emergency numbers, short codes, toll-free, premium | Refused | Number validation |
| Owner's own number as a third-party target | Refused (use reminders) | Validation |

Signals reviewed in `/owner/operations` (Phase 8): opt-out rate per owner,
wrong-person rate, repeated calls to one number, calls near limits. An owner
with opt-outs above a threshold is paused for review.

## 6. Application security

| Threat | Control |
| --- | --- |
| Forged identity/plan from the browser | Session only (`requireUser`, `authenticate`); plan from `effective_plan_id` (AGENTS.md invariant 3) |
| Browser sets a task to completed | No write grants; `voice_transition()` allow-list + trigger (D-06) |
| Approving something other than what was shown | `payload_hash` must match the stored approval (DATA_MODEL §2) |
| Forged status webhook | Unguessable per-attempt URL token (hash stored) + provider API verification before any terminal state (TELEPHONY §2.3) |
| Someone else connects to the media WebSocket | Basic-auth secret + one-time per-attempt stream token + `call_sid` match; IP allow-list requested |
| Replayed webhooks/events | `unique (provider, dedupe_key)` |
| Prompt injection via the callee | No consequential tools in calls (D-14); untrusted input; redaction; post-call authority check (CONVERSATION §8) |
| Prompt injection via the owner's request text | Extracted spec is shown and confirmed field by field; the model in the call sees the spec, not raw text |
| Cross-tenant reads | RLS on every table; composite FKs; `kriya-voice` reads only the validated attempt's task, scoped by `user_id` |
| Secrets | `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_STREAM_SECRET`, STT/TTS keys, `KRIYA_PHONE_HASH_KEY` in env only, listed in `SECRETS` (`lib/config.ts`), never in DB, logs, transcripts or browser |
| Phone numbers in logs | `lib/log.ts` gains a phone-number redaction pattern; logs use attempt ids |
| Transcript content in logs | Never logged (same rule as messages today) |
| OTP/card numbers spoken by a callee | Redacted before `conversation_turns` insert |
| Owner console snooping | Owner pages show counts and states, never transcripts (as today for messages) |
| Worker running side effects on web | Calls placed only by `kriya-worker`; hangups by worker/voice; web only verifies (AGENTS.md invariant 5) |

## 7. Incident investigation

`voice_transitions` (who changed what, with evidence), `call_events` (raw
provider data, redacted), `call_attempts.verification`, structured logs with
attempt ids, and the provider's own call logs (by `CallSid`) together
reconstruct any call. An **emergency stop** (`voice.liveCalls = off` in
`/owner/config`) stops new dials within the settings cache window (15 s); a
per-owner stop is in the app (UX spec §9). Both are tested in Phase 9.

## 8. Questions for counsel (blockers for live third-party calls)

| # | Question |
| --- | --- |
| Q1 | Is an owner-directed, non-promotional AI call to a person the owner knows "commercial communication" under TCCCPR, and is it A2P under the Third Amendment? What exactly must be declared, and by whom (Kriya or Exotel)? |
| Q2 | Which numbering series or CLI type may Kriya use for these calls? |
| Q3 | Lawful basis under DPDP for processing the recipient's number and speech supplied by the owner; notice duties to the recipient; is the spoken opening sufficient? |
| Q4 | Required wording and timing of the AI disclosure; is an opt-out line needed? |
| Q5 | Recording: what consent is required if Kriya ever records? |
| Q6 | Do IT Rules provisions on synthetic media apply to a TTS voice on a phone call? |
| Q7 | Calling-hour restrictions applicable to non-promotional calls |
| Q8 | Retention: are 30-day transcripts and indefinite suppression lists acceptable? Is the suppression list itself personal data needing a basis? |
| Q9 | Terms for owners: what must they warrant (they know the recipient, lawful purpose)? |
| Q10 | Liability if Tavi mis-states an agreement; disclaimer wording |
| Q11 | May Kriya use de-identified call transcripts, with the owner's consent, to build test scenarios (SELF_IMPROVEMENT.md §6)? Does the recipient's speech need its own basis? Are content-free call metrics covered by the service's basis? |
