# Kriya Tavi — UI & User Experience Audit

**Date:** 2026-10-21  
**Target Viewports:** 
- Mobile: **360px × 800px** (Indian smartphone baseline: Samsung Galaxy M-series, Redmi, Realme)
- Desktop: **1280px × 800px** (Standard laptop display)
**Evidence Baseline:** Live Next.js 16 server (`http://127.0.0.1:6796`), component source inspection, and recorded visual artifacts in `screenshots/` and `screenshots/voice-phase7/`.

---

## 1. Design System & Visual Tokenization

The visual design system of Kriya Tavi is implemented in `app/globals.css` and `tailwind.config` using HSL-tailored custom color tokens, modern typography, and strict mobile-first ergonomics.

### 1.1 Color Tokens
- **Rigel Indigo (`--color-rigel`)**: `hsl(232, 47%, 28%)` to `hsl(232, 60%, 15%)`. Deep, contemplative indigo serving as the structural backdrop and foundation tone, conveying institutional integrity and technical depth.
- **Betelgeuse Saffron (`--color-betelgeuse`)**: `hsl(38, 92%, 50%)` to `hsl(28, 95%, 48%)`. Warm, radiant amber/saffron highlight tone used for primary call-to-action buttons, active tabs, recording badges, and urgent human approval prompts.
- **Surface Neutrals**: Subtle layered cards (`bg-card`, `border-border/50`) with high-contrast foreground text ensuring WCAG 2.1 AA conformance across both Light and Dark themes.

### 1.2 Typography
- **Primary Sans**: Modern geometric sans-serif (Inter / Geist Variable) with optimized tabular figures for money and timestamps.
- **Small-Caps Metadata (`label-mono`)**: `font-family: var(--font-jetbrains-mono); font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;`. Used universally across agent cards, tool execution chips, and status badges.
- **Editorial Headings**: Fraunces / Serif accents for landing page value propositions and narrative highlights.

---

## 2. Screen-by-Screen Visual Inspection

### 2.1 Landing Page (`/`)
- **Desktop (1280px)**:
  - **Reference**: [`screenshots/01_landing_desktop.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/01_landing_desktop.png), [`screenshots/02_landing_pricing.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/02_landing_pricing.png)
  - **Visual Quality**: Hero section features atmospheric radial glows combining Rigel indigo and Betelgeuse saffron. The headline *"AI that acts, and proves it acted right"* sets an immediate professional tone.
  - **Live Preview Card**: Shows a simulated execution timeline of an agent analyzing UPI failure rates across bank nodes, highlighting tool calls, citations, and evidence verification chips.
  - **Pricing Matrix**: Displays transparent tiers (Free, Pro, Business) in Indian Rupees (₹), detailing daily task limits, concurrent workers, and telephony allowances.
- **Mobile (360px)**:
  - **Reference**: [`screenshots/04_landing_mobile_top.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/04_landing_mobile_top.png), [`screenshots/03_landing_mobile_bottom.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/03_landing_mobile_bottom.png)
  - **Responsiveness**: Zero horizontal overflow. Headline fluidly clamps to 28px. Navigation collapses neatly into an accessible drawer.
  - **Touch Targets**: All CTA buttons meet or exceed the **44px × 44px** minimum touch target standard.

### 2.2 Authentication Screens (`/login`, `/signup`, `/forgot-password`)
- **Reference**: [`screenshots/05_login_page.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/05_login_page.png), [`screenshots/06_signup_page.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/06_signup_page.png), [`screenshots/07_forgot_password_page.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/07_forgot_password_page.png)
- **Form Ergonomics**: Centered minimalist card layout with explicit input labels, password visibility toggle, clear focus rings, and inline error messages.
- **Security & Anti-Enumeration**: Forgot password form provides constant-time feedback preventing user email enumeration. Password inputs indicate a 10-character minimum requirement.

### 2.3 Workspace & Thread Interface (`/home`, `/a/[agentId]`)
- **Reference**: [`screenshots/voice-phase7/home-entry-360-light.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/home-entry-360-light.png), [`screenshots/voice-phase7/home-entry-no-agents-360-dark.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/home-entry-no-agents-360-dark.png)
- **Chat Ergonomics**: Streamed responses render markdown, tables, and structured tool executions (`components/thread/tool-call.tsx`).
- **Memory & Evidence Chips**: When an agent leverages prior memories or verifies a source, discrete chips (`metadata.memoryIds`) appear below the assistant message, allowing the user to view the retrieved premise.

### 2.4 Voice & Outbound Calls Interface (`/calls`)
- **Reference**: [`screenshots/voice-phase7/calls-360-dark.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/calls-360-dark.png), [`screenshots/voice-phase7/calls-new-360-light.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/calls-new-360-light.png), [`screenshots/voice-phase7/confirm-card-360-light.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/confirm-card-360-light.png)
- **Call Preparation & Approval**: Before any outbound call is dialed, the user is presented with a structured confirmation sheet: recipient number, call objective, proposed talking points, and estimated cost.
- **Microphone States**: Includes verified visual states for permission prompt, active listening, speaking, denied permission (`calls-new-mic-denied-360-light.png`), and unsupported browser fallback.

### 2.5 Accounts, Invoicing & GST Interface (`/accounts`)
- **Features**: Gapless sequence invoice generator, single-entry ledger overview, and GST liability tracker.
- **Ergonomics**: Quick filters for financial quarters, downloadable tax invoice previews, and mod-36 validation on counterparty GSTIN inputs.

---

## 3. Detailed UX Findings & Recommendations

| Finding ID | Severity | Location | Issue Description | Recommended Resolution |
| :--- | :--- | :--- | :--- | :--- |
| **UX-01** | Low | `/calls/new` | Browser Web Audio API cannot be tested in headless CI without a mock media stream. | Add automated WebRTC audio fixture fallback in development mode. |
| **UX-02** | Medium | `/login` | If Supabase server is unreachable, the error toast lacks retry guidance. | Add network diagnostic helper: *"Unable to reach authentication server. Check your connection or try again in 1 minute."* |
| **UX-03** | Low | `/accounts` | Long invoice line-item descriptions truncate at 360px viewport on older devices. | Implement responsive expandable rows on mobile tables. |
| **UX-04** | Low | Dark Mode | High-contrast borders on inactive cards appear slightly intense on OLED mobile screens. | Adjust dark mode card border opacity from `0.15` to `0.08` for softer aesthetic hierarchy. |

---

## 4. Accessibility & Mobile Compliance

- **Touch Target Compliance**: 100% of tested interactive elements meet the **44px × 44px** standard.
- **Reduced Motion Support**: All CSS keyframe animations respect `@media (prefers-reduced-motion: reduce)`, verified via [`screenshots/voice-phase7/confirm-card-360-light-reduced-motion.png`](file:///Users/chaitanyakumarmanda/Developer/Kriya-Tavi/screenshots/voice-phase7/confirm-card-360-light-reduced-motion.png).
- **Color Contrast**: All text styles achieve a contrast ratio > 4.5:1 against their backgrounds, conforming to WCAG Level AA standards.
