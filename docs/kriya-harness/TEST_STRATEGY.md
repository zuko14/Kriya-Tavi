# Test strategy (track H)

Server tests run in this repository's `npm test` (PGlite, no network): a fake
OpenRouter (local `http` server returning recorded streaming responses with
and without a usage chunk), fake devices, the file-store test hook. Client
tests run in `kriya-harness` against `contract.json` and a local fake of the
API; a real DSH boot test runs there (`kriya doctor`, `kriya run` with the
fake gateway). Nothing in either suite calls OpenRouter, GitHub or a real
Kriya deployment.

Baseline to keep in this repository: track C's (Test Files 185 passed, 3
skipped; Tests 2289 passed, 42 skipped; exit 0), no existing assertion
changed.

| Id | Behaviour | Where |
| --- | --- | --- |
| HT-REG-01 | With `harness.*` off: every harness route 404s; no other route, page, prompt or tool changes; `usageSummary` equals today's when no harness rows exist | `tests/harness/regression.test.ts` |
| HT-IMP-01 | `lib/harness` imports only the seams in ARCHITECTURE §4; never `lib/connectors`, `lib/agent/metering`, `lib/agent/run-task` | `tests/harness/imports.test.ts` |
| HT-AUTH-01 | Device flow happy path: code → approve in session → token once → authenticated request | `tests/harness/auth.test.ts` |
| HT-AUTH-02 | Token stored only as sha256; a second `/device/token` after consumption gets 410 | same |
| HT-AUTH-03 | Revoked device → 401 on the next request | same |
| HT-AUTH-04 | Idle past `harness.deviceIdleDays` → 401 | same |
| HT-AUTH-05 | Suspended profile → 403 | same |
| HT-AUTH-06 | Expired, denied and already-used codes refused; approval needs a session | same |
| HT-AUTH-07 | Rate limits on `/device/code`, polling faster than `interval`, and the connect action | same |
| HT-AUTH-08 | `authenticateDevice` rejects a session cookie and accepts only bearer tokens on harness routes; session helpers reject device tokens | same |
| HT-API-01 | Every route's request and response match `contract.ts`; `contract.json` export is current | `tests/harness/contract.test.ts` |
| HT-API-02 | Below `harness.minClientVersion` → 426 | same |
| HT-API-07 | `POST /memory` saves unconfirmed; search returns only the device agent's notes | `tests/harness/api.test.ts` |
| HT-API-08 | No route returns another person's rows (two users, every route) | same |
| HT-API-09 | No route can approve devices, answer approvals or confirm memory (route table checked) | same |
| HT-API-10 | `proxy.ts`: a `POST` to `/api/harness/v1/*` without an `Origin` passes the proxy (and is then judged by `authenticateDevice`); a `POST` without `Origin` to any cookie route (`/api/threads/…`, a server action) is still refused 403; `/connect/device?code=X` signed out redirects to `/login?next=%2Fconnect%2Fdevice%3Fcode%3DX` | `tests/harness/proxy.test.ts` |
| HT-GW-01 | Alias → tier model; unknown alias and disallowed tier refused | `tests/harness/gateway.test.ts` |
| HT-GW-02 | Streaming passthrough unchanged (chunks byte-equal except `model`); tools passed through | same |
| HT-GW-03 | Final usage chunk settles the reservation with real tokens and cost | same |
| HT-GW-04 | Cap reached → refused before forwarding; nothing sent upstream | same |
| HT-GW-05 | Rate limit and concurrent-stream limit | same |
| HT-GW-06 | `max_tokens` capped; `provider`/`models`/`route` fields stripped | same |
| HT-GW-07 | Aborted stream → `estimated` at the reservation, never zero | same |
| HT-GW-08 | Upstream 5xx → one retry on `routing.fallback`, then `upstream_unavailable` | same |
| HT-GW-09 | Capacity on staging: 50/100/200 concurrent streams, CPU and memory recorded (owner-approved, paid tokens kept tiny by the fake upstream on staging) | staging script |
| HT-GW-10 | No prompt or output in logs (logger spy) | unit |
| HT-MTR-01 | Charge uses plan markup and `fx.usdInr`; unpriced without the rate (null, counted) | `tests/harness/metering.test.ts` |
| HT-MTR-02 | `usageSummary` adds harness charges exactly once; voice and task sums unchanged | same |
| HT-MTR-03 | Janitor statement turns stale reservations into `estimated` | same |
| HT-MTR-04…06 | Usage page and owner tiles equal the ledger; plan form saves the cap; cap 0 refuses | same |
| HT-APR-01 | Request → Inbox lists it → session answer → long-poll returns it | `tests/harness/approvals.test.ts` |
| HT-APR-02 | Expiry → `expired`; local cancel → `canceled`; answered can't change | same |
| HT-APR-03 | Card data includes tool, redacted input and folder | same |
| HT-MIR-01 | Turns idempotent by `seq`; one thread per device session | `tests/harness/mirror.test.ts` |
| HT-MIR-02 | `summary` mode refuses `full` payloads; mirror off → 404 | same |
| HT-HND-01 | Handoff creates a workspace with the checkpoint and enqueues one task | `tests/harness/handoff.test.ts` |
| HT-HND-02 | Base commit not reachable / repo not connected / switches off → refused | same |
| HT-HND-03 | Hash or size mismatch refused; pull returns the latest checkpoint with its sha256 | same |
| HT-DB-01…07 | DATA_MODEL §6 | `tests/db/harness-rls.test.ts` |
| HT-REL-01 | Client: exact pins, lockfile, `THIRD_PARTY_NOTICES.md` regenerated and current | client CI |
| HT-REL-02 | Client: a release fails on an unknown or disallowed license | client CI |
| HT-REL-03 | Client: `--dump-config` of each profile matches the recorded expected rows (disabled plugins stay disabled; Web UI bound to loopback) | client CI |
| HT-UI-01…04 | UX_SPEC §3 browser checks | isolated stack |
