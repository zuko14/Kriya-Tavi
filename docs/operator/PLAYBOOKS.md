# Playbooks (operator, track O, phase O7)

A playbook turns a common Indian job into a mandate proposal the person can
read in one screen (OD-09). It is **data** in `lib/operator/playbooks.ts`:
no new execution path. The agent works the job with the tools it already
has; the playbook adds the work prompt, default criteria, grant templates
and a check-in rule. Every playbook below uses only tools that exist today.

```ts title="lib/operator/playbooks.ts (shape)"
export type Playbook = {
  id: `OP-${string}`
  version: number
  title: string // shown on the picker
  roles: string[] // role-pack ids that show it (ROLE_PLAYBOOKS.md)
  needs: (
    "google.gmail" | "google.calendar" | "google.sheets" | "ledger" | "voice" | "web"
  )[]
  slots: {
    name: string
    label: string
    kind: "invoices" | "emails" | "sheet" | "text" | "date"
  }[]
  prompt: string // the check-in prompt; slots filled from the mandate
  criteria: Criterion[] // defaults; the person sees them before approving
  grants: GrantTemplate[] // pins come from slots, never from the model
  checkIn: Rule // lib/schedules.ts rule; at most daily
  // prompt ≤ 2000 chars after slots are filled (schedules.prompt check)
  dueInDays: number // default, ≤ 30
}
```

`needs` that aren't connected or switched on hide the playbook (no dead
buttons). `needs: "voice"` requires `voiceAvailable(userId)`.

## OP-COLLECT v1 — Get overdue invoices paid

**For:** freelancers, consultants, small businesses (FL-05, FD-03).
**Slots:** `invoices` (issued, past due date, picked by the person from the
ledger), `emails` (the clients' addresses, prefilled from the invoices,
editable).

| Criterion                                 | Evidence                                                     |
| ----------------------------------------- | ------------------------------------------------------------ |
| A reminder draft is ready for each client | `tool_verified` `gmail_draft`, `atLeast = number of clients` |
| Each invoice is paid                      | `invoice_paid` (the person marks paid)                       |

**Grants requested:** `gmail_draft`, `to ⊆ emails`, `maxUses = 3 × clients`
(≤ 50), until due.
**Not granted, always asked:** any call (`propose_call` → the person confirms
the exact call); any new recipient; anything R4.
**Work prompt (summary):** read the invoices with `ledger_list`; for each
overdue one, find the last thread with the client (`gmail_search`), draft a
polite reminder in the person's language with the amount (from the ledger,
never computed by the model), invoice number and due date; on the 2nd
check-in after a draft with no reply, offer a call draft with
`propose_call`; when an accepted call outcome has a promised date, propose
a one-time check on that date (`schedule_create`, R2, asks); report what's
still unpaid.
**Check-in:** daily 10:00 IST. **Due:** 21 days.
**Done:** every invoice paid (the person's tick in Accounts). If the job
expires first, the report lists each invoice, its drafts, call outcomes and
promised dates, labelled "not confirmed paid".

## OP-BOOKS v2 — Close this month's books

**For:** small businesses, founders (FD-01, FD-02, BZ-02, FD-09).
**Slots:** `date` (month), optional `emails` (the CA, for the share).

| Criterion                              | Evidence                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Every bill this month is in the ledger | `ledger_confirmed` (the person confirms entries; subjects filled as drafts are created) |
| You reviewed the month's summary       | `person_confirmed` (v2, OF-19; v1: `file_created`)                                      |
| The CA has the report                  | `person_confirmed` ("I shared it")                                                      |

**Grants requested:** none. Drafting ledger entries is R1 already.
**Work prompt (summary):** list files and Gmail attachments for the month,
draft ledger entries (code computes GST, AD-16), flag `needs_review` rows
for the person, render the report once every entry is confirmed, suggest a
K8 share link (the person creates it; share links are person-only).
**Check-in:** daily. **Due:** 10 days.

> [!NOTE]
> `ledger_confirmed` needs the entry ids in `mandates.subjects.ledger`.
> Entries drafted during the job are appended to `subjects` by the worker
> when `ledger_draft_entry` succeeds in the goal thread (O7 change, listed in
> CHANGE_IMPACT). The model never edits `subjects`.

## OP-COMPARE v2 — Compare and track a price

**For:** everyone; Research & Data Operator in map1.
**Slots:** `text` (what to compare, constraints, max price in ₹), optional
`sheet` (spreadsheet id + tab range to fill).

| Criterion                                              | Evidence                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| A comparison with a source and checked-at time per row | `tool_verified` `sheets_append` if a sheet is given, else `person_confirmed` (v2, OF-19)         |
| A watcher on the best option is running                | `person_confirmed` (approving the watcher is the person's R2 approval; its schedule id is shown) |

**Grants requested:** `sheets_append` pinned to the given spreadsheet id
and range, `maxUses = 5`.
**Work prompt (summary):** read official or authorised sources only
(`web_search`, `web_fetch`, facts commons); every price row carries the
source URL, "checked at" (IST) and whether taxes/fees are included; never
present an old result as live (the K7 citation check runs); propose a
watcher (`schedule_create` with `watch`, R2) at the person's threshold.
**Never:** book or pay (OD-12); scrape logged-in pages of other people.
**Check-in:** none after the first run (the watcher does the follow-up).
**Due:** 7 days.

## OP-COMPLY v1 — Keep my compliance dates

**For:** founders, small businesses (FD-04).
**Slots:** none beyond the role.

| Criterion                                         | Evidence                                          |
| ------------------------------------------------- | ------------------------------------------------- |
| This quarter's due dates are on the Radar, quoted | `person_confirmed` after reviewing the Radar list |

**Grants requested:** none (`obligation_add` is R1).
**Work prompt (summary):** use `facts_lookup` and official pages to add GST,
TDS and ROC dates with verbatim quotes (K4 rules; obligations need the
quote); reminders are phone calls through the existing Radar rules.
**Check-in:** weekly Monday 10:00 IST. **Due:** 30 days.

## OP-MEET v2 — Prepare me for this week's meetings

**For:** founders, freelancers (FD-06).

| Criterion                                   | Evidence                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| A one-page brief for each meeting this week | `person_confirmed` (v2, OF-19)                                                   |
| Follow-up events are on the calendar        | `tool_verified` `calendar_create_event` (only if the person asks for follow-ups) |

**Grants requested (optional):** `calendar_create_event` with
`attendees: []` (private reminders on the person's own calendar only),
`maxUses = 10`.
**Check-in:** daily 08:00 IST. **Due:** 7 days.

## How quotes find a playbook's past cost

A playbook's runs are scheduled runs of the job's goal. O7 makes
`claimDueSchedules` read the playbook id of the goal's mandate and pass it
to `enqueueScheduled` as `workflowId` (CHANGE_IMPACT §3, O7 rows). Before
that change, scheduled tasks carry no `workflowId` (re-audit OF-06), so
quotes say "No estimate yet".

## Adding a playbook later

1. Uses only existing tools and evidence kinds; if it needs a new kind or a
   new grantable tool, that's a decision first (OD-03, OD-06).
2. Its grants pin targets from slots the person filled.
3. A golden job (TEST_AND_EVALUATION §3) passes on the scripted model.
4. Its quote shows "No estimate yet" until 10 charged runs exist (K2).
