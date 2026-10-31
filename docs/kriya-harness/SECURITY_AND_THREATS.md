# Security and threats (track H)

The Kriya Harness runs on the person's machine and talks to a new public API.
This document adds to the other tracks' security documents and weakens
nothing in them.

## 1. Trust boundaries

| Zone | Trusted for | Not trusted for |
| --- | --- | --- |
| Kriya servers (`kriya-web`, worker, Postgres) | Identity, plans, caps, ledgers, approvals, memory, handoff | — |
| The person's machine (DSH + Kriya plugins) | Acting for that person on that machine | Anything it sends Kriya: every request is validated as hostile input; local content is untrusted (memory unconfirmed) |
| Processes on that machine started by the agent | Nothing | They can read the device token (same OS user, HS-4) |
| OpenRouter | Model answers | Their content (untrusted text, as today) |

## 2. Invariants

1. Identity on the harness API comes only from `authenticateDevice` in
   `lib/auth.ts` (HD-05 amendment); never a user id, plan or price from the
   client.
2. Device tokens and codes are stored only as sha256; the token is shown
   once; the person's session can't select `token_hash`.
3. No device endpoint answers an approval, approves a device, confirms
   memory, changes a plan or reads another person's data.
4. The gateway never accepts a model id: only the plan's tier aliases.
5. Spend is capped in SQL before each request; missing cost is never zero.
6. The harness API runs no agent tool on the web server; connectors stay in
   the worker (invariant 5).
7. Server logs never hold prompts, outputs, file contents or tokens.

## 3. Threats

| Id | Threat | Stopped by | Test |
| --- | --- | --- | --- |
| HS-1 | Stolen device token used from elsewhere | Token works only on `/api/harness/v1`; caps and rate limits bound spend; revocation in Account → Devices; idle expiry 90 days; `last_used_at` and client version shown per device | HT-AUTH-03…05 |
| HS-2 | Device-code phishing (someone tricks a person into approving an attacker's code) | The connect page shows device name, platform and request time; codes expire in 10 min; one approval per code; approving requires the signed-in session | HT-AUTH-06 |
| HS-3 | Brute-forcing user codes | 32⁸ ≈ 1.1 × 10¹² space; approval requires a session; IP and per-user rate limits on the connect action | HT-AUTH-07 |
| HS-4 | Agent-run code on the machine reads the token and calls the API directly | Possible by design (same OS user). Bounded: no approve/answer/confirm endpoints (§2.3), caps, rate limits, handoff tasks are visible to the person and need track C's limits; documented in Kriya's SAFETY.md; the person can revoke | HT-API-09 |
| HS-5 | Gateway abuse as a cheap general LLM proxy | Plan cap, tier allow-list, rate limits, max tokens, concurrent streams; harness off by default per plan | HT-GW-04…06 |
| HS-6 | Prompt injection through local files reaching Kriya memory | `kriya_memory_save` writes unconfirmed notes only; the person confirms in Kriya | HT-API-07 |
| HS-7 | Approval spoofing (a fake approval request with a misleading summary) | The approval card shows the tool name, the redacted exact input and the folder, not only the summary; the person answers the exact input | HT-APR-03 |
| HS-8 | Mirror leaks code to Kriya's database | Mirror off by default; `summary` mode sends no file contents or outputs; `full` is an explicit per-device choice; 64 KB cap per turn | HT-MIR-02 |
| HS-9 | Malicious handoff patch (path traversal, huge file) | Size and hash checked on upload; the patch is applied only inside a track C sandbox by `git apply`, where CD-06 isolation holds | HT-HND-03 |
| HS-10 | Supply chain: a compromised DSH or dependency release | Exact pins, lockfile, provenance check of DSH releases where available, license/notice generation, bump only through a reviewed branch | HT-REL-02 |
| HS-11 | DSH's own security status ("not undergone a security audit") | Beta label and first-run notice (HF-05); safe defaults (`workspace-write`, `ask`); our review of the Kriya plugins (HG-6) | HG-6 |
| HS-12 | Outdated clients with known issues | `harness.minClientVersion` (426) | HT-API-02 |
| HS-13 | Cross-tenant reads through the API | Every query scoped by the device's `user_id`; RLS on the person's reads | HT-API-08, HT-DB-01 |
| HS-14 | Webview/local UI exposure (DSH Web UI on `127.0.0.1`) | DSH's own host authentication; the `kriya` profile keeps the bind address on loopback; documented in SAFETY.md | HT-REL-03 |

## 4. Questions for counsel

| Id | Question |
| --- | --- |
| HQ-C1 | Terms for distributing the harness (beta disclaimer, liability for actions on the person's machine), alongside DSH's MIT disclaimer |
| HQ-C2 | Data processing for mirrored session content (DPDP), when a person turns on `full` mirror |

## 5. Readiness gates (HG-…)

| Gate | Evidence |
| --- | --- |
| HG-1 | HT-REG-01: with `harness.*` off, nothing in the app changes; the whole existing suite passes |
| HG-2 | HT-AUTH-*, HT-GW-*, HT-MTR-* pass; the cap holds under 20 concurrent streams on staging |
| HG-3 | Gateway capacity measured on the staging web instance (HT-GW-09) |
| HG-4 | Contract tests green in both repositories on the same `contract.json` |
| HG-5 | Release pipeline: exact pins, SBOM, notices, provenance |
| HG-6 | Review of the Kriya plugins and the pinned DSH version's defaults; SAFETY.md written; first-run notice shown |
| HG-7 | Counsel HQ-C1 answered before public download |
