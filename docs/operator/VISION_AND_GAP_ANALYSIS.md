# Vision and gap analysis (operator, track O)

Written 2026-10-21 against `main` at `7c32922` plus the uncommitted
`status.md`, `package.json` and `package-lock.json` changes. Inputs:
`docs/kriya_roadmap/map1.md` (a suggestion, not a plan), `docs/audit/*`,
`docs/agent-platform/*`, `docs/voice-assistant/*`, `status.md`, and the code.
**Where a document and the code disagree, the code was taken as the fact**
and the disagreement is listed in §5.

## 1. Intent

> **Kriya Tavi is an India-first AI operator: you hand it a well-defined job,
> it works within the authority you granted, and it proves what it got
> done.**

"Operator" means three things a chatbot and today's Kriya don't do together:

1. **Takes responsibility.** A job has an owner (an agent or a squad), a
   definition of done, a deadline, a budget and check-ins. Kriya keeps
   working on it in the background until it's done, it runs out of time or
   money, or it needs the person.
2. **Acts within granted authority.** The person approves a bounded
   envelope once ("save up to 5 draft reminders to these 3 clients until
   31 Oct"). Inside it Kriya doesn't ask again; outside it, it asks as it
   does today. The envelope is enforced by code, not by the model.
3. **Shows what it accomplished.** The job closes with a verdict computed
   by code from evidence (verified tool runs, accepted call outcomes, the
   person's own confirmations), never from the model's prose.

## 2. What Kriya has today (verified in code)

Everything below exists in the repository with tests. "Fixtures" means
proven on local fixtures or mocks, not on live services.

| Capability                                                                           | Where                                                                 | State                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------- |
| Durable task runner (lease, heartbeat, retry, budget stop)                           | `lib/agent/run-task.ts`, `lib/agent/queue.ts`, `kriya.claim_task`     | Tested (PGlite)                           |
| Deterministic risk classes R0–R5                                                     | `lib/agent/policy.ts` (`TOOL_CLASSES`, `classifyTool`, `approvalFor`) | Tested                                    |
| Per-call approvals, Inbox, 72 h expiry                                               | `lib/agent/approvals.ts`, `queries/inbox.ts`, `app/(workspace)/inbox` | Tested, behind `agents.inbox`             |
| "What I did" episodes + hash-chained receipts (K1)                                   | `lib/agent/episodes.ts`, `lib/agent/verify.ts`                        | Tested                                    |
| Goals with success criteria and evidence-linked checklist                            | `lib/goals.ts` (achieved only with episode evidence)                  | Tested, behind `agents.goals`             |
| Schedules, watchers, ₹ caps, quotes (K2, K5)                                         | `lib/schedules.ts`, `lib/watch.ts`, `lib/quotes.ts`                   | Tested, behind switches                   |
| Memory v2                                                                            | `lib/memory/*`                                                        | Tested                                    |
| Browser on fixtures, login profiles, take-over, kits                                 | `browser/*`, `lib/browser/*`                                          | Fixtures; public live view needs AB-11    |
| Files, PDFs (`report`, `invoice`, …), shares (K8)                                    | `lib/files.ts`, `lib/documents/*`, `lib/share.ts`                     | Fixtures                                  |
| Ledger, GST, invoices (`draft/issued/paid/void`, due date)                           | `lib/ledger.ts`, `lib/gst.ts`                                         | Fixtures                                  |
| Connectors: Calendar, Gmail draft, Drive, Notion, GitHub, Sheets, YouTube, Instagram | `lib/connectors.ts`, `lib/connectors/*`                               | Fixtures; live needs AB-06                |
| Undo window (K3)                                                                     | `lib/undo.ts`, `worker/index.ts` `undoLoop`                           | Fixtures                                  |
| Radar, public facts (K4, K6)                                                         | `lib/radar/*`, `lib/facts.ts`                                         | Fixtures                                  |
| Outbound calls with exact-payload confirmation, verified outcomes, phone reminders   | `lib/voice/*`, `voice/index.ts`, `propose_call`                       | Mocks; live calls BLOCKED (voice phase 5) |
| Governed improvement loop                                                            | `lib/improve.ts`, `lib/voice/improve.ts`                              | Test data                                 |
| Owner console, metering in integer micro-units                                       | `app/owner/*`, `lib/agent/metering.ts`, `lib/money.ts`                | Tested                                    |

## 3. What's missing for an operator (the real gaps)

Each gap was checked in code on 2026-10-21 (GAP-09…12 added in the re-audit the same day, also against the live database, read-only).

| #      | Gap                                          | Evidence in code                                                                                                                                                                                    | Track O answer                                         |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| GAP-01 | **No delegated authority**                   | Every R2–R4 call asks (`TOOL_APPROVALS` in `run-task.ts:130`). A 20-step job means up to 20 approvals; the person is the bottleneck                                                                 | Standing grants (O2, O4)                               |
| GAP-02 | **No job contract the person approves once** | Goals are created by the model (`goal_create`, R1) with free-text `successCriteria`; there is no person-approved scope, deadline or authority                                                       | Mandates (O2, O3)                                      |
| GAP-03 | **"Done" isn't typed**                       | `goals.plan[].evidence` links an episode id, but nothing checks the episode proves _that_ item (`lib/goals.ts:updateGoal` only checks the id exists)                                                | Typed evidence + code verdict (O5)                     |
| GAP-04 | **Nobody follows up**                        | `goals.check_in` exists in the schema and is used nowhere (`grep checkIn` → only `db/schema.ts`)                                                                                                    | Responsibility loop (O6)                               |
| GAP-05 | **No single capability registry**            | Facts about a tool are spread over `TOOL_CLASSES`, `TOOL_WRITES`, `SIDE_EFFECT_TOOLS`, `lib/undo.ts`; no owner kill switch per tool                                                                 | Registry + kill switch (O1)                            |
| GAP-06 | **Workflows are prose**                      | Role-pack workflows (FD-03, FL-05, BZ-07…) are rows in `ROLE_PLAYBOOKS.md` and template text; none carries a definition of done or authority                                                        | Playbooks (O7)                                         |
| GAP-07 | **No operator metrics**                      | The owner console counts tasks and cost; nothing measures verified completion, unconfirmed claims or approval latency per job                                                                       | Metrics (O8)                                           |
| GAP-08 | **No end-to-end acceptance for whole jobs**  | Tests prove each piece; no test drives a job from proposal to verdict                                                                                                                               | Golden jobs (O9)                                       |
| GAP-09 | **Crews can't act**                          | `assign` members get only memory and web tools, `writes: false`, no connected accounts (`run-task.ts` `runAssignments`); an approval can't pause a member                                           | Crew parts as their own tasks (O11, CREW_EXECUTION.md) |
| GAP-10 | **Google isn't live**                        | `GOOGLE_CLIENT_ID`/`SECRET` absent from `.env` and `.env.local`; the deployed Account page says "Not available"; 0 rows in `kriya.connections` (live DB); a dead refresh token isn't shown anywhere | G1–G3 (GOOGLE_CONNECTIVITY.md)                         |
| GAP-11 | **No Drive share, no Drive PDFs**            | `driveRead` exports only Google files and text; no permissions call exists                                                                                                                          | G2 (`drive_import`, `drive_share`)                     |
| GAP-12 | **No safe way to check the UI locally**      | `.env`, `.env.local` and the worker's env all point at the live database                                                                                                                            | P-3 (UI_VERIFICATION.md)                               |

## 4. map1.md, item by item

map1 is good direction, but it was written from the audit, which
understates what exists. Decisions on each recommendation:

| map1 recommendation                                        | Already in Kriya?                                 | Track O decision                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Typed step states, checkpoints, action receipts (§9A)      | Receipts, episodes, retries: yes. Step states: no | Step state is **derived** from executions and criteria (O5), not a second state store                        |
| Capability registry and dispatcher (§8, §9B)               | Partly (policy tables)                            | O1 registry derived from existing tables; the model still picks the tool, code still classifies it           |
| Exact-action approval cards (§10 P1)                       | Yes (Inbox, voice confirm card)                   | Kept; plus the mandate card for the envelope (O3)                                                            |
| User-defined autonomy, "system policy always wins" (§12.4) | No                                                | **Grants** (OD-02): R2/R3 only, target-pinned, expiring, counted                                             |
| Evidence standard for "complete" (§12.5)                   | For actions yes (AD-02); for jobs no              | Code verdict (O5, OD-05)                                                                                     |
| Business Operator first (§6)                               | Pieces exist (ledger, Gmail draft, calls)         | First playbooks are business ones: OP-COLLECT, OP-BOOKS (O7)                                                 |
| Research & Data Operator (§6)                              | Web, Sheets, watchers exist                       | OP-COMPARE (O7) with sources and checked-at times                                                            |
| Voice as a shared capability (§6)                          | `propose_call` already available to any agent     | Used inside playbooks; **calls are never covered by a grant** (OD-03)                                        |
| Tiered computer use, GUI desktop VM (§4)                   | Browser yes; desktop no                           | **Deferred** with a measurable trigger (OD-08)                                                               |
| Real prices, bookings (§7)                                 | Watchers yes; booking no                          | Compare + watch only; booking/payment stays R5 hand-off (OD-12)                                              |
| Notifications through user-selected channels (§8)          | In-app + phone calls                              | **Not adopted**: conflicts with voice rule 10 / AD-20. Only the owner can change that rule (OD-11)           |
| Connector directory, MCP, SDK (§8 future)                  | No                                                | Out of scope until the registry is stable and O10 is done                                                    |
| Phase 0 launch blockers (§10 P0)                           | Tracked as B2/AB-02, AB-08, AB-11, voice 5        | Not duplicated; listed as O10 preconditions (status.md "Track O blockers")                                   |
| Finish Google Workspace OAuth, read-only first (§8)        | Code yes, not configured live                     | G1 (Testing mode, owner's checklist), G2 (Drive import/share, optional Gmail send), G3 (Google verification) |
| Specialist agents on a shared runtime (§6)                 | Squads exist; members can't act                   | O11: each crew part is its own durable task with the member's full tools                                     |
| Hindi/Hinglish/Telugu voice (§10 P3)                       | Voice phase 4 owns STT/TTS adapters (B6)          | Not duplicated                                                                                               |
| "India's first" claim (§1, §12.6)                          | —                                                 | Say "India-first". "First" only after a dated competitor check and counsel (OD-10)                           |
| Metrics (§11)                                              | Partly (A12, voice phase 8)                       | O8 defines OM1–OM8 from existing rows                                                                        |

## 5. Conflicts found between documents and code

| Id    | Document says                                                                                           | Code says                                                                                                                                                                             | Effect                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF-01 | Audit `UPGRADE_ROADMAP.md`: voice adapters go in "`lib/voice/providers.ts` … `saaras:v2`" etc.          | Model names there are unverified by any test or doc in the repo                                                                                                                       | Voice phase 4 decides; track O doesn't rely on them                                                                                                                                                                                                                               |
| OF-02 | Audit: "59 unindexed foreign keys"                                                                      | Live DB (read-only, 2026-10-21): 106 FKs, 58 without an exactly-leading index                                                                                                         | Resolved as P-2; an index migration is an owner decision, not track O                                                                                                                                                                                                             |
| OF-03 | map1: "test totals inconsistent (104 vs 108 files)"                                                     | Recorded with this session's real `npm run check` output in `status.md` (Track O check log)                                                                                           | —                                                                                                                                                                                                                                                                                 |
| OF-04 | map1 §10 P0 treats "notifications" as a channel choice                                                  | `AGENTS.md` voice rule 10 and track-A rule 10 forbid push/SMS/WhatsApp/email reminders                                                                                                | OD-11                                                                                                                                                                                                                                                                             |
| OF-05 | Track A rule 3: "R2–R4 need the person's approval of the exact action"                                  | Grants change this for R2/R3 inside a mandate                                                                                                                                         | Needs the AGENTS.md amendment in CHANGE_IMPACT §7 (OD-02)                                                                                                                                                                                                                         |
| OF-06 | (re-audit 2026-10-21) This blueprint's first draft said a playbook task "sets `tasks.input.workflowId`" | `enqueueScheduled`/`taskRow` never set it                                                                                                                                             | O7 changes `queue.ts`/`schedules.ts` (CHANGE_IMPACT §3)                                                                                                                                                                                                                           |
| OF-07 | First draft: kickoff schedule "`once`, now"                                                             | `createSchedule` refuses a time already passed; it takes no cap                                                                                                                       | now + 60 s; `setScheduleCap` (TOOLS_AND_CONTRACTS §2)                                                                                                                                                                                                                             |
| OF-08 | First draft: verdict reads episodes                                                                     | Episodes are written only with `agents.inbox` on; the live DB stores no `agents.*` keys                                                                                               | OD-21                                                                                                                                                                                                                                                                             |
| OF-09 | First draft: `consume_grant` revoked from `public` only                                                 | Supabase grants function execute to `anon`/`authenticated` explicitly in some setups                                                                                                  | Revoke from `public, anon, authenticated`                                                                                                                                                                                                                                         |
| OF-10 | First draft: approval uses `createGoal` for every job                                                   | `createGoal` sets no `squad_id`                                                                                                                                                       | Squad jobs create their thread and goal in `lib/operator/mandates.ts`                                                                                                                                                                                                             |
| OF-11 | First draft used OG- for both gaps and golden jobs                                                      | —                                                                                                                                                                                     | Gaps renamed GAP-                                                                                                                                                                                                                                                                 |
| OF-12 | ARCHITECTURE §4: the registry has "one entry per tool", derived from `TOOL_CLASSES`                     | `propose_call` is a belt tool with no `TOOL_CLASSES` entry (runs without approval by design, D-09)                                                                                    | Registry = `TOOL_CLASSES` keys; a test pins `propose_call` as the only unclassed belt tool (O1)                                                                                                                                                                                   |
| OF-13 | PLAYBOOKS: OP-COLLECT "a reminder draft for each client" is `tool_verified gmail_draft`                 | `gmailDraft` and `calendarCreate` return no `verification`, so episodes list them as "not confirmed" and the criterion can't be met                                                   | Read-back in `lib/connectors.ts` (protected; owner approval), before O5. **Resolved 2026-10-22** (owner-approved): both read back headers/event and return `verification`                                                                                                         |
| OF-14 | DATA_MODEL §1.1: `origin_thread_id not null … on delete cascade`; actors enforced in code only          | Deleting the origin chat would delete an active job and its grants; the client role could set worker-only statuses                                                                    | O2: nullable + `set null`; `mandates_guard` and a stricter insert policy in SQL                                                                                                                                                                                                   |
| OF-15 | UX_SPEC §5 "Settings → Jobs"; CHANGE_IMPACT allows `app/(workspace)/settings/page.tsx`                  | That page is only `redirect("/account")`: there is no Settings screen                                                                                                                 | O3: with `operator.mandates` on, `/settings` renders Jobs (Stop all, running jobs); off, it redirects as before; the Inbox links to it. Owner may prefer Account (new CHANGE_IMPACT row)                                                                                          |
| OF-16 | DATA_MODEL §4: `TOOL_WRITES.mandate_report = []`                                                        | `mandate_report` stores the computed verdict and `last_evidence_at` (server, scoped by user id)                                                                                       | O5 declares `["mandates.verdict", "mandates.last_evidence_at"]`, so AT-POL-07 sees what it really writes; neither is a person-only column                                                                                                                                         |
| OF-17 | UI_VERIFICATION §5: exporting `.env.verify` makes its values win                                        | Next.js fills every name undefined in `process.env` from `.env`/`.env.local`, which hold live-only names (Exotel, voice, Firecrawl, browser)                                          | P-3: `.env.verify` sets every name those files hold (empty when unused); the guard fails on any name left undefined                                                                                                                                                               |
| OF-18 | AGENTS.md: "owners edit [settings] in `/owner/config`"; O1 assumed new keys appear there                | `app/owner/config/page.tsx` renders only `routing.`, `agent.`, `fx.`, `finance.`, `voice.`, `firecrawl.`, `support.` keys: no `agents.*` or `operator.*` switch is editable in the UI | **Fixed 2026-10-22** (owner-approved): the two groups were added. Owner decision was: add groups for `agents.` and `operator.` (needs a CHANGE_IMPACT row); until then switches come from Render env or `platform_settings`                                                       |
| OF-19 | DATA_MODEL §3 / PLAYBOOKS: `file_created` = an episode of the goal thread has files                     | No agent tool creates a file and `writeEpisode` never fills `episodes.files`, so the kind can never be met (OP-BOOKS, OP-MEET, OP-COMPARE without a sheet)                            | **Fixed 2026-10-22** (owner decision, options 1 + 3): OP-BOOKS, OP-MEET and OP-COMPARE without a sheet (v2) mark those lines `person_confirmed`; `file_created` is also met by the job's own report PDF (`loadEvidence` → `reports`). OG-03 now completes after the person's tick |

## 6. What makes Kriya different (honest version)

We don't claim competitors lack anything (track-A RG-9 rule). This is how
**Kriya** works:

1. **Authority is a contract you can read.** The mandate card says what
   Kriya may do without asking, how many times, to whom, until when, for how
   many rupees, and what it will never do. Revoke it with one tap.
2. **Done is computed, not narrated.** The verdict lists each criterion with
   its proof; anything not proven says "not confirmed".
3. **Indian work, end to end.** A receivables job goes: overdue invoice in
   the ledger → reminder drafts in Gmail → a phone call the person confirms →
   the customer's promised date recorded from the verified call outcome → a
   check on that date → the person marks it paid. All in rupees, IST and the
   person's language.
4. **Cost is visible.** Quotes from real past charges (K2), hard ₹ caps, a
   charge on every receipt.
5. **Works on a ₹10,000 phone.** Lite mode (K10), 360 px, text first.

## 7. Out of scope for track O (and why)

| Not built                                           | Why                                                                   | Revisit when                                   |
| --------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| Grants for R4 actions (posting, commenting, issues) | Public and hard to reverse; one mistake costs the person's reputation | After O10 with OM3 measured; a new decision    |
| Grants for phone calls                              | Voice D-09: the person confirms the exact call                        | Never in track O                               |
| GUI desktop VM / computer use                       | No measured need yet; large cost and attack surface                   | OD-08 trigger                                  |
| Payments, bookings, UPI, OTPs                       | R5 (AD-04)                                                            | Partner + PSP design + counsel; separate track |
| Push / SMS / WhatsApp / email notifications         | Voice rule 10, AD-20                                                  | Only if the owner changes rule 10              |
| Third-party connector directory, MCP, SDK           | Trust and review model not designed                                   | After O10                                      |
| New languages for speech                            | Voice phase 4                                                         | —                                              |

## 8. Glossary

| Term          | Meaning                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Mandate       | A person-approved job: objective, done criteria, scope, grants, deadline, budget, check-ins. One per goal |
| Grant         | Standing permission inside a mandate for one R2/R3 tool, with pinned targets, a use limit and an expiry   |
| Criterion     | One line of "done", with the evidence kind that proves it                                                 |
| Evidence kind | A fixed, code-checked kind of proof (`tool_verified`, `call_outcome`, `invoice_paid`, …; DATA_MODEL §3)   |
| Verdict       | Code's per-criterion result: `met` (with references) or `not_met`                                         |
| Playbook      | A versioned, code-defined job template (OP-COLLECT, …) that fills a mandate proposal                      |
| Check-in      | A scheduled run of the mandate's goal thread (an ordinary schedule)                                       |
| Needs person  | The mandate is stuck or blocked; it waits in the Inbox                                                    |
