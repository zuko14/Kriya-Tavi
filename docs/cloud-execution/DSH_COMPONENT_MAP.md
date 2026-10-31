# DeepSeek Harness component map (track C)

How each relevant DeepSeek Harness (DSH) subsystem maps onto Kriya, and what
track C takes from it. Decision words come from the brief (§3.3): **Reuse**,
**Adapt**, **Extend**, **Keep existing**, **Defer**, **Reject**.

## 1. The pinned source

| Item | Value |
| --- | --- |
| Repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Pinned commit | `ce7073d51254c26cd63b22a60835b8f948deb447` (2026-10-30, "Merge pull request #7552…") |
| Inspected | Read-only shallow clone in a scratch directory on 2026-10-31; nothing was installed, built or run |
| License | MIT, "Copyright (c) 2026 DeepSeek" (`LICENSE`); `THIRD_PARTY_NOTICES.md` lists vendored and bundled third-party code |
| Runtime | Node ≥ 24.9, pnpm workspaces, ESM only, 58 package groups under `packages/`, vendored Cordis under `vendor/` |
| API stability | "Public APIs are pre-stable; update every consumer" (`AGENTS.md`) |
| Architecture | Every capability is a Cordis plugin on a shared context (`ctx.tools`, `ctx.sessions`, `ctx.shell`, `ctx.fs`, `ctx.sandbox`…); an append-only session log is the model's context source; profiles compose bundles at boot (`docs/architecture.md`) |

### What decides the integration style

1. **Every candidate package depends on Cordis and the DSH package closure.**
   Measured on the pinned commit: `shell/bash-local` (404 lines) needs
   `dsh-shell`, `dsh-subprocess`, `dsh-timeout`, `cordis`; `fs/tool-fs` (2365)
   needs 15 DSH packages; `subprocess/subprocess-local` (5031) needs
   `node-pty`, `koffi` and Windows code. Importing any of them brings the
   plugin runtime with it.
2. **Kriya's worker runs Node 22 on Render**; DSH needs ≥ 24.9 (CF-06).
3. **DSH owns its own agent loop, model adapters, session log and approvals.**
   Kriya already has all four (AI SDK `streamText` in `runTask`, OpenRouter
   gateway, `messages`/`task_events`, `TOOL_APPROVALS` + Inbox). Running the
   DSH loop would be the "second agent platform" the brief forbids (§4.1).
4. **DSH's sandbox is not a hostile-code boundary.** Its own README:
   "Confinement is same-world only: it shares the host kernel and
   filesystem, while containers, microVMs, and remote executors replace whole
   capabilities instead of registering here" (`packages/sandbox/README.md`).
5. **DSH's best idea for us is the execution-world seam**: "Filesystem and
   subprocess providers share one execution world, so pointing them at a
   remote sandbox moves Bash, PTY, and LSP with them" (`docs/architecture.md`,
   Capability seams). Track C builds exactly that seam: the runner inside the
   sandbox is the execution world, and Kriya's tools talk to it.

So the decision (CD-03) is: **reuse the engineering, not the runtime.**
Selected algorithms are ported, with their MIT notice, into the
dependency-light `runner/` service that runs inside the sandbox image (Node
24), and into small pure helpers in `lib/cloud/`. No DSH package becomes
an npm dependency; Cordis is not adopted.

## 2. Matrix

| # | Upstream subsystem (packages) | What it does upstream | Kriya equivalent today | Decision | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | Cordis plugin runtime (`vendor/cordis`, `boot/*`) | Services, typed events, reversible effects, profile/bundle composition | Plain modules, switches in `lib/config.ts`, belt built per task | **Reject** | A second composition system beside Next.js and the worker; every Kriya invariant is enforced in plain code paths that tests pin (AT-REG-01, NT-REG-01). Small interfaces (`BrowserProvider`) already give swappability |
| 2 | Agent interface and loop (`core/agent`, `core/agent-loop`) | Turn/step driver, inbox, waterfalls around requests and tools | `runTask` on AI SDK 7 `streamText` (`stopWhen`, `prepareStep`, `toolApproval`, hooks) | **Keep existing** | Replacing it would rewrite metering, approvals, grants, delivery, skills and memory wiring. The loop gains workspace tools only |
| 3 | Session/event model, persistence (`core/session`, `session/*`, JSONL) | Append-only per-session JSONL log; model history derived from it | `messages` (reply parts), `task_events` (stream replay), `tool_executions` (evidence) in Postgres | **Keep existing** (principle adopted) | Postgres stays the system of record (brief §7.1). Adopted: DSH's "model-visible ⟺ logged" rule; every workspace output the model sees is a tool part in `messages` |
| 4 | Model adapters and streaming (`llm/*`) | DeepSeek-first adapters, retry, token meter | OpenRouter gateway (`lib/models.ts`), tiers, fallback, `usage_events` | **Keep existing** | Provider-independent routing must stay (brief §3.4) |
| 5 | Tool registry and guarded execution (`core/tools`, `guard/*`) | Scoped registry; pre/post-execute waterfalls; repeat-call reminder; per-tool timeout | AI SDK `tool()` belt; `TOOL_CLASSES`, kill list, belt guard, `wrapReads` | **Keep existing**; **Adapt** two guards | `repeat-tool-reminder` (240 lines) and `timeout-policy` (81) are ported as behaviour inside workspace tools (§3, P5, P6) |
| 6 | Shell, process execution (`shell/*`, `subprocess/*`) | Bash executor with bounded output, background processes, scrubbed env, process ranges | None | **Adapt** | Ported into `runner/exec.ts`: bounded capture with head/tail, full log to a file, scrubbed environment, kill the process group on timeout or abort (P1, P2) |
| 7 | Filesystem and workspace (`fs/*`, `workspace/*`) | `ctx.fs` backends, read-before-edit freshness policy, `read`/`write`/`edit`/`apply_patch`, `glob`/`grep`; `workspace` = project list in a GUI | None for files; "workspace" in Kriya UI means the app shell | **Adapt** fs; **Reject** `workspace` package | Ported: patch parser (`fs-patch`, 350 lines, no I/O), read-before-edit rule (`fs-observation-policy`, 170), exact-replace edit semantics (`tool-str-replace-editor`), search limits (`tool-fs-search`) (P3, P4, P7). DSH `workspace` is a desktop project list, not a compute workspace |
| 8 | Terminal / PTY (`terminal/*`) | Persistent interactive shells across tool calls (node-pty, xterm headless); local to one process | None | **Defer** | v1 commands are one-shot with a working directory and environment carried by the runner. A persistent PTY needs `node-pty` in the image and a live terminal view; revisit after C10 (CD-17) |
| 9 | Sandbox, confinement (`sandbox/*`) | bwrap/Landlock/Seatbelt/Windows ACL on the host | None | **Reject** as the boundary | Same-kernel by its own statement. The boundary is a provider microVM per workspace (CD-06). Inside the VM the runner still runs commands as a non-root user |
| 10 | Browser and computer use (`browser-use`, `computer-use`, `experimental/cua*`) | Provider registry; experimental Playwright/Stagehand/CUA providers | `kriya-browser` (A4) with page-derived risk classes and site modes | **Keep existing** (browser); **Defer** (computer use) | The browser already has Kriya's safety floor. A desktop profile is only for workflows that truly need one (brief §5.3) |
| 11 | Skills loading (`skill/*`) | Filesystem and Office skill catalogs; `skill` tool | Skill library (`skills/`, `skills-v2/`, `lib/skill-library.ts`), Skill Studio | **Keep existing**; **Extend** | One new library skill `cloud-coding` (guidance only) that activates when workspace tools are on the belt (CD-20) |
| 12 | Subagents, agent teams (`subagent/*`, `experimental/agent-team`) | Child agents in-process or out of process (ACP, Codex, Claude Code) | Squads, `delegate`, `assign`, crews (O11) | **Keep existing** | Squad members get no workspace tools in v1 (CD-19) |
| 13 | Workflow, jobs, schedules, goals (`workflow/*`, `jobs/*`, `schedule/*`, `goal/*`) | Scripted fan-out, process-local background jobs, RFC 5545 schedules, session goals | Postgres queue, schedules (A3), goals, jobs/mandates (track O), check-ins | **Keep existing** | One orchestration story (brief §7.3). DSH jobs are process-local; Kriya's survive restarts |
| 14 | Context assembly, compaction, attachments, spill (`context/*`, `compaction/*`, `attachment/*`, `spill/*`) | Summaries under token pressure; trim big tool results; store full text outside context with a locator | `compactContext` (`lib/agent/messages.ts`), memory v2 summaries | **Adapt** spill; **Defer** pruner | Spill is ported as "full output stays in a log file in the workspace, the model gets head + tail + the path" (P2). A tool-result pruner for `compactContext` is a later change to a shared file |
| 15 | MCP, LSP, API/SDK (`mcp/*`, `lsp`, `api`, `sdk`) | MCP client; language servers; JSON-RPC SDK; remote BFF | Track N MCP (owner registry, pinning, egress guard) | **Keep existing** (MCP); **Defer** (LSP); **Reject** (SDK/API server) | Track N's MCP is already safer for tenants. LSP inside the workspace is a later runner feature. Kriya's API is its own |
| 16 | Credentials, approvals, interaction, telemetry (`credentials/*`, `interaction/*`, `session-telemetry*`) | Named credentials in local storage; one-shot approvals; permission presets; OTel | `lib/secrets.ts` + `lib/connectors.ts`; `TOOL_APPROVALS`, Inbox, grants; `lib/log.ts`, `tool_executions` | **Keep existing** | Invariants 3–5. DSH's local credential store is single-user by design |
| 17 | Web/desktop UI, boot profiles (`apps/*`, `client/*`, `host/*`, `bundle/*`) | Electron and Web clients; profile launcher | Kriya Next.js app, mobile-first | **Reject** | "Do not import all upstream UI or branding" (brief §13.5) |
| 18 | Deliverables (`deliverables/workspace-changes`, `tool-present`) | Records the files a turn changed from git snapshots and serves per-file comparisons | "What I did" (episodes from `tool_executions`) | **Adapt** | Ported idea: the runner's `changes` endpoint reports changed files with line counts against the base commit (P8); shown in the thread and used for publish |
| 19 | SSH execution (`ssh/*`) | Runs fs/subprocess/sandbox on one SSH host while the harness stays local | None | **Reject** (pattern noted) | Same "remote world" idea as the runner, but SSH keys and a shared host are the wrong trust model for tenants |
| 20 | PTC runtime (`ptc-runtime/*`) | Executes model-written programs against host functions | None | **Defer** | Programmatic tool calling is a different feature with its own risk review |

## 3. What is ported (the only DSH code that enters Kriya)

Each port is a re-implementation in Kriya's style (no Cordis, no branded
ids, zod at the wire), keeping the upstream behaviour. Every ported file
starts with a two-line header naming the upstream path and the pinned SHA,
and `NOTICE.md` (new, track A's named governance file) carries the DSH MIT
notice (CD-22). Sizes are the upstream source without tests.

| Id | Upstream path @ `ce7073d` | Size | Kriya file | Behaviour kept |
| --- | --- | --- | --- | --- |
| P1 | `packages/subprocess/subprocess-local` (env scrubbing, process-group termination only) | part of 5031 | `runner/exec.ts` | Child starts with an allow-listed environment (`PATH`, `HOME`, `LANG`, `TERM`, `CI=1`), never the runner's; timeout or abort kills the whole process group (`SIGTERM`, then `SIGKILL` after a grace) |
| P2 | `packages/shell/bash-local` + `packages/spill/spill-local` (bounded capture, spill) | 404 + 726 | `runner/exec.ts` | Output capped in memory; the model gets the first and last N bytes with a "truncated" marker and the path of the full log under `/workspace/.kriya/logs/` |
| P3 | `packages/fs/fs-patch` (`parse.ts`, `apply.ts`) | 350 | `runner/patch.ts` | Codex-style `*** Begin Patch` parser and hunk applier on strings, structured failure on mismatch |
| P4 | `packages/fs/fs-observation-policy` | 170 | `runner/files.ts` | An edit or overwrite needs a prior read of that file in this runner session and is refused if the file changed since (mtime + size + sha256); reading a missing path allows creating it |
| P5 | `packages/guard/repeat-tool-reminder` | 240 | `lib/cloud/tools.ts` | The third identical `workspace_run` in a row returns its result plus a note to change approach or finish |
| P6 | `packages/guard/timeout-policy` | 81 | `runner/exec.ts` + tool schema | Each command declares `timeoutSeconds` (bounded by the setting); a hung command returns a clear timed-out result instead of stalling the task |
| P7 | `packages/fs/tool-fs-search` (limits only) | part of 1570 | `runner/search.ts` | `ripgrep` with a match cap, a per-line length cap and a time cap; globbing with ignore files honoured |
| P8 | `packages/deliverables/workspace-changes` (idea, not code) | 1294 | `runner/changes.ts` | Changed files against the base commit with added/removed line counts and a per-file diff; binary files listed, not inlined |

Rules for every port: (1) behaviour tests are written first from the
upstream README's stated behaviour, not copied tests; (2) no upstream
dependency is added (`diff` and `@vscode/ripgrep` are not needed: the image
has `git` and `rg` binaries); (3) a later upstream change is merged only by
a reviewed, recorded port update (SHA bumped in the header and NOTICE.md).

## 4. Things considered and rejected outside DSH

| Option | Why rejected | Evidence |
| --- | --- | --- |
| AI SDK `HarnessAgent` (`@ai-sdk/harness-*`: Claude Code, Codex, OpenCode… in a sandbox) | The harness runtime owns history, model choice and approvals; it bypasses OpenRouter metering, `TOOL_CLASSES`, grants and "What I did". Marked experimental | `node_modules/ai/docs/03-ai-sdk-harnesses/01-overview.mdx` ("Harness packages are **experimental**") |
| AI SDK `Experimental_SandboxSession` as **the** provider API | Adopted as the **shape** of the operation surface (CD-05) through a structural type test, not imported at runtime, because it is experimental and has no lifecycle (create/pause/resume) | `@ai-sdk/provider-utils` 5.0.58 `SandboxSession` (`run`, `spawn`, `readTextFile`, `writeTextFile`…) |

## 5. License, provenance and governance checklist

- [ ] Pin: every port header and `NOTICE.md` name `ce7073d51254c26cd63b22a60835b8f948deb447`.
- [ ] Notice: `NOTICE.md` reproduces the DSH MIT copyright and permission
      notice; the repository `LICENSE` (Sourav Bera; Kriya AI) is untouched.
- [ ] Only DSH-authored packages are ported; nothing from `vendor/`
      (Cordis and others have their own notices) and no assets, fonts, icons
      or brand names (DSH `BRAND_GUIDELINES.md`).
- [ ] The runner image's own third-party software (Debian packages, Node,
      git, ripgrep, Python) is listed by an SBOM generated at image build
      (CD-21) and stored with the image version.
- [ ] Upstream changes: a recorded port update per file; never a sync of
      `master`.
