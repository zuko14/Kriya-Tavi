# Kriya Tavi — Security, Threat Model & Reliability Audit

**Date:** 2026-10-21  
**Auditor:** Principal Security Engineer & Infrastructure Auditor  
**Scope:** Threat modeling (S1–S15), risk policy enforcement (R0–R5), database RLS integrity, secret handling, browser sandboxing, webhook authenticity, and worker concurrency reliability.

---

## 1. Threat Model & Risk Classification

### 1.1 The R0–R5 Risk Model (`lib/agent/policy.ts`)
Kriya Tavi implements a **code-enforced, deterministic risk engine**. The risk tier of any proposed action is calculated synchronously based on element roles, page facts, domain trust, and multilingual keyword regex. **The LLM is never permitted to classify or lower its own risk tier.**

| Risk Tier | Definition | Examples | Enforcement Policy |
| :--- | :--- | :--- | :--- |
| **R0** | Read-only observation | `browse_url`, `read_page`, `search_web`, `memory_search` | Automated execution without interruption. |
| **R1** | Reversible, low-stakes drafting | `draft_message`, `draft_invoice`, `fill_field` (non-commit) | Automated execution; state remains uncommitted. |
| **R2** | Modest external side effects | `github_comment`, `notion_append`, `voice_call_place` | **User Approval Gate**: Task suspends until explicit user confirmation in UI. |
| **R3** | Non-trivial commitment / money | `ledger_post_entry`, `post_social_update`, `submit_form` | **Mandatory Exact-Action Approval**: Requires explicit confirmation of payload and recipient. |
| **R4** | High-consequence mutation | Account modifications, public broadcasts, data deletion | **Mandatory Approval with Warning**: Detailed impact preview required. |
| **R5** | Prohibited / High-Risk Security Boundary | Typing passwords, reading OTPs, solving CAPTCHAs, payments | **Unconditional Refusal**: Tool call is rejected at the engine level; user takeover required. |

### 1.2 Multilingual Commit Detection
To prevent prompt injections from triggering accidental external writes on non-English sites, `COMMIT_WORDS` in `lib/agent/policy.ts` includes comprehensive word boundaries across **English, Hindi, and Telugu**:
- English: `save`, `submit`, `post`, `send`, `confirm`, `pay`, `buy`, `delete`, `connect`
- Hindi: `सहेजें`, `सेव`, `भेजें`, `सबमिट`, `जमा करें`, `प्रकाशित`, `पुष्टि`, `भुगतान`, `हटाएं`
- Telugu: `సేవ్`, `పంపు`, `సమర్పించు`, `ప్రచురించు`, `నిర్ధారించు`, `చెల్లించు`, `తొలగించు`

---

## 2. Authentication & Data Boundary Architecture

### 2.1 Supabase RLS & Tenant Isolation
1. **0 Security Lints on Live Supabase**: Verified via MCP advisor inspection on `kriya-tavi` (`kiyfofxkechnzeeluhtv`), all security lints are clean (`lints: []`).
2. **Strict RLS Across 70 Tables**: Every table in schema `kriya` has `rls_enabled = true`.
3. **Session Binding via `withUser(userId, ...)`**:
   ```sql
   -- Conceptual SQL executed within withUser transaction
   set local role authenticated;
   set local request.jwt.claims = '{"sub":"<userId>"}';
   ```
   Postgres engine evaluates `auth.uid() = user_id` for every `SELECT`, `INSERT`, `UPDATE`, and `DELETE`.
4. **Server Privileges Separation**: `privileged` queries bypass RLS only for system-level queuing (`claim_task`, `recover_tasks`), verified webhooks, and owner checks (`requireOwner()`).

---

## 3. Secret Management & Cryptographic Isolation

1. **Environment-Only Secrets (`lib/config.ts`)**:
   All 18 production secrets (API keys, OAuth client secrets, encryption keys, webhook secrets) reside strictly in environment variables. They are excluded from database storage, client-side bundles, API responses, and server logs.
2. **AES-256-GCM Token Encryption (`lib/secrets.ts`)**:
   - OAuth access and refresh tokens (Google, Notion, GitHub, Meta) and sealed browser login states are encrypted using AES-256-GCM with a 32-byte secret (`KRIYA_TOKEN_KEY`).
   - Each ciphertext includes a unique 12-byte initialization vector (IV) and 16-byte authentication tag.
   - Key rotation is supported out of the box via `KRIYA_TOKEN_KEY_PREVIOUS` without downtime (`lib/connectors/rotation.test.ts`).
3. **Zero Passwords Policy**:
   Agents **never** create, store, or view passwords. Browser sessions use encrypted cookie jars (`StorageState`), never credentials.

---

## 4. Browser & Egress Sandboxing (`browser/egress.ts`)

The browser execution container (`kriya-browser`) represents a significant potential attack surface. It is secured through multiple concentric boundaries:
1. **No Database Credentials**: The browser container runs with zero database environment variables or network routes.
2. **Egress Proxy Isolation**: Chromium network traffic is forcefully routed through an internal Node.js HTTP/HTTPS forward proxy (`browser/egress.ts`).
3. **SSRF & LAN Blocking**: The proxy automatically blocks private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`, `169.254.169.254` cloud metadata endpoints).
4. **Site Domain Whitelist**: On untrusted web navigation, only domains explicitly registered in site loadouts (`lib/browser/sites.ts`) are allowed to resolve; unknown domains are strictly read-only.

---

## 5. Webhook Authenticity & Anti-Replay

1. **Razorpay Billing Webhooks (`lib/billing.ts`)**:
   - Every incoming event at `/api/billing/webhook` requires an `X-Razorpay-Signature` header.
   - Computed via `createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')`.
   - Verified using `timingSafeEqual()` to eliminate timing attack vectors.
   - Processed idempotently in `kriya.billing_events` using `provider_event_id` unique constraint.
2. **Exotel Telephony Webhooks**:
   - Verified via per-attempt cryptographic tokens generated during call initialization. An attacker cannot forge call progress events without possessing the attempt token.

---

## 6. Worker Concurrency & Distributed Task Reliability

1. **Atomic Job Claiming (`kriya.claim_task()`)**:
   ```sql
   select id from kriya.tasks
   where status = 'queued' and attempts < max_attempts
   order by attempts asc, created_at asc
   for update skip locked
   limit 1;
   ```
   Ensures zero race conditions or double-claiming across arbitrarily scaled worker replicas.
2. **Heartbeat Leases & Crash Recovery**:
   - Running workers maintain a 30-second lease renewed every 5 seconds.
   - If a worker crashes or is SIGTERM'd during deployment, `kriya.recover_tasks()` detects expired leases (`lease_until < now()`) and automatically requeues tasks with exponential backoff, provided no irreversible side-effect tool was executed.
3. **Cancellation Semantics**:
   - User cancellation sets `cancel_requested_at = now()`. The running worker checks this flag at each heartbeat and tool invocation boundary, aborting gracefully without leaving orphaned tasks.

---

## 7. Security Audit Findings Summary

| Severity | Target Subsystem | Description | Status |
| :--- | :--- | :--- | :--- |
| **High** | Telephony (Exotel) | Outbound dialing requires strict caller authentication to prevent toll fraud or harassment. | Mitigated: Owner confirmation required; daily spend caps enforced. |
| **Medium** | OpenRouter Models | Risk of prompt injection via crawled web text (indirect injection). | Mitigated: Memory redaction (`sensitive.ts`) & deterministic tool policy engine. |
| **Low** | Supabase Indexes | 59 foreign key constraints lack covering indexes on newly migrated tables. | Optimization recommended: Add index migration before scale. |
| **Low** | Worker Memory | Potential Chromium memory leak under high concurrent browser sessions. | Mitigated: Hard session ceiling (`BROWSER_MAX_SESSIONS = 3`) and 15m lifetime reaper. |
