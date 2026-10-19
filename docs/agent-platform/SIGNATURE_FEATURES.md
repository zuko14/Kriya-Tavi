# Signature features: what makes Kriya different

General assistants (ChatGPT, Grok, Gemini and others) compete on model
intelligence, and Kriya can't win that race. It rents the same models through
OpenRouter. Kriya competes on **trust, India-correctness and cost**: things a
person can check, in rupees, on a phone, grounded in Indian sources.

> **Honesty rule for this document.** We do not claim that a competitor lacks
> a feature. Their products change monthly, and none were re-checked here.
> Before any marketing claim, RG-9 (RESEARCH.md §6) compares the current
> products and records the date. What follows is how **Kriya** works,
> whatever others do.

Each feature has: the problem in real life, how it works, why it's cheap,
data, tests, and the phase. Decisions AD-27…AD-36.

| #   | Feature                  | One line                                                                                                                                             | Phase  | Decision |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| K1  | **Kriya Receipt**        | Every task ends with a tamper-evident receipt: what was done, the proof, what it cost in ₹                                                           | A3, A5 | AD-27    |
| K2  | **Quote and cap**        | See the likely ₹ cost before work starts; set a hard cap that's never crossed                                                                        | A3     | AD-28    |
| K3  | **Undo window**          | Reversible actions can be undone for 10 minutes, and the undo is verified                                                                            | A8     | AD-29    |
| K4  | **Kriya Radar**          | Deadlines and obligations (exams, GST, scholarships, renewals) found from official sources and your mail; reminders by phone                         | A13    | AD-30    |
| K5  | **Zero-token watchers**  | Watch any page; the model is called only when something actually changed                                                                             | A13    | AD-31    |
| K6  | **Public facts commons** | Verified public facts (an exam's last date, a GST due date) read once from the official source, reused by everyone                                   | A13    | AD-32    |
| K7  | **Cross-check**          | High-stakes answers (money, deadlines, eligibility) are checked against their quoted sources; anything unsupported is flagged                        | A3, A7 | AD-33    |
| K8  | **Kriya Share**          | Send your CA, parent or co-founder an expiring, read-only link to a report or receipt; they don't need an account and get no access to your accounts | A5     | AD-34    |
| K9  | **Ready-to-apply kits**  | For sites agents may not touch, everything prepared for a 2-minute apply, then checked                                                               | A6     | AD-35    |
| K10 | **Lite mode**            | Works on slow 2G/3G and cheap phones: smaller pages, no images by default, text-first                                                                | A2     | AD-36    |

## K1 Kriya Receipt (AD-27)

**Real life.** A founder asks "did my agent really send that invoice draft?".
A student's parent asks "what did this app do with my child's LinkedIn?".
People need a record they can trust and keep.

**How it works.**

1. At task end, the episode (AD-02, derived from verified executions) is
   canonicalised to JSON with sorted keys, no free model text. Its hash is
   `sha256(prev_hash ‖ canonical_episode)`, chained per user.
2. The chain is written under `pg_advisory_xact_lock(hashtext(user_id::text))`,
   so two tasks finishing at once can't fork it. Per-user `seq` is unique.
3. The receipt (thread card and PDF via AD-18) shows:
   - each verified action with its evidence;
   - unconfirmed claims;
   - the ₹ charge with its status (`final`, `estimated`, `unpriced`), from
     `kriya.charges`;
   - model ids and the time;
   - the chain hash.
4. **Verify** recomputes the chain from the person's episodes and reports the
   first mismatch. Records the person deleted show as a gap ("record n
   deleted by you on …"), not as tampering (DATA_MODEL §2.3).

**Honest limit, shown to the person:** the chain proves records weren't
changed **after** a receipt the person holds. It doesn't prove anything
against Kriya, the operator, unless the person keeps receipts. A downloaded
receipt PDF is their anchor. No email or push anchoring (AD-20).

**Cost:** no model call. **Data:** `episodes.seq`, `prev_hash`, `hash`,
`deleted_at` (DATA_MODEL §2.3). **Tests:** AT-RCP-01 (chain under
concurrency), AT-RCP-02 (edit detection; only the content-clearing delete is
allowed), AT-RCP-03 (no model text in the hashed body).

## K2 Quote and cap (AD-28)

**Real life.** A freelancer on ₹299 a month can't risk a surprise. Flat
subscriptions hide cost; Kriya shows it.

**What a "workflow" is.** A task started from a role-pack workflow (a
template suggestion, goal or schedule built from ROLE_PLAYBOOKS, e.g.
`FD-02`) or a skill carries `tasks.input.workflowId` (the code constant) or
`tasks.input.skillId`. These are new keys in the existing `input` jsonb, so
there is no column change. The ids are code constants or the person's own
skill ids, so aggregating over them exposes no content.

**How it works.**

- **Quote.** Before starting a goal, schedule, skill run or a task the person
  marks "big", Kriya shows p50 and p90 of `charges.charge_micro_inr` for
  earlier tasks with the same `skillId` (the person's own) or `workflowId`
  (the person's own history first, then all users').
  - Only rows with status `final` or `estimated` count, labelled as such.
  - With fewer than 10 samples it says **"No estimate yet"**. It never
    invents a number (invariant 6).
- **Cap.** The person sets a ₹ cap per task, schedule or goal (monthly).
  It's converted to `tasks.cost_budget_micro_usd` with the same
  owner-configured inputs `chargeTask` uses: the `fx.usdInr` setting and the
  plan's `markup_bps`.
  - Formula: `provider_micro_usd = cap_micro_inr × 10000 / markup_bps / fx`,
    in `BigInt` with floor rounding, by a new additive function in
    `lib/money.ts` with tests.
  - The budget used is `min(converted cap, plan max_task_cost_micro_usd)`.
  - If `fx.usdInr` isn't set, the plan's `max_task_cost_micro_usd` is used,
    and the UI says "₹ cap unavailable: exchange rate not configured".
- **Enforcement** is the existing mid-run budget stop (`run-task.ts`,
  `stop("budget")`), so there is no new enforcement code.
- A goal's monthly cap pauses its schedules when reached (`pause_reason =
'budget'`), checked at claim time in SQL.

**Cost:** one aggregate query. **Tests:** AT-QUO-01 (fewer than 10 samples →
no estimate), AT-QUO-02 (cap converted with the configured FX and markup,
enforced mid-run on the scripted model), AT-QUO-03 (goal cap pauses
schedules).

## K3 Undo window (AD-29)

**Real life.** "Oops, wrong date": an agent added a calendar invite that
emailed five people.

**How it works.** A tool that has a reliable reverse declares a `compensate`
function. The result records what's needed to reverse it (provider id) in
`tool_executions.undo`, with `undo_until = finished_at + 10 min`. **Undo** is
a person-initiated action. It runs the compensation in the worker, records
it as its own execution, verifies by read-back, and marks the original
`undone_at`. The receipt shows both.

| Tool                                  | Compensation                                           | Undoable                                       |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `calendar_create_event`               | Delete the event (attendees get Google's cancellation) | Yes, and the UI says invitees will be notified |
| `gmail_draft`                         | Delete the draft                                       | Yes                                            |
| `github_comment`, `github_label`      | Delete comment / remove label                          | Yes                                            |
| `github_create_issue`                 | Close it (can't be deleted by most users)              | Partly; shown as "Close"                       |
| `sheets_append`                       | Not offered: rows may have shifted                     | No                                             |
| `instagram_publish`, `youtube_upload` | Only if the API supports deletion (RG-10)              | Unknown until verified                         |
| Browser commits                       | None                                                   | No                                             |

The phase is A8, because the compensations for calendar and Gmail need
`lib/connectors.ts`, which is protected and is opened once, with approval,
in A8. **Tests:** AT-UNDO-01 (only within the window), AT-UNDO-02 (verified
by read-back), AT-UNDO-03 (non-undoable tools show no button).

## K4 Kriya Radar (AD-30)

**Real life.** India runs on deadlines nobody tracks well: JEE/NEET/GATE
registration windows, scholarship last dates, GSTR-3B and TDS due dates,
advance tax, ITR, insurance and vehicle renewals, rent and fee dates. Missing
one costs money or a year.

**How it works.**

1. **Obligation templates per role pack** (`lib/radar/templates.ts`) say
   **where to look**, never the date. Example:
   `{ kind: "gst_return", source: "official", domains: ["gst.gov.in",
"cbic-gst.gov.in"], appliesIf: "profile.gstin set" }`. Dates are never
   hard-coded or remembered.
2. **Sources.** Official pages via watchers (K5) and the commons (K6); the
   person's Gmail (renewal notices, fee mails) when connected; things the
   person tells an agent.
3. Each found obligation is a row in `kriya.obligations` with:
   - the due date, and the exact quote it came from;
   - the source URL (or Gmail message id) and when it was read;
   - its status;
   - lead times (default 7 days and 1 day before).
4. A date is shown only with its quote and source. If the quote isn't found
   verbatim in the fetched text (K7 deterministic check), the obligation has
   `verified = false` and says so.
5. **Reminders** are phone calls through the voice track (D-07, AD-20) once
   it ships. Until then they appear on Home and in the Inbox. Never push, SMS,
   WhatsApp or email.

**Cost:** mostly zero-token (K5); one budget-tier extraction per changed page.
**Tests:** AT-RAD-01 (no date without a verbatim quote), AT-RAD-02 (lead
times in IST across month ends), AT-RAD-03 (templates contain no dates,
static check), AT-RAD-04 (reminder routes only to voice or in-app).

## K5 Zero-token watchers (AD-31)

**Real life.** "Tell me when the GATE notice board changes", "when this
internship page opens", "when the price drops below ₹40,000". Asking a model
every hour to look is slow and expensive.

**How it works.** A schedule of `kind = 'watch'` with `watch = { url,
selector?, condition? }`:

1. Fetch (Firecrawl through `lib/web.ts`, or `kriya-browser` read-only for
   pages that need JavaScript, A4).
2. Normalise: extract the selector or main text, strip dates and counters
   by known patterns, collapse whitespace.
3. Hash (sha256) and compare with `watch_state.last_hash`.
4. **Unchanged → done. No model call, no task, no thread message.** Only
   `watch_state.checked_at` updates.
5. Changed → a task gets only the **diff** (capped) and the condition. The
   model decides whether it matters, and the episode stores before/after
   snippets as evidence.

The fetch step runs in the worker's scheduler loop before any task exists, so
an unchanged page never touches `kriya.tasks`. Minimum interval:
`plans.min_schedule_interval_minutes` (Free: daily). Fetch costs (Firecrawl
credits, browser seconds) go to `resource_usage`, so "zero-token" is never
sold as "zero-cost".

**Tests:** AT-WAT-01 (unchanged page → 0 model calls, 0 tasks), AT-WAT-02
(counter-only change ignored), AT-WAT-03 (diff capped and marked untrusted).
**Metric W1:** model calls per watcher-day on unchanged pages = 0.

## K6 Public facts commons (AD-32)

**Real life.** Thousands of students ask "when does GATE registration
close?". Fetching and reading the same official page for each of them wastes
tokens, fetches and time.

**How it works.** `kriya.public_facts` (no `user_id`, no personal data):
`key` (e.g. `exam.gate.2027.registration_close`), `value`, `quote`,
`source_url`, `fetched_at`, `expires_at`, `confirmations`.

A fact is written only when all of these hold:

1. The source domain is on the allow-list table `kriya.fact_sources`:
   seeded by migration, changed only through an audited owner action, and
   enforced by a trigger on `public_facts` (DATA_MODEL §2.11). It contains
   official domains only (`*.gov.in`, `*.nic.in`, exam authorities,
   CBIC/GSTN).
2. The fetch came from a watcher or a dedicated fact job, **never** from a
   user's private context or a user-supplied URL.
3. The quote appears verbatim in the fetched text (deterministic).
4. Two fetches at least 1 hour apart agree (`confirmations ≥ 2`), before the
   fact is served to anyone.

Agents read facts through `facts_lookup(key | query)`. The answer always shows
"read from <source> on <date>". Expired or retracted facts aren't served. The
owner console lists facts and can retract one, and retraction is audited.

**Why it's safe:** there is no personal data, the sources are official only,
and a fact is a quote plus a URL anyone can check. Poisoning would need the
official site itself to be wrong.

**Tests:** AT-FCT-01 (non-allow-listed domain rejected by the trigger),
AT-FCT-02 (quote must be verbatim), AT-FCT-03 (needs 2 confirmations),
AT-FCT-04 (no write path from a user task's tool results). **Metric F1:**
wrong facts served = 0 on the AS-FCT suite.

## K7 Cross-check (AD-33)

**Real life.** A wrong scholarship deadline or a wrong GST figure is worse
than no answer.

**How it works, cheapest first:**

1. **Deterministic citation check (free, A3).** In flagged outputs, every
   claim must carry a citation `[n]` with a short quote. `lib/agent/verify.ts`
   checks that the quote appears verbatim in the stored output of the cited
   tool call (`web_fetch`, `drive_read`, `file_read`, `facts_lookup`), read
   from the saved message parts, which keep tool outputs whole. Missing or
   not found → **unsupported** chip on that sentence. The reply isn't
   rewritten.
2. **Model cross-check (A7, only when step 1 can't decide, e.g.
   arithmetic in prose or a paraphrase).** A budget-tier model, preferably
   from a different provider family than the one that answered, gets only
   the claim and the cited text. It answers `supported`, `contradicted` or
   `not_found`. It runs as a maintenance job, with the cost in
   `resource_usage`.
3. **Money is never cross-checked by a model.** It is computed (AD-16).

**Flagged outputs:** replies containing ₹ amounts or dates in a deadline
context, eligibility statements, and anything going into a document or an
external draft. A role pack can flag more.

**Tests:** AT-XCK-01 (fabricated quote → unsupported), AT-XCK-02 (model
cross-check runs only when the deterministic check is inconclusive).
**Metric X1:** unsupported claims marked = 100 % on the AS-XCK suite.

## K8 Kriya Share (AD-34)

**Real life.** The founder's CA wants the quarter's bills; a parent wants to
see the study plan's progress. Today people forward screenshots on WhatsApp.

**How it works.**

- The person picks a receipt, a report, a goal snapshot or a ledger period
  export, and chooses an expiry (1–30 days, default 7).
- Kriya renders a **snapshot** (PDF + listed files) at that moment and
  creates `kriya.share_links` with `token_hash` (sha256 of 32 random bytes;
  the token is shown once in the link).
- `/share/[token]` serves the snapshot read-only: no account, no live data,
  no access to the person's accounts. It's rate-limited, `noindex`, and sends
  `Referrer-Policy: no-referrer`.
- Views are logged (count, time, IP hash). The person can revoke at any time;
  files are served through 60 s signed URLs.
- Creating a share is an explicit person action with a confirmation that
  names what's shared (DPDP: the person's decision about their own data).
  No agent tool creates shares.

**Tests:** AT-SHR-01 (expired or revoked → 404 without detail), AT-SHR-02
(token stored only hashed), AT-SHR-03 (snapshot doesn't change when the
source changes), AT-SHR-04 (no agent tool can create a share).

## K9 Ready-to-apply kits (AD-35)

**Real life.** On LinkedIn, Upwork, Naukri and government portals, agents
must not click Save or Submit (AD-06). That shouldn't mean "do it all
yourself".

**How it works.** For each target page the kit has:

- the deep link to the exact form;
- copy blocks in field order, each with a **Copy** button and the field's
  name as the site labels it;
- the site's current length limits (read at run time);
- a checklist;
- an **"I've applied it"** button that triggers a read-only check of the
  public result (verified line on the receipt).

It works in the person's own browser too, without a login profile.

**Cost:** one drafting task. **Tests:** AT-KIT-01 (kit fields within the
limits read), AT-KIT-02 (post-apply check marks verified only when the page
shows the text).

## K10 Lite mode (AD-36)

**Real life.** Many users are on prepaid data, slow networks and entry-level
Android phones.

**How it works.**

- A per-person setting (`profiles.lite_mode`, with a column grant like the
  other profile fields), and the default when `navigator.connection.saveData`
  is true.
- Polling backs off (thread 350 ms → 1.5 s; tabs 3 s → 10 s).
- No live view frames unless the person opens them; screenshots load on tap.
- Fonts fall back to the system font.
- Images in replies are click-to-load.

There are no new dependencies. **Tests:** AT-LITE-01 (setting honoured;
polling intervals), plus a 360 px check on a throttled profile. Page-weight
numbers are recorded in `status.md`.

## How the features fit the architecture

None of them adds a service. They use the policy engine, episodes, schedules,
`kriya-browser` (PDFs and read-only fetches), the voice track for reminders,
and integer money.

- New tables: `obligations`, `watch_state`, `public_facts`, `fact_sources`,
  `share_links`, `share_views` (DATA_MODEL §2.11).
- New columns:
  - episodes and `tool_executions` (`verification` in A3; `undo`,
    `undo_until`, `undone_at` in A8): DATA_MODEL §2.3;
  - `profiles.lite_mode` (A2).
- New `tasks.input` keys: `workflowId`, `skillId`, `channel`, `scheduleId`.
