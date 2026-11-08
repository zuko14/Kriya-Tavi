# Test strategy (track E)

Server tests run in this repository's `npm test` (PGlite, no network). Client
tests run in `kriya-harness` with `node --test`. Neither calls a real model, a
real site or a real Kriya deployment. **All media fixtures are synthetic**:
FFmpeg `lavfi` video, tones and generated speech committed as small files, so
no real person is on them. A separate `npm run test:media` needs the Media
Runtime, and it runs in client CI and locally, not in `npm test`.

Baselines to keep, recorded at EDP-1 on 2026-11-07: Kriya `d46bb0c`, Test Files 263
passed, 5 skipped, Tests 3,106 passed, 63 skipped, exit 0; client `0ebfd0c`, 390/390,
exit 0. No
existing assertion changes, apart from the lists named in CHANGE_IMPACT.

| Layer | Runs | Needs |
| --- | --- | --- |
| Edit Core | Every commit; milliseconds | Nothing: pure functions and golden files |
| Director | Every commit | Scripted model (AGENTS.md, Testing changes that call models) |
| Engine | `test:media` | Runtime; fixtures |
| Studio | Browser check, per screen phase | Fake Kriya |
| Server | `npm test` | PGlite |
| Real model | Owner's go-ahead only | Budget |

## Regression

| Id | Behaviour | Where |
| --- | --- | --- |
| ET-REG-01 | With every `editing.*` setting and `KRIYA_EDIT` off: no new route answers (404), no tool, prompt, approval, sidebar row, dispatch kind in use, or page changes; `TOOL_APPROVALS` is the same object; both suites at baseline | `tests/editing/regression.test.ts`; client `tests/edit-regression.test.js` |
| ET-REG-02 | `expected/*.dump.yml` differ only by the `kriya-edit` row | Client `HT-REL-03` |
| ET-REG-03 | A new client against a recorded old server: `hello` sends no new field; the daemon, Control Center and Remote Control work as before | Client |
| ET-IMP-01 | `lib/editing` and `src/edit/**` import only what ARCHITECTURE §6 allows; `src/edit/core` imports no `node:` I/O module; nothing outside `src/edit/` imports it except lazily; `src/edit/loop` imports nothing from `src/loop.js` and friends | Both repositories |

## Edit Core

| Id | Behaviour |
| --- | --- |
| ET-CORE-01 | Time: every rate in EDIT_ENGINE §2 converts exactly; no float time field in the schema; round trips are exact across 3 hours |
| ET-CORE-02 | VFR: source-time mapping holds against a fixture timestamp table |
| ET-CORE-03 | Schema: valid projects pass; each invalid shape is refused with a reason; a newer schema is refused |
| ET-CORE-04 | Each schema migration on golden files |
| ET-OPS-01 | Each operation: applies, validates, undoes (HEAD moves, and replay restores the hash); applying is atomic |
| ET-OPS-02 | Property test: any operation sequence keeps the project valid, and undo to any version restores its hash |
| ET-OPS-03 | Replay of the log gives the same hash |
| ET-ANC-01 | Removing a sentence moves anchored captions, SFX and zooms with their words |
| ET-ANC-02 | An anchor to removed content is reported, never guessed |
| ET-ANC-03 | Re-transcription remaps ids; unmappable ones are listed |
| ET-SOL-01 | Cuts: on frames; zero-crossing within tolerance; pads applied; never inside a word |
| ET-SOL-02 | Layout: never on a face box; inside safe zones; stable across pages (golden cases) |
| ET-SOL-03 | Reframe: subject stays in frame; path is piecewise smooth; deadzone holds; shot change resets |
| ET-SOL-04 | Impossible requests are reported, not dropped |
| ET-CMP-01 | Golden RenderPlans: same project gives byte-identical plan |
| ET-CMP-02 | FFmpeg arguments: no shell metacharacter reaches an argument unescaped (fuzzed text) |
| ET-CMP-03 | Cache keys change when, and only when, an input changes |
| ET-CMP-04 | A caption change invalidates only the segments it touches |

## Edit Host and graph

| Id | Behaviour |
| --- | --- |
| ET-HOST-01 | One Host per machine; a second start attaches; it survives the harness and the daemon closing |
| ET-HOST-02 | Launch token works once, expires, and never appears in a log |
| ET-HOST-03 | A path outside a project is refused on every route, including through a symlink |
| ET-HOST-04 | Every document carries the COOP, COEP and CSP headers |
| ET-HOST-05 | No child process's environment holds the device token (ES-23) |
| ET-HOST-06 | Exits when idle with no jobs; a job in progress keeps it alive |
| ET-GR-01 | Change one input: exactly the dependent nodes re-run |
| ET-GR-02 | Early cutoff: an unchanged output stops downstream work |
| ET-GR-03 | A caption colour change re-runs no picture or audio node |
| ET-GR-04 | Kill mid-run: restart redoes no completed node |
| ET-GR-05 | Demand beats speculation: real work pre-empts it, and speculation spends no tokens |
| ET-GR-06 | Traces survive a version bump only when the node's version matches |

## Edit Loop and Governor

| Id | Behaviour |
| --- | --- |
| ET-LOOP-01 | Anytime: at every point of a scripted run a valid best version exists |
| ET-LOOP-02 | A worse attempt is never accepted, and stays in history |
| ET-LOOP-03 | Every stop condition ends the loop; no run exceeds its bounds |
| ET-LOOP-04 | Ladder: a failure at F0 renders nothing |
| ET-LOOP-05 | Sparse verification picks every risk point on fixtures, and finds a seeded defect at each |
| ET-LOOP-06 | Crew roles merge with no conflict; a role can't touch another's track role |
| ET-LOOP-07 | Rebase: the person's edit is never moved, and conflicting agent operations are dropped and listed |
| ET-LOOP-08 | `kriya edit replay` reproduces a recorded job exactly, with no model call |
| ET-LOOP-09 | Shadow compile: old projects give the same RenderPlan, or the diff is reported |
| ET-GOV-01 | Never more than 2 open answers, or 20 calls a minute, on the fake gateway |
| ET-GOV-02 | During a job, a scripted live chat sees no 429 |
| ET-GOV-04 | A first cut uses at most 8 model calls |
| ET-GOV-03 | `retryAfter` is honoured; the rate halves and recovers; `max_tokens` is always set; bodies use the relay encoding |

## Daemon

| Id | Behaviour |
| --- | --- |
| ET-DMN-01 | An edit doesn't enter `running`: two `kriya run` tasks still start during one |
| ET-DMN-02 | Without the capability, `edit` is refused; `hello` sends `edit` only after the manifest answered 200 |
| ET-DMN-03 | Cancelling an edit doesn't touch `kriya serve` |
| ET-DMN-04 | Cancelling a job the Host doesn't know reports `canceled` at once: no hot poll |
| ET-DMN-05 | A job outlives the daemon, and `control.update` keeps the capability |

## Engine (needs the runtime)

| Id | Behaviour |
| --- | --- |
| ET-ENG-01 | Probe: VFR, rotation, HDR, odd channels, on fixtures |
| ET-ENG-02 | Proxy and peaks: created, seekable, frame-accurate against a burned-in counter |
| ET-ENG-03 | A path outside the project is refused for every method, including through a symlink (ES-01) |
| ET-ENG-04 | Sources are byte-identical after a full run (ES-02) |
| ET-ENG-05 | Kill the engine mid-render; restart; job completes; completed steps aren't redone |
| ET-ENG-06 | Two jobs share slots; neither starves; one engine per machine |
| ET-ENG-07 | Timeout, hang and crash each end as a typed failure |
| ET-ENG-08 | Layer-split output matches a reference within tolerance, frame by frame, with tiles at the right time |
| ET-ENG-09 | Low disk stops cleanly before writing, and resumes (ES-17) |
| ET-ENG-10 | Segment join: no audio gap or duplicate frame |
| ET-ENG-11 | Master comes from sources: no proxy in its inputs |
| ET-ENG-12 | Colour: HDR and SDR fixtures give correct tags and expected values on a colour chart |
| ET-ENG-13 | Audio: band ducking leaves bass and air within tolerance; loudness hits target |
| ET-ENG-14 | Each encoder path in the table on the machines that have it |

## Perception

| Id | Behaviour |
| --- | --- |
| ET-IDX-01 | Layers are cached by content and model version; a re-add does no work |
| ET-IDX-02 | A missing optional layer degrades, and says so |
| ET-IDX-03 | Retake groups match hand labels on the synthetic set (precision and recall reported) |
| ET-IDX-04 | Filler removal leaves normal uses of the same word |
| ET-IDX-05 | Views stay inside their token budgets; every line has resolvable ids |
| ET-IDX-06 | Story tree: chunks cached, and summaries keep their sentence ids |
| ET-IDX-07 | Multi-camera sync recovers known offsets and drift on fixtures |
| ET-IDX-08 | Text from media carries the untrusted marker in every view |

## Director (scripted model)

| Id | Behaviour |
| --- | --- |
| ET-DIR-01 | A full run on a scripted model gives a valid project and a verdict |
| ET-DIR-02 | Malformed output: one repair, then the slot's default; the run finishes and says so |
| ET-DIR-03 | Semantically wrong ids are refused and repaired |
| ET-DIR-04 | Model unavailable throughout: the run ends with a default-only edit, marked |
| ET-DIR-05 | Tournament: position swap applied; ranking stable under a noisy scripted judge |
| ET-DIR-06 | Budgets stop a run; the gateway's cap refusal pauses it (ES-18) |
| ET-DIR-07 | Prompt blocks 0 and 1 are byte-stable across calls in a project |
| ET-DIR-08 | Escalation fires only on its code triggers, and never near the budget |
| ET-DIR-09 | Agent tool results stay under 2 KB |
| ET-DIR-10 | Each tool in DIRECTOR_AND_AGENT §9, on real pinned DSH with a scripted model (the `*-run.test.js` pattern) |
| ET-DIR-11 | Repair ladder: a worse attempt is set aside; thresholds are never loosened; a must-keep is never cut to pass |
| ET-TST-01 | Taste: repeated choices propose once; only confirmed rules apply; nothing is written by a tool |

## Gates

| Id | Behaviour |
| --- | --- |
| ET-QG-01…14 | Each gate QG-01…QG-14: fires on its seeded defect at the right time, passes clean, and reports `not checked` when it can't run |
| ET-QG-20 | A model's text can't change a verdict |
| ET-QG-21 | Receipt: `kriya edit verify` matches a good file, and fails a changed one |

## Recipes, skills, licences

| Id | Behaviour |
| --- | --- |
| ET-RCP-01 | Recipes and Looks have no field for a command, path, URL, model or price; schema refuses extras |
| ET-RCP-02 | Every recipe runs on its fixture with a scripted model |
| ET-SK-01 | Each `kriya-edit-*` skill is selected for its tasks and not others; names only real tools |
| ET-SK-02 | Skills are served only with `editing.skills` on; off, `harness.defaultSkills` output is unchanged |
| ET-LIC-01 | Every shipped code, font, sound, block and weight, read from esbuild's metafile and the manifest, has a recorded licence inside the table; none uses GSAP or Remotion |
| ET-PK-01 | Each pack installs, is optional, and fails with a plain reason when absent |
| ET-PK-02 | Generated frames are marked in the receipt, and a bad Smooth cut falls back to a punch-in |
| ET-PK-03 | A pack's weight has a recorded licence and hash |
| ET-INT-01 | OTIO, FCPXML, EDL, SRT round-trip through their parsers |

## Runtime

| Id | Behaviour |
| --- | --- |
| ET-RT-01 | Install from a fixture manifest; resume after a cut connection |
| ET-RT-02 | A wrong hash is refused and deleted (ES-08) |
| ET-RT-03 | Doctor reports what's missing, and hardware tier, on fixtures |
| ET-RT-04 | Two runtime versions side by side; rollback works |

## Server

| Id | Behaviour |
| --- | --- |
| ET-DB-01 | Two users can't read each other's `edit_jobs` and `edit_deliverables` |
| ET-DB-02 | A device can't write another device's job |
| ET-DB-03 | A session can't set a job status beyond cancel |
| ET-DB-04 | `reserve_edit_preview` holds under concurrent calls; cap 0 refuses |
| ET-DB-05 | Rollback restores the kind check; old rows intact |
| ET-DB-06 | Every new table has RLS and a policy; pinned `search_path` |
| ET-API-01 | New routes match the contract; `contract.json` is current; 404 with the switch off |
| ET-API-02 | No route returns another person's rows |
| ET-API-03 | Preview: wrong hash, wrong size, wrong container, over cap and wrong job all end `rejected`, with the object removed; binary never passes through the web service |
| ET-API-04 | Manifest route serves only approved versions |
| ET-TV-01 | `video_edit_start` needs approval; refuses without the capability or offline; `queue()` refuses `edit`; `dispatchAction` can't start one; `queueEdit()` validates the payload |
| ET-TV-02 | `editLoop` mirrors status, marks `lost`, posts exactly one assistant message per finish by stable id, no model call, no user message |
| ET-TV-03 | Revision makes a new job linked to its parent; nothing retried by itself |
| ET-TV-04 | With the capability off on the computer, nothing in Kriya can raise it; results carry no file contents (ES-15) |
| ET-TV-05 | Preview served safely (ES-16); a 1-hour link seeks; `janitor()` removes expired previews and orphaned objects after account deletion |
| ET-POL-01 | No tool can reach `actions/editing.ts`, answer a question, confirm taste or approve a job (AT-POL-07's pattern) |
| ET-POL-02 | Classes present; start and revise are R3 and in `SIDE_EFFECT_TOOLS`; `FACTS` complete, so the worker imports; `grantable` false |

## Review Room

| Id | Behaviour |
| --- | --- |
| ET-RV-01 | A decision card reaches the person; the answer reaches the job; a timeout takes the default, noted in the report |
| ET-RV-02 | Only a session can answer; no device route can |
| ET-RV-03 | A note resolves to an anchor, shows as a pin, and passes operation validation (ES-20) |
| ET-RV-04 | **Send notes** starts one revision; a double tap starts one |
| ET-RV-05 | Watch folder: off by default; only name and duration leave; nothing runs until tapped |
| ET-RV-06 | At 360 px: play, seek, pin, send, on a touch device profile |

## Security

| Id | Behaviour |
| --- | --- |
| ET-SEC-01 | Malformed files (a corpus plus mutated fixtures) don't crash outside the child; playlist and `concat` tricks read nothing else |
| ET-SEC-02 | Text with quotes, colons, newlines and `%` lands literally in the output |
| ET-SEC-03 | Injection fixtures in speech, on-screen text, file names and metadata cause no tool call beyond what the brief asked |
| ET-SEC-04 | Under confinement a composition can't reach the network or read outside its folder; a timer or `Date.now` is lint-refused; `editing.customMotion` off refuses model-written code |
| ET-SEC-05 | With frame vision off, no image leaves (asserted at the fake gateway) |
| ET-SEC-06 | Logs hold no transcript, name or prompt, by a sentinel test |
| ET-SEC-07 | Requests to fake a named real person are refused; generative tools are absent with the switch off |
| ET-SEC-08 | A reference asset can't be placed on a track; output check fires when one is forced |
| ET-SEC-10 | No child process reaches the network; telemetry variables are set on every HyperFrames run |
| ET-SEC-09 | A foreign `Host` or `Origin` is refused on every Studio route; DNS rebinding fails; the launch route is owner-only |

## UI

| Id | Behaviour |
| --- | --- |
| ET-UI-01 | Sidebar row present only when on; opening navigates to the Studio; **Back** returns, sessions intact |
| ET-UI-02 | Bin, transcript edit, timeline edit, prompt with a selection, undo, Proposal mode, Variations wall, drawing on the frame |
| ET-UI-03 | Live preview shows the right frame against a burned-in barcode; one GPU device across 1,000 clip switches; the watchdog recovers a stalled worker |
| ET-UI-04 | Export and report |
| ET-UI-05 | Keyboard-only path; 44 px targets; 360 px Review mode; light and dark; console clean |
| ET-UI-06 | Thread cards, `/harness` list, Inbox with `editing.tavi` on; unchanged off |

## Hard-rule tests

video-use's 12 hard rules become regressions, so Kriya can't lose what the
baseline already gets right: captions over overlays, no double encode, fades at
every boundary, overlays start at frame 0 of their animation, output-timeline
caption times, no cut inside a word, padded edges, word-level ASR kept verbatim,
cached transcripts, strategy before cutting in Ask-style flows, outputs in one
place. ET-HR-01…12, one each.

## ED17: security, scale, release readiness

| Id | What | Where (client) |
| --- | --- | --- |
| ET-SEC-01 | A corpus of broken files and playlist and `ffconcat` tricks through the real FFprobe and through the Host's import and index: facts or a typed failure, nothing reached | `tests/edit/media/security.test.js`; `tests/edit-security.test.js` (arguments, format allow-list) |
| ET-SEC-03, ET-SEC-05 | Injected speech through a scripted Director: fenced, text only (no image part), no tools, only valid edits; QG-14's view fenced | `tests/edit-security.test.js` |
| ET-SEC-06, EG-2 | After a real Host session the audit finds no secret on disk; planted ones are found and not printed | `tests/edit-security.test.js`, `scripts/audit-secrets.js` |
| ET-SEC-09 | The fence against 17 look-alike `Host` values, 7 origins, `cross-site` and non-navigation `same-site` | `tests/edit-security.test.js` (with ED6's in `edit-host`, `edit-ui`) |
| ET-SEC-10 | FFmpeg and FFprobe can't connect anywhere on macOS; an unconfined control can | `tests/edit/media/security.test.js` |
| EG-3 | 20,000 mutated project files and 20,000 malformed operation lists; hostile shapes; damaged index, job record and history; a killed Host | `tests/edit-fuzz.test.js` |
| EG-5 | 100 mixed jobs over three projects with the Host killed every third batch | `tests/edit/media/reliability.test.js` |
| EG-6 | A 2-hour source through import, index, proxy, 16 rounds of edits, seeks and renders, and a master; memory, files, children, temporary files and cache bounded | `tests/edit/media/soak.test.js` |
