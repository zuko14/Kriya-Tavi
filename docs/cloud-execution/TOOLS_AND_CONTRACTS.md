# Tools and contracts (track C)

The interfaces each phase implements. Types are TypeScript sketches; the
implementing phase writes them in the codebase's style (zod at every wire,
plain functions, comments only for the why).

## 1. `WorkspaceProvider` (`lib/cloud/provider.ts`, C3)

Lifecycle only. Every operation on files and commands goes to the runner.

```ts
export type WorkspaceSpec = {
  workspaceId: string
  userId: string
  generation: number
  image: string            // cloud.image (template id)
  size: string             // cloud.size, e.g. "2c-4g"
  network: "registries" | "offline"
  runnerToken: string      // runnerToken(workspaceId, generation), CD-09
  limits: RunnerLimits     // from the cloud.* settings; §2 "Limits"
  timeoutSeconds: number   // provider-side auto-stop if Kriya stops extending
}

export type Opened = { ref: string; runnerUrl: string }

export interface WorkspaceProvider {
  readonly name: "local" | "e2b" | "daytona"
  create(spec: WorkspaceSpec): Promise<Opened>
  // null: the provider no longer has it (destroyed, expired) → restore path
  resume(ref: string, spec: WorkspaceSpec): Promise<Opened | null>
  pause(ref: string): Promise<void>
  destroy(ref: string): Promise<void>        // idempotent
  extend(ref: string, seconds: number): Promise<void>
  // Reconcile: every sandbox this deployment owns (tagged at create)
  list(): Promise<{ ref: string; workspaceId: string | null; running: boolean }[]>
}
```

Rules every adapter keeps (CT-PRV-01…06 against recorded responses):

1. Tags each sandbox with `kriya_env` (from `KRIYA_APP_URL`'s host) and
   `workspace_id`; never the person's name, email or repository.
2. Passes `runnerToken` only as the runner process's environment at create,
   never in a URL, log or tag.
3. Requests the network policy for `network`; refuses to create when the
   provider can't express it and the image fallback isn't available (CD-12).
4. Never retries `create`; retries `pause`, `destroy`, `extend`, `list` up
   to twice on transport errors (they are idempotent).
5. Maps provider errors to `WorkspaceProviderError` with a plain message;
   provider payloads are logged only as status codes.

`workspaceProvider()` (in `lib/cloud/session.ts`) returns the adapter for
`cloud.provider` when its env is complete, a test override
(`setWorkspaceProviderForTests`, the browser pattern), or null. `local`
returns null unless `KRIYA_WORKSPACE_LOCAL=1` and `DATABASE_URL`'s host is
`127.0.0.1` or `localhost` (CD-07, CT-PRV-01).

## 2. The runner protocol (`runner/protocol.ts`, C2)

HTTP/1.1 JSON on one port (default 10000), every request except
`GET /v1/health` with `Authorization: Bearer <runnerToken>` compared in
constant time (as
`browser/index.ts` does). Bodies are zod-validated; unknown fields refused.
Paths are relative to `/workspace` and resolved with `realpath`; anything
outside, any symlink escaping it, and `.kriya/` (the runner's own area) are
refused for writes.

| Method and path | Request | Response | Notes |
| --- | --- | --- | --- |
| `GET /v1/health` | — | `{ ok, version, generation }` | No token needed for liveness only; returns no workspace data |
| `POST /v1/import` | `application/x-tar+gzip` stream, header `X-Kriya-Strip: 1`, `X-Kriya-Base: <sha>` | `{ files, bytes, baseCommit }` | Once per generation; size cap; refuses absolute paths, `..`, links pointing outside, devices; then `git init`, one local base commit |
| `POST /v1/restore` | `application/octet-stream` patch | `{ applied: true }` | After import; `git apply --binary --whitespace=nowarn`; failure leaves the tree at base and says so |
| `POST /v1/exec` | `{ command, cwd?, timeoutSeconds, env? }` | NDJSON: `{type:"out", stream, text}`… then `{type:"end", exitCode, signal, durationMs, truncated, logPath}` | The runner (root in the VM, CD-21) spawns `bash -lc` with `kriya`'s uid and gid and the scrubbed environment (P1); `env` keys must match `^[A-Z_][A-Z0-9_]{0,63}$` and may not set `PATH`, `HOME`, `LD_*`; output capped (P2); timeout and client disconnect kill the process group (P1, P6) |
| `POST /v1/read` | `{ path, startLine?, endLine? }` | `{ text, lines, sha256, truncated }` or `{ binary: true, bytes }` | Records the observation for P4 |
| `POST /v1/write` | `{ path, content, expectSha256? }` | `{ sha256, created }` | P4: refused if the file exists and wasn't read in this generation, or changed since |
| `POST /v1/edit` | `{ path, oldText, newText, replaceAll? }` | `{ sha256, replacements }` | Exactly one match unless `replaceAll`; P4 applies |
| `POST /v1/patch` | `{ patch }` | `{ files: [{ path, op }] }` | P3 parser; all-or-nothing; P4 per touched file |
| `POST /v1/list` | `{ path?, depth? }` | `{ entries: [{ path, type, bytes }], truncated }` | Honors `.gitignore`; caps entries |
| `POST /v1/search` | `{ pattern, path?, glob?, fixed? }` | `{ matches: [{ path, line, text }], truncated }` | `rg` with match, line-length and time caps (P7) |
| `POST /v1/changes` | `{ maxDiffBytes? }` | `{ changeSetId, files: [{ path, status, added, removed, binary, bytes }], diff, truncated }` | Against the base commit; `changeSetId` = sha256 over the sorted (path, status, content sha256) list (P8) |
| `POST /v1/files` | `{ changeSetId }` | `{ files: [{ path, status, mode, contentBase64? }] }` | Full content of changed files for publish; refused if the id no longer matches |
| `POST /v1/checkpoint` | — | `application/octet-stream` patch, header `X-Kriya-Sha256`, `X-Kriya-Changes` (JSON counts) | Binary diff base → snapshot of the working tree incl. untracked, excl. ignored; 413-style refusal above the cap |

Limits (defaults; the worker passes `WorkspaceSpec.limits` and the adapter
sets them as `KRIYA_RUNNER_LIMITS`, JSON, in the runner's environment at
create, next to the token; the runner validates them with zod at start and
refuses to start on a bad value): body 16 MB except import (`cloud.maxImportMb`);
exec output kept in memory 64 KB per stream, model gets the first 8 KB and
last 8 KB; read 2 000 lines or 256 KB; list 2 000 entries; search 500
matches, 400 chars per line, 10 s; diff 200 KB.

### Structural compatibility with AI SDK (CD-05)

`lib/cloud/client.ts` exposes `run({ command, workingDirectory, env, abortSignal })`
→ `{ exitCode, stdout, stderr }` and `readTextFile`, `writeTextFile`,
`readBinaryFile`, `writeBinaryFile` with AI SDK's option names, plus
`description`. A type-only test (CT-RUN-20) asserts
`satisfies Pick<Experimental_SandboxSession, "run" | "readTextFile" | "writeTextFile" | "readBinaryFile" | "writeBinaryFile" | "description">`.
If the experimental type changes, that test fails and nothing at runtime.

## 3. The tools (`lib/cloud/tools.ts`, C4; publish in C5)

All are created by `createWorkspaceTools(env, workspace, { publish })` and
re-exported from `lib/agent/tools.ts`. Every output that carries workspace
content starts with `notice: FOREIGN` (the existing constant). Names never
contain `share` (`tests/agent/share.test.ts`).

| Tool | Input (zod) | Output | Class | Notes |
| --- | --- | --- | --- | --- |
| `workspace_open` | `{ repo?: REPO, ref?: BRANCH }` | `{ repo, ref, baseSha, status, restored }` | R1 | Opens this thread's workspace. With `repo`: needs a GitHub connection (`connected.github`) and `agents.connectors`; refuses a repo different from an existing workspace's ("close it first"). Without `repo` and no workspace: a blank one |
| `workspace_run` | `{ command: string ≤ 4000, cwd?: path, timeoutSeconds?: 1…setting }` | generator of `{ status: "running", tail }`, final `{ exitCode, durationMs, stdout, stderr, truncated, logPath }` | R1 | Third identical command in a row adds a "change approach" note (P5); `toModelOutput` gives head + tail only |
| `workspace_read` | `{ path, startLine?, endLine? }` | `{ text, lines, truncated }` | R0 | |
| `workspace_list` | `{ path?, depth?: 1…4 }` | `{ entries, truncated }` | R0 | |
| `workspace_search` | `{ pattern ≤ 200, path?, glob?, fixed? }` | `{ matches, truncated }` | R0 | |
| `workspace_write` | `{ path, content ≤ 512 KB }` | `{ path, created }` | R1 | P4 |
| `workspace_edit` | `{ path, oldText, newText, replaceAll? }` | `{ path, replacements }` | R1 | P4 |
| `workspace_patch` | `{ patch ≤ 512 KB }` | `{ files }` | R1 | P3, P4 |
| `workspace_changes` | `{}` | `{ changeSetId, files, diff, truncated }` | R0 | Also updates `workspaces.changes` for the strip |
| `workspace_publish` | `{ repo: REPO, changeSetId: sha256, branch: /^kriya\/[a-z0-9._-]{1,60}$/, title ≤ 120, body ≤ 8000 }` | `{ repo, number, url, branch, base, verification }` | R4, side effect | Only with `cloud.publish` on, a repo workspace and `connected.github`. `repo` must equal the workspace's (the person approves the exact destination). CD-10 |

`approvals.ts` `actionTitle(tool, input, tense)` sees only the input, so the
one new case uses input fields: `workspace_publish` → "Open a draft pull
request in <repo>: “<title>”" / "Opened a draft pull request in <repo>:
“<title>”".

### Policy rows (CD-11), all additions

- `TOOL_CLASSES`: the classes above.
- `TOOL_WRITES`: DATA_MODEL §6.
- `SIDE_EFFECT_TOOLS += "workspace_publish"` (AT-POL-01: exactly the R3/R4 tools).
- `PRIVATE_READ_TOOLS += workspace_read, workspace_run, workspace_list, workspace_search, workspace_changes`.
- `PERSON_ONLY_WRITES += "workspaces.close_requested_at"`.
- `capabilities.ts`: `System` gains `"workspace"`; `FACTS` rows for all ten
  (`{ system: "workspace" }`; `workspace_publish` adds
  `verification: "api_readback"`); none `repeatable`, none with `pins`
  (so none grantable).
- Not in `UNCLASSIFIED_OK`; the belt guard keeps them because they are classed.

## 4. `TaskWorkspace` (`lib/cloud/session.ts`, C3)

```ts
class TaskWorkspace {
  constructor(provider: WorkspaceProvider, task: Task, settings: CloudSettings)
  describe(): Promise<WorkspaceLine>                 // DB only, for the prompt
  open(input: { repo?: string; ref?: string }): Promise<OpenResult>
  client(): Promise<RunnerClient>                    // ensures running; restores if needed
  heartbeat(): Promise<void>                         // extend + session heartbeat_at
  close(reason: StopReason | null): Promise<void>    // checkpoint (unless shutdown/lease_lost) + pause + meter
}
```

`client()` steps, each a guarded transition:

1. Load the thread's most recent workspace that isn't `closed` (`privileged`,
   `user_id = task.userId`, `thread_id = task.threadId`). `running` with an
   open session of this task → reuse the client.
2. `open_workspace_session` with a new session id **before** any status
   change (refusal → plain message; status untouched); then
   `paused`/`failed`/`new` → `starting`.
3. `provider_ref` present → `resume`; else or on `null` → `generation + 1`,
   `create`, then import at `base_sha` (if repo) and restore the checkpoint.
4. Health probe (10 s); `starting → running`; `last_active_at = now()`.
5. Any failure in 3–4: destroy what was created this call, session `failed`
   with its measured seconds, workspace `starting → paused` if an earlier
   sandbox is untouched (a failed resume), else `starting → failed`; tool
   error with the plain message.

`close(reason)`: no open session → nothing. For `shutdown`/`lease_lost`:
pause, session `closed` with that reason, workspace `paused`. Otherwise:
`changes` → if the change set id differs from the last checkpoint's,
`checkpoint` (upload, `checkpoint_seq + 1`, delete the one before the
previous), then pause; a failed upload sets `checkpoint_failed_at` and still
pauses (never destroys). Seconds = `closed_at - opened_at`; one
`resource_usage` row `workspace_seconds` with `request_key = workspace:<session id>`
and `cost_micro_usd = round(seconds × rate / 3600)` when
`cloud.costMicroUsdPerHour` is set, else null.

## 5. Publish and import (`lib/cloud/publish.ts`, `lib/connectors/github.ts`, C5)

Three additive functions in `lib/connectors/github.ts` (owner-gated,
CD-09/CD-10), all through `providerFetch` so the token never leaves
`lib/connectors`: `githubTarball` and `githubCommitTree` below, and
`githubOpenDraftPr` (next paragraph). To verify in C5 on fixtures and once
on the owner's test repository: GitHub answers the tarball request with a
redirect to a short-lived download URL; if `providerFetch` doesn't follow it
(or forwards the `Authorization` header to the other host), `githubTarball`
follows the `Location` itself without the header. Record the observed
behaviour in `status.md`.

```ts
// The repository at one commit as a gzip tar stream (GET /repos/{repo}/tarball/{sha})
export async function githubTarball(userId: string, repo: string, ref: string):
  Promise<{ sha: string; body: ReadableStream<Uint8Array>; bytes: number | null }>

// One commit with these files on top of base, on a new branch (Git Data API:
// blobs, trees, commits, refs); never updates an existing ref
export async function githubCommitTree(userId: string, input: {
  repo: string; base: string; baseSha: string; branch: string; message: string
  files: { path: string; mode: "100644" | "100755"; content: Buffer | null }[] // null = delete
}): Promise<{ commitSha: string; branch: string }>
```

`workspace_publish` then opens the draft PR with the existing REST call shape
used by `githubOpenPr` (a new small function `githubOpenDraftPr` in the same
file, `draft: true`) and reads it back. Limits: 300 files, 5 MB per file,
50 MB total; binary files allowed through blobs; file modes kept.

## 6. Worker steps

| Where | What | Switch |
| --- | --- | --- |
| `runTask` | §4 lines (ARCHITECTURE §4) | `cloud.workspaces` |
| `schedulerLoop` | One `try` block: `workspaceJanitor()` | `cloud.workspaces` (also runs once with the switch off while any workspace is `running`/`paused`, so switching off stops compute) |
| `janitor()` (hourly) | Nothing new (retention is in `workspaceJanitor`) | — |

`workspaceJanitor()` per run (bounded batch sizes, each step in its own
`try`): (1) open sessions with `heartbeat_at` older than
`cloud.orphanSeconds` → checkpoint if reachable, pause, close as `orphan`;
(2) `close_requested_at` set → `closing`, destroy, delete checkpoints,
`closed`; (3) `paused` longer than `cloud.pausedHours` with no
`checkpoint_failed_at` → destroy, clear `provider_ref`; (4) unused past
`cloud.retentionDays` → as (2); (5) `checkpoint_failed_at` set → retry the
upload if the sandbox can be resumed briefly, else leave it paused and log;
(6) every 10 minutes `provider.list()` → destroy sandboxes whose
`workspace_id` has no open row; delete `workspaces/<user_id>/…` objects with
no row (account deleted).
