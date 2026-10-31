# Decisions (track H: Kriya Harness)

Architecture decision records in the brief's ADR format. All **Proposed**
until the owner writes "Approved HD-…" under "Track H owner approvals" in
`status.md`. **Owner-gated** ones touch a protected file or an invariant,
add a public surface, or spend money; they need approval by id.

Evidence ids: `HF-…` (REPOSITORY_AUDIT §3), `HQ-…` (VISION_AND_SCENARIOS §5),
`HS-…` (SECURITY_AND_THREATS), `CD-…` (track C).

| Id | Decision | Owner-gated | Phase |
| --- | --- | --- | --- |
| HD-01 | The harness is a client of the existing Kriya platform, behind `harness.*` switches (default off) | — | all |
| HD-02 | Built on DeepSeek Harness as pinned npm dependencies: a `kriya` profile + Kriya plugins on DSH seams; no fork | **Yes** (new dependency family, brand) | H4 |
| HD-03 | Client code in its own repository `kriya-harness`; the API contract lives here | **Yes** (new repository) | H4 |
| HD-04 | Local loop on the person's machine; DSH's own tools under DSH permission presets | — | H4 |
| HD-05 | Device identity: device authorization flow, hashed device tokens, verified in `lib/auth.ts` | **Yes** (invariant 3, protected file) | H2 |
| HD-06 | Model gateway: OpenAI-compatible endpoint on `kriya-web`, plan-tier model allow-list | **Yes** (public API, platform key use) | H3 |
| HD-07 | Metering: `kriya.harness_usage` ledger, one allowance, a monthly cap in SQL | **Yes** (allowance semantics) | H1, H3 |
| HD-08 | Approvals from the phone through a DSH user-approval answerer | — | H5 |
| HD-09 | Session mirror: opt-in, redacted summaries in a Kriya thread | — | H6 |
| HD-10 | Kriya tools in the harness: skills, memory (unconfirmed), handoff; no connectors | — | H7, H8 |
| HD-11 | Handoff laptop ↔ cloud uses track C's checkpoint format | — | H8 |
| HD-12 | Your machine as an execution world (runner protocol over an outbound connection) | **Yes** (new service) | H10 |
| HD-13 | ACP for editors | — | H11 |
| HD-14 | Distribution: npm `@kriya-ai/harness`, bin `kriya`, provenance, SBOM, notices | **Yes** (publishing) | H4, H9 |
| HD-15 | API versioning and minimum client version | — | H2 |
| HD-16 | Rate limits and abuse controls | — | H3 |
| HD-17 | Privacy: server logs ids only; client telemetry off by default | — | H4 |
| HD-18 | Settings | — | H1 |
| HD-19 | Marketing and comparison claims follow RG-9 | — | all |

---

## HD-01 — A client of the existing platform

- **Context.** The owner wants a downloadable Kriya harness (like Claude
  Code) without a second product (brief §0, §4.1).
- **Decision.** The harness signs in to the person's Kriya account and uses
  Kriya's model gateway, plan, allowance, skills, memory and approvals. It
  creates no accounts, no separate billing and no separate agent identities.
  Server parts sit behind `harness.api` (default `off`); with it off, every
  `/api/harness/v1/*` route answers 404 and nothing else changes (HT-REG-01).
- **Rollback.** Switch off: the API stops; installed clients show "Kriya
  Harness is turned off for your account".
- **Status.** Proposed, 2026-10-31.

## HD-02 — Built on DeepSeek Harness, not forked (owner-gated)

- **Context.** The owner asked to integrate DSH fully rather than re-create
  it. DSH is designed for exactly this: "A bundle is a distribution format
  for Cordis config rows and the code they mount"; "custom plugin composition
  remains a profile plus ordered patch files" (`docs/architecture.md`).
- **Evidence.** Published on npm (`@deepseek-ai/dsh` `0.2.1-rc.5`); every seam
  we need exists: `llm-pi-ai` (OpenAI-compatible routes), `credentials` +
  `authorization` (sign-in methods), `user-approval` (machine answerers),
  `session-persistence` (backends), skill sources, `ctx.tools`.
- **Options.** (a) Fork the repository and rebrand; (b) depend on pinned
  published packages and add a `kriya` profile with Kriya plugins; (c) write
  our own harness.
- **Decision.** (b). The `@kriya-ai/harness` package declares a `kriya`
  profile (`dsh.profile`) stacking `dsh-base` and a `kriya` bundle whose
  patch mounts seven Kriya plugins (DSH_DISTRIBUTION §3). Users get DSH's
  terminal UI, bash and PowerShell, file tools, persistent terminals, LSP,
  MCP client, subagents, compaction, skills and hooks unchanged.
- **Reasons.** (a) means owning 58 package groups of pre-stable code and
  merging upstream forever; (c) re-creates years of work. (b) keeps upgrades
  to a version bump.
- **Trade-offs.** Two agent loops exist in the company: AI SDK `runTask` in
  the cloud, DSH's loop on the person's machine. They never run the same
  task: the cloud loop owns cloud tasks; the local loop owns local sessions.
  Shared contracts (gateway, ledger, approvals, skills, memory, checkpoints)
  keep them one product.
- **Brand.** Product name "Kriya Harness"; "built on DeepSeek Harness" in the
  README and `kriya --version`, as the brand guidelines allow; no DeepSeek
  logos or the full trademark in the name.
- **Upgrades.** Exact versions (no ranges); a bump is a recorded change with
  HT suite results; local patches only through the package manager's patch
  files, each with an upstream issue link.
- **Safety status.** DSH calls itself an unaudited developer preview with
  breaking changes ahead (HF-05). The Kriya Harness is therefore a **beta**:
  a first-run notice (what it can do on this machine, run it in a folder you
  can afford to lose, keep backups), the `kriya` profile's defaults
  (`workspace-write`, approvals `ask`), our own review of the Kriya plugins
  and the pinned DSH version (HG-6) and no "production-ready" wording until
  DSH ships a stable, audited line and our gates pass.
- **Surfaces.** `kriya` = the `kriya` profile with DSH's `web-app` bundle (the
  local browser UI, HF-06); `kriya run "…"` = a headless-based profile;
  `kriya acp` = the ACP profile (HD-13).
- **Rollback.** Pin back to the previous version and republish.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## HD-03 — The client lives in its own repository (owner-gated)

- **Context.** This repository's `tsconfig.json` includes `**/*.ts`, root
  `npm ci` installs only the web app, and Render runs Node 22 (HF row 14).
  DSH needs Node ≥ 24.9 and Cordis peer dependencies.
- **Options.** (a) `harness/` here with exclusions in `tsconfig.json`,
  `eslint.config.mjs` and the Prettier setup; (b) a separate repository.
- **Decision.** (b) `kriya-harness` (owner creates it, private until H9). It
  holds the profile, plugins, tests and release scripts. This repository
  holds the server side and the **contract**: zod schemas for every request
  and response in `lib/harness/contract.ts`, exported to
  `docs/kriya-harness/contract.json` by a script so the client tests against
  the same file.
- **Reasons.** Zero changes to this repository's build, lint or test
  configuration; independent releases; its own Node and package manager.
- **Status.** Proposed, 2026-10-31. Owner approval needed (repository).

## HD-04 — The local loop and its tools

- **Decision.** The harness runs DSH's agent loop on the person's machine.
  Model calls go to the Kriya gateway (HD-06); everything else (files,
  commands, terminals) is DSH's own, under DSH's permission presets (default
  shipped by the `kriya` profile: sandbox `workspace-write`, approvals `ask`).
  Kriya's `TOOL_CLASSES` decide only Kriya-side tools (HD-10).
- **Recorded interpretation for the owner.** Commands on the person's own
  machine are the person's own actions under their own control, like any
  terminal tool; Kriya's servers never run them (invariant 5 is about tools
  that run in Kriya's services).
- **Status.** Proposed, 2026-10-31.

## HD-05 — Device identity (owner-gated)

- **Context.** Invariant 3: identity comes from the session only, through
  `lib/auth.ts`. A terminal has no browser session.
- **Decision.**
  1. Device authorization flow: `kriya login` asks the API for a device code
     and a short user code; the person opens `/connect/device` in Kriya (a
     normal session page), sees the device name and approves; the client
     polls and receives a device token once.
  2. The token is 32 random bytes; only its sha256 is stored
     (`harness_devices.token_hash`), the `share_links` pattern.
  3. `authenticateDevice(request)` is added to `lib/auth.ts`: bearer token →
     hash → active device → active profile (not suspended) → `{ id, deviceId }`.
     Every harness route calls it; nothing else accepts device tokens.
  4. Tokens work only on `/api/harness/v1/*`, expire after
     `harness.deviceIdleDays` (default 90) unused, and are revoked from
     Account → Devices (person-only action).
- **Invariant 3 amendment (owner applies to AGENTS.md at H2 start):**
  "Identity comes from the session or, for the Kriya Harness API only, a
  device token verified by `authenticateDevice` (`lib/auth.ts`). Never trust a
  user id, role, plan or price from the browser or a device."
- **Tests.** HT-AUTH-01…08.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## HD-06 — Model gateway (owner-gated)

- **Decision.** `POST /api/harness/v1/chat/completions`, OpenAI-compatible
  (streaming and tools passed through), on `kriya-web`. Steps per request:
  authenticate the device; check `harness.gateway`, the plan's harness cap
  (HD-07) and rate limits (HD-16); map the requested model alias (`budget`,
  `balanced`, `escalation`) to the tier's model through `modelForTier`, only
  for tiers the plan allows (no arbitrary model ids); forward to OpenRouter
  with the platform key and `usage: { include: true }`; stream back; parse the
  final usage chunk; write one `harness_usage` row.
- **Why on `kriya-web`.** It already holds the key and serves the API; the
  route is stateless, so it can move to its own Render service later without
  changing the contract (HF-03).
- **Tests.** HT-GW-01…10.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## HD-07 — Metering, allowance, cap (owner-gated)

- **Decision.** One row per gateway request in `kriya.harness_usage` with
  provider-reported cost, our estimate (from `kriya.models` prices) and the
  customer charge computed at write time with `lib/money.ts` and the plan's
  markup and `fx.usdInr` (unpriced when the rate is missing, never zero).
  `usageSummary` adds harness charges to the same allowance, exactly as it
  adds voice charges. A plan column `harness_monthly_micro_inr` (default 0 =
  harness off for that plan) caps a month's harness charges; the gateway
  reserves before forwarding through `kriya.reserve_harness_spend()` and
  settles after (DATA_MODEL §4).
- **Unchanged.** `lib/agent/metering.ts`, `kriya.usage_events`, `kriya.charges`.
- **Tests.** HT-MTR-01…06.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## HD-08 — Approvals from the phone

- **Decision.** A Kriya plugin registers as a DSH `user-approval` answerer.
  Each request becomes a `harness_approval_requests` row (tool, exact
  arguments redacted by `redactInput`, device, expiry); the person sees it in
  the Inbox and through the notifier and answers on any device; the client
  long-polls the answer. Expiry (`harness.approvalTtlMinutes`, default 30)
  answers `unavailable`, so DSH fails closed. Only the device's owner can
  answer (RLS + action check). A local answer in the terminal still works;
  the first answer wins.
- **Status.** Proposed, 2026-10-31.

## HD-09 — Session mirror

- **Decision.** Opt-in per device. The `kriya-sync` plugin wraps the local
  JSONL backend: local history stays complete; a summary goes to Kriya (each
  turn's text, tool names, statuses and durations, never file contents or
  command output unless the person turns on "full mirror") into a thread
  "<device> · <project>" so the phone shows progress. Limits: 64 KB per turn,
  retained like other threads.
- **Status.** Proposed, 2026-10-31.

## HD-10 — Kriya tools inside the harness

| Tool | What | Server rule |
| --- | --- | --- |
| `kriya_skills` (skill source, not a tool) | Curated + the person's approved Studio skills | Same catalogue rules as the cloud |
| `kriya_memory_search` | The person's notes for the chosen agent | `withUser`; R0 |
| `kriya_memory_save` | Saves a note **unconfirmed** | Local content is untrusted to Kriya (memory quarantine) |
| `kriya_handoff` | HD-11 | Creates a cloud task; needs track C on |

No connector tools (Gmail, Calendar…) in v1: connector actions run only in
`kriya-worker` (invariant 5). A later decision may add "ask a Kriya agent",
which enqueues a cloud task. **Status.** Proposed, 2026-10-31.

## HD-11 — Handoff between laptop and cloud

- **Decision.** `kriya handoff`: the client checks that `HEAD`'s base commit
  exists on GitHub (`git branch -r --contains` or the API), builds a binary
  diff of the working tree against it in track C's checkpoint format, and
  uploads it (`POST /handoff`). The server stores it at
  `workspaces/<user>/<workspace>/<generation>-<seq>.patch`, creates a thread
  and a `workspaces` row (repo, base_sha, checkpoint) and enqueues the agent's
  turn with the person's note. `kriya pull` downloads the workspace's latest
  checkpoint and applies it on a new local branch `kriya/pull-<id>`.
- **Refusals.** Base commit not on GitHub ("push your branch first"); patch
  over `cloud.maxCheckpointMb`; repository not connected.
- **Status.** Proposed, 2026-10-31.

## HD-12 — Your machine as an execution world (owner-gated)

- **Decision (direction).** The client can serve track C's runner protocol
  for one chosen folder, over an outbound authenticated WebSocket, so a cloud
  agent works on the person's machine (`WorkspaceProvider` name `device`).
  Needs a relay (Render web service `kriya-relay`, Node `ws`, no database),
  because Next.js route handlers don't hold WebSocket upgrades. Decided with
  measurements at H10 between a relay and HTTPS long-polling.
- **Status.** Proposed direction, 2026-10-31; a decision record at H10.

## HD-13 — ACP for editors

`kriya acp` runs DSH's ACP server with the `kriya` profile, so ACP editors
use the same agent. **Status.** Proposed, 2026-10-31.

## HD-14 — Distribution (owner-gated)

npm `@kriya-ai/harness` (scope per HQ-03), bin `kriya` running
`dsh --profile kriya` with a Kriya home (`~/.kriya`), Node ≥ 24.9, published
with npm provenance from CI; an SBOM and `THIRD_PARTY_NOTICES.md` (DSH's MIT
notice and its own notices) in every release; desktop app deferred.
**Status.** Proposed, 2026-10-31. Owner approval needed.

## HD-15 — API versioning

Paths under `/api/harness/v1`; every request sends `X-Kriya-Harness: <client
version>`; below `harness.minClientVersion` the API answers 426 with an
upgrade message; additive changes only within v1. **Status.** Proposed.

## HD-16 — Rate limits and abuse

Per device and per user through `kriya.hit_rate_limit`: requests per minute
(`harness.rpm`, 60), concurrent streams per user (3), max output tokens per
request (plan tier's limit), monthly cap (HD-07). Suspended profiles are
refused at authentication. **Status.** Proposed.

## HD-17 — Privacy

Server logs carry device id, user id, status and timing, never prompts or
outputs. The `kriya` profile disables DSH telemetry plugins by default.
**Status.** Proposed.

## HD-18 — Settings

`harness.api` (off), `harness.gateway` (off), `harness.mirror` (off),
`harness.handoff` (off), `harness.minClientVersion` (`0.0.0`),
`harness.deviceIdleDays` (90), `harness.approvalTtlMinutes` (30),
`harness.rpm` (60). Plan column `harness_monthly_micro_inr` (0).
**Status.** Proposed.

## HD-19 — Claims

Comparisons with other products follow RG-9 (official pages, dated) and
never say a competitor lacks a feature without that check
(VISION_AND_SCENARIOS §2). **Status.** Proposed.
