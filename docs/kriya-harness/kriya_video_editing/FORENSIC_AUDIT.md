# Forensic audit (track E)

Owner, 2026-11-07: "Reaudit each and everything at a forensic level, because the
changes we are making should not cause any bugs or existing workflows damage."

Every place the blueprint touches existing code was traced through the real
source of `Kriya-Tavi` (`d46bb0c`) and `kriya-harness` (`0ebfd0c`), the pinned DSH
packages, and HyperFrames v0.9.19. The first version of this blueprint **had real
defects**, and several would have broken running workflows. They are listed here
with their evidence, so the next agent can see why the design is as it is.

Severity: **S1** breaks an existing workflow or CI. **S2** a design that wouldn't
work. **S3** a wrong statement or a smaller gap. Every item below is fixed in the
documents; "Fix" says how.

## 1. Would have broken existing workflows

| Id | Sev | What the first blueprint said | Evidence | Would have happened | Fix |
| --- | --- | --- | --- | --- | --- |
| EH-01 | S1 | Report `edit` in the daemon's capabilities | `DaemonCapabilities` is `z.strictObject` (`lib/harness/contract.ts:292`), and `hello()` runs before the poll inside one `try` (`src/daemon.js`) | A new client on a server without the field gets 400 on `/daemon/hello`, backs off forever, never polls: **the Control Center and Remote Control stop on that computer** | Server field first, optional. The client sends `edit` only after `GET /editing/manifest` answered 200 (§3) |
| EH-02 | S1 | Daemon spawns `kriya edit run` as a child, "the same way it runs `kriya run`" | `MAX_RUNNING = 2`; `running.size` checked in `run` (`src/daemon.js`) | An edit holds a slot for hours; the person's tasks from Kriya are refused with "already running 2 tasks" | Edits never enter `running`. The daemon hands them to the Edit Host and returns |
| EH-03 | S1 | Cancel goes through the existing path | `next.cancel` loop: `else if (serving && id) serving.child.kill("SIGTERM")` | Cancelling any id not in `running` **kills `kriya serve`**, stopping a person's cloud tasks | The edit id map is checked first, and an edit id never reaches that branch |
| EH-04 | S1 | Not considered | `next()` returns at once while any row is `canceling` (`lib/harness/control.ts`), and such a row stays until reported | A lost edit job left `canceling` turns the long poll into a **hot loop** against Kriya, for ever | A cancel for an unknown edit always gets a terminal report at once |
| EH-05 | S1 | Job is a child of the daemon | On exit the daemon kills all children; Remote Control runs the daemon inside the app | Closing the harness kills a 3-hour render | The Edit Host is detached and owns its jobs |
| EH-06 | S1 | `edit` added to `DispatchKind` | `dispatchAction` validates `kind: DispatchKind` from the browser (`actions/harness-control.ts:27`) | A web session could queue `edit` directly, skipping the tool's approval, `editing.tavi` and the job row | `queue()` refuses `edit`; only `queueEdit()` in `lib/harness/control.ts` accepts it |
| EH-07 | S1 | Three rows for the new kind | `KIND_LABEL: Record<Dispatch["kind"], string>` (`components/harness/control-center.tsx:68`), `HARNESS_DISPATCH_KINDS` in `db/schema.ts` | Typecheck fails, so `npm run check` fails | Both listed in CHANGE_IMPACT |
| EH-08 | S1 | `kriya edit run` as a normal kriya process | `harness_runs.kind` SQL check and `RunReportRequest.kind` hold six kinds | `POST /runs` answers 400 | The Edit Host doesn't broadcast runs; it isn't a `kriya run` |
| EH-09 | S1 | `video_edit_start` is R2 **and** in `SIDE_EFFECT_TOOLS` | `tests/agent/tool-policy.test.ts`: "SIDE_EFFECT_TOOLS are exactly the R3 and R4 tools" | CI fails. Invariant 5 needs side effects in that set, so R2 was simply wrong | They are **R3** |
| EH-10 | S1 | `lib/agent/run-task.ts` "None" | The belt is built there (lines 863–880). `TOOL_APPROVALS` derives from `TOOL_CLASSES`, so approval needs no change, but offering a tool needs one spread. `CAPABILITIES` **throws at import** if `FACTS` lacks a classed tool (`lib/agent/capabilities.ts`) | The tools could never appear; or, with `FACTS` forgotten, **the whole worker crashes on import** | One owner-approved spread; `TOOL_CLASSES`, `TOOL_WRITES`, `FACTS` change in one commit; ET-POL-02 |
| EH-11 | S1 | Template "filtered out unless on" in `lib/templates.ts` | Imported by client components (`components/dialogs/agent-dialog.tsx`, `components/home/actions.tsx`, `components/onboarding/team.tsx`, `components/thread/thread-view.tsx`). A client can't read a setting | Onboarding, Home and the dialog would change for everyone with the switch off (AT-REG) | `lib/templates.ts` untouched. A preset passed through `getFeatures()` |
| EH-12 | S1 | Library skill `skills/video-editing` | `SKILL_MANIFESTS_V2` has no per-feature gate | The skill reaches every agent with `next.skillsV2` on | Removed. Guidance lives in the tool descriptions, which exist only with the switch on |
| EH-13 | S1 | Director fans out in parallel | `reserve_harness_spend`: `v_open >= 3` → `harness too many open`, **per person, across devices** (`20270301000200_harness_open_cap.sql`) | A running edit starves the person's live chat with 429s | The Model Call Governor (EDIT_LOOP §8): at most 2 open, 1 when anything else is live |
| EH-14 | S1 | 150 to 1,500 model calls per job | `harness.rpm` default 60 per device, shared by **every** harness route (`lib/harness/route.ts:123`), including Remote Control's 2-second posts | Same: chat, approvals and the daemon's poll get 429 | Governor at 20 per minute with AIMD; batching. A 2-hour transcript is about 40 k tokens and fits one call of a 1 M-token model, so budgets drop by about 10× |
| EH-15 | S1 | Model calls through `call()` | The host's firewall blocks bodies with shell text or HTML; only `gzip+base64` passes (`src/gateway-proxy.js`, `lib/harness/route.ts`) | A transcript containing such words gets a 403 "Blocked" | The Director uses the existing relay logic |
| EH-16 | S2 | `enqueueTurn` when a job finishes | It saves a **user** message, holds the daily limit and runs a model turn (`lib/agent/queue.ts:211`) | A fake user message in the thread, a paid turn per job, and a refusal at the limit | An assistant message by stable id with `onConflictDoNothing`, as `lib/voice/thread-summary.ts` does. No model |
| EH-17 | S2 | Dispatch `result` for all job state | `report()` allows `running → done/failed`, and only `canceling → canceled` | A `canceled` report from `running` is silently refused | The Edit Host reports `canceled` only after Kriya said `canceling` |
| EH-18 | S1 | Capability toggled by Remote Control | `options.control.update` sets only `fullAccess` and `serve` | Any toggle would drop `edit` | Listed in CHANGE_IMPACT §4 |
| EH-19 | S1 | `--edit` in `SWITCHES` | `bin/kriya.js` routes the app's flags by explicit `case` labels | `kriya --edit` is an unknown command | Case labels added |

## 2. Would not have worked

| Id | Sev | What it said | Evidence | Fix |
| --- | --- | --- | --- | --- |
| EH-20 | S2 | Studio as a DSH `main` page with `/api/kriya.edit.*` routes | Routes are **exact** paths (`fetchRoutes` is a `Map` on pathname), so a composition's relative assets can't load. No wildcard. React is pinned to DSH's 18. No way to set COOP/COEP on DSH's document | The Studio is its own local web app on its own origin (STUDIO_APP_AND_BROWSER). DSH keeps one sidebar row and one route. A DSH bump can't break it |
| EH-21 | S2 | "A clone where the disk supports it" for dropped files | A browser gives bytes, never a path | Dropped files stream as a copy. Big footage uses **Add folder**, by reference |
| EH-22 | S2 | DSH's directory picker | Its native variant is desktop-only; a plugin's reach is unproven | The Studio's own folder browser, as the Projects page does |
| EH-23 | S2 | Preview limit 100 MiB, uploaded through `kriya-web` | `supabase/config.toml` `file_size_limit = "50MiB"`; firewall reads bodies; `harnessRoute` paths buffer | Default 45 MiB; device uploads straight to Storage by signed link; the worker verifies |
| EH-24 | S2 | Previews in `fileStore` | It is bound to `kriya-files`; `FILE_MIMES` has no video; `sniff` refuses it | Own bucket `kriya-edit-previews`, own small client in `lib/editing/previews.ts`; `lib/files.ts` untouched |
| EH-25 | S2 | Reuse the 60-second signed link | `DOWNLOAD_SECONDS = 60` (`lib/files.ts`) | A `<video>` seek fails after a minute, so previews use a 1-hour link |
| EH-26 | S2 | Rows cascade away on account deletion | Cascade deletes rows, not Storage objects. `lib/cloud/janitor.ts` sweeps its own by comparing `storage.objects` with rows | A person's video would outlive their account: same sweep for previews (DPDP) |
| EH-27 | S2 | "Chrome with its sandbox on" (ES-05) | `buildChromeArgs` in HyperFrames always passes `--no-sandbox` | The claim was false. Chrome runs inside an OS sandbox with no network; model-written code is behind `editing.customMotion`, off, and off on any OS without confinement |
| EH-28 | S2 | HTML report uploaded and served | Stored markup in a Kriya-served bucket is a known risk (`sniff` refuses it for that reason) | The report is JSON, rendered by Kriya's own page |
| EH-29 | S2 | Custom trigger for job status | The codebase has `kriya.check_transition` and `kriya.allowed_transitions` | Uses them |
| EH-30 | S2 | Licence check over `package.json` | `scripts/notices.js` reads production dependencies; UI libraries are bundled from dev dependencies | ET-LIC-01 reads esbuild's metafile, so nothing bundled escapes the gate |

## 3. Deployment order (the rule EH-01 taught)

Strict schemas mean a client and server may be out of step for days. The rule:

| Combination | Result | Why it's safe |
| --- | --- | --- |
| New server, old client | Nothing changes | `queue()` needs a capability the old client never sends |
| Old server, new client | Studio says "not available on your Kriya yet"; everything else unchanged | `/editing/manifest` answers 404, so the client sends no new field |
| New server, new client, switches off | Nothing changes | Routes 404 |
| Ship order | **Server first, always**, then the client | ET-REG-03 runs a new client against a recorded old server |

No client ever sends a new field to a server that didn't advertise it first.

## 4. Smaller corrections

| Id | Correction |
| --- | --- |
| EH-31 | `tests/harness/regression.test.ts` filters on `harness.`, so it needs no change. Editing has its own test |
| EH-32 | EF-05's open point is settled: `beginFrame` runs only on Linux with `chrome-headless-shell`. macOS and Windows use screenshot capture |
| EH-33 | HyperFrames' `render` has `--start`, `--end`, `--workers`, `--gpu`, `--browser-gpu`, so tiles are a supported path, and EX-01 confirms speed only |
| EH-34 | Text in a dispatch's `prompt`-style field is capped at 4,000 characters; `payload` at 16 KB, `result` at 32 KB |
| EH-35 | The gateway passes `response_format`, `tools` and `tool_choice` (`ChatRequest` is a loose object) and strips `n`, so N-way sampling needs N calls |
| EH-36 | Without `max_tokens` a call reserves the full output cap, so a job could report the limit reached falsely. The Director always sets it |
| EH-37 | A person-offered folder is a precondition for a Tavi job (CC-D2), so a Studio project outside offered folders isn't reachable from Tavi until the person allows it |
| EH-38 | `lib/agent/instructions.ts` stays unchanged: a prompt line would differ with the switch off unless gated, and tool descriptions are enough |
| EH-39 | `queries/features.ts` gains a key, so any typed fixture of `Features` updates with it |
| EH-40 | The client's `package.json` `files` list must include the Studio's built assets |
| EH-41 | Project files in a synced folder may get "conflict copy" twins. The Studio detects two files with one project id and asks |
| EH-42 | `sandbox-exec` is deprecated by Apple, though still shipped. Noted in ES-05 with a fallback |

## 4a. Found by running it (ED1)

Static reading can't find these. Evidence is in SPIKES.md.

| Id | Sev | Finding | Fix |
| --- | --- | --- | --- |
| EH-43 | S2 | HyperFrames' CLI sends PostHog telemetry by default | Disabled by environment, and blocked by the sandbox (ES-24) |
| EH-44 | S2 | A composition can reach the internet during a render | Every Chrome render confined |
| EH-45 | S3 | Pixels differ between identical renders on one machine | Claim weakened; cache keys on inputs |
| EH-46 | S3 | The layer split's first-render gain is 1.3×, and an untagged source goes wrong through Chrome | Sold on revisions; colour normalised first |
| EH-47 | S3 | "200 calls is 10 minutes" was wrong: 25 to 50 | First cut at most 8 calls |
| EH-48 | S2 | faster-whisper has no GPU path on a Mac | Engine per platform |
| EH-49 | S2 | Language detection took Telugu for Tamil | The person sets the language |
| EH-50 | S2 | BiRefNet runs at 0.2 fps on CPU and CoreML can't compile it | Hybrid matte |
| EH-51 | S3 | `ffprobe-static` is Intel-only on arm64 | Matched native pair in the manifest |
| EH-52 | S2 | A GPU device per clip hangs intermittently | One device, plus a watchdog |
| EH-53 | S2 | QG-04 can't reliably catch a clipped word | QG-05 checks the signal at each cut |

## 5. Every existing workflow, and what protects it

The list a release must keep green. "Touched" means code in that path changes.

| Workflow | Touched? | Protection | Test |
| --- | --- | --- | --- |
| Coding session in the Web UI | One sidebar row | Plugin no-ops off; `src/edit/**` is imported lazily, only when on | ET-REG-01 |
| `kriya run` | No | Not in its profile path | Existing `*-run` tests |
| `kriya acp` | No | Same | `acp.test.js` |
| Agent browser, Preview tab | No | Studio uses its own Chrome | `browser-run.test.js` |
| Loop, verify, checkpoints, rules | No | Edit Loop shares no code or files | `loop*.test.js` |
| Skills page, default skills | Off → no | Separate export, own switch | ET-SK-02, HT-DS-01/02 |
| Model gateway, billing | No | Director is an ordinary client under the Governor | HT-GW-*, ET-GOV-01 |
| Live chat during an edit | Indirect | Governor leaves room (EH-13, EH-14) | ET-GOV-02 |
| Approvals, Inbox | Additive, behind a switch | Off → identical | HT-APR-*, ET-UI-06 |
| Daemon, Control Center | One new branch | EH-01…08 | `daemon*.test.js`, ET-DMN-01…05 |
| Remote Control | One toggle | EH-18 | `remote.test.js` |
| `kriya serve`, cloud tasks | No, and EH-03 protects it | Cancel routing | ET-DMN-03 |
| Handoff, pull | No | Different kinds | HT-HND-* |
| Flows device runs | No | `queue()` unchanged for `run` | ST tests |
| Session mirror | No | | HT-MIR-* |
| Tavi chat, tasks, queue | One spread in the belt, off by default | `lib/agent/queue.ts` untouched | AT-REG-01, NT-REG-01, CT-REG-01 |
| Tool policy, capabilities | Rows | EH-09, EH-10 | AT-POL-*, OT-CAP-* |
| Agent creation, onboarding | Dialog only, behind a feature | EH-11 | ET-REG-01 |
| File uploads, Files page | No | Own bucket | Existing file tests |
| Plans, billing, usage | One column, default 0 | Off → same | Existing owner tests |
| Migrations, RLS | New migration and rollback | `tests/db/migrations.test.ts`, `lint.test.ts`, readiness test | ET-DB-* |
| Voice | No | | Existing |
| Rooms | No | | Existing |

## 6. How this audit was done, and its limits

Read directly: `src/daemon.js`, `bin/kriya.js` routing, `src/launch.js`,
`src/modes.js`, `src/profiles.js`, `plugins/{overview,projects,preview,remote}`,
`bundle/cordis.patch.yml`; DSH's `dsh-client-connection`, `dsh-host-webserver`,
`dsh-client-ui-layout`, `dsh-web-frontend`; `lib/harness/{contract,control,gateway,
route,handoff}.ts`, `lib/agent/{tools,policy,capabilities,run-task,queue}.ts`,
`lib/files.ts`, `lib/templates.ts`, `lib/cloud/janitor.ts`, `lib/voice/thread-summary.ts`,
`actions/{harness-control,account}.ts`, `components/harness/control-center.tsx`,
`queries/features.ts`, `worker/index.ts`, the dispatch and spend migrations, and
the tests that pin these. HyperFrames: `browserManager.ts`, `config.ts`,
`render.ts`, and its docs.

Not done: nothing was executed against a real media file, model or DSH build of
the Studio. Static reading finds what static reading can find. ED1's spikes and
each phase's tests are what prove the rest.
