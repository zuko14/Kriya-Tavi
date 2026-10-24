# Decisions (operator, track O)

All decisions are **Proposed** until the owner approves them in `status.md`
("Track O owner approvals"). **OD-01…OD-21 were approved by the owner on
2026-10-21.** A phase may start only when every decision it
lists is Approved. Format: decision, why, alternatives rejected, what it
binds.

| Id    | Decision                                                     | Needed by           |
| ----- | ------------------------------------------------------------ | ------------------- |
| OD-01 | Mandates sit on goals; no new execution engine               | O2                  |
| OD-02 | Standing grants (and the AGENTS.md amendment)                | O2, O4              |
| OD-03 | What can never be granted                                    | O2                  |
| OD-04 | Grants pin targets instead of pausing on untrusted content   | O4                  |
| OD-05 | Completion is a code verdict over typed evidence             | O5                  |
| OD-06 | The evidence-kind catalogue is fixed in code                 | O5                  |
| OD-07 | Check-ins reuse schedules; the stuck rule                    | O6                  |
| OD-08 | GUI computer use deferred, with a measurable trigger         | —                   |
| OD-09 | Playbooks are versioned code data                            | O7                  |
| OD-10 | Positioning: "India-first", not "India's first"              | —                   |
| OD-11 | Notification channels unchanged                              | —                   |
| OD-12 | Bookings and payments stay R5 hand-offs                      | —                   |
| OD-13 | Migration range and switches                                 | O1+                 |
| OD-14 | Limits per person                                            | O3                  |
| OD-15 | Google scope strategy (Testing now; Drive "files I choose")  | G1, G2, G3          |
| OD-16 | Gmail may send a reviewed draft (R4, exact approval)         | G2                  |
| OD-17 | Drive sharing as an R4 action with undo                      | G2                  |
| OD-18 | Calendar events keep the person's own Google reminders       | G1                  |
| OD-19 | Crew parts run as their own tasks in their own threads       | O11                 |
| OD-20 | UI verification only on an isolated stack, with a stub model | P-3, every UI phase |
| OD-21 | Operator requires `agents.goals` and `agents.inbox`          | O3                  |
| OD-22 | Deleting a calendar event the person names (R3)              | G2                  |

## OD-01 Mandates sit on goals; no new execution engine

**Decision.** A mandate is one row in `kriya.mandates` that, once the person
approves it, owns exactly one goal (`goals`) and that goal's thread. Work
happens as ordinary tasks in that thread, started by the person or by the
mandate's schedules. Nothing in `claim_task`, `heartbeat_task`,
`recover_tasks` or `kriya.tasks` changes.

**Why.** Goals already have a thread, a checklist with evidence, statuses,
a monthly ₹ cap that pauses schedules, and person-only closing. Schedules
already go through `prepare()` (limits, tiers, idempotency). Reusing them
keeps every proven guarantee.

**Rejected.** A separate plan executor with its own step queue (duplicates
the runner, splits receipts, needs new recovery proofs). A new task status
(touches the protected queue).

## OD-02 Standing grants

**Decision.** Inside an **active** mandate the person may grant standing
permission for a tool whose registry entry is `grantable` (O1). A grant has:
the tool; constraints that pin the target (DATA_MODEL §2.2); `max_uses`
(1–50); `expires_at` (≤ the mandate's `due_at`, ≤ 30 days from approval).
When a call in **that mandate's goal thread** matches every constraint of an
active grant, and the grant is consumed atomically in SQL, the call runs
without a per-call approval. Otherwise it asks exactly as today.

Only the person creates, edits (reduce-only) or revokes grants, through
server actions. No tool writes `mandates.status`, `grants` or `grant_uses`
(checked by AT-POL-07's table, extended in O3).

**Binds an AGENTS.md change.** Track-A rule 3 says R2–R4 need approval of
the exact action. With OD-02 it becomes the amendment in
CHANGE_IMPACT_AND_SAFETY.md §7. O4 code may not be written before the
owner approves OD-02 **and** the amendment is applied.

**Why.** Approving 20 identical drafts one by one teaches people to tap
"Approve" without reading, which is worse than one careful approval of a
narrow envelope.

**Rejected.** Model-judged "similar enough" approvals (a model would lower a
class: AD-03 forbids it). Grants by risk class ("all R3") (too broad).
Grants that outlive the mandate.

## OD-03 What can never be granted

**Decision.** Never grantable: every R4 and R5 class; any tool not marked
`grantable` in the registry; `propose_call` and anything in `lib/voice`
(the person confirms each call, voice D-09); `schedule_create` and
`schedule_update` with a rule (the mandate's own schedules are created by
the person's approval); browser actions (classified per page, AD-06);
`skill_run` (replay already re-classifies each step). Grantable in v1:
`gmail_draft`, `calendar_create_event`, `sheets_append`, `sheets_update`.

**Why.** v1 grants cover private, reviewable or reversible effects only:
a draft the person still sends, an event on their own calendar (undoable,
K3), rows in a sheet they named.

## OD-04 Grants pin targets instead of pausing on untrusted content

**Decision.** A grant always pins the target: email recipients ⊆ a list
the person approved; calendar attendees ⊆ a list (empty list = no
attendees); a spreadsheet id and, for `sheets_update`, an exact range.
Untrusted content in context (`untrustedSeen`) does **not** suspend a grant.

**Why.** Every receivables job reads Gmail, which `untrustedSeen` counts as
untrusted; suspending would make grants useless. Pinning means injected
text can at worst change the **content** of a draft or row inside the
envelope, never send anything or reach anyone new. Drafts are still sent by
the person.

**Alternative (owner may choose instead).** Suspend grants after untrusted
content. Safer, but OP-COLLECT and OP-BOOKS would ask for every action.

## OD-05 Completion is a code verdict over typed evidence

**Decision.** Each criterion names an evidence kind (OD-06). `lib/operator/verdict.ts`
(pure) computes `met`/`not_met` per criterion from rows: episodes, tool
executions, voice outcomes, invoices, ledger entries, files. A mandate
becomes `completed` only when every criterion is `met`, and only through
code. The model can ask for a verdict (`mandate_report`, R1); it can't set
one. The person can close a mandate at any time (`closed`); the report then
lists unmet criteria as "not confirmed".

A criterion of kind `person_confirmed` is met only by the person's own tick
and is labelled "confirmed by you", never "verified".

## OD-06 The evidence-kind catalogue is fixed in code

**Decision.** Kinds in v1 (DATA_MODEL §3): `tool_verified`, `call_outcome`,
`invoice_paid`, `ledger_confirmed`, `file_created`, `person_confirmed`.
Adding a kind is a code change with a test. A proposal using an unknown kind
is refused.

## OD-07 Check-ins reuse schedules; the stuck rule

**Decision.** Approving a mandate creates its schedules through the existing
schedule code (person's action, so already approved): a kickoff run now and
recurring check-ins (default daily at 10:00 IST, at most daily). Each run is
an ordinary task (limits, caps). A worker pass (`reviewMandates`, no model)
then:

- marks a mandate `needs_person` after **2 consecutive check-in runs with no
  new evidence and no pending approval**, pausing its schedules;
- marks it `expired` at `due_at`, ending its schedules and computing the
  verdict;
- marks it `completed` when the verdict is all `met`.

Needs-person mandates show in the Inbox. No push, SMS or email (OD-11).

## OD-08 GUI computer use deferred, with a measurable trigger

**Decision.** No desktop VM in track O. Reopen when **all** hold:
(1) O10 has run; (2) at least 3 distinct playbook steps failed on the
DOM browser for a recorded reason the API and DOM routes can't fix;
(3) a cost estimate per successful task from real measurements exists.
Then a new decision with its own security design (egress, isolation,
recording, take-over).

## OD-09 Playbooks are versioned code data

**Decision.** `lib/operator/playbooks.ts` exports playbooks as typed
constants: id (`OP-…`), version, title, needed connections, slots, the work
prompt, default criteria, default grant templates, default check-in, and
the role packs that show it. A mandate stores `playbook_id` and
`playbook_version`; editing a playbook never changes an existing mandate.
Tasks from a playbook carry `tasks.input.workflowId` = the playbook id,
so quotes (K2) work; O7 adds that to `enqueueScheduled` (it isn't set
today, OF-06).

## OD-10 Positioning

**Decision.** Public copy says **"India-first AI operator"**. "India's
first" needs a dated comparison of current products (track-A RG-9) and
counsel's sign-off, recorded in `status.md`, before any use.

## OD-11 Notification channels unchanged

**Decision.** Mandate events use the in-app notifier and Inbox; reminders
the person asks for stay phone calls (voice rule 10). map1's "user-selected
channels" is not adopted. Only the owner can change rule 10, in a new
decision.

## OD-12 Bookings and payments stay R5 hand-offs

**Decision.** Playbooks may compare, prepare (K9 kits) and hand off. Kriya
never pays, books with payment, enters OTPs or files returns. A booking
claim needs a provider confirmation; the verifier already marks unbacked
"booked/paid" claims as not confirmed.

## OD-13 Migration range and switches

**Decision.** Track O migrations use `202612DDhhmmss` (after track A's
`202611…`, including `20261115000000_database_lint`). One migration writer
at a time across all tracks. Switches (all default off, settings in
`lib/config.ts`):

| Switch                   | Effect                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| `operator.disabledTools` | Owner kill list (comma-separated tool names) removed from every belt (O1)     |
| `operator.mandates`      | `mandate_propose`, `mandate_status`, mandate card, actions, pages (O3)        |
| `operator.grants`        | Grant matching in the runner (O4). Off = every call asks, as today            |
| `operator.reports`       | `mandate_report`, verdicts, handover PDF (O5)                                 |
| `operator.checkIns`      | `reviewMandates` worker pass (O6)                                             |
| `operator.playbooks`     | Playbook picker and playbook prompts (O7)                                     |
| `operator.maxActive`     | Active mandates per person, default 3 (O3, OD-14)                             |
| `operator.crews`         | `crew_dispatch` and the `reviewCrews` pass (O11, OD-19)                       |
| `operator.driveShare`    | `drive_share` and `drive_import` (G2, OD-17)                                  |
| `operator.gmailSend`     | `gmail_send_draft` (G2, only if OD-16 is approved)                            |
| `google.testingMode`     | Account note "reconnect every 7 days" while the Google app is in Testing (G1) |

Off means byte-identical prompts, tool sets and `TOOL_APPROVALS` for
existing agents (OT-REG-01, extending AT-REG-01).

## OD-14 Limits per person

**Decision.** At most `operator.maxActive` active or needs-person mandates
per person (default 3), checked in the approval action inside the same
`withUser` transaction (invariant 7). A plan column can replace the setting
later through a new migration.

## OD-15 Google scope strategy

**Decision.** Two stages. **Now (G1):** the existing scopes
(`calendar.events`, `gmail.readonly`, `gmail.compose`, `drive.readonly`)
with the consent screen in **Testing**: up to 100 listed testers, refresh
tokens that expire every 7 days (Google docs, read 2026-10-21;
GOOGLE_CONNECTIVITY §2). **Public (G3):** never "In production" while
unverified (100-user lifetime cap). Drive moves to `drive.file` + Google
Picker ("files I choose", Non-sensitive) as the default, with "search all
my Drive" (`drive.readonly`, Restricted) opt-in. Gmail reading and drafts
are Restricted: public launch with Gmail needs Google's security
assessment; until it passes, Gmail stays for listed testers.

**Rejected.** Publishing unverified (permanent 100-user cap). Dropping
Gmail entirely (it's the core of OP-COLLECT and OP-BOOKS).

## OD-16 Gmail may send a reviewed draft

**Decision (owner's choice; recommended yes).** A new tool
`gmail_send_draft` sends a draft **Kriya saved and the person has seen**,
as **R4** with exact approval every time, **never grantable**, behind
`operator.gmailSend`. No new Google scope (`gmail.compose` covers sending
drafts; G3 still applies). The verifier's claim table
(`lib/agent/verify.ts`, protected) changes by one row so "I sent …" is
backed only by a verified `gmail_send_draft` run.

**Why.** "Kriya never sends" was the right default; an operator that
follows up on invoices needs the person to be able to say "send it" without
leaving Kriya. The exact approval keeps the person the sender.

**If not approved:** drafts only, as today; OP-COLLECT's criterion stays
"a draft is ready".

## OD-17 Drive sharing as an R4 action with undo

**Decision.** `drive_share` adds reader or commenter access for up to 10
addresses to one file; R4, exact approval every time, never grantable;
verified by reading the permissions back; undo (K3) removes only the
permissions it added, within 10 minutes. Google notifies the recipients;
the approval card says so. `drive_import` (R1) copies a Drive file into
Kriya files so PDFs and Word files can be read by the existing extraction.

## OD-18 Calendar events keep the person's own Google reminders

**Decision.** `calendar_create_event` doesn't set notification fields, so
the person's own Google Calendar defaults apply. That is the person's
calendar, not a Kriya channel. Reminders **Kriya** gives stay phone calls
(voice rule 10, OD-11).

## OD-19 Crew parts run as their own tasks in their own threads

**Decision.** CREW_EXECUTION.md. A job's lead dispatches up to 4 parts per
round (3 rounds max); each part is an ordinary task in its own thread, run
by the member with its full tool belt, approvals, grants and receipts; a
worker pass joins the results into the lead's thread. `assign` (research
only, in one task) stays unchanged for chats outside jobs.

**Rejected.** Giving `assign` members connectors inside the lead's task
(an approval can't pause a member, and a member's web request after private
data can't be approved). Members writing directly into the job thread
(`tasks_one_active_per_thread` forbids parallel tasks in one thread).

## OD-20 UI verification only on an isolated stack, with a stub model

**Decision.** UI_VERIFICATION.md. Every UI phase ends with a browser check
on a local server whose database is the **local Supabase stack** (or a
staging project the owner names), enforced by `npm run verify:guard`. The
model is a local scripted stub unless the owner approves a paid run. The
owner's `.env` and `.env.local` (which point at the live project) are
never edited; `.env.verify` is exported into the process instead.

## OD-21 Operator requires `agents.goals` and `agents.inbox`

**Decision.** Jobs live on goals (`agents.goals`), and "What I did"
episodes, which the verdict reads, are written only when `agents.inbox` is
on (`lib/agent/run-task.ts`, the `if (inbox)` block). `approveMandate`
refuses with a clear message unless both are on, and the owner config page
shows `operator.*` as ineffective while either is off. On 2026-10-21 the
live database had **no** `agents.*` keys stored (their value may still come
from Render environment variables, which agents can't see; check
`/owner/config`, which shows each setting's source).

## OD-22 Deleting a calendar event the person names

**Decision (owner, 2026-10-24).** A new tool `calendar_delete_event`
deletes one event from the person's primary Google Calendar, behind
`operator.calendarDelete` (off by default). **R3**, exact approval every
time, **never grantable** (no pins). The model passes the event's id,
title and start exactly as `calendar_events` returned them; the tool reads
the event first and deletes nothing unless both match what the approval
card showed. Guests aren't emailed (`sendUpdates=none`). Verified by
reading the event back as gone. No undo (Kriya can't recreate it
faithfully). No new Google scope (`calendar.events` covers deleting). The
verifier gains one claim row: "I deleted/removed/cancelled … event" is
backed only by a successful `calendar_delete_event` run.
