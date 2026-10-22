# Kriya Tavi — Repository Architecture & Technical Design

**Date:** 2026-10-21  
**Baseline Commit:** `51b1af6`  
**Author:** Principal Software Architect & Technical Auditor  

---

## 1. System Architecture Overview

Kriya Tavi is structured as a **distributed, state-externalized agent platform** organized around four decoupled services executing against a shared PostgreSQL database in Supabase (Mumbai `ap-south-1`). No application state, authentication token, or worker session is kept in local filesystem memory.

```mermaid
flowchart TB
    subgraph Client["Client Devices"]
        Mobile["Chrome on Android (360px)"]
        Desktop["Desktop Browser (1280px+)"]
    end

    subgraph Render["Render Cloud (Singapore)"]
        Web["kriya-web\nNext.js 16 (App Router)\nPort: $PORT"]
        Worker["kriya-worker\nNode.js Distributed Daemon\nConcurrency: 4"]
        Voice["kriya-voice\nNode.js WebSocket Server\nAudio: 8/16kHz PCM"]
        Browser["kriya-browser\nDocker Container (Playwright)\nEgress Proxy + Sandbox"]
    end

    subgraph Supabase["Supabase Cloud (Mumbai, ap-south-1)"]
        Auth["Supabase Auth (SSR JWT)"]
        DB[(PostgreSQL 17\nSchema: kriya\n70 Tables, 100% RLS)]
        Storage["Storage: kriya-files (Private)"]
    end

    subgraph External["External Cloud Services"]
        OR["OpenRouter\n(DeepSeek / Gemini / Claude)"]
        Exotel["Exotel Telephony\n(SIP / AgentStream WebSockets)"]
        FC["Firecrawl Web Search"]
        RZ["Razorpay Subscriptions"]
        Google["Google APIs (Sheets, Gmail, Calendar)"]
        Meta["Meta Graph API (Instagram)"]
        GitHub["GitHub REST API"]
    end

    Client -->|HTTPS / Session Cookies| Web
    Web -->|getClaims()| Auth
    Web -->|withUser: RLS Enforced| DB
    Web -->|privileged: Enqueue Task| DB
    Web -->|HTTP Streaming /turn| Client

    Worker -->|claim_task() SKIP LOCKED| DB
    Worker -->|Model Invocations| OR
    Worker -->|Web Research| FC
    Worker -->|WebDriver Commands| Browser
    Worker -->|OAuth API Calls| Google
    Worker -->|OAuth API Calls| Meta
    Worker -->|OAuth API Calls| GitHub
    Worker -->|Outbound Call Request| Exotel

    Exotel -->|Bi-directional Media Stream| Voice
    Voice -->|Claim Attempt Token| DB
    Voice -->|Turn Dialogue & Audio Frames| Exotel

    RZ -->|Signed Webhooks| Web
```

---

## 2. Service Inventory & Responsibilities

### 2.1 `kriya-web` (Web Application & Server API)
- **Path**: `app/`, `actions/`, `queries/`, `components/`, `proxy.ts`
- **Runtime**: Next.js 16.4.0 (Turbopack, Node.js 22, React 19.3.0)
- **Port**: Listens on platforms' dynamically assigned `$PORT` (default local: `6796`).
- **Core Responsibilities**:
  - Authenticates sessions via `@supabase/ssr` (`getClaims()`) in `proxy.ts`.
  - Enforces Origin verification and CSRF protection on all non-GET requests.
  - Exposes server components reading database data via `queries/` under `withUser`.
  - Exposes server actions modifying state via `actions/` with Zod validation.
  - Serves streaming turn updates (`/api/threads/[threadId]/turn`) polling `kriya.task_events`.
  - Handles incoming Razorpay billing webhooks with HMAC-SHA256 signature verification.

### 2.2 `kriya-worker` (Background Agent & Task Queue Daemon)
- **Path**: `worker/index.ts`, `lib/agent/`, `lib/memory/`, `lib/extract.ts`
- **Runtime**: Node.js standalone daemon (`tsx worker/index.ts`)
- **Concurrency**: Governed by `WORKER_CONCURRENCY` (default: 4 tasks).
- **Core Responsibilities**:
  - Atomic task claiming via `kriya.claim_task(worker_id, lease_seconds)`.
  - Multi-turn LLM reasoning loop (`lib/agent/run-task.ts`) with step and cost budgets.
  - Heartbeat maintenance every 5 seconds; automatic task recovery via `kriya.recover_tasks()`.
  - Executes approved tools under the authenticated user's RLS session (`withUser`).
  - Background memory summarization and maintenance jobs (`lib/memory/maintenance.ts`).
  - Cron schedule execution and recurring watcher triggers (`lib/schedules.ts`, `lib/watch.ts`).
  - Document extraction from uploaded files via vision models (`lib/extract.ts`).
  - Automatic rollback of model policy canaries based on metric degradation (`guardCanary()`).

### 2.3 `kriya-voice` (Real-Time Telephony Media Streamer)
- **Path**: `voice/index.ts`, `lib/voice/`
- **Runtime**: Node.js WebSocket media server (`tsx voice/index.ts`)
- **Port**: Dedicated HTTP/WebSocket server listening on `$PORT` (Render web service).
- **Core Responsibilities**:
  - Terminates Exotel's bi-directional audio WebSocket (`/streams`).
  - Authenticates stream upgrades using `KRIYA_VOICE_STREAM_SECRET` and per-attempt single-use tokens.
  - Manages real-time audio pipeline: 8kHz/16kHz PCM framing (20ms chunks), mu-law / linear conversion.
  - Handles interruption and barge-in (`clear()`) dropping unplayed audio chunks and resetting generation marks.
  - Coordinates conversation turns (`lib/voice/dialogue.ts`), STT integration, and prompt assembly.
  - Records audio metrics (`played_ms`, latency, user interruptions) in `kriya.attempt_metrics`.

### 2.4 `kriya-browser` (Isolated Sandbox Browser)
- **Path**: `browser/index.ts`, `browser/egress.ts`, `browser/session.ts`
- **Runtime**: Dockerized Chromium (`browser/Dockerfile`, Playwright 1.64.1)
- **Security**:
  - Has **zero database access** and zero platform secrets.
  - Controlled strictly via internal HTTP API authenticated by `KRIYA_BROWSER_SECRET`.
  - All outbound network requests are forced through a local HTTP egress proxy (`browser/egress.ts`).
  - Blocks loopback/LAN requests and limits browsing to domains explicitly declared in site loadouts.
  - Manages sealed browser login profiles (`lib/browser/profiles.ts`) stored as AES-256-GCM ciphertext.

---

## 3. Database Architecture & Tenancy Model

The database is PostgreSQL 17 deployed on Supabase. It uses a private schema named `kriya` containing **70 tables**.

### 3.1 Tenancy & Isolation Primitives
1. **Unexposed Schema**: The `kriya` schema is not included in Supabase's PostgREST API exposure. All external access is mediated by application server code.
2. **100% RLS Coverage**: Every table in schema `kriya` has `rowsecurity = true`.
3. **Dual Execution Paths (`db/index.ts`)**:
   - `withUser(userId, callback)`: Sets transaction-local config `request.jwt.claims` to `{"sub": userId}` and executes queries under Postgres role `authenticated`. Every RLS policy enforces `user_id = auth.uid()`.
   - `privileged`: Executes queries under server role `postgres` without RLS. Used exclusively for queue leases, system metering, webhook ingestion, and owner administration after explicit server-side role verification.
4. **Composite Foreign Keys**: Relationships between entities enforce user ownership in the constraint itself (e.g., `foreign key (agent_id, user_id) references kriya.agents(id, user_id)`), preventing cross-tenant references at the database engine level.

### 3.2 Schema Table Groups
- **Core & Identity (9 tables)**: `profiles`, `platform_roles`, `plans`, `subscriptions`, `payments`, `billing_events`, `platform_settings`, `audit_events`, `workers`.
- **Agents & Threads (8 tables)**: `agents`, `squads`, `squad_members`, `threads`, `messages`, `memories`, `approvals`, `episodes`.
- **Execution & Metering (8 tables)**: `tasks`, `task_attempts`, `task_events`, `tool_executions`, `usage_events`, `charges`, `models`, `rate_limits`.
- **Extended Capabilities (15 tables)**: `connections`, `thread_summaries`, `maintenance_jobs`, `resource_usage`, `browser_sessions`, `goals`, `schedules`, `schedule_runs`, `login_profiles`, `kits`, `skills`, `files`, `share_links`, `share_views`, `watch_state`.
- **Ledger & Invoicing (5 tables)**: `ledger_entries`, `invoice_series`, `invoices`, `claim_checks`, `obligations`.
- **Governance & Facts (4 tables)**: `fact_sources`, `public_facts`, `policy_versions`, `policy_task_versions`.
- **Telephony & Voice (21 tables)**: `voice_access`, `voice_profiles`, `phone_verifications`, `voice_tasks`, `voice_approvals`, `voice_calls`, `call_attempts`, `call_events`, `conversation_turns`, `call_outcomes`, `call_suppressions`, `voice_prices`, `voice_usage`, `voice_charges`, `allowed_transitions`, `voice_allowed_transitions`, `voice_transitions`, `voice_policy_versions`, `attempt_metrics`, `voice_feedback`, `voice_cases`.

---

## 4. End-to-End Data Flows

### 4.1 Chat Turn Execution Flow
```
User (Browser)
    │  POST /api/threads/[threadId]/turn
    ▼
proxy.ts (Auth check & CSRF Origin check)
    ▼
route.ts (Rate limit, parse body)
    ▼
lib/agent/queue.ts: enqueueTurn()
    ├─ withUser: Load thread, verify agent & entitlements
    ├─ privileged: Transaction (Insert user message + Insert task with status 'queued')
    └─ Return HTTP stream response (reading kriya.task_events)
    ▼
kriya-worker: claim()
    ├─ SQL: kriya.claim_task(worker_id, 30s) -> SKIP LOCKED
    ├─ Update task status to 'running'
    ▼
lib/agent/run-task.ts: runTask()
    ├─ Start heartbeat timer (renews lease every 5s)
    ├─ Load recent turns + memories (lib/memory/retrieve.ts)
    ├─ OpenRouter API invocation (AI SDK streamText)
    ├─ Stream chunks -> task_events (batch inserted)
    ├─ Tool call detected:
    │    ├─ Check risk class (lib/agent/policy.ts: R0-R5)
    │    ├─ If R2-R4: Create approval record, suspend task, notify UI
    │    ├─ If R0-R1: Execute tool in withUser context
    │    └─ Record in tool_executions
    ├─ Loop until finish-reason = 'stop'
    ├─ Record usage.cost in usage_events
    ├─ Compute rupee charge (lib/billing.ts / chargeTask)
    └─ Set task status = 'succeeded', save assistant message
    ▼
User (Browser): Receives final event and closes stream
```

### 4.2 Outbound Telephony Call Flow
```
User / Schedule / Agent Task
    │  POST /api/calls or voiceLoop()
    ▼
lib/voice/tasks.ts: createVoiceTask()
    ├─ Check recipient against kriya.call_suppressions (DND)
    ├─ Verify owner calling allowance & daily spend cap
    ├─ Insert kriya.voice_tasks (status: 'draft')
    └─ Insert kriya.voice_approvals (Requires owner consent)
    ▼
Owner approves call via UI /calls/[taskId]
    ▼
kriya-worker: voiceLoop()
    ├─ Claims due voice_task
    ├─ Transitions status: 'draft' -> 'approved' -> 'dialing'
    ├─ Calls Exotel API: POST /v1/Accounts/{SID}/Calls/connect
    │    └─ Passes webhook URL and media stream wss:// endpoint with one-time token
    ▼
Recipient answers phone
    ▼
Exotel connects to kriya-voice via WebSocket
    ├─ kriya-voice verifies Basic auth + token in kriya.call_attempts
    ├─ Plays AI Identity Disclosure: "Hello, I am Kriya, an automated AI assistant..."
    ├─ Streams bi-directional audio frames
    ├─ dialogueLoop(): STT -> Prompt -> LLM -> TTS -> Audio pump
    ├─ Handles barge-in via clear()
    └─ Upon call completion: Extract structured outcome (agreed time, status)
    ▼
Worker records call_outcomes, computes voice_charges, transitions status to 'completed'
```

---

## 5. Deployment Architecture (`render.yaml`)

The deployment architecture is fully declared in `render.yaml` for Render:

| Service Name | Render Type | Runtime | Region | Build Command | Start Command | Health Check |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `kriya-web` | Web Service | Node.js 22 | Singapore | `npm ci && npm run build` | `npm start` | `/api/health` |
| `kriya-worker` | Background Worker | Node.js 22 | Singapore | `npm ci` | `npm run worker` | Internal Heartbeat |
| `kriya-voice` | Web Service | Node.js 22 | Singapore | `npm ci` | `npm run voice` | `/health` |
| `kriya-browser` | Private Service | Docker | Singapore | Docker build (`browser/Dockerfile`) | Chromium runner | Port probe |

---

## 6. Security Boundaries & Invariants

1. **Secret Isolation**: Secrets reside strictly in server environment variables. They are never rendered in client components, never returned in API payloads, and never stored unencrypted in Postgres.
2. **Deterministic Risk Enforcement**: Risk classifications (R0–R5) are decided exclusively by compiled code in `lib/agent/policy.ts`. No LLM prompt or model instruction can lower a risk class or bypass an approval gate.
3. **Prohibited Capabilities (R5)**: The platform contains zero tools for submitting passwords, bypassing CAPTCHAs, handling credit card CVVs, or executing unassisted financial payments.
4. **Browser Containment**: `kriya-browser` has no database credentials, no access to other microservices, and all outbound network requests pass through an egress filter enforcing strict domain allowlists.
