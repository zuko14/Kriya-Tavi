# Kriya Tavi — Competitive Analysis & Market Landscape

**Date:** 2026-10-21  
**Auditor:** Principal Product Strategist & AI Market Specialist  
**Methodology:** Primary source documentation, repository inspection, release tracking, and architectural benchmarking.

---

## 1. Competitive Overview

Kriya Tavi occupies a unique strategic intersection: it combines **autonomous computer/browser use**, **enterprise-grade tenant security**, **Indian business workflow automation (GST/Ledger)**, and **real outbound telephone voice AI** into a mobile-first web interface.

### Competitors Evaluated:
1. **Xiryn (`SouravBeraAkaSpeed/xiryn`)**: The foundational open-source inspiration credited in Kriya Tavi (`package.json`). Xiryn provides containerized Docker agents with Linux desktops, Telegram controls, and web browsing.
2. **OpenAI ChatGPT Agents / "Dots"**: OpenAI's always-on agent framework featuring cloud-hosted computing environments and deep app integrations.
3. **Claude Computer Use (Anthropic)**: Native OS-level GUI automation using coordinate-based mouse and keyboard actions.
4. **Grok (xAI)**: Multimodal reasoning with real-time X search and low-latency voice mode.
5. **OpenClaw (`openclaw/openclaw`)**: Local-first open-source personal agent communicating via messaging channels (Telegram, WhatsApp, Discord, Slack).
6. **Equal AI / Ring / HeyTring (`myequal.ai`, `heytring.com`)**: India-first consumer call-screening assistant that intercepts incoming calls, handles delivery/spam in Hinglish, and transcribes conversations.
7. **Tring AI / Tring Labs (`tringlabs.ai`)**: Indian B2B outbound voice-calling automation platform for sales and customer engagement in vernacular languages.
8. **Bolna AI (`bolna.ai`)**: Open-source voice agent orchestration framework optimized for Indian telephony (Exotel, Twilio) and multilingual TTS/STT (Sarvam AI, ElevenLabs).

---

## 2. Capability Matrix

| Feature / Capability | **Kriya Tavi** | **Xiryn** | **OpenAI Dots** | **Claude Computer Use** | **OpenClaw** | **Equal / Ring** | **Bolna AI** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **General Conversational Chat** | ✅ Full | ✅ Full | ✅ Full | ✅ Full | ✅ Full | ⚠️ Voice-only | ⚠️ Voice-only |
| **Autonomous Multi-Step Tool Loops** | ✅ Verified | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ⚠️ Call-graph only |
| **Browser / Computer Use** | ✅ Supervised Playwright | ✅ Full Desktop Docker | ✅ Cloud VM | ✅ OS Coordinates | ⚠️ Headless only | ❌ No | ❌ No |
| **Persistent Tasks & Crash Recovery** | ✅ Postgres Leases | ❌ Process memory | ✅ Cloud queue | ❌ API session | ⚠️ Local SQLite | ❌ None | ⚠️ Celery/Redis |
| **Long-Term Memory & Redaction** | ✅ Typed + Redacted | ⚠️ Vector vault | ✅ Assistant memory | ❌ Ephemeral | ⚠️ Vector store | ❌ Call logs only | ❌ Session only |
| **Multi-Agent Specialist Teams** | ✅ Role Squads | ⚠️ Single agent | ⚠️ Workspaces | ❌ Single agent | ✅ Multi-agent | ❌ Single | ❌ Single |
| **Outbound PSTN/GSM Phone Calls** | ✅ Exotel Pipeline | ❌ No | ❌ No | ❌ No | ❌ No | ❌ Inbound Only | ✅ Yes (B2B) |
| **Call Outcome Extraction (Zod)** | ✅ Verified | ❌ No | ❌ No | ❌ No | ❌ No | ⚠️ Text Summary | ⚠️ Key-Value |
| **Phone-Only Reminders** | ✅ Enforced | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Indian Workflows (GST, Invoicing)** | ✅ Built-in | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Mobile-First UX (360px Chrome)** | ✅ 44px Touch Targets | ❌ Desktop/Telegram | ⚠️ Responsive web | ❌ API/Desktop | ⚠️ Messaging Apps | ✅ Mobile App | ❌ Admin Dashboard |
| **Indian Vernacular Languages** | ⚠️ English (HI/TE regex) | ❌ English | ⚠️ Multilingual | ⚠️ Multilingual | ⚠️ Multilingual | ✅ 10+ Indian Languages | ✅ 10+ Languages |
| **Deterministic Risk Policy (R0–R5)** | ✅ Code-only | ⚠️ Approval prompt | ⚠️ Safety classifier | ⚠️ Tool approval | ⚠️ Confirmation | ❌ N/A | ❌ N/A |
| **Multi-Tenant RLS Database** | ✅ 70 tables (100% RLS) | ❌ Single-user | ⚠️ Proprietary | ❌ API-only | ❌ Local SQLite | ⚠️ Cloud backend | ⚠️ Cloud backend |
| **Integer Rupee / Cent Cost Metering** | ✅ Micro-INR / Micro-USD | ❌ Token estimate | ⚠️ Account billing | ⚠️ API credits | ❌ Bring-your-own | ⚠️ Flat subscription | ⚠️ Per-minute |

---

## 3. Detailed Competitor Comparison

### 3.1 Xiryn vs. Kriya Tavi
- **Shared Heritage**: Kriya Tavi credits Sourav Bera (author of Xiryn) in `package.json`.
- **Architectural Divergence**:
  - *Xiryn* spins up heavy, full-blown Linux desktop containers inside Docker with XFCE/VNC and communicates via Telegram or local web. It is designed as a single-user, self-hosted power-user tool.
  - *Kriya Tavi* reimagines this for a **scalable multi-tenant SaaS**: it replaces heavy virtual desktops with lightweight, headless Chromium workers (`kriya-browser`), introduces enterprise Postgres RLS across 70 tables, adds strict egress network sandboxing, and integrates PSTN telephony.

### 3.2 OpenAI Dots & Claude Computer Use vs. Kriya Tavi
- **Strengths of US Frontier Models**: OpenAI and Anthropic have direct native model weights with coordinate vision training and massive cloud infrastructure.
- **Where Kriya Tavi Leads**:
  - **India-First Localization**: Native rupee (₹) pricing, GSTIN checksum verification, gapless tax invoicing, and Indian telecom compliance.
  - **Deterministic Policy Safety**: Frontier models rely heavily on LLM self-moderation or simple tool prompts. Kriya Tavi uses synchronous code-level regex inspection across English, Hindi, and Telugu, refusing R5 actions unconditionally.
  - **Real PSTN Telephony**: Neither ChatGPT nor Claude can place an outbound phone call to a local plumber or vendor in Bangalore and extract a confirmed appointment.

### 3.3 Equal AI (Ring / HeyTring) & Bolna AI vs. Kriya Tavi
- **Equal AI / Ring**: Focused entirely on **inbound consumer call screening** (answering spam or delivery calls on mobile phones via call forwarding). It does not perform autonomous computer work, browser tasks, or accounting.
- **Bolna AI**: Excellent open-source voice orchestrator for outbound marketing campaigns. However, it lacks personal assistant context, user task persistence, browser automation, and multi-agent coordination.
- **Kriya Tavi's Voice Niche**: Focused on **owner-directed personal assistance**—calling a specified contact with explicit instructions, negotiating a time/outcome, recording verifiable commitments, and placing voice-only reminder calls to the owner.

---

## 4. Strategic Advantages & Differentiators of Kriya Tavi

1. **Verified Action Over Chat**: "AI that acts, and proves it acted right." Every external action generates a verifiable receipt, read-back check, or structured outcome card.
2. **Deterministic Risk Boundaries**: Protects users from accidental commits or prompt injections on untrusted websites.
3. **India-First Affordability & Economics**:
   - Integrates cost-effective routing via DeepSeek V3/R1 and Gemini Flash via OpenRouter.
   - Transparent micro-rupee accounting ensures sustainable margins.
4. **True Multi-Tenancy**: Built from day one on Supabase Postgres RLS, avoiding the security compromises common in prototype agent wrappers.

---

## 5. Known Vulnerabilities & Competitive Threats

1. **Vernacular Speech Gap**: While Equal AI and Bolna support 10+ Indian languages with Sarvam AI voice models, Kriya Tavi's voice assistant is currently implemented in **English only**, with Hindi/Telugu present only in safety regex. Integrating Sarvam AI or Bhashini STT/TTS is vital for deep Indian penetration.
2. **Frontier Model In-Housing**: If OpenAI or Google natively bundle free SIP calling into Android Gemini or ChatGPT Voice, standalone calling wrappers will face commoditization unless deeply integrated into local Indian workflows (GST, UPI, banking, legal).
