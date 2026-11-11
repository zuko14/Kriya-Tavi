# Decisions (track E: Kriya Editing Studio)

Owner, 2026-11-07: "you will take the decision for entire complete advanced way."
So every decision **not** marked owner-gated is **Decided** under that delegation,
recorded in `status.md`.

**Owner-gated** records stay **Proposed**: they involve the law, money, a third
party's consent, or a protected file. Designing a thing isn't signing for it. They
need "Approved EDD-…" under "Track E owner approvals" in `status.md` before the phase
that needs them starts.

Evidence ids: `EF-…` (SOURCE_AUDIT), `EH-…` (FORENSIC_AUDIT), `EX-…`
(IMPLEMENTATION_PLAN §2), `ES-…` (SECURITY_AND_THREATS), `EQ-…` (§3 here).

## 1. Index

| Id | Decision | Owner-gated | Phase |
| --- | --- | --- | --- |
| EDD-01 | A capability of Kriya Harness, behind switches that default off | — | all |
| EDD-02 | Entered from the harness UI; no Tauri, no Rust | — | ED6 |
| EDD-03 | The Edit Host: one separate local process that owns jobs | — | ED4 |
| EDD-04 | The Studio is its own local web app on its own origin | — | ED4, ED6 |
| EDD-05 | Media Runtime: on demand, from a pinned manifest | **Yes** (hosting, signing) | ED2 |
| EDD-06 | How FFmpeg binaries reach people | **Yes** (licence, EQ-02) | ED2 |
| EDD-07 | HyperFrames renders the motion layer | — | ED8 |
| EDD-08 | No Remotion | **Yes** | ED8 |
| EDD-09 | No GSAP until Webflow agrees in writing | **Yes** | ED8 |
| EDD-10 | Integer flicks, typed operations, anchors | — | ED3 |
| EDD-11 | Determinism is claimed per machine only | — | ED4 |
| EDD-12 | Short-GOP proxies with WebCodecs | — | ED4 |
| EDD-13 | Index and cache live outside the person's folder | — | ED4 |
| EDD-14 | Frames leave the machine only with consent | **Yes** | ED7 |
| EDD-15 | The Director is code that makes bounded model calls | — | ED7 |
| EDD-16 | The viral rubric ranks; it never forecasts | — | ED11 |
| EDD-17 | Layer-split render | — | ED8 |
| EDD-18 | Segments follow shots; audio renders once | — | ED4 |
| EDD-19 | 14 gates, verdicts by code, a repair ladder | — | ED10 |
| EDD-20 | Round-trip speech check | — | ED10 |
| EDD-21 | Raw footage stays on the computer | — | ED5 |
| EDD-22 | Link import is off; owner-gated if ever on | **Yes** | ED13 |
| EDD-23 | A reference gives numbers only (Edit DNA) | — | ED13 |
| EDD-24 | No synthetic people or cloned voices by default | **Yes** | ED13 |
| EDD-25 | Skills, recipes, looks, blocks, and a licence gate | — | ED13 |
| EDD-26 | Metering: no new ledger; preview bytes capped in SQL | **Yes** (plan column) | ED14 |
| EDD-27 | Honest speed: staged results, no promises in seconds | — | all |
| EDD-28 | Tavi reaches the computer through dispatch kind `edit` | **Yes** (protected files) | ED14 |
| EDD-29 | No cloud rendering in the first release | — | — |
| EDD-30 | Risk classes for editing tools | **Yes** | ED7, ED14 |
| EDD-31 | Taste ledger: local, and confirmed by the person | — | ED16 |
| EDD-32 | Names: Editing Studio, `editing.*`, phases `ED…` | — | ED0 |
| EDD-33 | Platform order: macOS arm64, then Windows x64, Linux x64 | — | ED2 |
| EDD-34 | Code placement: client worktree, `lib/editing` on the server | — | ED2 |
| EDD-35 | Paid benchmark, and the rule for public claims | **Yes** (money) | ED16 |
| EDD-36 | Interchange: OTIO, FCPXML, EDL, SRT | — | ED3 |
| EDD-37 | A separate Edit Loop, sharing nothing with the coding loop | — | ED7 |
| EDD-38 | Model Call Governor | — | ED7 |
| EDD-39 | Incremental graph runtime | — | ED4 |
| EDD-40 | Fidelity ladder and sparse verification | — | ED7 |
| EDD-41 | Proposal mode, and the person always wins | — | ED6, ED7 |
| EDD-42 | Review Room and decision cards | — | ED15 |
| EDD-43 | Capability packs | — | ED13 |
| EDD-44 | Chrome confinement; model-written code off by default | — | ED8 |
| EDD-45 | Server ships before client; features are discovered, never assumed | — | all |
| EDD-46 | Previews: own bucket, straight to Storage | **Yes** (new bucket, storage cost) | ED14 |
| EDD-47 | Watch folders and the content engine | **Yes** (privacy; posting is a later decision) | ED15 |
| EDD-48 | Speech engine per platform; language set by the person | — | ED5 |
| EDD-49 | Hybrid matte | — | ED8 |
| EDD-50 | One GPU device for the Studio's life, plus a watchdog | — | ED6 |
| EDD-51 | Explainer scenes the Director proposes, drawn by Kriya's code | **Yes, approved 2026-11-09** | EV1 |
| EDD-52 | Internet media only from Wikimedia Commons, NASA and Openverse; CC0, public domain and CC BY; credited | **Yes, approved 2026-11-09** | EV3 |
| EDD-53 | Lemo-Opuscar's styles rewritten and pinned, its map rules refused; Kriya's maps have no borders | **Yes, approved 2026-11-09** | EV2 |
| EDD-54 | No generated video and no synthetic people in visual scenes | **Yes, approved 2026-11-09** | EV1 |
| EDD-55 | A Plan Card approves or swaps each scene before anything is downloaded or rendered; `balanced` tier for scene code | **Yes, approved 2026-11-09** | EV1, EV2 |
| EDD-56 | The Director's playbooks, DP1 to DP6, built and verified in order (DIRECTOR_PLAYBOOKS.md) | **Yes, approved 2026-11-09** | DP1…DP6 |
| EDD-57 | On-screen definitions of hard terms are allowed only as quoted text with a citation: the one exception to words on screen being the speaker's | **Yes, approved 2026-11-09** | DP6 |
| EDD-58 | A motion kit drawn by Kriya's code, proposed by the Director and added in chat, behind `editing.motion`; words on a graphic are the speaker's or the person's own; nothing is searched for and downloaded as code | **Yes, approved 2026-11-10 in chat** | MG1 |
| EDD-59 | Many files in one edit: one typed assembly, made by drag, by pointing or by words; the person's placement always outranks the Director's (ASSEMBLY_AND_INTENT.md) | **Yes** (new switch `editing.assembly`) | TP1, TP2 |
| EDD-60 | Every file has one handle (number, label, role) shown the same everywhere; file names and labels are untrusted data, matched by code | — | TP1 |
| EDD-61 | Every request becomes one intent frame; a model-filled field needs evidence quoted from the person's message, checked by code; what can't be done is listed, never dropped | **Yes** (new switch `editing.intent`) | TP4 |
| EDD-62 | QG-15 (assembly) blocks; a question in the Studio is a choice with a default and never blocks; hold to talk uses the local recogniser only | — | TP2, TP4 |
| EDD-63 | The monitor previews with the renderer's own tile code; a preview is never evidence, the rendered file is | **Yes, approved 2026-11-11 in chat** (new switch `editing.livePreview`) | TP3 |
| EDD-64 | Effects are a registry of typed rows; nothing can be stored that the render can't draw; keyframes are typed points compiled by code | **Yes** (new switch `editing.craft`) | TP5, TP10 |
| EDD-65 | Edit DNA 2: a reference's method measured locally as numbers and fixed words; a style brief with matched, nearest, cannot; gates outrank the reference; QG-16 is a note | **Yes** (new switch `editing.referenceIntent`; EQ-10) | TP6 |
| EDD-66 | A vision model may read a reference's frames, answers as fixed words only | **Yes: proposed as off; not part of any phase until approved, with counsel on EQ-10** | — |
| EDD-67 | Fonts ship in the signed Media Runtime, each licence-checked per item; script picks the font; type kit, style packs | **Yes** (new switch `editing.typeKit`; manifest signing, EB-09) | TP7 |
| EDD-68 | The Director watches its draft by code first, fixes with typed changes, keeps only a higher score; a stronger tier in two named places only | **Yes** (new switch `editing.directorLoop`; EB-06 for escalation) | TP8 |
| EDD-69 | Sound Kriya adds stays code-made until EQ-07 is decided; beds are arranged to the cut | — | TP10 |

## 2. Records

### EDD-01 A capability, default off
**Decision.** Editing is part of Kriya Harness, not a new product. `KRIYA_EDIT` and all `editing.*` keys default off. Off, both repositories behave exactly as today (ET-REG-01).
**Why.** The owner's first requirement after quality: nothing existing may break.

### EDD-02 Entered from the harness UI, no Tauri
**Decision.** A sidebar row in the harness, and `kriya edit`. The Studio can be installed as a web app, with its own window.
**Why.** The owner asked for a section in the harness UI. A desktop app is out of scope (EF-03), and a Web App Manifest gives the same feel with no installer.
**Alternatives.** Tauri: a second language, distribution and update path.

### EDD-03 The Edit Host
**Decision.** One detached process per machine holds the Studio server, the Edit Loop, the graph runtime and the Governor, and owns every job.
**Why.** Isolation from crashes; one scheduler; survives the harness closing (EH-05); keeps edits out of the daemon's task slots (EH-02).

### EDD-04 Own origin
**Decision.** STUDIO_APP_AND_BROWSER §1. Revised after the forensic audit: the first design was a portal over a DSH page.
**Why.** Exact-path routes can't serve compositions (EH-20). Own headers unlock `SharedArrayBuffer`. A DSH bump can't break the editor, and the editor can't touch a coding session. It also makes "the whole dashboard is replaced" literally true.
**Cost.** A second local listener, fenced as DSH's is (ES-11).

### EDD-05 Media Runtime **(owner-gated)**
**Decision.** `kriya edit setup` installs pinned artifacts into `~/.kriya/media/<version>/`, from a manifest served by Kriya, with sha256 on each. Python through `uv` with a hash-locked environment. Tiers: Core, Standard, Packs.
**Owner decides.** Where artifacts are hosted (upstream URLs or Kriya's own bucket) and whether the manifest is signed by a key held outside the web service. Recommendation: Kriya's bucket for binaries, for availability, and a detached signature checked by a key in the client.
**Owner decided, 2026-11-07.** Approved. The manifest is signed with an Ed25519 key held offline by the owner, never by the web service; a client refuses a manifest no pinned key signed. Artifacts use upstream URLs for the alpha, and Kriya's bucket stays the recommendation for release.
**Why.** EF-19. A plain `npm install` must stay light.

### EDD-06 FFmpeg distribution **(owner-gated)**
**Decision.** Blocked on EQ-02. Options: (a) an LGPL build with hardware encoders only, no x264; (b) a GPL build as a separate program, with source offer and notices; (c) the person installs it with `brew` or `winget`, and Kriya only uses it.
**Recommendation.** Start with (c) for the alpha, which needs no distribution at all, and let counsel choose between (a) and (b) for release.
**Owner decided, 2026-11-07.** Approved: (c) for the alpha.

### EDD-07 HyperFrames
**Decision.** The motion layer uses `@hyperframes/*`, exact pin, in the runtime. Own blocks. `@hyperframes/player` in the live preview.
**Why.** Apache-2.0, frame-accurate seek, alpha output, active. v0.x: its `FrameAdapter` is marked experimental, so Kriya pins versions and depends on the CLI-level contract where it can.
**Risk.** Pre-1.0 changes; a HeyGen-steered project. The compiler isolates it behind one backend.

### EDD-08 No Remotion **(owner-gated)**
**Why.** EF-06. Paid licence above 3 people, and the end-user product question is unsettled.
**Alternatives.** Buy a licence: possible later, and not needed.

### EDD-09 No GSAP **(owner-gated)**
**Decision.** Nothing Kriya ships uses GSAP until the owner has Webflow's written consent, because the Studio resembles what the licence's Prohibited Uses clause describes (EF-07). Blocks use WAAPI and CSS with Kriya's own spring math. `edit_motion` lints against it.
**Cost.** Ghost-editor's and HyperFrames' GSAP templates can't be used as they are, so blocks must be written. A person's own GSAP project remains theirs.
**Owner action.** Write to GSAP's contact (EQ-01), and take counsel's view.

### EDD-10 Time, operations, anchors
**Decision.** EDIT_ENGINE §2, §4, §5.
**Why.** EF-15, EF-16. This is what lets a project survive change, and lets a cheap model be precise.

### EDD-11 Determinism
**Decision.** The RenderPlan is deterministic. Pixels are close, not identical, even on one machine (EX-02). The cache keys on inputs, and no claim of identical pixels is made.

### EDD-12 Proxies
**Decision.** H.264, 960×540, GOP 30, no B-frames, about 1.5 Mbps (EX-03: 0 wrong frames in 200 seeks of 2 hours).

### EDD-13 Index and cache location
**Decision.** `~/.kriya/edit/`, with a size cap and a chosen drive (EF-28).
**Why.** Synced folders and SQLite don't mix, and caches are large.

### EDD-14 Frames and consent **(owner-gated)**
**Decision.** Contact sheets go to a model only with `editing.frameVision` on and the project's consent. Text views go by default, after a first-run notice. A person can work with no model at all.
**Why.** ES-10. Frames show faces, and leave for a third-party provider.
**Owner decides.** Default for new projects. Recommendation: ask once, per project, in plain words.

### EDD-15 The Director
**Decision.** DIRECTOR_AND_AGENT §1, §2. Code holds the plan. In the Studio, the prompt box goes straight to it, with no chat session. Jobs have no agent loop. The central bet, tested by arm A5.

### EDD-16 Rubric as ranking
**Decision.** Scores order candidates for one video. No score is shown as a viral prediction (EF-23).

### EDD-17 Layer-split render
**Decision.** EDIT_ENGINE §6. Chrome renders only motion windows. EX-10: 1.3× on a first render, 5× on a change.
**Fallback.** Whole-composition backend.

### EDD-18 Segments
**Decision.** EDIT_ENGINE §7 (EF-18).

### EDD-19 Gates
**Decision.** QUALITY_GATES. Verdicts by code; three repair rounds; never keep a worse attempt.

### EDD-20 Round-trip speech
**Decision.** QG-04 blocks on dropped words (9 of 10, no false alarms). Clipped words go to QG-05's signal check (EX-11).

### EDD-21 Footage stays
**Decision.** No raw footage, project or master goes to Kriya. Only small previews, posters and reports, and only with `editing.previews`.

### EDD-22 Link import **(owner-gated)**
**Decision.** Not built by default. `yt-dlp` stays out of the runtime. If the owner wants it: `editing.urlImport`, a per-link attestation, no cookies or logins, no evasion, reference use only, and counsel's view first (EF-09).
**Recommendation.** Leave it off: people can drop a file they already have.

### EDD-23 Edit DNA
**Decision.** EDITOR_WORKFLOWS §4. No reference pixels or audio in the output. Replaces `motionclone` (EF-08).

### EDD-24 Synthetic people **(owner-gated)**
**Decision.** `editing.generative` off. No face generation or lip-sync. Text-to-speech for explainers only with a stock voice. Voice cloning only of the person, with a consent record, if ever.
**Why.** ES-13, EQ-09.

### EDD-25 Knowledge and licences
**Decision.** SKILLS_AND_OPEN_SOURCE §1, §2. The gate applies per item.

### EDD-26 Metering **(owner-gated)**
**Decision.** Tokens through the existing ledger; `plans.editing_preview_bytes`, default 0; `edit_preview_bytes` in `resource_usage`.

### EDD-27 Honest speed
**Decision.** No promise in seconds until measured. A live preview gives the feeling of speed that a render can't (EF-04).

### EDD-28 Tavi by dispatch **(owner-gated)**
**Decision.** TAVI_INTEGRATION. A new kind through `queueEdit()`, four tools, a worker loop, in protected files: `lib/agent/tools.ts`, `lib/agent/policy.ts`, `lib/agent/capabilities.ts`, and one spread in `lib/agent/run-task.ts`.
**Alternatives.** `kriya serve` and `workspace_*`: runs an agent loop in a fresh folder, with no access to the person's footage, by design. A new relay protocol: not needed.

### EDD-29 No cloud render
**Decision.** Not in the first release. It would need uploads of raw footage, GPU capacity and new pricing.
**Revisit.** After the pilot, with track C's fabric.

### EDD-30 Risk classes **(owner-gated)**
**Decision.** `video_edit_places`, `video_edit_status`: R0. `video_edit_start`, `video_edit_revise`: **R3**, in `SIDE_EFFECT_TOOLS`, not grantable. Harness-side `edit_*` tools: allowed in Ask mode with no prompt, because they stay in the project and can be undone; refused in Read only and Plan.
**Why R3.** Invariant 5 puts anything that changes something outside Kriya in `SIDE_EFFECT_TOOLS`, and a test pins that set to R3 and R4 (EH-09).
**Owner decides.** Whether Ask mode should prompt for `edit_export`. Recommendation: no.

### EDD-31 Taste
**Decision.** DIRECTOR_AND_AGENT §12. Local, code-written, confirmed by the person.

### EDD-32 Names
**Decision.** Product label "Editing Studio" ("Kriya Editing Studio" in full). Track E, phases `ED…`, `editing.*`, `lib/editing`, `plugins/edit`, `kriya edit`. Not "Studio" alone (EF-27).
**Owner may rename** the label; identifiers stay.

### EDD-33 Platforms
**Decision.** macOS arm64 first, since the owner's machine and much of the tooling are there; then Windows x64, where most Indian creators are likely to be, then Linux x64. Windows must land before any public release (EQ-11).

### EDD-34 Placement
**Decision.** Client code in `plugins/edit` and `src/edit` of `kriya-harness`, on `feat/editing-studio`, in worktree `../kriya-harness-edit`. Server code in `lib/editing`.

### EDD-35 Benchmark and claims **(owner-gated)**
**Decision.** EVALUATION_PLAN. The owner funds the runs and recruits raters. No comparative claim before EG-8.

### EDD-36 Interchange
**Decision.** EDIT_ENGINE §11. Editors can always leave with their work.

### EDD-37 A separate Edit Loop
**Decision.** EDIT_LOOP. Asked for by the owner. It shares no code or state with `src/loop.js`, because its truth, attempts and costs are different (EDIT_LOOP §1), and because that keeps the coding loop safe.

### EDD-38 Model Call Governor
**Decision.** EDIT_LOOP §8. All Director calls through one queue: at most 2 open, 20 a minute, AIMD, batching.
**Why.** EH-13, EH-14: otherwise a running edit starves the person's live chat.

### EDD-39 Graph runtime
**Decision.** EDIT_LOOP §4. Demand-driven, verifying traces, early cutoff.
**Why.** Incrementality falls out of hashes instead of being hand-coded per feature, and preview, draft and master can't disagree.

### EDD-40 Fidelity ladder
**Decision.** EDIT_LOOP §5. Candidates climb F0 to F5 by successive halving, and F3 checks risk points only.
**Why.** Rendering is the expensive check. Cheap tokens are only useful if evaluating an option is cheap too.

### EDD-41 Proposal mode
**Decision.** UX_SPEC §4, EDIT_LOOP §9. Broad changes arrive as ghost clips. The person's edit always lands first, and agent work rebases around it.

### EDD-42 Review Room and decision cards
**Decision.** TAVI_INTEGRATION §5, §6. Answers and notes are the person's alone, and each question has a default, so nothing waits forever.

### EDD-43 Capability packs
**Decision.** CAPABILITY_PACKS. Optional, local, typed, cached. Refused: lip-sync, face swap, cloning.

### EDD-44 Chrome confinement
**Decision.** Chrome runs inside an OS sandbox with no network, since HyperFrames passes `--no-sandbox` (EH-27). Model-written compositions need `editing.customMotion`, off, and are refused on an OS without confinement.

### EDD-45 Server first
**Decision.** FORENSIC_AUDIT §3. Strict schemas mean a client must never send a field a server hasn't advertised. `/editing/manifest` answering 200 is the signal.

### EDD-46 Previews **(owner-gated)**
**Decision.** Private bucket `kriya-edit-previews`; device uploads by signed link; the worker verifies; 45 MiB by default; 1-hour links; a sweep after account deletion. `lib/files.ts` untouched.
**Owner decides.** Creating the bucket, and plan caps.

### EDD-48 Speech engine per platform
**Decision.** mlx-whisper on Apple silicon, faster-whisper with CUDA on NVIDIA, CPU otherwise. The person sets the language (EX-04).

### EDD-49 Hybrid matte
**Decision.** MediaPipe selfie segmenter for preview and drafts; BiRefNet only where final quality is asked for (EX-05). PyTorch Metal is tested in ED8.

### EDD-50 One GPU device
**Decision.** STUDIO_APP_AND_BROWSER §4 (EX-13).

### EDD-47 Watch folders and the content engine **(owner-gated)**
**Decision.** TAVI_INTEGRATION §8, §9. Off, per folder, set on the computer. Only a name and a duration leave. Nothing runs until tapped. Scheduled jobs still ask each time. Posting isn't included, and needs its own decision.

### EDD-58 Motion graphics **(owner-gated, approved 2026-11-10)**
**Decision.** MOTION_GRAPHICS.md. Graphics are typed blocks drawn by code, so a cheap model only chooses among them. Their words come from the speaker or from what the person typed, checked by code. Open-source motion code is never fetched and run: an allowed idea is rewritten as a kit graphic and credited. Model-written animation stays MG2, behind `editing.customMotion`.

### EDD-51…EDD-55 Visual scenes **(owner-gated, approved 2026-11-09)**
**Decision.** VISUAL_SCENES.md. Words on a scene come from the speaker, checked by code. EDD-52 settles the stock half of EQ-07 for these three sources: BY-SA and non-commercial are refused. Any other source, or a key-based one such as Pexels, needs its own decision.

### EDD-59…EDD-69 Top-tier upgrade **(proposed 2026-11-10; EDD-59, EDD-60 and EDD-62 approved by the owner 2026-11-10 in chat, EDD-63 on 2026-11-11 in chat; the other owner-gated ones await approval by id)**
**Decision.** TOP_TIER_GAP_ANALYSIS.md, ASSEMBLY_AND_INTENT.md, CRAFT_UPGRADE.md, TOP_TIER_PLAN.md. The method is the motion kit's: code draws and checks, a cheap model chooses from a typed list, the person's words outrank both. Each new server switch defaults off and is a row in CHANGE_IMPACT §3 marked proposed. EDD-66 is recorded so that it is refused by default: no phase sends a reference's frame to a model. No comparative claim follows from any of this before EG-8 (rule 14).

## 3. Open questions

| Id | Question | Settled by | Blocks |
| --- | --- | --- | --- |
| EQ-01 | Will Webflow consent to GSAP in the Studio? | Owner writes to GSAP; counsel | GSAP-based blocks only |
| EQ-02 | FFmpeg and codec licensing for what Kriya distributes (legal page unread, EF-26) | Counsel | Release, ED2's bundling only |
| EQ-03 | Which models do `balanced` and `escalation` use? | Owner | Escalation having any effect |
| EQ-04 | ASR quality in Telugu, Hindi and code-mixed speech | EX-04 | Language promises |
| EQ-05 | Which speaker model has usable weights and terms? | Read pyannote's and sherpa-onnx's model licences | L4 |
| EQ-06 | Should a cloud speech option exist for weak machines or languages? | Owner, after EX-04 | Nothing yet |
| EQ-07 | A sound and music starter pack, and stock sources: whose, on what licence? | Owner, counsel | Bundled sound; stock |
| EQ-08 | Which `motion-video-kit` does the awesome list mean? | Read its entry | That item only |
| EQ-09 | Synthetic-media labelling, DPDP and faces in footage, output ownership wording | Counsel | Public release; generative switch |
| EQ-10 | Any limit on measuring a third party's video style | Counsel | Public release of reference analysis |
| EQ-11 | Windows sandbox and hardware support | ED17 | Public release |
| EQ-12 | Is `kriya.models.supports_images` true for Flash-1017 on the live database? | Read at EX-08 | Frame vision |
| EQ-13 | Is a recorded model version enough for reproducibility when an upstream provider changes a model? | Note in EX-08 | Bench claims |
| EQ-14 | Would anyone want a fully offline Director on a local model? | Pilot feedback | A later pack |
| EQ-15 | Are PSF-2.0 (`typing-extensions`), CNRI-Python (`regex`), Zlib and 0BSD (parts of `numpy`) fine in the Media Runtime? The owner allowed them for the alpha only | Counsel | Public release |
| EQ-16 | Which filters of CRAFT_UPGRADE §3.2 does the signed runtime's FFmpeg have? | Spike TPX-02 | Those effects only |
| EQ-17 | Which scripts does the OCR helper read, and what stands in on Windows and Linux? | Spike TPX-05 | QG-10 by OCR for those scripts |
| EQ-18 | Each candidate font's licence at its pinned version | Read per item before the manifest; ET-LIC-01 | That font |
| EQ-19 | How well does code read transitions and text regions on real references? | Spike TPX-03, then EB-05's set | Those traits of Edit DNA 2 |
| EQ-20 | Do live tiles hold a usable frame rate while scrubbing? | Spike TPX-01 | Tiles while scrubbing |
| EQ-21 | The intent fields' and the `assembly` slot's accuracy per language on the `budget` model | Bench-A-R (EB-07) | Language promises |
| EQ-22 | The frame-match threshold for QG-15 | Spike TPX-04 | QG-15 blocking rather than noting |
