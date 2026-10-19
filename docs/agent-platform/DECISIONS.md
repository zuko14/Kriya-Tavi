# Kriya Tavi agent platform: architecture decisions

Each decision has an id (`AD-nn`) that the other documents and `status.md`
refer to. Status is **Proposed** until the owner approves it. A coding agent
must not start a phase whose decisions are still Proposed unless that approval
is recorded under "Owner approvals" in `status.md`.

Written 2026-10-17 from the repository at commit `bdf223f` (82 tests passing)
and the research in `RESEARCH.md`. Voice decisions (`D-nn`) are separate and
live in `docs/voice-assistant/DECISIONS.md`. Where the two tracks meet, both
apply.

| Id    | Decision                                                                                                                                   | Status   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| AD-01 | Extend Kriya's own runtime (tasks, worker, tools, squads); no external agent framework                                                     | Proposed |
| AD-02 | "Verified action": what Kriya says it did comes from evidence, never from model text alone                                                 | Proposed |
| AD-03 | Six risk classes R0–R5 with a deterministic policy engine; R5 actions don't exist as tools                                                 | Proposed |
| AD-04 | Agents never handle passwords, OTPs, CAPTCHAs, payments or identity documents; the person takes over                                       | Proposed |
| AD-05 | Login profiles = sealed browser session state (cookies + storage); amends AGENTS.md invariant 4                                            | Proposed |
| AD-06 | Per-site automation mode (`api`, `supervised`, `assisted`, `blocked`); conservative defaults; LinkedIn is `assisted`                       | Proposed |
| AD-07 | Official APIs first; the browser only where no API fits                                                                                    | Proposed |
| AD-08 | Self-hosted Playwright service `kriya-browser` behind a provider interface; one Chromium process per session; egress guard                 | Proposed |
| AD-09 | Memory v2 in Postgres with full-text search first; embeddings only when the eval shows a recall gap                                        | Proposed |
| AD-10 | The acting agent reconciles memory writes; a background job consolidates; history is kept, never overwritten                               | Proposed |
| AD-11 | Memory written after untrusted content was read is quarantined until the person confirms it                                                | Proposed |
| AD-12 | Prompt laid out stable → semi-stable → volatile for provider prompt caching; every block has a token budget                                | Proposed |
| AD-13 | Thread summaries and episode summaries run after the turn, on the budget tier                                                              | Proposed |
| AD-14 | Role packs are data (templates + tool loadouts), not code paths; one engine for every role                                                 | Proposed |
| AD-15 | Goals and schedules enqueue ordinary tasks in their own threads; background work pauses on approvals                                       | Proposed |
| AD-16 | Money is computed by code only; models extract, code sums, taxes and reconciles; mismatch → person                                         | Proposed |
| AD-17 | Invoice numbers are gapless per financial-year series through a locked counter row                                                         | Proposed |
| AD-18 | PDFs are rendered by Chromium in `kriya-browser` from HTML templates; no PDF library                                                       | Proposed |
| AD-19 | Files live in a private Supabase Storage bucket under the user's id; extraction runs in the worker                                         | Proposed |
| AD-20 | Reminder channel: anything the person asks to be reminded of is a phone call (voice D-07); approvals use the existing in-app notifier only | Proposed |
| AD-21 | Skills: a successful run saved as a versioned procedure the person approves; replay deterministic first, model only on divergence          | Proposed |
| AD-22 | Phase order: memory and the browser on fixture sites before logins; real sites only in a controlled pilot                                  | Proposed |
| AD-23 | Every automated browser test runs against local fixture sites; no real site in `npm test`                                                  | Proposed |
| AD-24 | Running the person's code (developer sandbox) is deferred until a microVM provider is chosen                                               | Proposed |
| AD-25 | Improvement is governed (same rules as voice D-17); production never tunes itself                                                          | Proposed |
| AD-26 | Memory has two scopes: shared (all the person's agents) and agent-private                                                                  | Proposed |
| AD-27 | K1 Kriya Receipt: per-user hash-chained, immutable episodes with ₹ cost and evidence                                                       | Proposed |
| AD-28 | K2 Quote and cap: ₹ estimates only from real charge history (≥ 10 samples); caps enforced by the existing task budget                      | Proposed |
| AD-29 | K3 Undo window: compensating actions for reversible tools, 10 minutes, verified by read-back                                               | Proposed |
| AD-30 | K4 Kriya Radar: obligations only with a verbatim quote and source; templates say where to look, never dates                                | Proposed |
| AD-31 | K5 Zero-token watchers: deterministic fetch–normalise–hash; the model sees only diffs                                                      | Proposed |
| AD-32 | K6 Public facts commons: no personal data, allow-listed official domains, verbatim quotes, two confirmations                               | Proposed |
| AD-33 | K7 Cross-check: deterministic citation-quote check first, cheap model only when inconclusive, never for money                              | Proposed |
| AD-34 | K8 Kriya Share: person-created, expiring, revocable read-only snapshots; tokens stored hashed                                              | Proposed |
| AD-35 | K9 Ready-to-apply kits for `assisted` sites, verified after the person applies                                                             | Proposed |
| AD-36 | K10 Lite mode for slow networks and low-end phones; no new dependency                                                                      | Proposed |

---

## AD-01 Extend Kriya's own runtime

**Decision.** Build every new capability on the existing core: `kriya.tasks`
and the worker's claim/lease/recover loop, `lib/agent/run-task.ts`, the tool
belt in `lib/agent/tools.ts`, AI SDK 7 tool approvals, squads (`delegate`,
`assign`) and metering. Don't adopt LangGraph, CrewAI, AutoGen, browser-use
(Python) or a hosted "agent OS" as the runtime.

**Why.** The core already gives durable execution, approval pauses that resume
in the worker (`enqueueApproval`, `lib/agent/queue.ts:208`), no blind retries
after side effects (`kriya.recover_tasks`), per-call usage and per-task
charges, and RLS for everything done on a person's behalf. A framework would
duplicate these and sit outside the tenancy model.

**Consequence.** New capabilities arrive as tools, tables, a scheduler loop
and one new service (`kriya-browser`). Libraries may be used inside a tool
(Playwright inside `kriya-browser`), never as the orchestrator.

## AD-02 Verified action

**Decision.** The "What I did" record for a task is built by code from
`kriya.tool_executions` (succeeded, side-effecting or producing a document)
plus their evidence (API read-back, screenshot, file). The model's prose is
shown as the reply but never becomes an accomplishment entry. A claim like
"I updated your profile" without a matching verified execution is shown
as unverified.

**Why.** The product's promise (`package.json`: "AI that acts, and proves it
acted right") and AGENTS.md's honesty rules. Models sometimes claim actions
they didn't take. Deriving the record from executions removes that failure
from what the person sees as done.

**Consequence.** Every side-effect tool returns a `verification` object
(TOOLS_AND_CONTRACTS.md §1). `kriya.episodes` stores the derived record
(DATA_MODEL §2).

## AD-03 Risk classes and a deterministic policy engine

**Decision.** Every tool call, and every browser action, is classified by
code (never by the model) into:

| Class | Meaning                       | Examples                                                                                                                                | Gate                                                                                                          |
| ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R0    | Read                          | web search, read a page, read mail, list ledger                                                                                         | None (existing exfiltration guard still applies)                                                              |
| R1    | Internal write, reversible    | memory, goal notes, draft ledger entries, draft invoice                                                                                 | None; visible and undoable                                                                                    |
| R2    | Internal, consequential       | create a schedule (spends money later), issue an invoice number, approve a skill                                                        | Approval per call                                                                                             |
| R3    | External, private, reversible | calendar event, Gmail draft, fill a form field without submitting                                                                       | Approval per call (today's rule)                                                                              |
| R4    | External, public or binding   | submit a form, save a profile, publish a post, send a message, apply for a job, create a GitHub issue                                   | Approval per call with preview + before screenshot; never covered by a standing approval in the first release |
| R5    | Forbidden                     | pay, enter a password/OTP/CAPTCHA, upload identity documents, file a tax return, delete an account, accept terms on the person's behalf | Not available as a tool; the person takes over                                                                |

`lib/agent/policy.ts` is the only place the class is decided.
`SIDE_EFFECT_TOOLS` keeps its current meaning (R3 and R4 tools are in it).

**Why.** AGENTS.md invariant 5, and prompt injection: a page can talk a model
into anything, but it can't change code that classifies the click.

## AD-04 Agents never handle secrets of the person

**Decision.** No tool types into a password, OTP or card field, solves a
CAPTCHA or reads an OTP out of mail to type it. When a step needs one,
the agent calls `browser_handoff` and the person does that step in the live
view (BROWSER_AND_LOGIN_PROFILES.md §5). Kriya never creates, stores or sees a
site password. When the person signs up for a site, the UI can suggest a
strong password generated **in their own browser**
(`crypto.getRandomValues`). It is never sent to Kriya, and they save it in
their password manager.

**Why.** Invariant 4. Credential theft and account takeover are the worst
outcomes for a personal agent. CAPTCHAs exist to stop exactly this automation.

**Consequence.** "Create my LinkedIn account" works like this: the agent
prepares every detail, opens the sign-up page in the live view, and the person
types the password and verification code. Then the session is saved as a
login profile (AD-05).

## AD-05 Login profiles

**Decision.** A login profile is the browser storage state (cookies,
localStorage, IndexedDB origins) for one site after the person signed in. It
is stored in `kriya.login_profiles.state_sealed` as AES-256-GCM ciphertext
from `lib/secrets.ts` (`seal(state, "<user id>:login:<profile id>")`). It is
never selectable by the person's session, is opened only in
`lib/browser/profiles.ts` in the worker, and is passed to `kriya-browser` for
one session. After the session, the refreshed state comes back and the worker
seals it again.

**Requires** amending AGENTS.md invariant 4, which today allows only connector
OAuth tokens. Proposed wording is in CHANGE_IMPACT_AND_SAFETY.md §7. Phase A6
can't start until the owner approves this decision and the amendment.

**Why.** A session is as powerful as a password for that site, so it gets the
same protection as OAuth tokens. Storing the session, not the password, means
the person can revoke it by signing out of the site, and Kriya never learns
the password.

## AD-06 Per-site automation mode

**Decision.** `lib/browser/sites.ts` holds a reviewed registry by registrable
domain:

| Mode         | The agent may                                                                                                                                            | Default for                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api`        | Use the official API connector; the browser only reads public pages                                                                                      | Google, Notion, GitHub, YouTube, Instagram (professional accounts)                                    |
| `supervised` | Navigate, read and fill; every R4 commit needs approval with screenshots                                                                                 | Sites whose terms allow it (none assumed; each added after a terms review recorded in RESEARCH.md §4) |
| `assisted`   | Read and prepare. The person applies the result: Kriya opens the exact page, shows copy-ready text, and checks the result afterwards by reading the page | LinkedIn, Upwork, Naukri, Internshala, government portals, banks                                      |
| `blocked`    | Nothing                                                                                                                                                  | Payment pages, net banking, sites that forbid automated access outright                               |

Unknown domains default to read-only (R0). Never: scraping other people's
profiles, mass actions (bulk connect, bulk apply, bulk message), fake
engagement, or evading bot detection (no stealth plugins, no fingerprint
spoofing, no CAPTCHA services).

**Why.** LinkedIn's User Agreement §8.2 prohibits bots and unauthorized
automated methods for accessing the service, messaging and posting, and
LinkedIn restricts accounts for it. Upwork's terms reportedly require a human
to confirm proposals (RESEARCH.md §4; to be verified). Losing a student's
LinkedIn account would hurt them more than the convenience helps. Moving a
site from `assisted` to `supervised` needs a recorded terms review and the
owner's approval (blocker AB-04).

## AD-07 Official APIs first

**Decision.** For any task, prefer, in order: (1) a Kriya connector over an
official API, (2) the browser in the site's mode, (3) a draft the person
applies. New connectors (A8): GitHub, Google Sheets write, YouTube Data API,
Instagram Graph API (professional accounts), Google Business Profile (later).

**Why.** APIs are within the site's terms, structured (cheaper in tokens,
verifiable by read-back) and stable. Browser flows break when a page changes.

## AD-08 `kriya-browser`, self-hosted, behind an interface

**Decision.** A new service, `kriya-browser`: Node + Playwright
(`playwright-core`) + Debian Chromium in Docker. Rules:

- No database credentials, no Kriya secrets except `KRIYA_BROWSER_SECRET`.
- One Chromium **process** per session, sandbox on (`--no-sandbox`
  forbidden), non-root.
- An egress guard that refuses private, loopback, link-local and metadata
  addresses at connect time.
- Sessions capped in time and number.

The worker drives it through `lib/browser/provider.ts`. A managed vendor
(Browserbase, Steel, Anchor) may be added later as a second adapter of the same
interface, after the A10 benchmark.

**Why.** Session state stays sealed under Kriya's key instead of sitting at a
vendor. Tests can run locally against fixtures. The existing `workstation/`
image shows Chromium in Docker already works here. The interface keeps the
vendor option open if self-hosting can't meet capacity or reliability.

**Unknowns** (verify in A4, record in `status.md`): sessions per instance on
the chosen Render plan, memory per session, whether Render private services
allow Chromium's sandbox (user namespaces), and cold-start time.

## AD-09 Memory in Postgres, full-text first

**Decision.** Memory v2 (MEMORY_AND_CONTEXT.md) uses typed rows in `kriya`
with a generated `tsvector` (config `simple`, so romanised Hindi and Telugu
aren't stemmed wrongly) and ranked retrieval. Embeddings (pgvector +
OpenRouter `/embeddings`) are a conditional step in A9, taken only if the
memory eval's recall@5 is below 0.90 on the AS-MEM set.

**Why.** No new extension or dependency: the tests use PGlite 0.5.10, whose
package has no `vector` export (checked 2026-10-17), and DATA_MODEL rule F3
forbids extensions in migrations. A person's memory is hundreds to a few
thousand short notes, where keyword plus structure plus recency usually
works well. Measuring first avoids paying embedding cost for no gain.

## AD-10 Reconciled writes, consolidation, history kept

**Decision.** `memory_write` returns up to three similar existing notes with
their ids, and the agent decides then and there: keep both, or call
`memory_update` to supersede one. This costs no extra model call. A nightly
job (worker janitor) merges exact and near duplicates on the budget tier and
proposes merges of conflicting notes to the person. A superseded note is
never deleted. It gets `invalid_at` and `superseded_by`, so "what did I
prefer before?" stays answerable, and the person can roll back.

## AD-11 Quarantine for memory from untrusted turns

**Decision.** If a turn has seen untrusted content (web, mail, documents,
browser pages) before `memory_write`, the note is saved with
`trust = 'unconfirmed'`. Such a note is retrievable (marked "unconfirmed") but
never part of the always-loaded block. The person confirms or deletes it in
"New memories to review".

**Why.** It closes known risk 6 in `docs/kriya/security.md` (prompt injection
into memory).

## AD-12 Cache-friendly prompt with budgets

**Decision.** `buildInstructions` orders sections as follows:

1. Stable: identity, role pack, standing orders, capabilities, rules.
2. Semi-stable: profile and pinned memory.
3. Volatile: today's date, goals, retrieved memory, episode recall.

Each block has a token budget (MEMORY_AND_CONTEXT.md §5). Tool definitions are
filtered per role pack and connection, as connectors are today.

**Why.** Per OpenRouter's documentation (RESEARCH.md §3), OpenAI, DeepSeek and
Gemini cache matching prefixes automatically, and Anthropic needs
`cache_control`. A prefix that changes every day (today's date currently sits
mid-prompt in "How you work") defeats caching. `usage_events.cached_tokens`
already records hits, so the effect is measurable.

## AD-13 Summaries off the critical path

**Decision.** After a task ends, the worker may insert a
`kriya.maintenance_jobs` row, run by its own worker loop on the budget tier.
Jobs write the thread summary checkpoint when the thread is over its budget,
and the episode summary.

They are **not** `kriya.tasks` rows: a task would take the thread's single
active slot and refuse the person's next message (AF-12). Model usage goes to
`resource_usage` (`maintenance_model`) as a platform cost, not a customer
charge, capped per user per day (`agents.maintenanceCapMicroUsd`). The
protected `lib/agent/metering.ts` is untouched.

## AD-14 Role packs are data

**Decision.** `lib/templates.ts` grows into role packs. Each pack is a set of
agent templates (name, role, instructions, suggestions), a recommended squad,
a tool loadout, the profile slots to collect, and starter goals. Onboarding by
use case (`profiles.use_case`) offers the pack. Templates with a pack become
a squad ("your team"). The engine is the same for every role.

## AD-15 Goals and schedules enqueue ordinary tasks

**Decision.** A goal has its own thread. A schedule fires in two steps:

1. SQL `kriya.claim_due_schedules()` claims due runs.
2. The worker calls `enqueueScheduled()` in `lib/agent/queue.ts`, which
   writes the prompt as a `user` message (metadata `channel: "schedule"`)
   and a normal `kriya.tasks` row through the same `prepare()` checks every
   turn uses. Plan, tier and limit logic isn't duplicated in SQL (AF-11).

The existing one-active-task-per-thread index makes overlapping fires
impossible: a fire that finds an active task is skipped and recorded. A
background run that needs approval ends waiting, as today, and appears in the
Approval inbox. Approvals expire (default 72 h). An expired approval is
rewritten as declined in its message part, no task is enqueued, and
`enqueueApproval` refuses it afterwards (AF-14).

## AD-16 Money by code

**Decision.** Models extract fields from bills (vendor, GSTIN, invoice number,
date, line items, tax lines, total) into a zod schema. `lib/ledger.ts`
computes every sum, every tax, and the reconciliation (sum of lines + taxes =
stated total, within 1 rupee for rounding) in integer paise. A mismatch,
missing GSTIN on a claimed tax, or extraction confidence below the threshold
marks the entry `needs_review` for the person. The agent is not a Chartered
Accountant: it organises, summarises and drafts. It never files returns,
never pays, and its reports say "prepared by Kriya, review with your CA".

## AD-17 Gapless invoice numbers

**Decision.** `kriya.invoice_series (user_id, series, fy, next_number)` is
locked `for update` in the same transaction that issues an invoice, giving
consecutive numbers per series and financial year (GST rule: unique,
consecutive, at most 16 characters; verify the exact rule text in A7).
Draft invoices have no number. A void invoice keeps its number.

## AD-18 PDFs via Chromium

**Decision.** Reports, invoices, resumes and media kits are HTML templates
(`lib/documents/templates/*`) with Kriya tokens and Indian formatting. They
are rendered to PDF by `kriya-browser` (`page.pdf()`) in a session with no
network access, then stored as a file.

**Why.** No new dependency, typography the app already has, one renderer.

## AD-19 Files

**Decision.** A private Supabase Storage bucket `kriya-files`, object path
`<user id>/<file id>`. Uploads go through a signed upload URL from a server
action, with size and type limits. Metadata lives in `kriya.files` (RLS).
Extraction (PDF text, images through a vision-capable model, CSV) runs in the
worker. Uploaded files are untrusted content. Executables and archives are
rejected.

## AD-20 Reminder channel

**Decision.** Anything the person asks to be reminded of (deadlines, bills due,
exam dates) becomes a voice owner reminder: a phone call, per voice D-07 and
AGENTS.md voice rule 10, once that track ships. Until then it is shown only
in Kriya (Home, Inbox). Approval requests and finished background work use
the existing in-app notifier exactly as task replies do today
(`components/workspace/notifier.tsx`: names the agent, never the content). No
push, SMS, WhatsApp or email is added.

## AD-21 Skills

**Decision.** A finished task can be saved as a skill: its tool-call sequence
with parameters turned into named slots, the site and mode, and the
acceptance check. The person approves each version. Replay runs the steps
deterministically (browser actions by stable locators, connector calls by
schema). The model is called only when a step's precondition fails (page
changed) or a slot needs judgement. A skill can never raise a step's risk
class, and approval rules apply on replay as on the original run.

**Why.** It cuts tokens for repeated work, makes routine tasks repeatable, and
makes them auditable.

## AD-22 Phase order

**Decision.** A1 memory → A2 role packs → A3 goals/schedules/inbox, in parallel
with A4 browser on fixtures → A5 files and documents → A6 login profiles →
A7 accounts → A8 connectors → A9 skills → A10 live pilot → A11 readiness →
A12 improvement. Rationale in IMPLEMENTATION_PLAN.md §1.

## AD-23 Fixture sites

**Decision.** `tests/fixtures/sites/` holds small static sites served on an
ephemeral port during tests. They include sign-up, profile editor, job
application, a bill portal, an infinite-scroll feed, a page with an embedded
prompt injection, and a page that redirects to a private IP. Every browser
behaviour is proven there. Real sites are touched only in A10, by the owner,
with test accounts.

## AD-24 Developer sandbox deferred

**Decision.** No tool runs the person's code in this plan. Developers get
GitHub (A8), research, reviews by reading, and drafts of PRs that the person
approves. A code sandbox needs a per-run microVM provider (to be chosen after
a separate assessment); Render services must never run user code.

## AD-25 Governed improvement

**Decision.** The voice track's SELF_IMPROVEMENT.md model applies. Signals and
cases become regression scenarios, then candidate prompt or policy versions,
then an offline gate, shadow, canary and rollout, with rollback. Risk classes,
site modes, R5 rules, limits and quarantine rules are never tuned by it.

## AD-26 Memory scopes

**Decision.** `kriya.memories.agent_id` becomes nullable. Null means shared by
all of the person's agents (profile facts, preferences about them); non-null
means private to one agent, as today. The person sees shared memory under
"About you" in Account, and agent memory on the agent as today.

## AD-27 … AD-36 Signature features

Designed in full in `SIGNATURE_FEATURES.md` (K1–K10). One sentence each:

- **AD-27 (K1)** Episodes are hash-chained per user and immutable except for
  the person's content-clearing delete; the receipt shows evidence and the
  ₹ charge status from `kriya.charges`.
- **AD-28 (K2)** Quotes come only from real `charges` rows (≥ 10 samples,
  else "No estimate yet"); ₹ caps convert with the owner's configured FX
  rate into the existing `cost_budget_micro_usd`, so enforcement reuses the
  current mid-run budget stop.
- **AD-29 (K3)** Only tools with a reliable reverse get Undo; done in A8,
  when `lib/connectors.ts` is opened once with approval.
- **AD-30 (K4)** No obligation without a verbatim quote and source; reminders
  only by phone (voice) or in-app (AD-20).
- **AD-31 (K5)** Unchanged pages cost no model call and no task; fetch costs
  are still metered in `resource_usage`.
- **AD-32 (K6)** Shared facts have no `user_id`, come only from domains in
  `kriya.fact_sources` via the fact job (never from a user's task), and need
  two agreeing fetches before anyone else sees them.
- **AD-33 (K7)** Citation quotes are checked verbatim by code; a model checks
  only when code can't decide; money is never model-checked (AD-16).
- **AD-34 (K8)** Shares are created by the person only (no tool), expire in
  ≤ 30 days, are revocable, served as snapshots, tokens stored as sha256.
- **AD-35 (K9)** Kits are the `assisted` mode's output: deep links, copy
  blocks, limits read at run time, and a post-apply read-only check.
- **AD-36 (K10)** Lite mode changes polling, media loading and fonts only.
