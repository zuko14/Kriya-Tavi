# UX spec (operator, track O)

Mobile first, tested at 360 px (AGENTS.md): 44 px touch targets, tokens from
`app/globals.css` (`rigel` indigo for primary, `betelgeuse` saffron for
attention, `label-mono` for small caps metadata), Base UI primitives from
`components/ui` (links as buttons need `nativeButton={false}`). Lite mode
(K10): no images, text first. Every screen answers four questions (map1
§5): **What did I ask? What is Kriya doing? What does it need from me? What
proves it's done?**

## 1. Mandate card (proposal) — in the thread and the Inbox

```
┌──────────────────────────────────────────┐
│ JOB PROPOSAL · OP-COLLECT          ₹ ~—  │  label-mono; quote or "No estimate yet"
│ Get 3 overdue invoices paid              │
│ Due 11 Nov · checks in daily 10:00 IST   │
├──────────────────────────────────────────┤
│ Done means                               │
│  ○ A reminder draft for each client      │  icon = evidence kind
│  ○ Each invoice is paid  (you mark it)   │
├──────────────────────────────────────────┤
│ Kriya may do without asking              │
│  ✉ Save up to 9 email drafts to          │
│    asha@…, ravi@…, kumar@…   [−] [off]   │  reduce-only controls
├──────────────────────────────────────────┤
│ Kriya will always ask you before         │
│  calls, new recipients, posting, money   │
│ Kriya never: pays, enters OTPs/passwords │
├──────────────────────────────────────────┤
│ [ Decline ]              [ Approve job ] │  44 px, Approve = rigel
└──────────────────────────────────────────┘
```

- The recipients are shown in full on tap (not truncated in the decision).
- "Approve job" is disabled while any grant control is mid-edit.
- After approval the card becomes a link to the job page.
- Copy says "job" to people; "mandate" is the internal term.

## 2. Job page — `/goals/[goalId]` gains a Job panel (behind `operator.mandates`)

Order, top to bottom:

1. **Status chip**: Active · Needs you · Paused · Done (verified) · Closed ·
   Expired · Revoked. "Needs you" uses `betelgeuse`.
2. **Needs from you**: pending approvals of this thread (existing Inbox
   rows), and the reason when stuck ("No progress in 2 check-ins: the
   client hasn't replied. Call them, wait, or close the job?").
3. **Done means**: each criterion with ● met (tap → evidence: receipt,
   call outcome, invoice) or ○ not yet; person-confirmed criteria show a
   "Mark done" button and, once ticked, "confirmed by you".
4. **Authority**: each grant "Email drafts to 3 clients · used 4 of 9 ·
   until 11 Nov" with **Revoke**.
5. **Activity**: next check-in time (IST), last run, spend so far (₹, with
   `final`/`estimated` label).
6. **Actions**: Pause / Resume, Close job, Revoke job; **Report** (PDF,
   with `operator.reports`) and Share (existing K8).

## 3. Inbox

Two new sections when `operator.mandates` is on: **Jobs to review**
(proposals) and **Jobs that need you**. Same row style as approvals; badge
count includes them.

## 4. Home — "Hand Kriya a job" (O7, `operator.playbooks`)

A short list of playbooks the person can actually run (connections and
switches checked). Tapping one opens a slot form (pick invoices from the
ledger, pick a sheet, type a price limit), then shows the same mandate
card, `proposed_by = 'person'`.

## 5. Settings → Jobs

"Stop all jobs" (confirm dialog, then `stopAllMandates`). Lists active jobs
with their authority.

## 6. "What I did"

A row done under a grant shows "under your job: Get 3 overdue invoices
paid" (join on `tool_executions.grant_id`), so a person always sees which
actions they didn't approve one by one.

## 7. Acceptance for UI phases

OT-UI-01: at 360 px, light and dark, the mandate card, job panel and Inbox
sections render without horizontal scroll; every control ≥ 44 px;
screenshots attached to `status.md`. OT-UI-02: keyboard and screen-reader
labels on every control (Revoke buttons name the grant).
