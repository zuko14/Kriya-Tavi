# Kriya Tavi — Staged Implementation & Upgrade Roadmap

**Date:** 2026-10-21  
**Auditor:** Principal Software Architect & Product Strategist  
**Guidance:** Dependency-aware, evidence-based upgrade roadmap to take Kriya Tavi from its current verified codebase to a production-ready, commercially viable Indian agent platform.

---

## Roadmap Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 0: Audit, Baseline & Forensic Verification (COMPLETED)    │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Critical Correctness & Security Fixes                  │
│ • Fix maintenance test mock key • Index 59 foreign keys         │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Staging Deployment & Chromium Capacity Sizing          │
│ • Deploy Render staging blueprint • Benchmark Chromium memory   │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: Telephony Operationalization & Compliance              │
│ • Provision Exotel account/KYC • TRAI CLI pre-declaration       │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 4: Commercial Monetization & Billing Gateway              │
│ • Razorpay live production keys • Set official FX rate source   │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 5: India-First Differentiators & Vernacular Voice         │
│ • Sarvam AI Hindi/Telugu TTS/STT • Automated GST filing checks  │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 6: Final Production Launch & Operations Monitoring        │
│ • Switch live calls on • 360px Android real-device sign-off     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 0 — Comprehensive Audit & Baseline Establishment
- **Status:** **COMPLETE** (2026-10-21)
- **Objective:** Establish the exact current implementation state, map all 70 database tables, run complete unit and integration test suites, inspect UI/UX across desktop and mobile, and research competitor landscape.
- **Deliverables**: Complete suite of 9 audit documents under `docs/audit/` and canonical `status.md` update.

---

## Phase 1 — Critical Correctness & Security Hygiene
- **Objective**: Resolve verified test environment inconsistencies and apply database performance optimizations before scaling traffic.
- **Current Problem**:
  1. `tests/agent/maintenance.test.ts` fails in default test runs because `process.env.OPENROUTER_API_KEY` is omitted in `beforeEach`, triggering a 503 Gateway check failure on `enqueueTurn`.
  2. Live Supabase database advisor reported 59 unindexed foreign keys across `kriya` schema tables, which will cause sequential scans as task volume grows.
- **Scope**:
  - `tests/agent/maintenance.test.ts`
  - Migration `20261116000000_foreign_key_indexes.sql` (+ rollback)
- **Prerequisites**: None.
- **Implementation Tasks**:
  1. Add `process.env.OPENROUTER_API_KEY = "test-mock"` to `tests/agent/maintenance.test.ts`.
  2. Generate a non-destructive migration adding covering B-tree indexes for all 59 unindexed foreign keys identified in Supabase advisor findings.
  3. Apply migration to Supabase `kriya-tavi` via `npm run db:migrate`.
- **Tests**:
  - `npm test` passes 108/108 test files with 0 failures.
  - Supabase database advisor reports 0 unindexed foreign keys.
- **Acceptance Criteria**: `npm run check` exits 0 cleanly.
- **Rollback Approach**: Run `20261116000000_foreign_key_indexes_down.sql` dropping newly added indexes.

---

## Phase 2 — Staging Infrastructure Deployment & Capacity Benchmarking
- **Objective**: Deploy the four microservices to Render staging and measure real-world Chromium resource consumption and network latency.
- **Current Problem**: `kriya-browser` capacity per instance is unmeasured (Blocker AB-08); maximum concurrent Playwright sessions (`BROWSER_MAX_SESSIONS`) must be calibrated against Render Standard container RAM (2GB).
- **Scope**:
  - `render.yaml` staging environment
  - `scripts/readiness.ts`
- **Prerequisites**: Render team account and Supabase staging credentials.
- **Implementation Tasks**:
  1. Apply `render.yaml` Blueprint to a staging environment in Render Singapore region.
  2. Execute synthetic browser stress tests measuring memory pressure across 1, 3, and 5 simultaneous sessions.
  3. Verify public `wss://` routing for browser live-view takeovers (`AB-11`).
- **Tests**:
  - `npm run readiness` passes with all environment checks green.
  - Zero out-of-memory (OOM) crashes under 3 concurrent 15-minute browser runs.
- **Exit Criteria**: Staging services healthy on `/api/health` and `/health`.

---

## Phase 3 — Telephony Operationalization & Regulatory Compliance
- **Objective**: Transition the voice assistant from mock execution to controlled live telephone calling.
- **Current Problem**: Live calls are blocked (`voice.liveCalls = "off"`, `KRIYA_VOICE_LIVE=0`) pending Exotel account verification and TRAI compliance sign-off.
- **Scope**:
  - `lib/voice/exotel.ts`, `voice/index.ts`
  - Legal compliance checklists (`docs/voice-assistant/SECURITY_AND_COMPLIANCE.md`)
- **Prerequisites**:
  - Business KYC completion with Exotel (Blocker B3).
  - Legal review of TRAI TCCCPR rules for 160-series transactional CLI (Blocker B4).
- **Implementation Tasks**:
  1. Configure `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, and `EXOTEL_CALLER_ID`.
  2. Pre-declare A2P voicebot dialogue templates on DLT portal (Blocker B5).
  3. Enable `voice.testNumbers` allowlist restricted strictly to the owner's personal phone number (Finding F25).
  4. Perform controlled test call from owner UI: verify audio streaming, barge-in, AI disclosure, and outcome extraction.
- **Tests**:
  - Real voice call placed to owner's test number; audio latency mouth-to-ear measured <700ms.
  - Outcome recorded accurately in `kriya.call_outcomes`.
- **Exit Criteria**: Signed checklist from the owner authorizing expansion beyond test numbers.

---

## Phase 4 — Commercial Billing Gateway & Cost Controls
- **Objective**: Activate live payment collection in Indian Rupees (₹) and enforce customer usage quotas.
- **Current Problem**: Billing provider operates in test simulation mode; FX rate is unpriced, preventing automatic customer cost calculation.
- **Scope**:
  - `lib/billing.ts`, `lib/config.ts`, `app/owner/config`
- **Prerequisites**: Active Razorpay merchant account and approved payment gateway.
- **Implementation Tasks**:
  1. Configure live Razorpay API keys and webhook secret on `kriya-web`.
  2. Set `KRIYA_FX_USD_INR` to the current RBI reference exchange rate (e.g., `84.25`) in `/owner/config`.
  3. Verify automated subscription provisioning upon receiving `subscription.charged` webhook.
  4. Test daily quota hard-stops on Free and Pro tiers when limits are exceeded.
- **Tests**:
  - End-to-end subscription upgrade using Razorpay live checkout.
  - Over-quota task rejection returns HTTP 402 with rupee top-up prompt.
- **Exit Criteria**: First live ₹799 Pro subscription processed and verified.

---

## Phase 5 — India-First Differentiators & Vernacular Voice
- **Objective**: Expand voice assistant to support Indian vernaculars (Hindi, Hinglish, Telugu) and deepen local business integrations.
- **Current Problem**: Voice dialogue currently operates in English only, limiting adoption across regional Indian users.
- **Scope**:
  - `lib/voice/languages.ts`, `lib/voice/providers.ts`
  - `lib/gst.ts`, `lib/ledger.ts`
- **Prerequisites**: API keys for Sarvam AI or Bhashini speech models.
- **Implementation Tasks**:
  1. Implement Sarvam AI STT (`saaras:v2`) and TTS (`bulbul:v1`) adapters in `lib/voice/providers.ts`.
  2. Add language detection and multi-lingual prompt conditioning for Hindi and Hinglish.
  3. Implement automated GST portal GSTR-1 draft export and counterparty GSTIN verification tools.
- **Tests**:
  - Conversational speech evaluation in Hindi/Hinglish achieves word error rate (WER) < 12%.
  - GST invoice export validates cleanly against official CBIC schema.
- **Exit Criteria**: Vernacular voice demo signed off by native Hindi/Telugu speakers.

---

## Phase 6 — Production Launch & Continuous Operations
- **Objective**: Open general availability to Indian users with automated alerting, error telemetry, and continuous improvement loops.
- **Current Problem**: Platform is not yet serving public traffic; operational playbooks must be finalized.
- **Scope**:
  - Monitoring, runbooks, and disaster recovery.
- **Prerequisites**: Phases 1 through 4 complete.
- **Implementation Tasks**:
  1. Switch `voice.liveCalls = "on"` in production owner dashboard.
  2. Configure uptime checks and latency alerts on Render and Supabase.
  3. Enable automated canary policy evaluation loop (`lib/improve.ts`) in worker.
  4. Conduct 360px physical Android device audit across low-bandwidth 4G networks.
- **Acceptance Criteria**: System achieves 99.9% task execution success across first 1,000 public tasks.
