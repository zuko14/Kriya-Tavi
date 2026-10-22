# Kriya Tavi — Product Strategy, Agent Architecture & Upgrade Roadmap

**Prepared:** 21 October 2026  
**Basis:** The nine supplied Kriya Tavi audit files, plus a current review of official Meta Muse, OpenAI ChatGPT agent, Anthropic computer-use, BHASHINI and Sarvam documentation.  
**Purpose:** Move from a technically strong agent codebase toward a dependable India-first platform that executes useful work on a user's behalf and proves what happened.

---

## 1. Executive decision

**Do not rebuild Kriya Tavi as another generic chatbot. Do not start by trying to match every feature in every global agent.** Build Kriya as an **India-first action platform**: people state an outcome, the system plans the work, chooses the safest available capability, asks for approval when required, executes across apps/browser/voice, verifies the result, and returns an evidence-backed receipt.

The audit indicates that Kriya already has substantial foundations: a durable multi-step task runner, long-term scoped memory, recurring schedules/watchers, a supervised Playwright browser service, a separate voice service, tenant-level database policies, a deterministic R0–R5 risk system, rupee-native accounting, GST/invoicing and outbound-call logic. The immediate gap is not simply a lack of code. It is the distance between a tested architecture and a **production-verified end-to-end product**: browser execution is mainly proven on fixture sites, live browser takeover still needs deployment, real telephony is gated, and several OAuth and billing integrations are not live.

### Recommended product thesis

> **Kriya gets Indian work done, safely, in the user's language, and shows proof of completion.**

A defensible initial wedge is the **personal and small-business operator**—especially workflows involving Indian vendors, invoices, follow-ups, schedules, phone calls, and online research. This wedge builds on existing code instead of chasing a broad consumer booking marketplace before provider access is secured.

“India’s first” is a market-superlative claim that the audit does not prove. Position the company as **India-first** now; only claim “first” after systematic competitor, launch-date, and legal review.

---

## 2. What Kriya Tavi has today

| Area | Evidence in the audit pack | Practical interpretation |
|---|---|---|
| Core agent runner | Multi-turn tool loop, step/cost budgets, cancellation, leases, heartbeat and crash recovery are reported tested | A foundation for long-running delegated tasks already exists |
| Task persistence | Postgres queue, atomic task claiming, event records, retry/recovery | Tasks can survive worker restarts more reliably than an in-memory prototype |
| Memory | Typed/scoped memory, retrieval, sensitive-value redaction and summarization logic | Foundation for personalization and persistent goals; validate that summary maintenance works in the default test environment |
| Browser execution | Isolated Chromium + Playwright, strict egress proxy, encrypted browser profiles, fixture-site tests | This is **supervised browser use**, not yet a general-purpose persistent desktop computer per agent |
| Live browser control | Local live-view/token work exists; public `wss://` deployment remains to be validated | Human takeover should be completed before broader production use |
| Voice | Dedicated WebSocket media service, streaming dialogue logic, interruptions/barge-in, structured outcome extraction, mock fault tests | The dialogue system is substantially built; live carrier performance and credentials are unverified |
| Outbound phone tasks | Exotel adapter and call workflows exist; live calls are disabled pending account, KYC and telecom/legal gates | Do not market real-world calling as generally available until a real controlled test succeeds |
| India business workflows | Ledger, GST calculations/checks, invoice numbering and rupee-native integer accounting | One of the strongest potential differentiators—extend into end-to-end business workflows rather than isolated utilities |
| Integrations | GitHub connector and undo window reported verified; Google and Meta connector code exists but is not production-verified | Complete existing connectors before adding a large plugin catalogue |
| Schedules and watchers | Cron schedules/watchers and unchanged-watch zero-token behavior reported tested | Build price, deadline, invoice and follow-up monitors on top of the existing foundation |
| Security | RLS across 70 tables, encrypted tokens/browser state, egress isolation, deterministic risk policy and approvals reported by the audit | Strong foundations; continue adversarial testing as capabilities become more powerful |
| UI | Mobile-first responsive UI, tool-call timeline, evidence/memory chips, call approval card and rupee pricing | Retain the mobile-first design; make task plans, approvals, live status and proof central to the workspace |
| Billing/operations | Model metering, usage reconciliation and owner dashboards exist; live merchant/payment and FX configuration remain launch gates | A billing design exists, but production revenue and margin need real end-to-end validation |

### Important verification caveats

The audit pack is a repository and test audit, not proof that all capabilities work against every live third-party service. It reports browser tests skipped or based on fixtures, live voice disabled, Google/Meta integrations awaiting production setup, and staging load/capacity still to be measured. The test totals are also inconsistent across documents: the executive summary reports 104 passed, 1 failed and 3 skipped, while the feature audit describes 108 test files passing in another section. Reconcile this with a fresh CI run and an evidence ledger before publishing readiness claims.

**Immediate conclusion:** keep the existing architecture. Complete operational verification first; then expand the execution environment and reliable connector coverage.

---

## 3. Competitive benchmark: what to learn, not copy

The global direction is already clear. Meta's official Muse material describes a persistent secure VM/browser, tasks such as appointments and forms, connected apps, background goals and price monitoring, approval for consequential actions, and an activity trail. OpenAI describes an agent using a virtual computer, visual and text browsing, a terminal, APIs and app connectors, with user takeover and approval for consequential actions. Anthropic offers browser-use and computer-use toolsets, while emphasizing that the developer must provide and secure the execution environment. These are useful product benchmarks, not templates to copy feature-for-feature.

The competitive bar is moving from “answers questions” to “completes multistep work.” Kriya should compete through **the jobs it understands deeply, how it operates in India, and how reliably it proves the outcome**.

### Proposed differentiation

1. **India workflow depth:** invoices, GST evidence, Indian vendors, local business follow-up, rupee budgets, local calling rules, and regional-language interactions should work together in a single task—not be a list of disconnected features.
2. **Voice-to-action:** a user can speak in English, Hindi/Hinglish or Telugu, ask Kriya to contact a vendor, get a response, record the commitment and create a reminder. Expand languages only after native-speaker evaluation and real carrier tests.
3. **Evidence-backed completion:** every meaningful action returns a receipt containing what was attempted, what changed, evidence/source, timestamp, verified outcome, cost and any unresolved limitation. “I clicked submit” is not the same as “the booking was confirmed.”
4. **Permissioned autonomy:** users define which actions are allowed automatically, which need approval and which must be handed back to the user. Policies are enforced by code and connectors—not solely by the model's promise.
5. **Small-business outcomes:** an agent that turns an invoice into a ledger entry, notices an overdue amount, drafts a message, obtains approval, calls a vendor and records the outcome is harder to commoditize than a generic research chatbot.
6. **Affordable and understandable execution:** show estimated/actual cost, enforce budgets, and use structured APIs before expensive computer vision whenever possible.

---

## 4. The missing capability: a tiered computer-use system

Kriya already has a browser service. What it does not yet demonstrate is a complete, always-available, general desktop/computer environment equivalent to the persistent VM model described by Muse. Do not assume every agent needs its own permanently running virtual desktop.

### Recommended execution hierarchy

1. **First choice — direct, permissioned API/connector.** Use the official API for calendar edits, invoice records, GitHub issues, or other supported actions. This is usually faster, more reliable and easier to verify than clicking a UI.
2. **Second choice — structured browser automation.** Use the existing Playwright runtime for web workflows where a supported API is unavailable. Prefer accessibility/DOM information and explicit selectors over blind coordinates.
3. **Third choice — visual GUI computer.** Add an isolated Linux desktop/virtual-display worker for sites or apps that cannot be controlled reliably through DOM-based Playwright. Give it screenshot, click, type, scroll, window and limited file operations. Do not expose the host machine or platform secrets.
4. **Human takeover.** Pause for the user to log in, resolve CAPTCHA/2FA, confirm a consequential action or handle a site that is not supported. Resume from a known checkpoint afterward.

### Workspace design

Create a **logical workspace per user and agent**, with an execution session allocated per task. Preserve the task plan, browser profile, allowed connections, files, logs and checkpoints according to user permissions and retention settings. Allocate a full desktop VM **on demand** for tasks that need it; keep it warm only when measured latency and paid-plan economics justify it. This avoids the potentially large cost of keeping one full VM alive for every agent.

Minimum safety and reliability requirements:

- Tenant- and task-isolated execution, with no browser/desktop access to Supabase credentials or unrelated customer data.
- Default-deny outbound network policy; explicit destination allowlists, private/LAN/cloud-metadata blocking and DNS/IP revalidation.
- Separate encrypted credential storage; agents should never read or log passwords, OTPs, UPI PINs or recovery codes.
- One-time, scoped session grants; expiry, revocation, session deletion and a visible kill/pause/takeover control.
- Checkpoints around every external side effect; idempotency keys for retries; do not blindly repeat a booking, message, payment or deletion after an ambiguous timeout.
- Prompt-injection defenses for webpage content, files and emails; treat external content as data, never as permission to override policy.
- Browser/desktop session recording of actions and results where lawful and disclosed, with configurable retention and strong access controls.
- Load tests at realistic concurrency, including long sessions, downloads, timeouts, stalled pages, memory pressure and forced termination.

**Do not remove the existing R5 boundaries just to claim full autonomy.** In particular, the audit currently blocks passwords, OTPs, CAPTCHAs and payment submission. A shopping/booking agent can discover and compare options, prepare checkout and hand the user to a trusted payment surface. The user should perform the sensitive authentication and authorize payment themselves unless Kriya later has an approved, contractually supported payment-initiation design.

---

## 5. The product experience: an action, not a chat transcript

Every task should follow a consistent lifecycle:

1. **Request:** User states the desired outcome in text or speech.
2. **Clarify only what is necessary:** destination, budget, date, constraints or authority to act.
3. **Plan preview:** Show the target outcome, likely steps, data/apps needed, limits, expected cost/time and the actions that require confirmation.
4. **Execute:** Route each step to API, browser, GUI or voice using the safest available tool.
5. **Checkpoint:** Display current state, blocked steps, approvals needed and a way to pause/cancel/take over.
6. **Verify:** Re-read the authoritative source or check a confirmation response. Persist reference IDs and source evidence where permitted.
7. **Receipt:** Show successful, failed and unverified steps distinctly; list final price/cost, source and timestamp, confirmation/reference number, and next action.
8. **Continue or monitor:** Ask whether to schedule a relevant follow-up only when useful, or set one as part of the task if the user requested it.

A good UI should make four things instantly obvious: **What did I ask? What is Kriya doing? What does it need from me? What proof shows it finished?** Keep this legible on the existing 360px mobile baseline.

---

## 6. Which agents to launch first

Build specialist experiences on a shared runtime. Avoid separate agent codebases with inconsistent permissions and memory.

### Agent 1 — Kriya Business Operator (recommended first commercial wedge)

**User:** freelancer, shop, consultant or small business.  
**Workflows:** turn approved invoice details into a compliant draft; maintain customer/vendor records and ledger; reconcile invoice facts against connected files; draft overdue-payment follow-ups; schedule or place approved calls; record commitments and create reminders; summarize weekly cash/receivables; produce a sourced report from Sheets/email/documents.

**Why first:** existing GST/invoicing, ledger, voice workflow, schedules, cost accounting and task persistence provide a meaningful head start. Start with draft/export/approved actions; expand only after live connector verification.

### Agent 2 — Kriya Personal Operator

**Workflows:** compare real options, create itineraries, monitor prices, make appointment requests, track deadlines and organize personal admin. Start with search, comparison, monitoring and booking assistance. Enable autonomous reservation/booking only where a trustworthy API or partner supports it and the full confirmation/payment flow is tested.

### Agent 3 — Kriya Research & Data Operator

**Workflows:** collect current information from multiple sources, compare prices, extract data to Sheets, generate a spreadsheet/report, cite source links and timestamps, and monitor changes against a user-defined threshold. This creates a visible demonstration of current-data analysis and action, not just text generation.

### Shared voice capability

Treat voice as a cross-platform ability available to the above agents, not only another isolated persona. A user should be able to say “call the supplier, ask whether the delivery can arrive Friday, record the commitment and remind me Thursday.” The user sees the planned call, recipient, purpose, script/summary, estimated cost and approval card first.

---

## 7. Real prices, tickets and bookings: a safe implementation path

This is a compelling demo but depends on live data and authorized transaction access, not just a powerful model.

### A correct booking flow

- Identify exact dates, passengers/attendees, locations, baggage/seat/add-on preferences and maximum budget.
- Query official provider APIs, authorized aggregators, affiliate feeds or partners wherever possible. Use browser automation only where permitted and stable; never treat scraped snippets as a guaranteed inventory API.
- Normalize the total price, taxes/fees, availability, cancellation/refund rules and important restrictions.
- Show **source, “checked at” timestamp, final-price caveats and direct booking link** for every candidate.
- Let the user choose the preferred option. Re-check availability and the total immediately before any reservation/checkout step.
- Present an exact-action approval card: provider, date/time, traveler/attendee details, all-in price, refund conditions and whether the next step is only a hold, a reservation or a purchase.
- Hand off secure login/payment/UPI PIN/OTP to the user or a supported provider flow. Do not let an LLM invent a booking confirmation or bypass a provider's authentication controls.
- Verify the provider's success response/confirmation reference and produce a receipt. If verification fails, say **“not confirmed”**, show evidence and offer a recovery path.

### Price monitoring

Build on the existing watcher/scheduler foundations: users define item/route/event, date range, source list, acceptable price, allowed notification channel and expiry. Store price observations with currency, timestamp, source, tax/add-on basis and a comparability label. Notify only when the price/availability condition is met, and revalidate on click-through. Never advertise an old result as a live price.

### Payments and India-specific guardrails

Keep discovery, reservation intent and payment authorization separate. The audit's current policy treats payment submission as a prohibited R5 action. Preserve that boundary for the first release. Kriya can compare and prepare a transaction, then send the user to the trusted provider/UPI app to authenticate; reconcile only from a verified confirmation. Any later payment-initiation capability requires a vetted PSP/merchant integration, legal/security review and explicit authorization design.

---

## 8. Connector and plugin strategy

Do not create an open plugin marketplace first. Build a **capability registry** that can support trusted built-in tools today and third-party extensions later.

Each connector/action should declare:

- Name, provider, supported action and data model.
- Read/write scope and exact OAuth scopes requested.
- Authentication method and token lifecycle.
- Supported regions/languages and API limits.
- Risk class (R0–R5), approval requirement and reversible/irreversible behavior.
- Input/output JSON schema, timeout, idempotency support and retry policy.
- Cost estimate, rate-limit behavior and result-verification method.
- Data retention, logging/redaction and a fixture-based test suite.
- Version, owner, health state, permissions and an emergency disable flag.

### Recommended order

**Unlock what exists first**

1. GitHub: validate production OAuth/webhooks and undo behavior across real repositories.
2. Google Workspace: finish production OAuth for Gmail, Calendar and Sheets; start with read-only permissions, then add carefully scoped writes and approval cards.
3. Meta/Instagram: complete app review and test scopes; separate draft/schedule from public posting.
4. Exotel and speech providers: live carrier test only after KYC/compliance sign-off, with strict allowlisted test numbers and cost caps.
5. Razorpay: complete live subscription webhooks, customer entitlements, refunds/support flow and reconciliation before charging customers broadly.

**Add after the core reliability gate**

- Email/calendar/task providers used by the first customer cohort.
- Regional-language speech and transcription via a measured comparison of BHASHINI/Sarvam and fallback vendors.
- Authorized catalog, travel, event and local-service partners to support live inventory/pricing.
- Business-document ingestion and export for invoice, ledger and reporting workflows.
- Notifications through user-selected channels with explicit opt-in and delivery logs.

**Future platform layer**

- A curated connector directory with permission scopes, publisher identity, versioning, review status and per-connector health indicators.
- MCP or similar interoperability support only behind the same manifest, policy, tenant sandbox, auditing and approval layer. A standard protocol is not a trust policy; do not execute arbitrary community tools with platform secrets.
- Developer SDK and partner APIs after built-in connectors have stable schemas and test coverage.

---

## 9. Target architecture

Preserve the four-service architecture and add clear capability boundaries rather than starting with a large rewrite.

### A. Agent orchestration and durable state

Keep the existing worker/task queue. Add explicit task plans, typed step states (`planned`, `running`, `awaiting_approval`, `succeeded`, `failed`, `unverified`, `cancelled`), checkpoints and an action receipt. Persist enough state to resume safely after worker/browser failure.

### B. Capability registry and dispatcher

One policy-aware dispatcher chooses between direct API, Playwright, GUI desktop, file processing, scheduler/watcher or telephony. The model may propose a tool; the deterministic dispatcher decides whether the tool is available, allowed, within budget and approved.

### C. Isolated execution plane

Keep `kriya-browser` isolated and evolve to multiple sandbox types: browser-only by default; desktop VM only when needed; short-lived file/compute workers for downloads and data analysis. Every worker gets only the task-scoped permissions and network destinations it needs.

### D. Connected apps and data

Use the existing Supabase RLS and encrypted token design. Add OAuth scope minimization, permission review/revocation UX and per-connection health. Avoid one broad “connect everything” permission.

### E. Memory and goals

Separate conversation memory, user preferences, sensitive data and task/business records. Let users inspect, correct and delete durable memories. Give every autonomous recurring goal an owner, schedule/trigger, budget, expiry, allowed tools, notification method and stop control.

### F. Evidence, trust and observability

Store action-level evidence and normalized outcomes; correlate task, tool, provider call, cost and approval IDs. Add dashboards for completion success, verification rate, approval latency, timeout/retry rates, model/tool cost and incidents. Support redacted audit exports for business customers.

---

## 10. Phased implementation roadmap

Priorities below are dependency-aware. Calendar durations are planning estimates and should be adjusted after staffing and live benchmark results.

### Phase 0 — Close launch blockers (first 1–2 weeks)

- Re-run the whole test suite from a clean environment and reconcile the conflicting test counts; fix the missing mock-key failure and make test configuration deterministic.
- Review the 59 reported unindexed foreign keys against the live schema/query plans; add only verified, non-duplicate indexes through reviewed migrations with rollback.
- Deploy the full stack to staging, validate health checks, environment/secrets, public `wss://` routes, service-to-service authentication and rollback procedure.
- Load-test browser sessions at 1, 3 and 5 concurrent sessions; measure memory, task duration, external latency, timeouts and recovery before setting concurrency entitlements.
- Conduct real-device Android tests for login, microphone permissions, long tasks, approvals, takeover, file download, accessibility and low-bandwidth recovery.
- Complete production OAuth, Razorpay and Exotel account setup as relevant; do not turn on live outbound calling until telecom/legal checks and a controlled call are signed off.
- Define incident response, backup/restore, data-retention, account deletion, support escalation and usage-refund processes.

**Exit gate:** repeatable CI green; staging smoke test green; verified backups/rollback; no unreviewed live side effects; one end-to-end test each for API, browser, approval, billing and voice mocks; actual provider test evidence attached.

### Phase 1 — Action Runtime v1 (next 2–4 weeks)

- Implement a shared task-plan and action-receipt schema.
- Surface task progress, next step, blocking approval, cancellation, takeover and verified outcome in the UI.
- Make approval cards exact-action previews: recipient, content/payload, total price, risk, external effect and cost.
- Establish connector manifest/registry, scoped credentials, test fixtures, idempotency and consistent error handling.
- Finish and validate Google Calendar/Sheets first, then Gmail with least-privilege scopes; production-test GitHub and Meta if those are launch priorities.
- Add task-level cost and wall-time estimates and hard-stop enforcement; show uncertain/estimated costs honestly.

**Exit gate:** 3 chosen workflows work end-to-end on real authorized accounts, with correct approval, completion evidence and recoverable failures.

### Phase 2 — Persistent workspace and computer use (weeks 4–8)

- Introduce per-user/per-agent logical workspaces and task-scoped execution sessions.
- Complete public live browser viewing and user takeover.
- Add a sandboxed GUI desktop worker only for workflows that fail the API/DOM-first route; start with a small set of known sites/applications.
- Build checkpoint/resume, secure session cleanup, task interruption and execution replay from redacted events.
- Stress-test multiple tenants; validate isolation, SSRF protections, storage encryption, memory limits and kill-switch behavior.
- Keep full desktop sessions on demand; compare cost and success rate against the existing browser worker before expanding concurrency.

**Exit gate:** benchmarked cost per successful task, verified tenant isolation, tested takeover/resume, and no critical security failures in a documented adversarial test pack.

### Phase 3 — Launch the first India-specific agent workflows (weeks 6–12)

Pilot with a small invited cohort rather than launching every use case at once.

1. **Business Operator:** invoice/ledger, connected spreadsheet/email, due-date monitoring, approved vendor/customer follow-up and verified call outcomes.
2. **Research & Data Operator:** multi-source research with citations/timestamps, comparison tables, spreadsheet export and price/threshold monitoring.
3. **Personal Operator:** reminders, scheduling, appointment requests and booking assistance; enable transactions only with verified partner/provider flows.

- Add Hindi/Hinglish and Telugu voice only after native-speaker quality testing, including code-mixing, numbers, dates, names and noisy 8 kHz telephony.
- Use official/authorized sources for live prices; display source, checked-at time, all-in price basis and confidence in freshness.
- Run a structured “golden tasks” suite against real sites and APIs before every release.

**Exit gate:** a meaningful sample of users complete these workflows successfully; all external writes are approved when required; action receipts are correct; no unsupported “booked/sent/paid” claims.

### Phase 4 — Proactive agents, integrations and scale (after pilot evidence)

- Add goals and event-triggered automation: “tell me if this price falls below ₹X,” “follow up if no supplier response,” or “prepare a weekly receivables brief.”
- Add partner-backed ticket/travel/catalog/local-service workflows where reliable APIs and commercial terms exist.
- Add user notification preferences, snooze/quiet hours, escalation policies and expiry for every recurring task.
- Create a reviewed connector directory, developer SDK and enterprise/team controls only after the built-in tool contract is stable.
- Evaluate voice, messaging and local integrations on actual cost, conversion, complaint rate and completion—not demo quality alone.

**Exit gate:** positive unit economics, proven support processes, measured task quality and a defensible retention/usage signal.

---

## 11. Suggested product dashboard and success metrics

Do not use raw conversation volume or agent count as the main success measure. Track whether tasks are completed correctly and safely.

- **Verified task completion:** percentage of tasks ending with an evidence-backed success receipt.
- **Outcome accuracy:** percentage of receipts that match the source of truth on sampled independent review.
- **Unverified side-effect rate:** task claims of success without reliable provider confirmation; target zero for bookings, public posts, calls and money-affecting actions.
- **Approval quality:** percentage of approvals showing exact action, correct target, price/payload and risk; measure accidental reject/approve rate.
- **Autonomy rate:** percentage of low-risk tasks completed without unnecessary user intervention, excluding actions that must remain gated.
- **Recovery quality:** successful resumptions after worker/browser/network failure, plus duplicate-action rate.
- **Latency and cost:** p50/p95 task time and cost per verified completion by workflow and connector—not just model token cost.
- **Retention:** weekly users with a recurring useful workflow, monitored goal or repeat business task.
- **India relevance:** native-speaker task success by language/accent, code-mixed speech accuracy, and completion rate on real Indian business workflows.
- **Trust/support:** user takeover/cancel frequency, complaints, incident severity, refunds and support resolution time.

Publish readiness only from real measured samples, not from an architecture maturity percentage alone.

---

## 12. Decisions to make now

1. **Primary launch audience:** choose the small-business operator as the initial commercial wedge, while keeping the runtime general-purpose. Validate the choice with 10–20 target users before overbuilding.
2. **Initial three workflows:** select a tightly defined set whose external systems and approval paths can be tested. Recommended: invoice-to-ledger/report; approved vendor follow-up by email/call; live multi-source comparison plus price watcher.
3. **Computer strategy:** API-first, DOM/browser second, desktop VM third. Do not provision an always-on computer per agent by default.
4. **Autonomy contract:** users can define limits, but system policy always wins. Payment authentication, passwords and OTP entry remain user-controlled in the initial release.
5. **Evidence standard:** a task cannot be called “complete” without provider confirmation or other explicitly named evidence. Model-generated narrative alone is not proof.
6. **Market claim:** use “India-first action agents” as positioning; validate “India’s first” independently before using it publicly.

## Bottom line

Kriya Tavi should not spend the next release merely adding more model options or more chatbot personas. The highest-leverage work is to **prove the current platform on live systems, turn the browser into a safe tiered execution environment, connect the apps customers already use, and launch a few India-specific workflows with exact approvals and verifiable receipts**. That is the path to an agent people can delegate work to—not just a chatbot that sounds capable.

---

## External benchmark references

- Meta Muse — official product page: https://ai.meta.com/muse/
- OpenAI — Introducing ChatGPT agent: https://openai.com/index/introducing-chatgpt-agent/
- Anthropic — Computer use tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic — Browser use tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
- BHASHINI — API integration: https://bhashini.gov.in/ulca/model/api-integration
- Sarvam — Building for Indian languages: https://docs.sarvam.ai/api/getting-started/building-for-india
- NPCI — UPI FAQs and merchant onboarding: https://www.npci.org.in/what-we-do/upi/faqs
