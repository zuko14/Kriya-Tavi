# Decisions (next platform, track N)

All decisions are **Proposed** until the owner approves them in
`status.md` ("Track N owner approvals"). A phase may start only when every
decision it lists is Approved. Format, as in the other tracks: decision,
why, alternatives rejected, what it binds.

The "Owner gate" column marks decisions that touch a protected file, an
AGENTS.md invariant or rule, or send data to a new processor. Those need a
**separate, explicit** approval naming the decision id; a batch "approve
all" message does not count for them.

| Id    | Decision                                                                      | Needed by | Owner gate                                                      |
| ----- | ----------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| ND-01 | Build on Kriya's runtime: no new service, queue or agent framework            | all       | —                                                               |
| ND-02 | Folder, ids, migration range, `next.*` switches                               | all       | —                                                               |
| ND-03 | Delivery status is computed by code from records                              | N2        | —                                                               |
| ND-04 | One late re-check of unverified side-effect runs, append-only                 | N3        | —                                                               |
| ND-05 | Transient retries for idempotent reads only; per-provider circuit breaker     | N4        | —                                                               |
| ND-06 | MCP: remote servers from an owner-curated registry only                       | N5        | **Yes** (new outside systems)                                   |
| ND-07 | Pinned, hashed tool definitions; drift removes the tool                       | N1, N5    | —                                                               |
| ND-08 | MCP risk classes decided in `lib/agent/policy.ts`; annotations only raise     | N5        | **Yes** (safety module)                                         |
| ND-09 | MCP tokens in `kriya.mcp_connections`, opened only in `lib/connectors.ts`     | N6        | **Yes** (protected file, invariant 4)                           |
| ND-10 | MCP tool calls only in the worker; egress through the existing guard's checks | N5        | **Yes** (imports from protected `browser/egress.ts`, read-only) |
| ND-11 | MCP output is untrusted and private; elicitation refused                      | N5        | —                                                               |
| ND-12 | MCP read-back mapping; claim-row change deferred                              | N7        | (the later `verify.ts` row: **Yes**)                            |
| ND-13 | Kriya names for MCP tools; per-agent enablement by the person; tool budget    | N5, N6    | —                                                               |
| ND-14 | Skills v2: Unicode keyword matching and new curated skills                    | N8        | —                                                               |
| ND-15 | Memory recall v2: embedding rerank in TypeScript, behind an eval gate         | N9        | **Yes** (memory text to an embeddings processor)                |
| ND-16 | Cost: measure caching first; MCP tool budget; no invented prices              | N10       | —                                                               |
| ND-17 | Delivery metrics NM1–NM10 and the owner page                                  | N2, N12   | —                                                               |
| ND-18 | Kriya as an MCP server: deferred with a trigger                               | —         | —                                                               |
| ND-19 | India-first scenarios; payments and bookings stay R5                          | N11       | —                                                               |
| ND-20 | Positioning and competitor claims                                             | —         | —                                                               |
| ND-21 | Belt guard: no unclassified tool runs                                         | N5        | **Yes** (always on, not behind a switch)                        |
| ND-22 | `tool_executions.risk` for MCP runs; `deriveEpisode` reads it                 | N1, N5    | **Yes** (changes how receipts are derived for new runs)         |
| ND-23 | Switch dependencies                                                           | all       | —                                                               |
| ND-24 | Production-readiness gates NR-1…NR-9                                          | N12       | —                                                               |
| ND-25 | MCP approvals: exact call, every time; never grantable in v1                  | N5, N6    | —                                                               |

## ND-01 Build on Kriya's runtime

**Decision.** Track N adds modules under `lib/delivery/`, `lib/reliability/`
and `lib/mcp/`, new tables in `kriya`, worker steps inside existing loops
and UI. No new Render service, no change to `kriya.tasks`, `claim_task`,
`heartbeat_task` or `recover_tasks`, no agent framework, no second
approval path. MCP tools run inside `runTask` like every other tool.

**Why.** The queue, recovery, approvals, metering, receipts and grants are
proven by existing suites; a parallel engine would split evidence and
need its own recovery proofs (same reasoning as AD-01, OD-01).

**Rejected.** A separate "MCP gateway" service (a second place tokens
live); an external agent framework; letting the model provider call MCP
servers itself (OpenAI's Responses-API MCP tool is noted in the AI SDK
docs) — Kriya would lose per-call approval, egress control and records.

## ND-02 Folder, ids, migration range, switches

**Decision.**

- Folder `docs/next-platform/`. Not `docs/next/` (reads as Next.js, whose
  docs agents must read under `node_modules/next/dist/docs/`), not
  `docs/platform-v2/` ("v2" suggests a rewrite, which this track forbids).
  Kebab-case like `agent-platform`.
- Track letter **N**; phases `NP-1`, `N0`…`N13`; ids `ND-` decisions,
  `NT-` tests, `NS-` threats, `NM` metrics, `NG-` golden scenarios,
  `NSC-` scenario catalogue, `NB-` blockers, `NF-` findings, `NQ-` counsel
  questions, `NRG-` research gaps, `NR-` readiness gates. Checked
  2026-10-24: none of these prefixes is used elsewhere (as whole ids).
- Migrations `202701DDhhmmss_*` (after track O's `202612…` and
  `20261202000000_skill_library`); one migration writer at a time across
  all tracks, timestamp claimed on the board.
- Switches `next.*` in `lib/config.ts` `SETTINGS`, all default `off`,
  edited in `/owner/config` (one new `GROUPS` entry, "Next platform").

| Switch                | Default | Effect                                                                       |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| `next.delivery`       | `off`   | Delivery status on "What I did" and the owner page (N2)                      |
| `next.recheck`        | `off`   | The worker's late re-check step (N3)                                         |
| `next.reliability`    | `off`   | Read retries and circuit breaker in the runner (N4)                          |
| `next.mcp`            | `off`   | MCP tools on the belt for people who connected an app (N5–N7)                |
| `next.mcpConnect`     | `off`   | The Account "Apps" section and the connect flow (N6)                         |
| `next.mcpMaxTools`    | `20`    | Most MCP tools on one belt (ND-13)                                           |
| `next.skillsV2`       | `off`   | Unicode keyword matching and the v2 skills (N8); needs `agents.skillLibrary` |
| `next.memoryRerank`   | `off`   | Embedding rerank of recall candidates (N9); needs `agents.memoryV2`          |
| `next.embeddingModel` | unset   | OpenRouter embedding model id (N9); unset = rerank off whatever the switch   |
| `next.promptCache`    | `off`   | Provider cache markers on routes where NRG-2 verified them (N10)             |

## ND-03 Delivery status is computed by code

**Decision.** `lib/delivery/status.ts` exports a pure
`deliveryOf(episode, checks)` returning one of:

| Status               | Rule                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `delivered`          | At least one `done` action, no `unconfirmed` entry left after late checks, no unsupported citation     |
| `partly`             | At least one `done` action and at least one remaining `unconfirmed` entry or unsupported citation      |
| `not_confirmed`      | No `done` action, at least one `unconfirmed` entry (a claim, a failed or unchecked run)                |
| `nothing_to_deliver` | No `done` and no `unconfirmed` (a pure answer or research reply; citation checks still shown as today) |

An `unconfirmed` entry with an `executionId` counts as resolved when a
`delivery_checks` row for that execution is `verified` (ND-04). The
episode itself is never rewritten. The model never sees or sets the status.

**Why.** "What I did" already separates verified actions from claims; the
person still has to judge the whole. A single computed answer is what a
real-world action product owes.

**Rejected.** A model judging "did it work"; storing the status on
`episodes` (it would enter or sit beside the receipt hash and go stale
after a late check).

## ND-04 One late re-check, append-only

**Decision.** For a succeeded side-effect run whose `verification.status`
is `unverified` (or missing for a tool whose registry entry says
`api_readback`), the worker re-checks **once**, between 2 and 30 minutes
after it finished, with the same read the tool used (functions already
exported by `lib/connectors.ts`, e.g. `calendarEvent`; MCP runs use their
read-back mapping, ND-12). The result is a new row in
`kriya.delivery_checks`. Episodes, `tool_executions.verification` and
receipt hashes are never changed. A `failed` verification is not
re-checked (it failed; only the person decides what next).

**Why.** Provider lag makes some read-backs inconclusive; a single later
check turns many "not checked" lines into proof without retries of the
action itself.

**Rejected.** Re-running the action; updating the episode (breaks
`verifyChain`); repeated polling (cost, rate limits).

## ND-05 Transient retries for idempotent reads only; circuit breaker

**Decision.** `lib/reliability/retry.ts` wraps, at belt-build time and
only with `next.reliability` on, the `execute` of tools that are **R0 and
not side effects** and whose capability says `idempotent: true` (a new
optional field in `lib/agent/capabilities.ts` `FACTS`, set only on reads).
Retry: at most 2 more attempts, 500 ms and 1,500 ms, only on a typed
transient error (HTTP 429, 502, 503, 504, a network timeout); a
`Retry-After` above 5 s means no retry. `lib/reliability/breaker.ts`: per
worker process, per `system` (google, notion, github, meta, each MCP
server), 5 transient failures within 60 s open the circuit for 60 s;
while open, tools of that system return a typed error at once ("<App>
isn't responding; Kriya stopped trying for a minute") and the task goes on.

Never wrapped: anything in `SIDE_EFFECT_TOOLS`, any R1–R5 tool, any MCP
tool whose class is not R0, browser tools (their own service), skill
replay.

**Why.** Reads are safe to repeat; actions are not (the queue already never
retries a task that ran one). A breaker stops a dead provider from eating
the step budget.

**Rejected.** Retrying side effects with idempotency keys (most providers
offer none for these calls); a shared breaker in the database (cross-worker
state for a 60-second window isn't worth a table).

## ND-06 MCP: remote servers from an owner-curated registry only

**Decision.** Kriya connects only to **remote MCP servers over HTTPS**
(Streamable HTTP; SSE only if a registry entry says so) that the **owner**
added to `kriya.mcp_servers` after the review in MCP_CONNECTIVITY §9.
No stdio transport, no local servers, no URL typed by a person, no server
suggested by content. A person can only connect (OAuth) to a registry
server and choose which agents may use it. The client is `@ai-sdk/mcp`
`createMCPClient`, created in the worker per task and closed in `finally`.

**Owner gate.** Each server added is a new outside system receiving the
person's requests: the owner approves the decision **and** each server
(audited, `audit_events`).

**Reopen trigger for person-added servers.** All of: NR-1…NR-9 passed for
registry servers; 90 days of NM8 (MCP incidents) = 0; an external review of
the MCP path with no open high finding; counsel answer NQ-2.

**Rejected.** Person-added servers now (tool poisoning, SSRF, rug pulls at
scale); stdio servers on Render (AD-24); a public MCP marketplace import.

## ND-07 Pinned, hashed tool definitions; drift removes the tool

**Decision.** Only tools the owner pinned exist. A pin stores the full
definition the server returned (`name`, `title`, `description`,
`inputSchema`, `outputSchema`, `annotations`) and `definition_hash` =
sha256 of its canonical JSON (sorted keys, as `lib/agent/episodes.ts`
`canonical` does; reused, not copied). At each task the worker lists the
server's tools; a pinned tool whose current hash differs is **drifted**:
it is left off the belt, a `mcp_tools` row moves `pinned → drifted`, and
the owner sees it on `/owner/apps`. Only the owner re-approves (new hash).
The model's input schema is the **pinned** schema passed to
`client.tools({ schemas })`, so tools not pinned are never loaded.

**Why.** OWASP's rug-pull control (COMPETITOR_RESEARCH §2).

**Rejected.** Trusting live descriptions; hashing the description only
(annotation flips change approval behaviour, OWASP).

## ND-08 MCP risk classes decided in `lib/agent/policy.ts`

**Decision.** A new pure function in `lib/agent/policy.ts`:

```ts
export function classifyMcpTool(tool: {
  ownerRisk: "R0" | "R1" | "R2" | "R3" | "R4" | "R5"
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
  }
  category?: "payments" | "identity" | "credentials" | "filing" | null
}): RiskClass
```

Rules, in order: a `category` in the R5 list → **R5** (never on a belt);
otherwise start from `ownerRisk`; `readOnlyHint !== true` raises to at
least **R3**; `destructiveHint === true` or `openWorldHint === true`
raises to **R4**. Annotations can only raise. `ownerRisk` defaults to
`R4` in the table. MCP results are never `R0`/`R1` side-effect-free unless
both the owner said so and the server says `readOnlyHint: true`.
`SIDE_EFFECT` for an MCP tool = class ≥ R2. No existing value in
`TOOL_CLASSES`, `approvalFor` or the browser policy changes.

**Why.** Track-A rule 3: classes come from code in `policy.ts`, never a
model; the AI SDK states annotations are untrusted hints.

**Rejected.** Classes from annotations alone; one class for a whole server.

## ND-09 MCP tokens in their own sealed table, opened only in `lib/connectors.ts`

**Decision.** A new table `kriya.mcp_connections` (one row per person per
server; N6 migration) holds MCP OAuth tokens as ciphertext from
`lib/secrets.ts` (context `mcp_connections:<serverId>`), with exactly the
grants and policies `kriya.connections` has
(`20261017000000_connections.sql`): the person's session may select the
non-token columns and delete its own row; only the server writes; the
sealed columns are never granted. `lib/connectors.ts` gains **additive**
functions only: `mcpAuthProvider(userId, serverId)` (an
`OAuthClientProvider` for `@ai-sdk/mcp` whose `tokens()` opens and
`saveTokens()` seals) and `mcpDisconnect(userId, serverId)`. Existing
functions, `ConnectionProvider`, `CONNECTION_PROVIDERS`, `kriya.connections`
and `tests/connectors.test.ts` stay unchanged. `validateAuthorizationServerURL`
accepts only the server's `allowed_auth_origins`; the callback `iss` must
match; the PKCE verifier travels in a sealed, HttpOnly, single-use cookie
like `OAUTH_STATE_COOKIE`. Client registration: a pre-registered public
client id (PKCE) or a Client ID Metadata Document Kriya hosts; a
confidential client secret only from an environment variable whose
**name** the registry stores (`secret_env`), never the value.

**Why a separate table.** Five existing readers of `kriya.connections`
assume the four providers (`queries/connections.ts` `connectionHealth`
keys its result by provider; `lib/connectors.ts` `listConnections` feeds
the Account page; `lib/agent/run-task.ts` `loadContext`;
`queries/mandates.ts` `playbookNeeds`; `queries/skills.ts`), and the
Drizzle column is typed `text({ enum: CONNECTION_PROVIDERS })` (NF-08). An
`mcp:` row there would reach all of them. A separate table changes none of
them. Invariant 4 stays word for word true: tokens are stored only as
ciphertext and opened only in `lib/connectors.ts`.

**Owner gate.** Protected file (`lib/connectors.ts`, additive) and a new
place tokens are **stored**; `lib/readiness.ts` key-rotation counts gain
the new table (CHANGE_IMPACT).

**Rejected.** Widening `connections_provider_check` to `mcp:<id>` (reaches
the five readers above); opening tokens in `lib/mcp/*` (breaks invariant
4); storing client secrets in the database.

## ND-10 MCP tool calls only in the worker; guarded egress

**Decision.** `lib/mcp/fetch.ts` builds the `fetch` passed to the MCP
transport: HTTPS only; host must equal the server's host or one of its
`allowed_auth_origins`; DNS resolved first and every address checked with
`isBlockedAddress`, host with `isBlockedHost`, both **imported** from
`browser/egress.ts` (no copy, no change); `redirect: 'error'`; 10 s
timeout; 2 MB response cap. No MCP **tool call** ever runs in
`kriya-web`. The web server only runs the OAuth redirect and callback
(through `lib/connectors.ts`, like Google today) and, for the owner's
`pinTool` action, one `tools/list` metadata request through the same
guarded fetch (no tool executes). Static test NT-IMP-03 asserts that
`callTool`/`tools()` execution is reachable only from `lib/agent/run-task.ts`
and `lib/delivery/recheck.ts` (worker).

**Owner gate.** Imports from a protected module (read-only); a static
test (NT-IMP-02) asserts `browser/egress.ts` keeps importing only Node
built-ins, so the worker pulls in nothing else.

**Rejected.** A copy of the block list (two lists drift); routing MCP
through `kriya-browser` (it has no secrets by design and must not get
tokens).

## ND-11 MCP output is untrusted and private

**Decision.** Every MCP tool result is returned as `{ notice: FOREIGN,
result }` (the existing `FOREIGN` text). `privateContentSeen` and
`untrustedSeen` in `lib/agent/tools.ts` also match tool names starting
`mcp_` (NF-04), so `guardWeb` and memory quarantine apply exactly as for
Gmail. Server **elicitation** requests are refused (the person isn't in
the task; R5 if it asks for credentials). MCP resources, prompts,
completions, apps and events are not used in v1.

## ND-12 MCP read-back mapping; claim row deferred

**Decision.** A pinned side-effect tool may carry an owner-written
`verify` spec: another **pinned R0 tool of the same server**, argument
paths from the first call's structured result (JSON pointer), and the
fields that must match. The runner runs it right after the call, adds a
Kriya `verification` (`method: "api_readback"`), and ND-04 re-checks once
if inconclusive. Without a spec the run is "Ran, but wasn't checked".
The `verify.ts` claim row that says Kriya can't post (NF-05) is **not**
changed in v1; a later owner-gated decision may add one row backed only
by a verified MCP side-effect run.

## ND-13 Kriya names, per-agent enablement, tool budget

**Decision.** The owner names each pinned tool `mcp_<server>_<tool>`
matching `^mcp_[a-z]{2,12}_[a-z_]{2,22}$` (≤ 40 characters), so the
existing kill list `operator.disabledTools` kills MCP tools too and
`actionTitle` has a stable key. The person enables a connected app for
all agents or chosen agents (`kriya.mcp_enablements`, person-only write).
A belt gets at most `next.mcpMaxTools` (default 20) MCP tools: the
enabled apps' tools in registry order; the rest are left off and the
prompt line says which apps were trimmed.

## ND-14 Skills v2

**Decision.** Behind `next.skillsV2` (and `agents.skillLibrary`): the
matcher in `lib/skill-library.ts` uses Unicode lookarounds (the
`wordsPattern` style in `lib/agent/policy.ts`, exported for reuse); manifests
may list Hindi, Telugu and romanised keywords (data); new curated skills
only for tools that exist (`delivery-proof`, always eligible, and
`indian-documents-reading`, which needs `file_read`). MCP guidance is not
a skill (a manifest can't name dynamic tools, NF-07): it is one prompt
line present only when MCP tools are on the belt (TOOLS_AND_CONTRACTS §5).
The v2 skills live in a separate list (`SKILL_MANIFESTS_V2` in
`skills/index.ts`); `lib/skill-library.ts` builds `CATALOG_V2 = CATALOG +
v2`, and the runner passes it through `resolveSkills`' existing `catalog`
input only with the switch on (the Creator's `queries/skills.ts` does the
same). Still: no external or user skills, nothing executed, skills never
add tools. Off: today's matcher and `CATALOG` exactly.

## ND-15 Memory recall v2: embedding rerank

**Decision.** Gate first: run AS-MEM (track A) and the new AS-MEM-ML on
the current code; proceed only if M1 < 0.90 (true today: 0.80). Then,
behind `next.memoryRerank` and a set `next.embeddingModel`: a nullable
`memories.embedding real[]` (new migration), filled by a maintenance job
on the budget path for confirmed notes only; at recall, FTS returns up to
50 candidates as today, the query is embedded once, and candidates are
reranked by cosine similarity in TypeScript, fused with the existing
score by reciprocal rank. No `vector` extension (track-O migration rule
2: no extensions; PGlite-compatible). Cost to `resource_usage` kind
`embedding_tokens` (already allowed) as platform cost, inside
`agents.maintenanceCapMicroUsd`. Rollout only if AS-MEM M1 improves by
more than its noise (AD-09's rule).

**Owner gate.** Memory text goes to a new processor (the embedding
provider via OpenRouter); privacy notice update (DPDP processor list);
NRG-3.

**Rejected.** pgvector now (extension, RG-8 unresolved); embedding
unconfirmed or untrusted notes.

## ND-16 Cost

**Decision.** (1) Measure before changing: C3 cache ratio from
`usage_events.cached_tokens` per route on staging (track A metric).
(2) Cache markers only on routes where NRG-2 proved they pass through,
behind `next.promptCache`. (3) MCP tool budget (ND-13) and short pinned
descriptions (owner may shorten the **Kriya-side** description at pin
time; the hash still covers the server's). (4) Read retries and the
breaker save wasted steps (ND-05). (5) Report "₹ per delivered task"
(NM6). Every price comes from `kriya.models` (synced from OpenRouter) or
a dated, sourced setting; unknowns stay null ("not priced").

## ND-17 Delivery metrics and the owner page

**Decision.** NM1–NM10 (EVALUATION_PLAN §1), computed by SQL in
`lib/delivery/metrics.ts`, shown on `/owner/delivery` (read-only, counts
and rates only, never content, AT-OWN-A1 rule).

## ND-18 Kriya as an MCP server: deferred

**Decision.** No inbound MCP endpoint in track N. Reopen when: NR-1…NR-9
pass; OAuth for third-party clients designed (per-client consent, the MCP
spec's confused-deputy rules); tools limited to R0 reads of the person's
own Kriya state and "propose a job" (lands as a proposal the person
approves in Kriya, never activates anything); a threat model and an
external review.

## ND-19 India-first scenarios; payments stay R5

**Decision.** SCENARIOS.md lists the real-world scenarios the track must
handle, with the expected route (official API, MCP, browser assisted
mode, phone call, hand-off). Payments, UPI mandates (UPI Reserve Pay,
NPCI's planned agent protocol), bookings with payment and filing returns
stay **R5**: MCP tools of a payments category are classified R5 and never
reach a belt (ND-08). Reopen only with a new owner decision, counsel, and
a published NPCI specification (NRG-5).

## ND-20 Positioning and competitor claims

**Decision.** Public copy says "India-first" (OD-10). A comparison with a
named product needs a primary source read within 30 days, dated in
`status.md`; COMPETITOR_RESEARCH.md entries marked Secondary are never
used in copy.

## ND-21 Belt guard: no unclassified tool runs

**Decision.** In `runTask`, after the belt is built and the kill list
applied, every tool name must be in `TOOL_CLASSES`, in this task's MCP
classes map, or in `UNCLASSIFIED_OK = new Set(["propose_call"])`
(`lib/agent/capabilities.ts`). Anything else is deleted from the belt and
logged (`unclassified tool removed`). **Always on**: NT-POL-01 builds the
belt under every switch combination the suites use and proves nothing is
removed today, so prompts and tools stay identical (NT-REG-01).

**Owner gate.** It is not behind a switch.

**Rejected.** Mapping unknown tools to `"user-approval"` (a tool Kriya
didn't classify shouldn't exist at all).

## ND-22 `tool_executions.risk`

**Decision.** New nullable column `tool_executions.risk text` (check R0–R5),
written in `onToolExecutionStart` **only** for MCP runs (null for every
other tool). `deriveEpisode` uses `run.risk ?? classifyTool(run.toolName,
run.input)`. For existing tools the value is null, the expression equals
today's, and the receipt body is byte-identical (AT-RCP-02 unchanged).

**Owner gate.** It changes how new receipts are derived (for MCP runs).

## ND-23 Switch dependencies

**Decision.** `next.delivery` and `next.recheck` need `agents.inbox`
(episodes exist only then). `next.recheck` also needs `next.delivery`.
`next.mcp` needs `agents.inbox` (so MCP actions are recorded in "What I
did") and `KRIYA_TOKEN_KEY` set. `next.mcpConnect` needs `next.mcp`.
`next.skillsV2` needs `agents.skillLibrary`; `next.memoryRerank` needs
`agents.memoryV2`. The owner config page shows a dependent switch as
ineffective while its dependency is off (the OD-21 pattern); the runner
reads both.

## ND-24 Production-readiness gates

**Decision.** No `next.*` switch is turned on in production until the
gates in SECURITY_AND_THREATS §5 (NR-1…NR-9) for that capability have
evidence recorded in `status.md`. Order: isolated stack, staging, then
production (IMPLEMENTATION_PLAN §5). There is no per-person allow-list
setting today (NF-09); none is added by this track.

## ND-25 MCP approvals

**Decision.** Every MCP call classed R2–R4 waits for the person's approval
of the exact call (tool, server, full input), every time. MCP tools are
**never grantable** in v1: `lib/agent/capabilities.ts` `GRANTABLE` and the
`kriya.grants.tool` check stay exactly as they are (OD-03). The approval
card shows the app's name and domain, the pinned description, the exact
input and "This happens in <App>, outside Kriya".
