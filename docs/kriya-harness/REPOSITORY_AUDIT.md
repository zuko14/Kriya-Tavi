# Repository audit for the Kriya Harness (track H)

What already exists that the Kriya Harness builds on, verified in the code at
`508bb6a` on 2026-10-31. The general baseline (services, task lifecycle,
check results) is in `docs/cloud-execution/REPOSITORY_AUDIT.md`; this file
adds only what track H depends on. The code is the fact.

## 1. Facts track H depends on

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| 1 | Identity comes only from the Supabase session: `getSessionUser` (`getClaims`), `requireUser`, `authenticate`, `requireOwner` | `lib/auth.ts`; AGENTS.md invariant 3 | A device token is a new identity source: it must be verified **in `lib/auth.ts`** (protected) with an invariant 3 wording change (HD-05) |
| 2 | Bearer tokens Kriya issues are stored only as sha256 hashes ("shown once and never kept") | `kriya.share_links.token_hash` (`20261110000000_files.sql`) | Device tokens follow the same pattern; no new sealed-secret category (invariant 4 unaffected) |
| 3 | No public API today: API routes are cookie-session routes listed in `proxy.ts` `PROTECTED_API` (`/api/threads`, `/api/events`, `/api/files/`, …) | `proxy.ts` | `/api/harness/v1/*` is a new, separately authenticated surface; it must not be swept into cookie redirects |
| 4 | `kriya-web` holds `OPENROUTER_API_KEY` but never calls models; models run in `kriya-worker` | `render.yaml` comment "Lets the web app refuse tasks when models are unreachable" | A streaming model gateway on `kriya-web` is new load on the web service (HD-06, capacity in COST_AND_METERING) |
| 5 | `usage_events.task_id` and `charges.task_id` are nullable; `recordUsage` and `chargeTask` require a task | migrations; `lib/agent/metering.ts` (protected) | Harness usage gets its own ledger, as voice did (HD-07) |
| 6 | Voice usage has its own tables and is added to the plan allowance in `usageSummary` | `lib/entitlements.ts` (voice phase 8, F9) | The precedent for "separate ledger, one allowance" |
| 7 | Rate limiting exists: `kriya.hit_rate_limit`, `lib/rate-limit.ts` `allow`/`allowAll` | code | Per-device and per-user gateway limits reuse it |
| 8 | Skills: curated catalogue (`CATALOG`, `CATALOG_V2`) plus the person's approved Studio skills (`personalCatalog`) | `lib/skill-library.ts`, `lib/skill-studio` | The harness can receive the same skills through an API (HD-10) |
| 9 | Memory v2 with quarantine: notes saved after untrusted reads are unconfirmed | `lib/memory/*`, `untrustedSeen` | Harness memory writes are always unconfirmed (local content is untrusted to Kriya) |
| 10 | Approvals: the Inbox (`kriya.approvals`) indexes tool calls waiting in a thread's reply; answered through `enqueueApproval` | `lib/agent/approvals.ts`, `lib/agent/queue.ts` | Harness approvals are a different object (a local action waiting on a person); they get their own table and appear beside Inbox items (HD-08) |
| 11 | In-app notifier: SSE `/api/events` polls the person's tasks every 3 s | `app/api/events/route.ts` | Harness approval requests reach the phone through the same notifier path (one more query) |
| 12 | Track C checkpoint format: base commit + binary patch in `kriya-files` | `docs/cloud-execution` CD-13 | Reused as the laptop ↔ cloud handoff format (HD-11) |
| 13 | Track C runner protocol | `docs/cloud-execution/TOOLS_AND_CONTRACTS.md` §2 | Reused for "your machine as an execution world" (HD-12) |
| 14 | Root `tsconfig.json` includes `**/*.ts`; root `npm ci` installs only the web app's dependencies; Render web/worker run Node 22 | `tsconfig.json`, `render.yaml` | A DSH-based client (Node ≥ 24.9, Cordis peer deps) inside this repo would break root typecheck unless excluded: the client lives in its own repository (HD-03) |

## 2. DeepSeek Harness facts (pinned `ce7073d`, npm read 2026-10-31)

| Fact | Evidence |
| --- | --- |
| Packages are published publicly; the CLI is `@deepseek-ai/dsh` with bin `dsh` | `apps/cli/package.json`; `npm view @deepseek-ai/dsh` → latest `0.2.1-rc.5` (modified 2026-10-29) |
| Other packages are release candidates too: `@deepseek-ai/dsh-base` `0.0.1-rc.1`, `@deepseek-ai/dsh-agent-loop` `0.1.0-rc.6`; the repository itself is at `0.2.2-alpha.2` | `npm view`; `package.json` files |
| Applications launch only through `dsh` profiles; custom composition = a profile + ordered patch files | upstream `AGENTS.md` "Application launch"; `docs/architecture.md` |
| `llm-pi-ai` routes requests to "OpenAI-compatible gateways" from configuration | `packages/llm/llm-pi-ai/README.md` |
| `user-approval` sends each request to the deployment's "human or machine answerers"; missing answerers fail closed | `packages/interaction/user-approval/README.md` |
| `session-persistence` is a backend-independent append-only API with a JSONL backend | `packages/session/session-persistence/README.md` |
| `credentials` + `authorization` support human-guided sign-in with a pluggable method | `packages/credentials/*/README.md` |
| ACP server and JSON-RPC SDK exist | `packages/acp`, `packages/sdk` |
| Experimental `liveshare` (share a session with viewers) and `agent-team` (lead, teammates, task board) | `packages/experimental/*/README.md` |
| `hooks-claude-code` runs existing Claude Code hooks | `packages/experimental/hooks-claude-code/README.md` |
| Brand: "built on DeepSeek Harness" is allowed; product names must not use the full trademark | `BRAND_GUIDELINES.md` |
| License MIT; Node ≥ 24.9; pre-stable APIs | `LICENSE`, `AGENTS.md` |

## 3. Findings (HF-…)

| Id | Finding | Handling |
| --- | --- | --- |
| HF-01 | DSH has no stable release yet (rc and alpha versions) | Pin exact versions; upgrade only by a recorded, tested bump (HD-02); the harness stays "beta" until DSH ships a stable line or our pinned version passes the HT suite for 30 days |
| HF-02 | One platform OpenRouter key would serve every harness user; OpenRouter's account-level rate limits for that load are unknown | HQ-01; gateway limits per user and per device; measured in H9 |
| HF-03 | `kriya-web` has no long-lived streaming endpoints today | Capacity test in H2 (HT-GW-09); the gateway can move to its own Render service later without changing the API (HD-06) |
| HF-04 | Invariant 3 names only session-based helpers | HD-05 amendment text, owner-gated |
| HF-05 | DSH's `SAFETY.md`: "experimental developer-preview software. It has not undergone a security audit and must not be treated as secure or production-ready"; its README: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" | The harness is labelled beta with Kriya's own safety notice shown at first run and in the README; readiness gate HG-6 (our plugins reviewed, pinned DSH version tested); no "production-ready" claim while DSH says otherwise |
| HF-07 | `proxy.ts` refuses every non-GET request whose `Origin` isn't Kriya's (CSRF guard), except paths in `WEBHOOKS`. A command-line client's `fetch` sends no `Origin`, so every harness `POST` would get 403 "Cross-site request refused." | `proxy.ts` gains a `TOKEN_API = ["/api/harness/"]` list exempt from the origin check (bearer-token routes read no cookies, so CSRF doesn't apply), with a test that cookie routes still require the origin (HT-API-10) |
| HF-08 | `proxy.ts` keeps `?next=` only for paths in `PROTECTED`; a signed-out person opening `/connect/device?code=…` must come back to it after login | `"/connect/"` added to `PROTECTED` |
| HF-06 | DSH's interactive surface is its local Web UI (`dsh web`, `127.0.0.1:3080`); headless, ACP and SDK are the other modes; no terminal UI is shipped (`apps/cli/README.md` names a `tui` profile only as an example "assuming the tui profile is installed") | `kriya` opens the local Web UI; `kriya run` uses the headless mode; a terminal UI is not promised (VISION §1) |
| HF-12 | `redactInput` (`lib/agent/approvals.ts`, track A) redacts only keys that *start with* `password`/`token`/`secret`/`otp`/`cvv`/`card` (so `apiToken` passes), and truncates inputs over 4 000 characters into `{ truncated }` *before* redacting, which would store a secret in a 4–8 KB harness input in clear (found 2026-11-01, H5) | `lib/harness/approvals.ts` walks the input first and redacts any value under a key naming a secret, then calls `redactInput` as API_AND_CONTRACTS §4 says (HT-APR-03). `redactInput` itself is unchanged (track A's file; whether to fix it for agent approvals is the owner's call) |
