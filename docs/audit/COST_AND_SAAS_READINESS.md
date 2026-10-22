# Kriya Tavi — Cost Modeling, Metering & SaaS Readiness Audit

**Date:** 2026-10-21  
**Auditor:** Principal FinOps & SaaS Business Systems Architect  
**Core Modules:** `lib/money.ts`, `lib/agent/metering.ts`, `lib/models.ts`, `lib/billing.ts`, `lib/voice/metering.ts`, `app/owner/`  

---

## 1. Cost Accounting & Precision Architecture

In strict accordance with AGENTS.md invariant 6, **money is stored as integers throughout the system**. Floating-point math is banned in all financial transactions to eliminate cumulative rounding errors.

### 1.1 Precision Hierarchy (`lib/money.ts`)
- **Micro-USD (`bigint`)**: $1.00 = 1,000,000 micro-USD. Model provider usage costs from OpenRouter are normalized to micro-USD.
- **Micro-INR (`bigint`)**: ₹1.00 = 1,000,000 micro-INR. All domestic Indian charges, telephony tariffs, and daily spend caps are accounted in micro-INR.
- **Paise (`bigint`)**: ₹1.00 = 100 paise. Customer-facing invoice totals and Razorpay subscription transactions are converted to paise at the billing boundary.
- **Foreign Exchange (FX)**: Conversion uses `KRIYA_FX_USD_INR` (configured by the owner or environment). If unconfigured, charges remain in an explicit `unpriced` state rather than fabricating an exchange rate.

---

## 2. Model Routing & Token Cost Analysis

Kriya Tavi routes tasks across three tiers (`lib/models.ts`), allowing users on basic plans to execute tasks cost-effectively while reserving expensive models for escalations.

### 2.1 Model Tiers & Economics (via OpenRouter)

| Tier | Primary Model Candidate | Input / 1M Tokens | Output / 1M Tokens | Typical Task Cost (5 Turns, 15k Tokens) |
| :--- | :--- | :---: | :---: | :---: |
| **Everyday (Budget)** | `deepseek/deepseek-chat` (V3) | ~$0.25 | ~$1.00 | **$0.007 (~₹0.60)** |
| **Balanced** | `google/gemini-2.5-flash` | ~$0.30 | ~$2.50 | **$0.015 (~₹1.25)** |
| **Expert (Escalation)**| `deepseek/deepseek-r1` / `claude-3.5-sonnet` | ~$0.70 / $3.00 | ~$2.50 / $15.00 | **$0.045–$0.12 (~₹3.80–₹10.00)** |

### 2.2 OpenRouter Ingestion Integrity
- OpenRouter returns `usage.cost` (in USD credits) within the terminal stream chunk.
- `lib/agent/metering.ts` captures this value:
  - If reported: Stored in `kriya.usage_events.reported_cost_micro_usd`.
  - If omitted: Falls back to catalogue calculation stored in `estimated_cost_micro_usd`.
  - If failed: Stored as `usage_status = 'missing'` with null tokens, never zero.
- Reconciled periodically via `/owner/operations` against OpenRouter generation logs.

---

## 3. Voice & Telephony Cost Model

Telephony calls combine multiple independent per-minute cost components:

| Component | Provider / Candidate | Tariff per Minute | Typical 2-Minute Call |
| :--- | :--- | :---: | :---: |
| **Telephony SIP Trunk** | Exotel / Plivo | ₹0.50 – ₹0.75 / min | ₹1.25 |
| **Speech-to-Text (STT)** | Deepgram Nova-2 / Sarvam AI | ~$0.0043 / min (~₹0.36) | ₹0.72 |
| **Text-to-Speech (TTS)** | ElevenLabs Turbo / Cartesia / Sarvam | ~$0.015 / min (~₹1.25) | ₹2.50 |
| **LLM Dialogue Stream** | DeepSeek V3 (Streaming) | ~$0.005 / min (~₹0.42) | ₹0.84 |
| **Total Estimated Cost**| — | **~₹2.70 – ₹3.20 / min** | **~₹5.50 – ₹6.50 / call** |

### 3.1 Spend Caps & Guardrails
- **Daily Platform Cap (`voice.dailySpendCapMicroInr`)**: Defaults to ₹500 (`500000000` micro-INR). Once total reported + estimated voice costs reach this ceiling, the worker immediately ceases claiming new outbound voice tasks.
- **Per-Task Cost Budget**: Each voice task carries an allocated spend ceiling in micro-INR, aborting the call if prolonged hold music or loops consume excessive credits.

---

## 4. SaaS Infrastructure & Fixed Operating Costs

Running Kriya Tavi on Render and Supabase incurs the following monthly baseline infrastructure overhead:

| Service | Instance / Plan | Region | Monthly Cost (USD) | Monthly Cost (INR) |
| :--- | :--- | :--- | :---: | :---: |
| **Render `kriya-web`** | Starter / Standard (1–2GB RAM) | Singapore | $7 – $25 | ₹600 – ₹2,100 |
| **Render `kriya-worker`** | Standard (2GB RAM, 1 CPU) | Singapore | $15 – $25 | ₹1,250 – ₹2,100 |
| **Render `kriya-voice`** | Starter (1GB RAM) | Singapore | $7 – $15 | ₹600 – ₹1,250 |
| **Render `kriya-browser`**| Standard (2GB RAM Chromium) | Singapore | $25 – $35 | ₹2,100 – ₹2,950 |
| **Supabase Pro** | Pro Database + Compute | Mumbai (`ap-south-1`) | $25 | ₹2,100 |
| **Firecrawl Search** | Scale Tier (Web Crawl) | Global | $19 | ₹1,600 |
| **Total Baseline Fixed** | — | — | **~$98 – $144 / mo** | **~₹8,250 – ₹12,100 / mo** |

---

## 5. Subscription Plans & Entitlements (`kriya.plans`)

The database includes three pre-configured subscription tiers:

1. **Free Tier (`free`)**:
   - Monthly Charge: ₹0
   - Daily Tasks: 15
   - Max Concurrency: 1 task
   - Daily Allowance: ₹20.00
   - Telephony Calling: Disabled (In-browser voice only)
2. **Pro Tier (`pro`)**:
   - Monthly Charge: ₹799 / month
   - Daily Tasks: 150
   - Max Concurrency: 3 tasks
   - Daily Allowance: ₹150.00
   - Telephony Calling: 60 minutes outbound calls included
   - Browser Automation & Connectors: Enabled
3. **Business Tier (`business`)**:
   - Monthly Charge: ₹2,499 / month
   - Daily Tasks: 500
   - Max Concurrency: 6 tasks
   - Daily Allowance: ₹500.00
   - Telephony Calling: 250 minutes outbound calls + voice reminders
   - Full Ledger, GST Invoicing, & Team Squads

---

## 6. Owner Dashboard Readiness (`app/owner/`)

The platform-owner dashboard is fully integrated with live database queries:
- **`/owner/config`**: Live management of platform settings, OpenRouter model overrides, FX rates, and live-call master switches.
- **`/owner/operations`**: Real-time worker status, running task counts, reconciliation of missing model token costs, and hung task force-termination.
- **`/owner/finance`**: Aggregated daily provider cost breakdown (Model USD vs. Telephony INR), platform revenue, and gross contribution margins.
- **`/owner/improve`**: Active canary tracking, policy version performance, and automated rollback status.

---

## 7. Commercial Blockers to Monetization

1. **Razorpay Live Merchant Account**: Webhook signatures are fully implemented, but live API keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) are needed to process real customer cards, UPI, and netbanking subscriptions.
2. **FX Rate Source Agreement**: `KRIYA_FX_USD_INR` must be configured in platform settings to enable automatic customer charge calculations.
3. **Exotel Billing Account**: Live outbound telephony requires prepaid credits and approved billing on Exotel's portal.
