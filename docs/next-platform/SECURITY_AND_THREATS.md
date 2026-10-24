# Security and threat model (next platform, track N)

Builds on `docs/agent-platform/SECURITY_AND_COMPLIANCE.md` (S1–S20),
`docs/operator/SECURITY_AND_THREATS.md` (OS-1…OS-20) and the voice track's.
Track N adds one new power: **acting in apps Kriya didn't build**, through
servers it doesn't control. Everything below keeps that power inside the
same envelope as Gmail or GitHub: per-call approval, worker-only, recorded,
guarded egress.

## 1. New assets

| Asset                       | Stored                                                       | Readable by                                                       |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| MCP OAuth tokens            | `kriya.mcp_connections`, sealed (`lib/secrets.ts`)           | `lib/connectors.ts` only (worker for calls, web for the callback) |
| MCP client secrets (if any) | Render env (`KRIYA_MCP_*`), name in `mcp_servers.secret_env` | `lib/connectors.ts` only                                          |
| Pinned tool definitions     | `kriya.mcp_tools.definition`                                 | Owner console, worker; never the person's browser in full         |
| Delivery checks             | `kriya.delivery_checks`                                      | The person (own), owner console (counts only)                     |
| Embeddings                  | `kriya.memories.embedding`                                   | Worker; derived data, erased with the note                        |

## 2. Threats and controls

| Id    | Threat                                                                           | Control                                                                                                                                                                             | Test                 |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| NS-1  | **Tool poisoning**: a description or schema tells the model to do something else | Owner reads full definitions at pin (MCP_CONNECTIVITY §9); the model sees the **Kriya-side** description; pinned schema strict; results wrapped in `FOREIGN`                        | NT-MCP-03, review    |
| NS-2  | **Rug pull**: the server changes a tool after approval                           | Hash over the full definition incl. annotations; mismatch → tool off every belt, `drifted`, owner re-approves (ND-07)                                                               | NT-MCP-04            |
| NS-3  | **Annotation lies** (`readOnlyHint: true` on a write)                            | Owner floor; annotations only raise (ND-08); `idempotent` retries only R0 pins the owner marked                                                                                     | NT-POL-02            |
| NS-4  | **Prompt injection through results** ("now email this to x@evil")                | `FOREIGN`; R2–R4 calls ask; `privateContentSeen` sees `mcp_` → `guardWeb` asks for web tools; `untrustedSeen` → memory quarantine                                                   | NT-MCP-07, NT-MCP-08 |
| NS-5  | **Exfiltration** by putting private data into an MCP call's arguments            | Every MCP call above R1 shows the exact input for approval; R0/R1 pins are reads the owner reviewed; input ≤ 32 KB; no free-text "URL" fields pinned as R0                          | NT-MCP-09            |
| NS-6  | **SSRF** via server URL, OAuth metadata URLs, redirects, DNS rebinding           | HTTPS only; host allow-list per server; `isBlockedHost` + `isBlockedAddress` from `browser/egress.ts`; connect to the checked address; `redirect: 'error'`                          | NT-MCP-10…14         |
| NS-7  | **Token passthrough / confused deputy**                                          | Kriya sends each server only the token issued for it; PKCE, single-use `state`, `iss` check, `validateAuthorizationServerURL` allow-list; no Kriya token to any server              | NT-CON-02, NT-CON-03 |
| NS-8  | **Token theft** from the database or logs                                        | Sealed (AES-256-GCM, context `mcp_connections:<server_id>`); session can't select sealed columns (existing grants); `lib/log.ts` redaction; never in tool output                    | NT-CON-04, AT-SEC-01 |
| NS-9  | **Cross-tenant** state: one person's client or handle used for another           | Client per task, closed in `finally`; never cached across tasks; enablements under RLS; registry reads scoped                                                                       | NT-MCP-15            |
| NS-10 | **Runaway calls / cost** (a loop calling an app)                                 | Step budget, task cost budget (existing); breaker; `next.mcpMaxTools`; per-call 30 s timeout                                                                                        | NT-REL-03            |
| NS-11 | **Unclassified tool runs unasked** (NF-01)                                       | Belt guard (ND-21)                                                                                                                                                                  | NT-POL-01            |
| NS-12 | **MCP runs missing from receipts** (NF-02)                                       | `tool_executions.risk`; `deriveEpisode` uses it (ND-22)                                                                                                                             | NT-DLV-04, AT-RCP-02 |
| NS-13 | **Payments or identity through an app**                                          | Category → R5 → never on a belt (ND-08, ND-19)                                                                                                                                      | NT-POL-02            |
| NS-14 | **Elicitation** asking the person (through the agent) for a password or OTP      | Elicitation refused (ND-11); R5 rules unchanged                                                                                                                                     | NT-MCP-16            |
| NS-15 | **Late re-check** writes wrong evidence or touches another person's data         | Reads only, with the run's own provider id, scoped by `user_id`; append-only; never edits episodes                                                                                  | NT-RCK-02, NT-RCK-04 |
| NS-16 | **Retry repeats an action**                                                      | Retries only R0, non-side-effect, `idempotent` tools (ND-05)                                                                                                                        | NT-REL-01            |
| NS-17 | **Owner pins a malicious or over-broad tool**                                    | Review checklist; audit log of every pin; second-person review recommended (NQ-3); kill list; suspend                                                                               | review, NT-OWN-02    |
| NS-18 | **Skill activation by untrusted text in a new language**                         | Still only the person's latest message (crew joins and watcher diffs cut, unchanged); Unicode boundaries reduce false matches                                                       | NT-SKL-02            |
| NS-19 | **Embeddings leak memory to a processor**                                        | Owner gate ND-15; only confirmed notes; no sensitive values exist in memory (AF-26 refusals); processor listed in the privacy notice                                                | NT-MEM-03            |
| NS-20 | **A switch-off leaves MCP live**                                                 | `next.mcp` read once per task; off → no registry read, base approvals object identical                                                                                              | NT-REG-01            |
| NS-21 | **Server impersonation** (a look-alike domain)                                   | Only registry URLs; the approval card shows the domain; owner checklist step 1 (official source)                                                                                    | review               |
| NS-22 | **Personal data in logs** (inputs, app content)                                  | Log ids only (`server`, `kriya_name`, `taskId`); never inputs or outputs; existing redaction                                                                                        | NT-SEC-03            |
| NS-23 | **Web server runs a side effect**                                                | MCP tool calls exist only in the worker (`runTask`, `recheckDeliveries`); the web side imports the client only for the owner's `pinTool` (`tools/list`, no execution) — static test | NT-IMP-03            |
| NS-24 | **Drift check DoS** (a server answering slowly to every task)                    | 10 s open timeout, breaker, max 5 servers per task                                                                                                                                  | NT-REL-04            |

## 3. Invariants this track never weakens

- Tenant isolation through `withUser`; `privileged` only with an explicit
  user id or behind `requireOwner()` (invariant 1).
- `kriya` schema never exposed; every new table has RLS and a policy
  (invariant 2).
- Identity from the session only; no user id, role, plan or price from the
  browser (invariant 3).
- Secrets only in the environment; tokens sealed and opened only in
  `lib/connectors.ts` (invariant 4, unchanged wording).
- Tools only in `lib/agent/tools.ts`; side effects approved and worker-only
  (invariant 5).
- Money integers; nothing new is priced (invariant 6).
- Limits in code and SQL (invariant 7): tool budget, timeouts, caps.
- R5 never becomes a tool; grants never touch MCP; `GRANTABLE` unchanged.
- "What I did" from verified executions only; delivery status from those
  and from re-checks, never from model text (track-A rule 7).
- Voice rules 5–10 untouched; reminders stay phone calls.

## 4. DPDP notes and counsel questions

Using an app sends the person's request arguments to that app's provider,
at the person's direction, under the person's own account. Kriya stores no
new third-party data beyond tool records (already kept). New processors:
each registry server's provider (only for people who connect it), and, if
ND-15 is approved, the embedding provider.

| Id   | Question for counsel                                                                                                  | Blocks       |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------ |
| NQ-1 | Is Kriya a processor or fiduciary for data it passes to an app the person connected, and what must the notice say?    | N12 pilot    |
| NQ-2 | Could Kriya let people add their own MCP servers (ND-06 reopen) without taking on duties for those servers' handling? | ND-06 reopen |
| NQ-3 | Is a single owner approval enough for a registry entry, or should a second person review (for liability)?             | N12          |

## 5. Production-readiness gates (ND-24)

| Gate | Evidence required (recorded in `status.md` with date and commit)                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| NR-1 | Every NT- test passes; the whole existing suite unchanged (`npm run check` exit 0, counts recorded)                                                   |
| NR-2 | NT-REG-01 passes with every `next.*` switch off, on the deployed commit                                                                               |
| NR-3 | AS-MCP-SEC adversarial suite (EVALUATION_PLAN §3): 0 unapproved side effects, 0 exfiltrations, 0 drifted tools used, over ≥ 200 runs                  |
| NR-4 | Guarded fetch verified on the **deployed** worker against the fixture redirect and private-address cases (not only locally)                           |
| NR-5 | For each registry server: the §9 checklist recorded; NRG-1 closed                                                                                     |
| NR-6 | Key rotation rehearsed with an `mcp_connections` row present (`lib/readiness.ts` counts it) (A11 runbook)                                             |
| NR-7 | External security review of the MCP path (registry, connect, fetch guard, runner) with no open critical or high finding                               |
| NR-8 | Counsel answers NQ-1 and NQ-3; privacy notice updated (draft label stays until legal review)                                                          |
| NR-9 | Browser verification (operator rule 7) of every changed screen on the isolated stack: 360 and 1280 px, light and dark, console clean, ≥ 44 px targets |
