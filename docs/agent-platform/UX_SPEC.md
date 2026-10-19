# UX specification

Mobile first: test at 360 px wide, 44 px touch targets, dark and light,
reduced motion (AGENTS.md). Build only from `components/ui` (Base UI) and the
tokens in `app/globals.css` (`rigel` indigo, `betelgeuse` saffron,
`label-mono`). No new UI dependency. Buttons that render links need
`nativeButton={false}`.

Language: every new string is plain and short, in the person's locale. Agent
names stay as the person named them.

## 1. Navigation changes

| Where                         | Change                                                                         | Shown when |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------- |
| Bottom nav (mobile) / sidebar | **Inbox** with a count badge (approvals + questions + memories to review)      | A3         |
| Home                          | "Today" section: goals with next steps, Inbox count, last 3 "What I did" items | A3         |
| Account                       | **About you** (shared memory), **Logins** (login profiles), **Files**          | A1, A6, A5 |
| Workspace                     | **Accounts** (ledger and invoices) for packs with the ledger                   | A7         |

Check that the bottom nav doesn't overflow at 360 px. If it would, Inbox
replaces the least-used tab and that tab moves to the command palette.

## 2. Onboarding by role (A2)

1. Existing step: name, locale, use case (`UseCasePicker`).
2. **New: "Meet your team".** Cards for the pack's agents (glyph, name,
   one-line role, three things they can do now), each with a toggle;
   default all on. A note says which capabilities need a connection later
   ("Connect Gmail to let Lekha find bills").
3. **New: "A few things about you"** (optional, skippable). Three to five
   profile slots for the role, saved as shared trusted memory. "Tell me
   later" is a first-class choice.
4. Lands on Home with one suggested first task per agent.

## 3. Inbox (A3)

One list, newest first, with filters: All · Approve · Answer · Memories.

| Item             | Card shows                                                                                                                                                                      | Actions                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Approval (R2–R4) | Agent, risk badge ("Will post publicly", "Will save to your calendar", "Starts a weekly job"), the exact thing, the before screenshot for browser actions, expiry ("in 2 days") | **Approve**, **Decline**, Open thread     |
| Question         | The agent's single question                                                                                                                                                     | Answer inline (opens the thread composer) |
| Memory to review | The note, where it came from ("while reading a web page"), kind, scope                                                                                                          | Confirm, Edit, Delete                     |
| Merge proposal   | Two or three notes and the proposed merge                                                                                                                                       | Accept, Keep separate                     |
| Login needed     | Site, why ("LinkedIn signed you out")                                                                                                                                           | Sign in (opens take-over)                 |

Approving from the Inbox calls the existing approvals route. The approval
mechanics don't change.

## 4. "What I did" (A3)

Per task (in the thread, below the reply) and as a feed (Home → See all):

```text
✓ Saved headline on your LinkedIn profile        14:32   [before] [after]
✓ Added "DSA practice" to Calendar, Mon 7–8 pm   14:30   [open event]
✓ Made "Q2 bills summary.pdf"                    14:29   [open]
? Said it emailed Ravi — not confirmed                    (no matching action)
```

Rules:

- ✓ lines come only from verified executions (AD-02). Each line has its
  evidence chips.
- "Not confirmed" lines are greyed and explain why.
- Each line links to its thread and approval.
- Times are in IST and the person's locale format.

## 5. Goal page (A3)

Title, success criteria, checklist (each item: status, evidence chip when
done), next check-in, schedules attached (cadence in words: "Every Monday
at 9:00 am"), spend this month vs budget (rupees, Indian grouping), and the
goal's thread. Controls: pause, resume, close as achieved (only when every
item has evidence, or the person overrides it), abandon.

## 6. Live view and take-over (A6)

Full-screen sheet on mobile:

- Top bar: site and lock icon, who's in control ("Disha is working" or
  "You're in control"), **Stop**.
- Centre: the live screen, fit to width; tap and keyboard pass through only
  when the person is in control.
- Bottom: the reason for the handoff ("Type your password and the code
  LinkedIn sent you, then press Done"), **Done**, **Cancel**.
- On sign-up pages: **Suggest a strong password**, generated on the device
  (AD-04), with copy and a reminder to save it in their password manager.
- Disclosure line, always visible during take-over (BROWSER §5): "What you
  type here goes to the site through Kriya's browser. Kriya doesn't store or
  record it."
- After a successful sign-in, a **Save login** dialog shows what's stored,
  the site's mode ("Kriya will prepare changes; you apply them" for
  `assisted`), and a background-use toggle (off).

## 7. Logins (Account → Logins, A6)

A list of profiles: site, label, status (Active, Expired, Needs
re-confirmation), last used, background use toggle, **Remove**. Removing also
shows "Sign out other sessions on this site" with the registry's security
link.

## 8. Files (Account → Files, A5)

Upload (camera on mobile: `accept="image/*,application/pdf"` with
`capture`), list with status chips (Uploading, Reading, Ready, Couldn't
read), search, delete. Generated documents are marked "Made by Kriya".

## 9. Accounts (A7)

- **Overview:** this month and FY to date: expenses, income, GST input
  and output (each tappable to its entries), entries needing review.
- **Entries:** list with filters; each entry shows the source bill
  thumbnail, the extracted fields, the reconciliation result ("₹11,800 =
  ₹10,000 + CGST ₹900 + SGST ₹900 ✓"), and review reasons. **Confirm
  selected** in one tap.
- **Invoices:** drafts, issued, paid; issue (R2 confirmation dialog: "This
  gives the invoice number INV/2026-27/014 permanently"), PDF, mark paid,
  void.
- **Export for my CA:** period picker → one ZIP is out of scope (no archive
  creation in the browser service); instead a CSV file + a PDF summary + a
  list of bill links.
- Footer on every report: "Prepared by Kriya from your records. Review with
  your CA."

## 10. Memory (A1)

- **About you:** profile slots grouped (Education, Work, Skills, Business),
  then shared notes. Each note: kind chip, "from you" or "learned", trust
  ("Unconfirmed" chip), pin, edit, forget, history ("Changed on 3 Oct").
- **Agent memory** (existing sheet): same chips; a toggle "Pause memory for
  this agent".
- **Used memories chip** on replies: opens the notes used for that reply.

## 11. Skills (A9)

On a finished task: **Save as skill**. Then the review card (in the Inbox)
shows the steps in words, the slots, the sites, the highest risk ("Posts
publicly — asks you each time"), and Approve. The Skills list sits on each
agent: runs, success rate, last run, retire.

## 12. Quality bars (measure and record in `status.md` per phase)

| Bar                                                                            | Target                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Inbox action to decision                                                       | ≤ 2 taps from Home                                             |
| First "What I did" line visible after a task ends                              | ≤ 2 s (polling as today)                                       |
| Live view frame latency on 4G (measured from Hyderabad or another Indian city) | Record p50/p95; target p95 ≤ 800 ms, unverified until measured |
| 360 px layout                                                                  | No horizontal scroll on any new screen                         |
| Screen reader                                                                  | Every card has a heading and labelled buttons                  |

## 13. Signature features (SIGNATURE_FEATURES.md)

| Feature          | Where                                                                                                  | What the person sees                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1 Receipt       | Below each finished task; Home → "What I did"                                                          | Receipt card: verified actions with evidence chips, "Not confirmed" lines, ₹ charge with its status label ("final", "estimated", "price pending"), time, short hash. **Download PDF**, **Verify my records** (shows "All n records intact", or the first mismatch, or "record n deleted by you on …")           |
| K2 Quote and cap | Confirm dialogs for goals, schedules, skill runs; a "Set a ₹ limit" link in the composer for big tasks | "Usually ₹4–₹9 (from 23 earlier runs)" or "No estimate yet". ₹ cap field with Indian grouping; "₹ cap unavailable: exchange rate not configured" when FX isn't set                                                                                                                                              |
| K3 Undo          | On "What I did" lines for undoable actions, for 10 minutes                                             | **Undo** with a countdown; for calendar: "Invitees will get a cancellation"; afterwards "Undone ✓ (checked)"                                                                                                                                                                                                    |
| K4 Radar         | Home → "Coming up"; Inbox                                                                              | Next obligations by date: title, due date in IST, the quote and source ("from gate2027.iitX.ac.in, read 17 Oct"), "Not verified" chip when the quote check failed; **Done**, **Dismiss**. A reminder line says "Kriya will call you 7 days and 1 day before" once voice reminders exist, otherwise "Shown here" |
| K5 Watchers      | Goal page and Account → Watchers                                                                       | What's watched, how often, last checked, last change with a before/after snippet; pause and remove                                                                                                                                                                                                              |
| K6 Facts         | Inside answers                                                                                         | "Read from <source> on <date>" chip, linking to the official page                                                                                                                                                                                                                                               |
| K7 Cross-check   | Inside answers                                                                                         | An **unsupported** chip on sentences whose citation couldn't be found; tap for why                                                                                                                                                                                                                              |
| K8 Share         | Receipt, report, goal, Accounts → Export                                                               | **Share** → choose what and how long (1–30 days) → confirmation naming exactly what's shared → link shown once with Copy. Account → Shared links: views, revoke                                                                                                                                                 |
| K9 Kits          | Thread result for `assisted` sites                                                                     | Step list with deep links, copy blocks with **Copy**, limits ("120 of 220 characters"), **I've applied it** → "Checked ✓ on your public profile"                                                                                                                                                                |
| K10 Lite mode    | Account → Display; banner when the browser asks to save data                                           | Toggle; images and screenshots load on tap; live view opens on request                                                                                                                                                                                                                                          |

The recipient's share page (`/share/[token]`) is plain and fast on any
phone. It shows the snapshot, "Shared by <display name> on <date>, expires
<date>", and no sign-up prompt or tracking.
