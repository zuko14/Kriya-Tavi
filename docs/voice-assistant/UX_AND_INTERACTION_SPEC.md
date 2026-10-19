# UX and interaction spec

Mobile first in Chrome, English only. Follows the existing UI: Base UI
primitives in `components/ui`, tokens in `app/globals.css` (`rigel` indigo,
`betelgeuse` saffron, `label-mono` for small-caps metadata), 44 px touch
targets, tested at 360 px wide, bottom tabs on phones
(`components/workspace/bottom-nav.tsx`).

The owner's reminder channel is the phone call. The UI never asks for, offers
or silently enables push, email, SMS or WhatsApp for reminders (D-07).

## 1. Where it lives

| Route | Screen |
| --- | --- |
| `/calls` | List: upcoming, live, needs you, history. A fifth bottom tab only if it still fits at 360 px; otherwise reached from Home and the command palette (decided in Phase 7) |
| `/calls/new` | Speak or type a request |
| `/calls/[taskId]` | One task: draft editor → confirmation → live status → outcome |
| `/account` (section "Phone & calls") | Owner number verification, timezone, quiet hours, report retries, transcript retention, emergency stop |
| Thread card | `propose_call` tool result in a thread links to `/calls/[taskId]` |

`/calls` is added to `PROTECTED` in `proxy.ts`. The section is hidden unless
the user has voice access (server-checked; hiding is a convenience).

## 2. Speak to Tavi (`/calls/new`)

1. Big mic button (reuses `useDictation` from `components/thread/dictation.ts`)
   and a text box. The live transcript appears **in the text box, editable**.
   Nothing is sent until the owner taps "Continue".
2. Under the box: "On-device" or "Uses Google's speech service" (as the composer
   does today).
3. Mic unavailable → the button explains why using the existing `PROBLEMS`
   messages ("Microphone access is blocked…") and the text box stays usable.
   Browser without Web Speech → text only, with a one-line note.
4. Continue → `draftCall` → `/calls/[taskId]`.

## 3. Draft and confirmation (`/calls/[taskId]`, draft states)

Missing information is asked one field at a time, in plain questions, each
answerable by typing or dictation:

- "What number should I call?" (tel input, `inputmode="tel"`; shows the
  normalised +91 form)
- "Who is this? (e.g. my CA)"
- "Which day?" when "tomorrow" is near midnight or unclear — shows the resolved
  weekday and date
- "Which other times are OK if 3 PM doesn't work?" (time-range chips)
- "When should I call you with the result?" (time picker in the owner's
  timezone; quiet-hours times disabled with the reason)

Then the **confirmation card** (rendered from `ConfirmationPayload`, never from
client state):

```
┌──────────────────────────────────────┐
│ CALL                     label-mono  │
│ My CA · +91 98xxx xxx21   [show all] │
│                                      │
│ Tavi will say:                       │
│ "Hello, this is Kriya Tavi, an AI    │
│  assistant calling on behalf of      │
│  Asha…"                              │
│                                      │
│ Ask: meet tomorrow, Thu 18 Oct, 3 PM │
│ May agree to: 2–5 PM that day        │
│ Won't: share your number, agree to   │
│ anything else                        │
│                                      │
│ Calls from 9:00 AM · max 5 min       │
│ Reports to you at 6:00 PM IST by     │
│ phone (+91 99xxx xxx07)              │
│ Est. cost: price not set / ₹x–₹y     │
│                                      │
│ [ Edit ]          [ Confirm & call ] │
└──────────────────────────────────────┘
```

- "Show all" reveals the full number; confirming requires it to have been
  shown once (tap) — prevents confirming a mis-heard number unseen.
- "Confirm & call" sends `approvalId` + `payloadHash`. If the payload changed
  (`stale_approval`), the card reloads with a notice.
- The approval expires in 30 minutes; the card shows a countdown in
  `label-mono`.

## 4. Live status

A vertical timeline driven by `/api/voice/tasks/[taskId]/stream`:

| State | Shown |
| --- | --- |
| scheduled | "Will call at 9:00 AM" |
| dialing | "Calling… (attempt 1 of 2)" |
| ringing | "Ringing" (only if the provider sent it) |
| connected | "On the call · 0:42" + optional "Show live transcript" (off by default) |
| retry_wait | "Line busy. Trying again at 4:25 PM" |
| awaiting_report | "Call done. I'll call you at 6:00 PM" |
| needs_owner | Amber card: what needs a decision and why |

A **Stop** button is always visible on a non-terminal task (`cancelVoiceTask`),
with a confirm dialog (`components/confirm.tsx`). On a live call: "Stop and
hang up".

## 5. Outcome

- **Result line** first, in words that never overstate: "He agreed to Thu 18 Oct
  at 3:30 PM" only for a verified agreement; "He suggested 4 PM; I said I'd check
  with you" for a proposal; "Didn't answer (2 tries)" for no answer.
- Sections: Proposed times, Agreed times (each with "heard at 1:12 →" linking to
  the transcript turn), Questions for you, Next step suggestion with a
  **"Draft a follow-up call"** button (`createFollowUp`, goes back to §3).
- Badges: "Verified by call records" when `verifier_status = accepted`;
  "Needs your review" otherwise.
- Transcript (if retained): speaker-labelled turns; Tavi's interrupted turns
  marked "(cut off)". "Delete transcript" button.
- Report delivery: "Told you at 6:01 PM ✓" or "Couldn't reach you: tried 6:00,
  6:10, 6:20" — no other channel.
- Cost: "Estimated ₹x.xx" until final; links to `/usage`.

## 6. Failure explanations

Plain, specific, no provider jargon:

| Code | Text |
| --- | --- |
| `number_unverified` | "Verify your phone number first so I can call you with the result." |
| `quiet_hours` | "6:30 AM is in your quiet hours (9:30 PM–8:00 AM). Pick another time." |
| `outside_calling_hours` | "I only call people between 9 AM and 9 PM, Monday to Saturday." |
| `suppressed` | "I can't call this number." |
| `limit_daily` | "You've reached today's 5 calls." |
| `voice_lost` | "The call dropped on our side after 1:20. Here's what was said before it dropped." |
| `unknown` attempt | "I'm not sure whether the phone rang. I won't call again unless you ask." |

## 7. Settings ("Phone & calls" in `/account`)

- Your number: add → "Call me to verify" → screen shows a 6-digit code in large
  type → "Answer the call and type this code on your keypad" → live status.
- Timezone (default Asia/Kolkata), quiet hours, report attempts and gap, report
  mode (at the time I choose / as soon as the call is done).
- Transcript retention (0, 7, 30, 90 days).
- A line stating: "Reminders and results come only as phone calls."

## 8. Accessibility and phones

- All controls 44 px; focus rings visible; live region (`aria-live="polite"`)
  for status changes; the timeline readable by screen readers.
- Works at 360 px; the confirmation card has no horizontal scroll; long numbers
  wrap.
- No autoplay audio; no browser notifications.

## 9. Emergency stop

`/account` and the `/calls` header: **"Stop all calls"** → confirm →
`emergencyStop`: cancels every queued task, hangs up live calls within seconds,
cancels pending report calls. Shown result: "Stopped 2 tasks. 1 live call was
hung up."

## 10. Usage

`/usage` adds a "Calls" row: count, minutes, estimated/final cost this period,
and calls remaining today.

## 11. Premium voice experience

Voice should feel like the most alive part of Kriya, without new dependencies
and without breaking the rules above. It's built from what the app already has:
the `Mascot` component (`components/brand.tsx`), the `tavi-breathe` keyframes,
the glass tokens (`--glass-bg`, `--glass-strong`, `--glass-rim`,
`--glass-edge`, `--glass-shadow`), `btn-liquid`, `font-display`, `label-mono`,
light and dark themes (`next-themes`, `.dark`), and the global
`prefers-reduced-motion` rule in `app/globals.css`. Note: in the code `rigel`
is teal (`#1f6362` light, `#6cc0b8` dark), not the "indigo" AGENTS.md mentions;
use the tokens, not hex values.

### 11.1 Tavi's presence

One component, `components/voice/presence.tsx`, shows what Tavi is doing in
every voice screen, as an animated state of the existing Mascot inside a glass
disc:

| State | When | Motion (CSS only) | Words beside it |
| --- | --- | --- | --- |
| `idle` | Nothing happening | `tavi-breathe`, 4 s | — |
| `listening` | Owner dictating in the browser | Ring that scales with input level (see 11.2) | "Listening…" |
| `thinking` | Draft extraction running | Slow orbit of a `rigel` dot (`pulse-dot`) | "Working out the details" |
| `dialing` / `ringing` | Call placed | Concentric rings every 1.2 s | "Calling My CA" |
| `talking` | Live call, Tavi speaking | Mouth/ring pulse from `turn` events | "Tavi is speaking" |
| `hearing` | Live call, callee speaking | Ring in `betelgeuse` | "My CA is speaking" |
| `done` | Settled | One-time `rise` + check | Result line |
| `attention` | `needs_owner` | Static amber ring, no motion | What's needed |

Rules: motion conveys state, never decoration only; every state also has text
(screen readers, reduced motion); under reduced motion the disc is static and
only the text changes (the global rule already shortens animations; no extra
code).

### 11.2 Speaking to Tavi

- **Hold or tap.** Tap the presence disc to start and stop dictation (44 px+
  target; the disc is 96 px). The transcript streams into the editable box as
  `display`-font text that settles into body text when final.
- **Live level ring.** If Chrome allows `getUserMedia` alongside Web Speech
  recognition on the device, a Web Audio `AnalyserNode` drives the ring size.
  On Android Chrome the two can conflict for the microphone; **verify in
  Phase 7 on a real phone**. If it conflicts or is unavailable, the ring is
  driven by interim-result events instead (a pulse each time words arrive). No
  audio is recorded or sent anywhere by the visualiser.
- **Smart chips** under the box after the draft is extracted: "Tomorrow, Thu 18
  Oct", "3:00 PM", "My CA", "Report at 6 PM". Tapping a chip edits that field.
  Chips are rendered from the server's draft, never guessed in the browser.

### 11.3 Confirmation as a moment

- The confirmation card is a glass sheet (`--glass-strong`, `--glass-shadow`)
  rising from the bottom (`rise`), with the recipient's initial in a `Glyph`
  disc, the number in `label-mono` digits, and "Tavi will say" as a quoted
  block in `font-display`.
- **"Listen to the opening"** button plays the exact disclosure sentence through
  the browser's `speechSynthesis` (local, free) or, later, the chosen TTS voice
  via a cached sample, so the owner hears what the callee will hear. Starts only
  on tap (no autoplay).
- Primary action uses `btn-liquid`: "Confirm & call". On Android, a short
  `navigator.vibrate(12)` on success where supported; feature-detected, never
  required.

### 11.4 The live call screen

A full-height view like a phone's in-call screen, but calmer:

- Top: presence disc (11.1), recipient label, elapsed time in `label-mono`,
  attempt "1 of 2".
- Middle: **live captions** (opt-in "Show what's being said", off by default):
  the last two turns, Tavi's in `foreground`, the callee's in `betelgeuse`, with
  the current partial fading in. Turns cut off by barge-in show "(cut off)".
- **Moments**: as call tools fire, small chips slide into a strip — "Proposed
  4:30 PM", "Question for you", "Agreed: Thu 4:30 PM ✓ read back". They come
  from stored notes, so what the owner sees is what will be in the outcome.
- Bottom: "Stop and hang up" (destructive style, confirm dialog).
- Keeps working when the screen is reopened: state comes from the SSE stream and
  the database, so closing the tab loses nothing.

### 11.5 The outcome

- A **result hero**: one sentence in `font-display` ("He agreed to Thursday at
  4:30 PM"), a status icon, and the verification badge.
- **Evidence chips** under each fact ("heard at 1:12") jump to that turn in the
  transcript with the quote highlighted (`rigel-soft` background).
- **Report timeline**: "Calling you at 6:00 PM" → "Told you at 6:01 PM ✓",
  drawn as the same timeline component as §4.
- **"Is this right?"** — yes / correct a field (SELF_IMPROVEMENT.md §3.2).
- **Next step** card with "Draft a follow-up call" (`btn-liquid` secondary).

### 11.6 `/calls` list

- Sections with sticky `label-mono` headers: Live, Needs you, Upcoming, Done.
- Each row: initial glyph, recipient label, result line or next time, a small
  presence dot for live calls.
- Empty state: the Mascot (`tavi-breathe`) and one line: "Tell Tavi who to call
  and what to ask. You'll confirm before anyone's phone rings."
- Skeleton rows while loading (no spinners on lists).

### 11.7 Quality bars for "premium"

| Bar | Check (Phase 7) |
| --- | --- |
| 60 fps animations on a mid-range Android phone | Chrome DevTools performance trace on a real device or 4× CPU throttle; only `transform`/`opacity` animated |
| No layout shift on state changes | Fixed-size presence disc and reserved caption space |
| First load of `/calls/[taskId]` | Server-rendered; no new client library; JS for the page under the current largest route's size (record both in `status.md`) |
| Dark and light | Every voice screen checked in both |
| Reduced motion | Every state still understandable |
| Screen reader | Presence state announced via `aria-live="polite"`; captions in a log region |
| 360 px | No horizontal scroll; chips wrap |
| No new dependency | `package.json` unchanged by Phase 7 |
