# Decisions (track C: cloud workspaces)

Architecture decision records for adding cloud execution to Kriya Tavi.
Each record follows the brief's format (§13.4). All are **Proposed** until
the owner writes "Approved CD-…" under "Track C owner approvals" in
`status.md`. **Owner-gated** records spend money, add a secret, touch a
protected file or set a risk class, and must be approved by id before the
phase that needs them starts.

Evidence ids: `CF-…` (REPOSITORY_AUDIT §7), `P…` (DSH_COMPONENT_MAP §3),
`CRG-…` (PROVIDERS_AND_COST §6, open research), `CS-…` (SECURITY_AND_THREATS).

| Id | Decision | Owner-gated | Phase |
| --- | --- | --- | --- |
| CD-01 | Cloud workspaces are a capability of the existing product, behind `cloud.*` switches that default off | — | all |
| CD-02 | One orchestrator: the Postgres queue and `runTask` | — | C3, C4 |
| CD-03 | DSH: port selected algorithms into the runner; no DSH runtime or dependency | — | C2 |
| CD-04 | Persistent identity, disposable compute | — | C1, C3, C6 |
| CD-05 | The boundary: `WorkspaceProvider` (lifecycle) + the runner protocol (operations) | — | C2, C3 |
| CD-06 | Isolation floor: one microVM-class sandbox per workspace, never shared | **Yes** | C8 |
| CD-07 | Provider chosen by a measured bake-off; a `local` provider for tests only | **Yes** | C3, C8 |
| CD-08 | Render Workflows not used for interactive workspaces | — | — |
| CD-09 | No credential enters a sandbox | **Yes** | C3, C5 |
| CD-10 | Changes leave only through `workspace_publish` (R4) as one tree commit and a draft PR | **Yes** | C5 |
| CD-11 | Workspace tool classes | **Yes** | C4 |
| CD-12 | Egress: `registries` allow-list by default, `offline` available | **Yes** | C2, C8 |
| CD-13 | Checkpoints: a patch against the base commit, in Supabase Storage | — | C6 |
| CD-14 | Metering: compute in `resource_usage`, minutes in SQL, charges unchanged | **Yes** | C1, C7 |
| CD-15 | Data model: `workspaces`, `workspace_sessions`, one plan column | — | C1 |
| CD-16 | Lifecycle inside a task | — | C3 |
| CD-17 | Long work: one turn per task, continued by the next turn | — | C4 |
| CD-18 | UI: thread cards and a workspace strip, no new dashboard | — | C7 |
| CD-19 | Squad members get no workspace tools in v1 | — | C4 |
| CD-20 | A `cloud-coding` skill injected only on workspace turns, replacing `code-assistance` there | — | C4 |
| CD-21 | The runner image | — | C2, C8 |
| CD-22 | License and provenance (`NOTICE.md`) | **Yes** | C2 |
| CD-23 | Settings and secrets | — | C1, C4 |
| CD-24 | Model routing unchanged; code-task qualification is a paid owner run | — | C10 |
| CD-25 | Documentation truth (stale status pages) | — | CP-1, C10 |
| CD-26 | The runner protocol is Kriya's execution-world contract, also served by the harness device world (track H) | — | C2 |
| CD-27 | The checkpoint format is also the laptop ↔ cloud handoff format (track H) | — | C6 |

CD-26 and CD-27 (added 2026-10-31 with tracks H and R, `docs/program/C_H_R_PROGRAM.md`):
**CD-26.** `runner/protocol.ts` is versioned by its `/v1` paths and kept
backward-compatible within v1, because the Kriya Harness's device world
(HD-12, H10) serves the same protocol from a person's machine; a breaking
change needs `/v2` and both served during a migration. **CD-27.** The
checkpoint (CD-13: base commit on GitHub + binary patch, object path
`workspaces/<user_id>/<workspace_id>/<generation>-<seq>.patch`) is also what
`kriya handoff` uploads and `kriya pull` downloads (HD-11). The path rules
live in a pure `lib/cloud/paths.ts` that `kriya-web` may import (PX-02).
Both **Proposed**, 2026-10-31.

---

## CD-01 — A capability of the existing product, switched off by default

- **Context.** The brief's first rule: extend Kriya, no second product (§0,
  §4.1). Every track so far ships behind switches that default off and
  proves "off changes nothing" (AT-REG-01, OT-REG-01, NT-REG-01).
- **Evidence.** `lib/config.ts` switch shape (`env`, `fallback: "off"`,
  `pattern`); `tests/next/regression.test.ts`.
- **Options.** (a) New app or route tree for "cloud work"; (b) workspace
  tools on the existing agents, threads, tasks and billing, behind switches.
- **Decision.** (b). A workspace belongs to a thread; its tools join the
  belt of the agent holding the turn. `cloud.workspaces` (default `off`) is
  the master switch; plan `workspace_minutes` (default 0) and a configured
  provider are also required. With the switch off, prompts, tool sets and
  the `TOOL_APPROVALS` object are identical (**CT-REG-01**).
- **Trade-offs.** Code tasks share the turn model (bounded by plan limits,
  CD-17) instead of an unbounded session.
- **Impact.** No new user accounts, billing, queue or memory system.
- **Migration.** Additive only.
- **Tests.** CT-REG-01.
- **Rollback.** Switch off: tools leave the belt on the next task; running
  sandboxes are paused by the janitor (CD-16).
- **Status.** Proposed, 2026-10-31.

## CD-02 — One orchestrator: the Postgres queue and `runTask`

- **Context.** DSH has its own loop, jobs, workflows and sessions; Render
  Workflows and Supabase Queues are also available (brief §6.2, §7.3).
- **Evidence.** `kriya.tasks` with leases, side-effect-aware recovery,
  per-user concurrency, idempotency and cancel (REPOSITORY_AUDIT §3); all
  three tracks protect it.
- **Options.** (a) Keep queue and `runTask`, add tools; (b) DSH agent loop
  inside the worker; (c) Render Workflows per task as orchestrator; (d)
  PGMQ; (e) AI SDK `HarnessAgent` running Claude Code/Codex in a sandbox.
- **Decision.** (a). The model loop stays in `kriya-worker`; only tool
  **execution** moves into the sandbox.
- **Reasons.** (b) needs Node ≥ 24.9 and Cordis and duplicates metering and
  approvals (DSH_COMPONENT_MAP §1); (c) and (d) create a second queue with
  a second owner of task state; (e) bypasses OpenRouter metering, risk
  classes, grants and "What I did" and is experimental. Keeping the loop in
  the worker also keeps the OpenRouter key out of the sandbox (CD-09).
- **Impact.** Latency: one HTTPS round trip worker→runner per tool call
  (target p50 ≤ 150 ms, measured in C8). Worker slots are held for the turn
  (`WORKER_CONCURRENCY`, CF-04).
- **Tests.** CT-WS-*, existing `tests/db/queue.test.ts` unchanged.
- **Rollback.** Not applicable (nothing replaced).
- **Status.** Proposed, 2026-10-31.

## CD-03 — DSH: reuse the engineering, not the runtime

- **Context.** The brief wants DSH studied in depth and reused where
  appropriate (§3.2), without importing a second application.
- **Evidence.** DSH_COMPONENT_MAP §1–§3: every candidate needs Cordis and
  the DSH closure; DSH needs Node ≥ 24.9; its sandbox is same-kernel.
- **Options.** (a) npm-depend on `@deepseek-ai/dsh-*` in the worker; (b) run
  a DSH `sdk` profile inside the sandbox; (c) port selected algorithms into
  Kriya's runner with provenance.
- **Decision.** (c): ports P1–P8 into `runner/` and `lib/cloud/`, each
  with an upstream header; no DSH package in `package.json`.
- **Reasons.** (a) breaks on Node 22 and drags the plugin runtime in; (b)
  puts a model loop (and so a model key) inside the hostile environment.
- **Impact.** About 1–1.5k lines of owned code instead of a 20k-file
  dependency; upstream fixes need a reviewed port update.
- **Tests.** CT-RUN-* written from upstream READMEs' stated behaviour.
- **Rollback.** Ported files are self-contained under `runner/`.
- **Status.** Proposed, 2026-10-31.

## CD-04 — Persistent identity, disposable compute

- **Context.** "Persistent agents, not permanently running machines" (§17).
- **Decision.** Durable: the agent, the thread, the `kriya.workspaces` row
  (repo, base commit, branch, status, checkpoint pointer), checkpoints in
  storage, code in Git. Disposable: the provider sandbox. A sandbox starts
  on the first workspace tool call of a task, is **paused** when the task
  ends, and is **destroyed** after `cloud.pausedHours` (default 24) without
  use; the workspace is then restored from its checkpoint on next use.
  Workspaces unused for `cloud.retentionDays` (default 14) are closed and
  their checkpoints deleted.
- **Impact.** No compute between tasks; provider storage bounded; resume is
  fast while paused and slower (import + restore) after.
- **Tests.** CT-WS-04 (pause at end), CT-CKP-02 (restore after destroy),
  CT-JAN-02 (retention).
- **Rollback.** Lower the two settings; nothing else depends on them.
- **Status.** Proposed, 2026-10-31.

## CD-05 — The boundary: `WorkspaceProvider` plus the runner protocol

- **Context.** The brief asks for an execution-provider boundary that can
  host more than one backend (§4.3) without needless abstraction (§13.5).
- **Evidence.** `BrowserProvider` (`lib/browser/provider.ts`) is the house
  pattern. AI SDK 7.0.137 already defines an operation surface for sandboxes,
  `Experimental_SandboxSession` (`run`, `spawn`, `readTextFile`,
  `writeTextFile`, `readBinaryFile`, `writeBinaryFile`, `description`), with
  no lifecycle.
- **Options.** (a) Provider SDK calls straight from tools; (b) a lifecycle
  interface per provider plus Kriya's own runner inside every sandbox
  speaking one protocol; (c) adopt AI SDK sandbox adapters as the provider
  layer.
- **Decision.** (b). `WorkspaceProvider` has only lifecycle methods
  (`create`, `resume`, `pause`, `destroy`, `extend`, `list`) and returns the
  runner's base URL. Every operation goes to the runner (`runner/protocol.ts`).
  The client's operation methods are **structurally compatible** with
  `Experimental_SandboxSession`, proven by a type-level test (CT-RUN-20),
  so AI SDK adapters can be adopted later without changing tools.
- **Reasons.** (a) ties tool semantics (output bounds, read-before-edit,
  patching, change sets) to each vendor and leaves nothing to test offline;
  (c) is experimental and lacks pause/resume. With (b) a provider adapter
  is ~150 lines and the runner is tested with no vendor at all.
- **Tests.** CT-RUN-*, CT-PRV-* (each adapter against a recorded fixture).
- **Rollback.** Replace an adapter; tools and runner unchanged.
- **Status.** Proposed, 2026-10-31.

## CD-06 — Isolation floor (owner-gated)

- **Context.** The model writes code that runs; repositories and packages are
  untrusted (brief §10.2).
- **Evidence.** `kriya-browser` hosts several tenants per container, which
  is acceptable only because it runs Kriya's fixed actions; DSH's sandbox
  shares the host kernel; Render services can't create a container per task.
- **Decision.** Arbitrary code runs only in a sandbox that (1) is one
  machine per workspace with its own kernel (microVM or equivalent
  documented by the provider), (2) is never reused across workspaces or
  users, (3) has no route to Kriya's private network, Supabase, the
  provider's metadata service or other sandboxes, (4) runs the person's
  commands as a non-root user different from the runner's, (5) has CPU,
  memory, disk, process and time limits. `kriya-worker`, `kriya-browser`,
  a Render private service and the DSH local sandbox are **rejected** as
  hosts for user code.
- **Impact.** A paid external provider becomes necessary (cost, CD-07).
- **Tests.** CT-ISO-01…08 against the real provider in C9.
- **Rollback.** Switch off; no code path falls back to an unisolated host.
- **Status.** Proposed, 2026-10-31. Owner approval needed (paid vendor).

## CD-07 — Provider chosen by a bake-off; `local` for tests (owner-gated)

- **Context.** The brief: compare at least two credible designs on the same
  workload before committing (§9.5); don't pick from headline rates (§8).
- **Evidence.** PROVIDERS_AND_COST §2–§3: E2B and Daytona publish per-second
  sandbox pricing with pause/stop; isolation and egress controls differ by
  documentation version (CRG-01…CRG-04); Fly Machines offers a Mumbai
  region but more operations work.
- **Decision.** Build everything against `WorkspaceProvider` first with a
  `local` adapter (runner as a child process in a temporary directory),
  which refuses to start unless `KRIYA_WORKSPACE_LOCAL=1` **and**
  `DATABASE_URL` points at `127.0.0.1`/`localhost` (the `verify:guard`
  rule). In C8, implement E2B and Daytona adapters and run the bake-off
  (EVALUATION_PLAN §3: W1–W3, criteria and thresholds). Fly Machines enters
  only if both fail a must-have. The default provider is the cheapest per
  successful task among those passing every must-have.
- **Impact.** No vendor lock-in before measurement; C1–C7 need no account.
- **Tests.** CT-PRV-01 (local refuses outside the verify stack), bake-off
  report in `status.md`.
- **Rollback.** `cloud.provider` back to `none`.
- **Status.** Proposed, 2026-10-31. Owner approval needed for accounts and
  the paid bake-off.

## CD-08 — Render Workflows: not for interactive workspaces

- **Context.** The brief suggests Workflows as a first proof of concept (§8).
- **Evidence (render.com/docs/workflows, /workflows-limits, 2026-10-31).**
  Runs are started by SDK/API and run to completion; runs "do not expose any
  ports" and only initiate outbound connections; runs can reach services in
  the same region over private networking; egress controls and untrusted
  code are not addressed; flex is up to 1 CPU / 4 GB at $0.20/CPU-h +
  $0.05/GB-h; default timeout 2 h, up to 24 h; 4 MB argument limit.
- **Decision.** Not used for workspaces. An agent turn needs an
  interactive, per-call command channel, which Workflows don't provide
  without putting the model loop (and its key) inside the run; private
  networking would put hostile code next to `kriya-browser`.
- **Deferred.** A batch profile (e.g. a test matrix with no model in the
  loop) may revisit Workflows with a new decision.
- **Status.** Proposed, 2026-10-31.

## CD-09 — No credential enters a sandbox (owner-gated)

- **Context.** Brief §10.1, §10.3; invariant 4.
- **Decision.**
  1. **Import.** The worker fetches the repository tarball at an exact
     commit through a new additive function in `lib/connectors/github.ts`
     (`githubTarball`, using `providerFetch`, so the person's GitHub App
     token is opened only in `lib/connectors.ts`) and streams it to the
     runner's import endpoint. Git history is not imported in v1; the runner
     makes a local base commit.
  2. **Runner token.** `HMAC-SHA256(KRIYA_WORKSPACE_SECRET, workspaceId + ":" + generation)`,
     computed by the worker, given to the runner process at sandbox creation,
     removed from its environment after start-up, never stored. The runner
     runs as root inside the VM (CD-21); the person's commands run as the
     unprivileged `kriya` user with a scrubbed environment (P1), so they can
     read neither the runner's environment nor its memory.
  3. **Provider API key** (`E2B_API_KEY` or `DAYTONA_API_KEY`, C8): worker
     environment only, listed in `SECRETS`.
  4. **No person-supplied secrets** (test API keys, `.env` values) in v1.
- **Reasons.** No new sealed secret category, so no invariant 4 amendment.
  A leaked runner token controls only the sandbox it is already inside.
- **Impact.** No `git log`/`blame` history in v1 (shallow history with an
  installation token is a later decision).
- **Tests.** CT-SEC-01 (sandbox env holds no Kriya secret), CT-RUN-11
  (wrong token refused), CT-IMP-02 (no `lib/connectors` import outside the
  allowed seam).
- **Rollback.** Rotate `KRIYA_WORKSPACE_SECRET`: every runner rejects the
  worker until restored from checkpoint (runbook).
- **Status.** Proposed, 2026-10-31. Owner approval needed (new secret,
  additive change to `lib/connectors/github.ts`).

## CD-10 — Publishing through `workspace_publish` (owner-gated)

- **Context.** Results must land as commits/PRs (brief §15); `github_open_pr`
  writes one commit per file (CF-08).
- **Decision.** One tool, `workspace_publish`, R4, in `SIDE_EFFECT_TOOLS`,
  never grantable, runs only in the worker. Input: `repo` (must equal the
  workspace's repo, so the person approves the exact destination),
  `changeSetId` (the sha256 `workspace_changes` returned), `branch` (new,
  `kriya/` prefix enforced), `title`, `body`. The tool re-reads the change
  set from the runner and **refuses** if its hash differs from the approved
  one or the repo differs from the workspace's; then a new additive
  `githubCommitTree` (blobs → tree → one commit on `base_sha` → new ref) and
  a **draft** PR into the workspace's base branch, read back for
  verification. It never writes to an existing branch, never to the default
  branch, never merges, never deletes.
- **Impact.** The approval card shows the exact files and line counts.
- **Tests.** CT-PUB-01…06.
- **Rollback.** `cloud.publish` off removes the tool; PRs stay drafts.
- **Status.** Proposed, 2026-10-31. Owner approval needed (protected
  connector file).

## CD-11 — Workspace tool classes (owner-gated)

| Tool | Class | Side effect | Why |
| --- | --- | --- | --- |
| `workspace_open` | R1 | No | Creates Kriya state and spends plan minutes |
| `workspace_run` | R1 | No | Changes only the isolated sandbox; egress per CD-12 |
| `workspace_read`, `workspace_list`, `workspace_search`, `workspace_changes` | R0 | No | Read inside the sandbox |
| `workspace_write`, `workspace_edit`, `workspace_patch` | R1 | No | Change only sandbox files |
| `workspace_publish` | R4 | Yes | Acts on GitHub as the person |

- **Interpretation recorded for the owner.** The sandbox is inside Kriya's
  boundary for invariant 5: it changes nothing a third party sees until
  `workspace_publish`. All workspace tools run only in `kriya-worker`.
- **Private content.** Reads of a person's repository are private content:
  `workspace_read`, `workspace_run`, `workspace_search`, `workspace_list` and
  `workspace_changes` join `PRIVATE_READ_TOOLS` (additions only), so web
  tools then need approval (`guardWeb`) and memory saved afterwards is
  unconfirmed (`untrustedSeen`). Outputs carry the existing `FOREIGN` notice.
- **Tests.** CT-POL-01, CT-POL-02, CT-POL-03.
- **Status.** Proposed, 2026-10-31. Owner approval needed (risk classes).

## CD-12 — Egress policy (owner-gated)

- **Decision.** Two profiles. `registries` (default): outbound only to an
  allow-list of package registries (npm, PyPI and its file host, crates.io,
  the Go module proxy) and nothing else; `offline`: none. Never allowed:
  private and link-local ranges, metadata addresses, Kriya's own hosts and
  Supabase. Enforced by the provider's network policy when it supports a
  domain allow-list; otherwise by an egress proxy in the image that imports
  `isBlockedAddress`/`isBlockedHost` from `browser/egress.ts` (read-only, as
  track N does) with a root-owned firewall that lets only the proxy's user
  connect out. Web research stays with the existing web tools in the worker.
- **Residual risk.** DNS-based leakage if the provider resolver is open
  (CS-6, CRG-08); a repository can be opened `offline`.
- **Tests.** CT-ISO-03…05.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## CD-13 — Checkpoints

- **Decision.** At the end of every task that changed files, and before
  `workspace_publish`, the worker asks the runner for a checkpoint: a binary
  `git diff --full-index` from the base commit to a snapshot of the working
  tree (untracked files included, `.gitignore`d files excluded), capped at
  `cloud.maxCheckpointMb` (default 50). The worker uploads it to the private
  `kriya-files` bucket at `workspaces/<user_id>/<workspace_id>/<generation>-<seq>.patch`
  (never a `kriya.files` row) and stores path, size and sha256 on the
  workspace. Restore = import the tarball at `base_sha` + apply the patch.
- **Why not provider snapshots.** Provider retention is unverified (CRG-05)
  and the brief forbids the sandbox disk as the only copy (§5.4).
- **Tests.** CT-CKP-01…04.
- **Status.** Proposed, 2026-10-31.

## CD-14 — Metering and limits (owner-gated)

- **Decision.** (1) Compute time per sandbox session goes to
  `resource_usage` kind `workspace_seconds`, `cost_micro_usd` computed only
  from the owner-entered `cloud.costMicroUsdPerHour` for the configured size
  (null = unpriced, never zero). (2) `plans.workspace_minutes` per IST month,
  enforced in `kriya.open_workspace_session`. (3) A global running cap
  (`cloud.maxRunning`) checked in the same function. (4) `kriya.charges` and
  `lib/agent/metering.ts` are **unchanged**: compute is included in the
  plan's minutes, like browser minutes (CF-07). (5) Per-task compute is
  bounded by the task deadline, so the model cost budget is unchanged.
- **Deferred.** Pricing compute overage to customers needs a protected-file
  change and is a later owner decision.
- **Tests.** CT-DB-03, CT-DB-04, CT-MTR-01…03.
- **Status.** Proposed, 2026-10-31. Owner approval needed.

## CD-15 — Data model

Two tables and one column, one migration `20270201000000_cloud_workspaces.sql`
(DATA_MODEL_AND_STATE_MACHINES): `kriya.workspaces`, `kriya.workspace_sessions`,
`plans.workspace_minutes`; transitions in the existing
`kriya.allowed_transitions` (entity `workspace`); two `resource_usage` kinds.
No change to `tasks`, `threads`, `agents` or any applied migration.
**Status.** Proposed, 2026-10-31.

## CD-16 — Lifecycle inside a task

`TaskWorkspace` (`lib/cloud/session.ts`), the counterpart of
`TaskBrowser`: opens lazily on the first workspace tool call (SQL session row
first, then provider), extends the sandbox on the task heartbeat, and in
`runTask`'s `finally` checkpoints and pauses. On `shutdown` or `lease_lost`
it pauses without a checkpoint (the next attempt resumes the same sandbox).
A worker that dies leaves an open session whose heartbeat goes stale; the
janitor (one new `try` block in `schedulerLoop`) checkpoints and pauses it
within `cloud.orphanSeconds` (default 120) and meters the time to its last
heartbeat. **Status.** Proposed, 2026-10-31.

## CD-17 — Long work

A workspace task is an ordinary turn bounded by its plan's
`max_task_seconds` (≤ 7200) and steps. The workspace outlives the turn; the
prompt gets a one-line workspace state (repo, branch, base, changed files)
so the next turn, a retry after a deploy, or an approval's resumed task
carries on from the files. Automatic continuation across turns
(goals/jobs driving repeated turns) is deferred to a later decision on top
of track O. **Status.** Proposed, 2026-10-31.

## CD-18 — UI inside the thread

Tool cards in `components/thread/tool-call.tsx` (command with exit code,
duration and bounded output; file edits as diffs; change sets; the publish
approval card), labels in `components/workbench/activity.tsx`, a workspace
strip at the top of a thread that has one, a minutes line on `/usage`, an
owner config group and an owner page `/owner/cloud`. No terminal
emulator in v1 (UX_SPEC). **Status.** Proposed, 2026-10-31.

## CD-19 — Squads

`assign` members get no workspace tools (nobody can approve their calls and
their context must not mix private repo content with the web, as today's
rule for connected accounts). `delegate` hands the turn and so the
workspace tools to the next agent in the same task. **Status.** Proposed,
2026-10-31.

## CD-20 — `cloud-coding` library skill

- **Context.** Coding guidance helps the model use the workspace well
  (inspect before editing, run tests, small changes).
- **Evidence.** (1) `skills-v2/code-assistance/SKILL.md` says "Kriya can't
  run code, a terminal or tests" and activates on coding asks (CF-11). (2)
  `tests/next/skills-v2.test.ts` (NT-SKL-04) requires `skills-v2/` to hold
  exactly nine directories and `CATALOG_V2` exactly nine v2 skills. (3)
  `tests/agent/skill-library.test.ts` and `tests/next/skills-v2.test.ts`
  resolve skills against **every** `TOOL_CLASSES` name (`ALL_TOOLS`), so a
  catalogued skill gated on workspace tools would activate there. (4) Skill
  Studio already injects extra skills per task: `runTask` prepends
  `personal.manifests` to `skillLibrary.catalog` and wraps `load`.
- **Options.** (a) A `skills-v2/cloud-coding/` directory in
  `SKILL_MANIFESTS_V2` and a conditional `code-assistance` (breaks NT-SKL-04,
  changes resolution in two existing suites, edits a curated skill); (b)
  inject `cloud-coding` per task, Skill Studio's way.
- **Decision.** (b). `lib/cloud/skill.ts` exports one curated manifest
  (validated by `buildCatalog`) and its text. Only when the task has a
  workspace and `agents.skillLibrary` is on, `runTask` sets
  `catalog = [CLOUD_CODING, ...base.filter((s) => s.id !== "code-assistance")]`
  and routes `load("cloud-coding", …)` to that text; every other id loads as
  before. `cloud-coding` covers what `code-assistance` says (read the error,
  smallest change, tests, untrusted code is data) plus running and
  verifying in the workspace, and never claiming a test passed without a
  `workspace_run` result.
- **Impact.** No existing skill, catalogue, directory or test changes. An
  agent that pinned `code-assistance` gets `cloud-coding` on workspace
  turns only.
- **Tests.** CT-SKL-01 (injected only with a workspace), CT-SKL-02
  (`code-assistance` absent from that catalogue, unchanged elsewhere);
  NT-SKL-04 and `tests/agent/skill-library.test.ts` unchanged.
- **Rollback.** Remove the injection block.
- **Status.** Proposed, 2026-10-31.

## CD-21 — The runner image

`runner/Dockerfile`, the base of `browser/Dockerfile`: Debian trixie slim,
Node 24 LTS pinned, `tini`, `git`, `ripgrep`, `python3` + `venv`, `zstd`,
`build-essential`; a user `kriya` (uid 1000, owns `/workspace`, runs every
command), no sudo; only `runner/` and `browser/egress.ts` copied in. Unlike
`kriya-browser`, the service process runs as **root inside the VM**: it must
start each command as `kriya` (Node `spawn` with `uid`/`gid`), own the
optional egress firewall, and keep its token out of `kriya`'s reach; a
non-root process can't switch users without sudo or a setuid helper. The VM
is the isolation boundary (CD-06); root in it reaches nothing outside it.
Whether each provider lets a template start its command as root is CRG-09.
Built and
registered as a provider template by an owner-run command; the template id
is the `cloud.image` setting. An SBOM (`syft`) is produced at build and kept
with the version. Rebuilt monthly for patches. **Status.** Proposed,
2026-10-31.

## CD-22 — License and provenance (owner-gated)

New `NOTICE.md` at the root with the DSH MIT notice and the list of ported
files with the pinned SHA; a two-line header in each ported file. `LICENSE`
untouched. Track A lists `NOTICE.md` as governance ("attribution rows for
ported code only"), hence owner approval. **Status.** Proposed, 2026-10-31.

## CD-23 — Settings and secrets

Settings (block `// Cloud workspaces (track C)` in `lib/config.ts`):
`cloud.workspaces` (on/off, off), `cloud.provider` (`none|local|e2b|daytona`,
`none`), `cloud.image` (template id), `cloud.size` (`2c-4g`), `cloud.network`
(`registries|offline`, `registries`), `cloud.commandTimeoutSeconds` (600,
max 1800), `cloud.maxRunning` (3), `cloud.pausedHours` (24),
`cloud.retentionDays` (14), `cloud.orphanSeconds` (120),
`cloud.maxImportMb` (200), `cloud.maxCheckpointMb` (50),
`cloud.costMicroUsdPerHour` (no default), `cloud.publish` (on/off, off).
Secrets (`SECRETS`, worker only): `KRIYA_WORKSPACE_SECRET`; the chosen
provider's key in C8. `.env.example` is edited by the owner (B9).
**Status.** Proposed, 2026-10-31.

## CD-24 — Model routing unchanged

Agents keep their tiers and the plan's allowed tiers. Whether the budget
tier can drive multi-step code work is measured in C10 on W1–W3 with the
owner's go-ahead (paid); escalation stays the existing quality-error retry.
**Status.** Proposed, 2026-10-31.

## CD-25 — Documentation truth

CP-1 corrects CF-01 and CF-02 (stale `docs/kriya/status.md` rows and the
`docs/kriya/architecture.md` execution section). `README.md` mentions cloud
workspaces only after C10 passes on staging (CF-03). **Status.** Proposed,
2026-10-31.
