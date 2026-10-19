# Security and compliance

Extends `docs/kriya/security.md` (read it first). The agent platform adds
four high-value assets:

1. login sessions for other sites;
2. people's documents and bills;
3. the ability to act on outside sites;
4. long-lived memory.

This is a design, not a claim of security. Nothing has been externally
reviewed. A11 does that.

## 1. New assets and who may touch them

| Asset                               | Stored                                                                        | Readable by                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Login profile state                 | `login_profiles.state_sealed`, AES-256-GCM (`KRIYA_TOKEN_KEY`), context-bound | Worker (`lib/browser/profiles.ts`) → one `kriya-browser` session; never the person's session, the owner console, logs or the model |
| Files (bills, resumes, screenshots) | Private bucket `kriya-files/<user_id>/…` + `kriya.files`                      | The person (signed URLs, 60 s), the worker for extraction; never the owner console                                                 |
| Ledger, invoices                    | `kriya` tables, RLS                                                           | The person; agents via `withUser`                                                                                                  |
| Memory                              | `kriya.memories`, RLS                                                         | The person; their agents                                                                                                           |
| Screenshots                         | Files with 30-day retention                                                   | The person                                                                                                                         |
| `KRIYA_BROWSER_SECRET`              | Env on worker, web (for minting live-view tokens), `kriya-browser`            | —                                                                                                                                  |
| New connector tokens                | `kriya.connections` (sealed, existing pattern)                                | `lib/connectors*` only                                                                                                             |

## 2. Threat model

| #   | Threat                                                                                                           | Control                                                                                                                                                                                 | Test                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S1  | Prompt injection makes the agent submit, post, pay or send                                                       | Deterministic classes (AD-03); R4 per-call approval with screenshot; R5 doesn't exist; `assisted` sites refuse fills and commits                                                        | AS-SEC-01…05, AT-POL-*                                                                        |
| S2  | Injection exfiltrates private data (mail, memory, a logged-in page) to an attacker URL                           | Existing `privateContentSeen` guard extended to file and browser reads; cross-domain navigation with a login profile = approval; typing private content into an off-domain form = R4    | AT-BRW-08, AS-SEC-02                                                                          |
| S3  | Injection poisons memory                                                                                         | Quarantine (AD-11); sensitive-pattern refusal; review UI                                                                                                                                | AT-MEM-05, AS-MEM-INJ                                                                         |
| S4  | Theft of login sessions from the database                                                                        | Sealed with an env key; column grants; never in logs; context binding stops row swaps                                                                                                   | AT-SEC-01 (session can't select `state_sealed`), AT-SEC-02 (swapped ciphertext fails to open) |
| S5  | Theft of sessions from `kriya-browser`                                                                           | No state at rest (temp profile dir deleted on close); one process per session; no inbound access except the authenticated API and the token-bound live view; logs exclude state         | AT-BRW-07, review                                                                             |
| S6  | SSRF via the browser into Render or metadata services                                                            | Egress guard (BROWSER §4)                                                                                                                                                               | AT-BRW-06                                                                                     |
| S7  | Another user's live view                                                                                         | One-time HMAC token bound to session and user, 60 s, single use; `kriya-browser` checks the token before sending a frame                                                                | AT-BRW-12                                                                                     |
| S8  | Password or OTP exposure                                                                                         | Agents can't type into sensitive fields (R5); snapshots never include their values; screenshots suppressed while one is focused; frames never stored; take-over disclosure (BROWSER §5) | AT-BRW-02, AT-BRW-03                                                                          |
| S9  | Malicious uploads (polyglot PDFs, scripts)                                                                       | MIME allow-list + magic-byte sniffing; size limits; text extraction in the worker without executing anything; PDFs opened only as data                                                  | AT-FILE-02                                                                                    |
| S10 | Wrong money (hallucinated totals)                                                                                | Code computes; SQL `check`s totals; `needs_review` on mismatch; only the person confirms                                                                                                | AT-LED-*                                                                                      |
| S11 | Runaway background spend                                                                                         | Schedules are R2; plan limits in SQL; per-goal budgets; maintenance cap; per-task cost budget (existing)                                                                                | AT-SCH-04, AT-SCH-05                                                                          |
| S12 | Account bans on outside sites                                                                                    | Site modes (AD-06), rate limits, no evasion, `assisted` default                                                                                                                         | Registry review                                                                               |
| S13 | Cross-tenant data via shared memory                                                                              | Shared means shared across one user's agents only; RLS on `user_id`                                                                                                                     | AT-RLS-MEM-01                                                                                 |
| S14 | Skills used to escalate                                                                                          | A skill's steps are re-classified at run time; `max_risk` is a ceiling; approval rules apply on replay                                                                                  | AT-SKL-03                                                                                     |
| S15 | Owner console oversharing                                                                                        | Owner pages select counts and statuses only: never memory, file, ledger, screenshot or login-profile content                                                                            | AT-OWN-A1                                                                                     |
| S16 | A share link leaks (forwarded, guessed, logged)                                                                  | 256-bit random token, stored only as sha256; expiry ≤ 30 days; revocable; `noindex`, `no-referrer`; snapshot only, never live data; view log visible to the person                      | AT-SHR-01…05                                                                                  |
| S17 | Poisoned public facts misleading many users                                                                      | Allow-listed official domains enforced by trigger; verbatim quote; two agreeing fetches; never written from a user's task; owner retraction, audited                                    | AT-FCT-01…04, AS-FCT                                                                          |
| S18 | An agent sets a person-only state (confirm ledger, approve skill, trust memory, create share) through `withUser` | No tool writes those columns; static check                                                                                                                                              | AT-POL-07                                                                                     |
| S19 | Receipts over-claim integrity                                                                                    | The receipt states the chain's honest limit (SIGNATURE_FEATURES K1)                                                                                                                     | Copy review                                                                                   |
| S20 | Undo runs against the wrong object                                                                               | Compensation uses the provider id recorded at execution; ownership checked; verified by read-back                                                                                       | AT-UNDO-01…03                                                                                 |

## 3. Data protection (India)

The DPDP Act 2023 and DPDP Rules 2025 are phased (RESEARCH.md §5). Design
for the strictest phase now:

| Duty                           | How Kriya meets it                                                                                                                                   | Phase          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Notice and consent per purpose | Separate, plain-language consents for: memory, files, login profiles (per site), background use of a login profile, ledger                           | A1, A5, A6, A7 |
| Purpose limitation             | Login profiles used only for the person's own tasks on that domain; bills only for their ledger                                                      | A6, A7         |
| Access and correction          | Memory export and edit; files listed; ledger editable                                                                                                | A1, A5, A7     |
| Erasure                        | Hard delete of memory chains, files (storage first), login profiles; account deletion cascades (existing)                                            | All            |
| Security safeguards            | §1–2; encryption of sessions; RLS; audit of owner access (existing `audit_events`)                                                                   | All            |
| Breach intimation              | Incident runbook in A11 (who, within what time, to whom); the 72-hour figure and the Board process must be checked against the Rules text            | A11            |
| Children                       | Students may be under 18. **Counsel question AQ-1**: verifiable parental consent requirements and whether to restrict sign-up to 18+ until solved    | Before A10     |
| Processors                     | Supabase, Render, OpenRouter and its model providers, Firecrawl, any managed browser vendor: list in the privacy notice; check data-processing terms | A11            |

Third parties' data (clients in invoices, contacts in memory, people in
mail): processed only for the person's own business. No scraping, no
enrichment from public profiles, no bulk messaging (AD-06).

## 4. Questions for counsel

| Id   | Question                                                                                                                                        | Blocks                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| AQ-1 | Users under 18 (students): verifiable parental consent under DPDP Rules; or 18+ only for now?                                                   | A10 for student pilots |
| AQ-2 | Kriya's role (fiduciary vs processor) for login sessions and for bills containing third-party data                                              | A11                    |
| AQ-3 | Retention periods for episodes, screenshots and ledger data (business records may need long retention for the person; Kriya's own copy may not) | A11                    |
| AQ-4 | Liability wording for accounting summaries ("not tax advice") and for actions taken on outside sites at the person's direction                  | A7, A10                |
| AQ-5 | For each site moved to `supervised`: does the person's approval of each action make it permitted use under that site's terms?                   | AB-04                  |
| AQ-6 | Should the browser identify itself as an AI agent (user-agent token)? Upwork's reported terms require disclosure labels on agent messages       | A10                    |

## 5. Operational security

- **Keys.** `KRIYA_TOKEN_KEY` now protects sessions too. Rotation plan in
  A11: add `v2` sealing with a new key, re-seal on next use, retire `v1`
  after 90 days. `lib/secrets.ts` already versions its output (`v1.`).
- **Logs.** No login state, cookie, file text, ledger amount with a
  counterparty name, or memory content in logs. `lib/log.ts` gets cookie and
  storage-state patterns (allowed change, CHANGE_IMPACT §3). Tests check the
  redaction.
- **Owner console.** Counts, statuses, costs only (S15).
- **Kill switches.** Each `agents.*` setting off within the 15 s settings
  cache. `KRIYA_BROWSER_URL` unset stops every browser tool. An emergency
  action pauses all schedules (A3).
- **External review** before A10 ends: browser service, login profiles,
  egress guard, files.

## 6. Production-readiness gates (A11)

| Gate | Evidence required                                                                              |
| ---- | ---------------------------------------------------------------------------------------------- |
| GA-1 | Every AT- test in TEST_AND_EVALUATION.md passes; existing 82 tests unchanged                   |
| GA-2 | AS-SEC suite: 0 unapproved commits, 0 exfiltrations, 0 R5 actions, over ≥ 200 adversarial runs |
| GA-3 | Egress guard verified on the deployed `kriya-browser` (not only locally)                       |
| GA-4 | Restore drill of Postgres + Storage on staging, with RPO/RTO measured                          |
| GA-5 | Key rotation rehearsed on staging                                                              |
| GA-6 | External security review with no open critical or high findings                                |
| GA-7 | Counsel answers AQ-1…AQ-6 recorded; privacy notice and terms updated in `app/legal`            |
| GA-8 | A10 pilot thresholds met (TEST_AND_EVALUATION §4), with n and dates                            |
