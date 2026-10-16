# Security design and threat model

This describes what is protected, how, and what is **not yet** protected.
It isn't a claim that Kriya is production-secure: nothing here has had an
external review or penetration test.

## Assets

1. People's conversations, memories and agent instructions.
2. Credentials: Supabase secret key, database URL, OpenRouter, Firecrawl and
   Razorpay keys, session cookies, password-reset links.
3. Money: model spend on Kriya's OpenRouter account, subscription state.
4. The owner console and its ability to change plans, prices and accounts.

## Boundaries and controls

| Threat | Control | Where |
| --- | --- | --- |
| User A reads or edits user B's data by changing an id in a URL or request | Every user read and write runs as role `authenticated` with A's id; RLS on every table limits rows to `user_id = auth.uid()`. Composite foreign keys stop cross-user references at the database. Tested per table | `supabase/migrations`, `db/index.ts`, `tests/db/rls.test.ts` |
| Browser talks to the database directly with the publishable key | Tables are in schema `kriya`, which isn't exposed through the Data API. Even if it were, users only have `select` on tasks, usage, charges, subscriptions and plans | migration, deployment step 1.2 |
| Forged identity, role or plan in a request | Identity comes only from `getClaims()` (signature-verified JWT). Owner role is a row in `kriya.platform_roles`, writable only with database credentials (`scripts/grant-owner.ts`). Plan comes from `kriya.effective_plan_id()` | `lib/auth.ts`, `lib/entitlements.ts` |
| Bypassing limits from the browser | Daily tasks, rupee allowance, agent count, model tier and concurrency are all checked on the server or in SQL, never just hidden in the UI | `lib/entitlements.ts`, `lib/agent/queue.ts`, `kriya.claim_task` |
| CSRF | Non-GET requests must carry an `Origin` matching the app (proxy); server actions also check origin; session cookies are `httpOnly`, `SameSite=Lax` and `Secure` in production | `proxy.ts` |
| Open redirect after sign-in or email links | `safeNext()` allows same-site relative paths only | `lib/auth.ts` |
| Brute force and enumeration | Rate limits per IP and per email (hashed) in Postgres; sign-up, resend and reset answer identically whether or not the account exists | `lib/rate-limit.ts`, `actions/auth.ts` |
| Secret leakage | Secrets are env-only, never saved in the database or returned to the browser; the owner console shows presence only. `server-only` guards secret-handling modules from client bundles. Logs are structured JSON with keys and token-shaped values redacted | `lib/config.ts`, `lib/log.ts`, `lib/supabase.ts` |
| Forged or replayed payment events | HMAC-SHA256 over the raw body with a constant-time compare; events stored once by id; stale events ignored; plan state never changes on a redirect | `lib/billing.ts`, `tests/billing.test.ts` |
| Prompt injection through web pages | Web results are labelled untrusted in the tool output; the instructions forbid following embedded instructions or saving web content to memory unasked. **Capability limits matter more**: hosted agents have no tools that act outside Kriya, so injected text can't make them pay, send or delete anything | `lib/agent/tools.ts`, `lib/agent/instructions.ts` |
| Runaway cost | Per-task step budget, cost budget (aborts mid-run), deadline; per-user daily tasks and allowance; per-plan concurrency; burst limit on task creation | `lib/agent/run-task.ts`, plans |
| A task repeating something irreversible on retry | Tools are classed as side-effecting; a task that ran one is never requeued automatically, and owner retry refuses it | `SIDE_EFFECT_TOOLS`, `kriya.recover_tasks`, `actions/owner.ts` |
| SSRF from agent tools | Agents don't fetch URLs from Kriya's network: Firecrawl fetches on its side | `lib/web.ts` |
| XSS from model output | Markdown is rendered by Streamdown (no raw HTML); tool result links accept `http(s)` only | `components/thread` |
| Clickjacking, MIME sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, restrictive `Permissions-Policy` | `next.config.ts` |
| Owner misuse | Owner pages never select message, memory or instruction content; every owner action is audit-logged | `lib/owner.ts`, `kriya.audit_events` |
| Notifications on a lock screen | Browser notifications name the agent but never include reply text | `components/workspace/notifier.tsx` |

## Remaining risks (known, not fixed)

1. **No script-src Content-Security-Policy.** Next's inline bootstrap needs a
   nonce-based policy. Do this before any in-page payment UI.
2. **Single region, no tested restore.** Supabase backups exist on paid plans
   but no restore has been rehearsed. RPO/RTO are unknown.
3. **Polling for live updates.** Each open thread polls Postgres every 350 ms
   and each open tab every 3 s. Fine for early traffic; move to Supabase
   Realtime or LISTEN/NOTIFY (session pooler) before it becomes load.
4. **Rate limits are fixed-window** and keyed by the first `X-Forwarded-For`
   address, which Render sets. Behind another proxy, that key changes.
5. **Account deletion** cancels the subscription and deletes the auth user
   (cascading all content). Usage, charges and payments stay, de-identified,
   for accounting. A retention period and a written data policy (DPDP Act
   2023) are still needed.
6. **Prompt injection into memory**: an agent reading a hostile page could
   still be talked into writing a misleading memory. The person can see and
   delete every note; there is no automatic review.
7. **The owner bootstrap** trusts whoever holds the database credentials.
   Use separate Supabase projects for staging and production, and restrict
   who has production credentials.
8. **Legal pages are drafts.** Terms and privacy text must be replaced by
   reviewed documents before charging customers.
9. **No error-monitoring service** is wired in. Logs are structured for a log
   drain, but nothing pages anyone.
10. **Supabase's built-in email sender** is rate-limited; production needs
    custom SMTP.

## Reporting

Security problems: email the address in `KRIYA_SUPPORT_EMAIL` with
"security" in the subject. Don't open public issues for vulnerabilities.
