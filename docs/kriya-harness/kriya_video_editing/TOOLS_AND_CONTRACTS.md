# Tools and contracts (track E)

Every interface between parts. Schemas live in code: zod in this repository
(`lib/harness/contract.ts`); the client's `contract/contract.json` is the exported
copy, as for all harness routes.

## 1. Edit Host API (local)

HTTP on `127.0.0.1:<port>`, fenced as STUDIO_APP_AND_BROWSER §3 says. The `edit_*`
tools and the daemon use a Unix socket with the same methods (a named pipe on
Windows), mode 0600: no port, no cookie.

| Route | Purpose |
| --- | --- |
| `POST /session` | Exchange a launch token for the session cookie |
| `GET /host` | Versions, runtime, hardware tier, free disk |
| `GET/POST /projects`, `GET/PATCH /projects/{id}` | List, create, read, apply operations |
| `POST /projects/{id}/assets` | Link by path (from the folder browser) |
| `POST /projects/{id}/upload` | Stream a dropped file |
| `GET /browse?root=` | Folder browser, inside allowed roots |
| `GET /media/{id}` | Proxy or audio, with `Range` and 206 |
| `GET /tiles/{id}` | Thumbs, peaks, motion tiles |
| `GET /, /studio.js, /studio.css` | The Studio app (ED6), fenced; everything it asks for needs the session |
| `GET /projects/{id}/plan` | RenderPlan for the live compositor, plus the solver's `timeline` (pieces with clip ids, in timeline time) |
| `GET/POST /projects/{id}/index` | Each asset's layers and notices, with the words, sentences, takes and shots; start an index job for one asset (ED5) |
| `POST /projects/{id}/ask` | The Director console: one request in words, with the selection; answers a proposal (ED7) |
| `POST /projects/{id}/proposals/{id}` | Accept all, accept some (`only`), or reject a proposal; rebased onto HEAD (ED7) |
| `POST /projects/{id}/make` | A make job: the `reel-talking-head` recipe through the Edit Loop, gated (ED7) |
| `POST /projects/{id}/export/handoff` | The current cut as a handoff package in the project's `exports/` folder: OTIO, FCPXML, EDL, SRT, chapters, manifest, media linked; answers the folder (relative to the project), the files, what was omitted and the chapters; 409 when the timeline is empty (ED12) |
| `GET/POST/DELETE /jobs` | Render, cancel, list |
| `GET /events` | Server-sent events: progress, layer ready, job done |
| `GET /taste`, `POST /taste/{key}/{confirm,dismiss,remove}` | The person's rules (ED16): a Studio session only, refused on the socket |
| `GET/POST /runtime` | Setup state, install a pack |
| `POST /internal/job` | Socket only: the daemon hands over a job |
| `POST /internal/cancel` | Socket only |

The Host accepts typed requests only. No route runs a command. Every path must be
inside a project's known assets, its cache or `exports/` (ET-HOST-03).

## 2. Agent tools (harness, coding sessions)

Registered by `plugins/edit/index.js` with the `edit` switch on. They're a thin way
to use the Studio from a normal session or `kriya run`; each calls the Host. Results
are short.

| Tool | Input | Result | Class |
| --- | --- | --- | --- |
| `edit_status` | — | Project, version, layers, jobs, verdict | Read |
| `edit_find` | `query`, `kind?`, `limit?` | Ids, times, short text | Read |
| `edit_look` | `view`, `range?` | A view, in budget | Read |
| `edit_make` | `brief`, `recipe?`, `effort?` | Job id, then a summary and verdict | Project write |
| `edit_change` | `request`, `selection?` | What changed, version | Project write |
| `edit_apply` | `ops[]` | Diagnostics, version | Project write |
| `edit_undo` | `to?` | Version | Project write |
| `edit_render` | `level`, `deliverable?` | Job id, then verdict | Project write |
| `edit_export` | `deliverables[]`, `handoff?` | Paths under `exports/`, verdict | Project write |
| `edit_motion` | `request`, `variables?` | Block id, or why it failed | Project write; needs `editing.customMotion` |

"Project write" touches only project state and `exports/`; sources are never written
(ES-02). In Read only and Plan modes writes are refused. In Ask mode they're allowed
with no prompt, because each stays in the project and can be undone (EDD-30). None
takes a shell string, a URL or an arbitrary path. All text from media comes under
the untrusted notice (ES-04).

## 3. Harness plugin routes

Two only, under DSH's `/api`, registered through `ctx.inject(["connection"], …)`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/kriya.edit.status` | GET | Whether the row should show; render ring |
| `/api/kriya.edit.launch` | POST | Starts the Host if needed; returns the one-time URL |

## 4. Command line

| Command | Does |
| --- | --- |
| `kriya edit` | Starts the Host, opens the Studio |
| `kriya edit setup [--pack <name>]` | Installs the Media Runtime; with `--pack`, one capability pack beside it (ED13). `--remove-pack <name>` removes one; the core stays |
| `kriya edit doctor` | Runtime, encoders, hardware tier, disk, synced-folder note |
| `kriya edit run "<brief>" [--media <folder>] [--recipe <id>] [--job <id>] [--json]` | One edit, no UI, no agent loop. Exit 0 delivered, 2 delivered with notes, 1 failed or blocked |
| `kriya edit render <project> [--master]` | Render |
| `kriya edit verify <file> [--receipt <file>]` | Re-measure a file against its receipt |
| `kriya edit replay <job>` | Re-run from the flight recorder, no model cost |
| `kriya edit gc`, `kriya edit forget <project>` | Clear cache; delete local data |
| `kriya edit watch [<folder>]`, `kriya edit unwatch <folder>` | New-recording cards, per folder (ED15, EDD-47). It must be a folder the daemon offers |
| `kriya daemon --allow-edit` | Allow editing from Kriya |

`src/modes.js` gains `["edit", "KRIYA_EDIT", false]`; `bin/kriya.js` gains the
`edit` case and the `--edit`, `--no-edit` labels (EH-19). Off, `kriya edit` says it's
off and nothing else runs.

## 5. Harness API additions

All behind `editing.studio` (404 when off), through `harnessRoute` (so
`authenticateDevice`, client version and `harness.rpm` apply), in `ROUTES`.

| Route | Method | Purpose | Switch |
| --- | --- | --- | --- |
| `/editing/manifest` | GET | Runtime manifest for this client; recipes version. **Its 200 is how a client learns this server has editing** (EH-01) | `editing.studio` |
| `/editing/jobs/{id}/previews` | POST | Reserve in SQL; returns a signed upload URL | `editing.previews` |
| `/editing/jobs/{id}/previews/{pid}` | POST | Upload finished; the worker verifies later | `editing.previews` |
| `/editing/jobs/{id}/references/{fileId}` | GET | A short signed link to a reference attached to that job. **Not built in ED14**: nothing on the computer uses a reference from Kriya yet, so `references` is on neither the tool nor the payload | `editing.tavi` |
| `/editing/jobs/{id}/questions` | POST | Post a decision card | `editing.review` |
| `/editing/questions/{id}` | GET `?wait=0…25` | Long-poll for the answer, as `/approvals` | `editing.review` |
| `/editing/jobs/{id}/notes` | GET | The notes the person sent in this revision (as built: by revision, so no `?since=`) | `editing.review` |
| `/editing/found` | POST | A new recording's folder id, name and duration; 409 when the computer doesn't offer the folder, 429 past 20 open cards | `editing.watchFolders` |

No route answers a question, adds a note, approves or starts a job: those are session
actions (§8, track H rule 3). Job progress uses the existing `POST /dispatch/{id}`
with `running` and `{ stage, percent }`, at most every 10 seconds. `GET /models` is
unchanged. Binary never passes through `kriya-web`: uploads go straight to Storage,
so the firewall and web memory aren't involved (EH-23).

## 6. Dispatch kind `edit`

```ts title="lib/harness/contract.ts"
edit: z.strictObject({
  project: PROJECT_ID,            // a folder this computer offers
  job: z.uuid(),
  brief: SHORT(4000),
  recipe: z.string().regex(/^[a-z0-9-]{1,48}$/).optional(),
  effort: z.enum(["fast", "best"]),
  revisionOf: z.uuid().optional(),
  // references: later, with the route in §5 (not built in ED14)
}),
```

```ts title="DaemonCapabilities, additive"
edit: z.boolean().optional(),    // absent from older clients
```

In `lib/harness/control.ts`: `queue()` refuses `kind === "edit"`. A new exported
`queueEdit()` shares its body and checks `caps.edit`, `editing.tavi` and
`editing.dailyJobs`. `dispatchAction` therefore can't reach it (EH-06).

In `src/daemon.js`:

```text
on edit:   if !capabilities.edit → refuse
           report running; hand to the Host over the socket; add to `editing` set
           never touches `running`, so MAX_RUNNING is unaffected
on cancel: if id in `editing` → forward to the Host          (before the serving branch)
           if the Host doesn't know it → report canceled now (no hot loop)
```

The Host reports the terminal status itself: `done` or `failed` from `running`, and
`canceled` only when Kriya already said `canceling` (EH-17). It doesn't call
`broadcastRun` (EH-08).

## 7. Tavi tools (`lib/agent/tools.ts`, `kriya-worker` only)

Built by `createEditTools(env)` in `lib/editing/tools.ts`, re-exported as
`createWorkspaceTools` is, and added to the belt by one spread in
`lib/agent/run-task.ts`, only with `editing.tavi` on.

| Tool | Input | Class | Notes |
| --- | --- | --- | --- |
| `video_edit_places` | — | R0 | Online computers with the capability and their offered folders. No file listing |
| `video_edit_start` | `device`, `project`, `computer`, `folder`, `brief`, `recipe?`, `effort?` | **R3** | Approval of the exact call; creates the job; `queueEdit()`. `computer` and `folder` are names for the card: refused unless they're what the computer reports, so a person never approves a raw id or a false name |
| `video_edit_status` | `job` | R0 | Status, stage, verdict, preview link |
| `video_edit_revise` | `job`, `change` | **R3** | A new job with `revisionOf` |

R3 because invariant 5 requires anything that changes something outside Kriya to be
in `SIDE_EFFECT_TOOLS`, and a test pins that set to exactly the R3 and R4 tools
(EH-09). `TOOL_APPROVALS` derives from `TOOL_CLASSES`, so approval follows with no
change there. Not grantable: no pins.

**All in one commit**, or the worker fails at import (EH-10): `TOOL_CLASSES`,
`TOOL_WRITES`, `SIDE_EFFECT_TOOLS`, `FACTS` in `lib/agent/capabilities.ts` with a new
`System` value `device`, and `createEditTools` in `everyTool()` in
`tests/operator/capabilities.test.ts`. Then the cards: `components/thread/tool-call.tsx`,
`components/workbench/activity.tsx`.

As built in ED14: what the computer reports through `POST /dispatch/{id}` is kept only
in a fixed shape (`lib/editing/jobs.ts`): `{ stage, percent, beat }` while running,
`{ outcome, gates, notes }` when done, `{ code }` when failed. No words from a computer
reach a thread or an agent. An invalid report ends the job `failed` with `bad_report`.
`POST /internal/job` and `POST /internal/cancel` are the Host's socket routes; cancel
answers `{ known }`, and the daemon closes a job the Host doesn't know.

## 8. Person's actions (server)

`actions/editing.ts`: session, zod, `withUser`. No agent tool can reach these
(track-A rule 11, ET-POL-01).

| Action | Does |
| --- | --- |
| `dismissFound` | "Not this one" on a new-recording card (added in ED15) |
| `cancelEdit` | Through the existing `cancel()` |
| `answerEditQuestion` | The person's answer to a decision card |
| `addEditNote`, `removeEditNote` | Timecoded notes |
| `sendEditNotes` | Starts a revision through `queueEdit()`. The person's own act, so no tool approval |
| `acceptEdit` | Closes the job |
| `startFromFound` | One tap on a watch-folder card |
| `deleteEditPreview` | Removes a preview |

Reads in `queries/editing.ts`. The player uses `GET /api/editing/preview/[id]`: session
only, own row only, a redirect to a 1-hour signed link (EH-25).

## 9. Errors

One shape everywhere: `{ code, message, where? }`, with `message` written for the
person.

| Code | Meaning | Handling |
| --- | --- | --- |
| `runtime_missing` | Runtime or a pack isn't installed | Studio offers install |
| `layer_unavailable` | A layer can't run here | Continue, or say what's lost |
| `disk_low` | Not enough space | Stop cleanly |
| `source_offline` | A file moved | Relink |
| `bad_op` | An operation failed validation | Repair, or show |
| `gate_blocked` | A blocking failure remains | Report |
| `model_unavailable` | Gateway refused or offline | Paused; hand editing goes on |
| `rate_limited` | 429 from the gateway | Governor backs off |
| `cap_reached` | Harness limit | Existing message |
| `not_allowed` | Off, or a capability is missing | Plain message |
| `rights_blocked` | Refused content | Plain refusal |

## 10. Versioning

Project `schema`, Host protocol, runtime manifest, recipe and block versions move
separately. The Host and client ship together and must match. A project written by
a newer client is refused, never downgraded. `harness.minClientVersion` works as it
does today. **Server ships before client, always** (FORENSIC_AUDIT §3).
