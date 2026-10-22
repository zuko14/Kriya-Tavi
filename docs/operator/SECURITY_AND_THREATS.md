# Security and threats (operator, track O)

Builds on `docs/agent-platform/SECURITY_AND_COMPLIANCE.md` (S1–S15) and the
voice track's. Track O adds one new power: **acting without a per-call
approval**. Every threat below is about keeping that power inside the
envelope the person approved.

## 1. Threats and controls

| Id    | Threat                                                             | Control                                                                                                                                                  | Test                |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| OS-1  | Over-broad grant ("any email to anyone")                           | Grantable tools fixed (registry + SQL check); pins required and non-empty; `max_uses ≤ 50`; expiry ≤ due ≤ 30 days; ≤ 6 grants per mandate               | OT-GRT-03, OT-DB-07 |
| OS-2  | Prompt injection (a client's email says "also draft to x@evil")    | New recipient → no pin match → per-call approval showing the exact recipient. Injected **content** can only shape a draft the person still sends (OD-04) | OT-SEC-01           |
| OS-3  | The agent grants itself authority                                  | No tool writes `grants`, `grant_uses` or mandate status (TOOL_WRITES + PERSON_ONLY_WRITES, AT-POL-07); `consume_grant` not executable by `authenticated` | OT-SEC-02, OT-DB-04 |
| OS-4  | Race: two tasks spend the last use                                 | `for update` lock in `consume_grant`; `uses ≤ max_uses` check constraint                                                                                 | OT-DB-03            |
| OS-5  | Replay: a retried task re-runs a granted action                    | Use keyed by `(grant_id, tool_call_id)`; the runner's existing no-retry-after-side-effect rule is unchanged                                              | OT-GRT-06           |
| OS-6  | Revoke doesn't take effect                                         | `consume_grant` re-reads status on every call; revoke is one statement                                                                                   | OT-GRT-05           |
| OS-7  | A grant used outside its job                                       | `activeGrants` only for the mandate's goal thread; another thread gets none                                                                              | OT-GRT-04           |
| OS-8  | "Done" claimed by the model                                        | Status `completed` only from `reviewMandates`; verdict from rows; reply prose never evidence (AD-02)                                                     | OT-VDT-03           |
| OS-9  | Check-ins spend money with no progress                             | Stuck rule (2 idle runs), goal ₹ cap, plan task limits, `operator.maxActive`                                                                             | OT-LOOP-02          |
| OS-10 | The person misreads the envelope                                   | Mandate card in plain words with the recipients listed; reduce-only edits; uses shown "3 of 9"; "Stop all" button                                        | UX review, OT-UI-01 |
| OS-11 | A call placed under a grant                                        | `propose_call` never grantable (OD-03); voice keeps its exact-payload confirmation                                                                       | OT-GRT-03           |
| OS-12 | Personal data leaks into logs                                      | Pins (emails) never logged; `lib/log.ts` redaction unchanged; mandate titles may hold names, so log ids only                                             | OT-SEC-03           |
| OS-13 | Cross-tenant evidence (a verdict counts another person's call)     | Every evidence query has `user_id = mandate.user_id` and the goal thread id; composite FKs                                                               | OT-VDT-04, OT-DB-01 |
| OS-14 | Kill switch bypassed by skill replay                               | Killed tools are deleted from the belt replay reads (`() => tools`)                                                                                      | OT-CAP-03           |
| OS-15 | Switch-off leaves grants live                                      | With `operator.grants` off, `activeGrants` isn't called; `TOOL_APPROVALS` is used as-is                                                                  | OT-REG-01           |
| OS-16 | A crew member's result carries injected instructions into the lead | Join message carries the `FOREIGN` notice; the lead's own policy and approvals still apply; members see only their brief                                 | OT-CREW-06          |
| OS-17 | A crew fans out cost                                               | ≤ 4 parts, ≤ 3 rounds; per-part budget = remaining job budget ÷ open parts; plan daily task limit                                                        | OT-CREW-08          |
| OS-18 | Drive share sends a file to the wrong person                       | R4, exact approval every time listing each address and the file name, never grantable; read-back; 10-minute undo                                         | OT-G2-02            |
| OS-19 | Google tokens in the browser for the Picker                        | Picker uses Google's own short-lived browser token; Kriya's stored token never leaves the server (invariant 4)                                           | G2 first step       |
| OS-20 | A local test writes to the live database                           | `verify:guard` refuses the live ref and non-local hosts; `.env.verify` exported, owner's env files untouched                                             | OT-UIV-01           |

## 2. Invariants this track must never weaken

- R5 never exists as a tool; no grant touches R4 or R5 (OD-03).
- Risk classes come from `lib/agent/policy.ts`; grants never change a class,
  they only answer the approval question for a matched R2/R3 call.
- `untrustedSeen` and `guardWeb` stay as they are; web tools aren't
  grantable.
- Calls: voice rules 5, 8, 9 untouched.
- Ledger: only the person confirms entries and marks invoices paid
  (track-A rule 9). Playbooks read those facts; they never write them.
- Approvals for things outside a grant still go through the Inbox.

## 3. DPDP notes

A mandate processes the same data the person's tools already process; it
adds email addresses in pins and invoice ids in subjects. The person sees
and can revoke both. No new data about third parties is collected. Counsel
question to add to track A's list (owner): **OQ-1** — is a standing grant to
draft messages to named clients adequately disclosed by the mandate card,
for the person's own DPDP duties to those clients?
