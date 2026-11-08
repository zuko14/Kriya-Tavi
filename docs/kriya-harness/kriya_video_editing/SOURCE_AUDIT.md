# Source audit (track E: Kriya Editing Studio)

`information.md` is the owner's brief. It holds the intent, and it is kept
unchanged. It is also full of specific claims about other people's software,
about models and about speed. Every claim that a design decision could rest on
was checked on **2026-11-07** against primary sources: the GitHub API, each
repository's README and docs, the OpenRouter catalogue, the licence texts, and
the code in this repository and in `kriya-harness`.

Where this document and `information.md` disagree, this document wins, because
it is the part that was checked. Nothing here reduces the ambition of the
brief; most corrections make the design stronger.

Status words: **Confirmed** (true as written), **Corrected** (true in spirit,
wrong in a detail that matters), **Refuted** (false, or impossible as written),
**Unverified** (nothing to check it against yet; settled by a spike or a
measurement), **Rejected** (true, but the wrong design; replaced).

## 1. The ten repositories

Read through the GitHub API on 2026-11-07.

| Repository | Licence | Stars | What it really is | Verdict for Kriya |
| --- | --- | --- | --- | --- |
| `heygen-com/hyperframes` | Apache-2.0 | 80,184 | HTML to video on Puppeteer and FFmpeg, v0.9.19 (2026-11-06). Seek protocol `window.__hf`; `@hyperframes/engine`, `producer`, `player`, `lint`, `core`. About 450 registry blocks. 9 skills. Alpha output as WebM or ProRes 4444 | **Use** for the motion layer (EDD-07), exact pin, in the Media Runtime |
| `CloudAI-X/threejs-skills` | MIT | 4,047 | 13 skills for three.js r186, r3f 9.8, drei 10.7, gltf-transform 4.5 | **Port** into a `kriya-edit-3d` skill, with credit |
| `zhuyansen/awesome-claude-video-skills` | CC0 (the list only) | 1,676 | A list: 427 repositories in its README, each with its own licence. It ran 16 of them end to end | **Read** as research. The list's CC0 grants nothing about the listed code |
| `openai/whisper`, `SYSTRAN/faster-whisper` | MIT, MIT | 112,130, 26,544 | Speech recognition; the CTranslate2 port | **Use** faster-whisper in the Media Runtime |
| `yt-dlp/yt-dlp` | Unlicense | 205,825 | Downloader | **Off by default**, owner-gated (EDD-22, EF-09) |
| `iart-ai/motion-skills` | MIT | 1,256 | An index repository: 56 skills in 19 pack repositories, each pack a repository of its own | **Port** selected packs. 18 of 19 packs are MIT; `generative-illustration-skills` has no licence, so it is excluded |
| `austriandev/motionclone` | **None** | 0 | A copy of `blixvip/MotionClone`. Its README says no project-wide open-source licence has been assigned. It rebuilds a reference through the Codex CLI and a ChatGPT account, not through optical flow | **Not imported.** Ideas only, rebuilt clean (EF-08) |
| `AgriciDaniel/claude-shorts` | MIT | 339 | 10-step long-to-short pipeline; renders on Remotion | **Port** the rubric, boundary snapping and cursor tracking. Not the Remotion part (EF-06) |
| `kajisho5/ffmpeg-skill` | MIT | 4,684 | v3.2.0: 42 FFmpeg tools, a machine-readable contract, an MCP server, `check.py` platform specs, `multicam.py`, `sync.py`, `render.py`. Python standard library only | **Use** in the Media Runtime as verification and quick-operation hands (EF-22) |
| `kurbaitaev/ghost-editor` | MIT (code) | 241 | A Claude Code skill for talking-head reels on HyperFrames. 18 recipe folders in the repository. Demo clips are not reusable | **Port** recipes and rules. Check each pack's licence file (`docs/THIRD_PARTY/`) |

One repository the brief does not name matters more than most of those it does:
`browser-use/video-use` (MIT, 30,668 stars) is the main reason "Claude Code
edits video" is trending. It gives the agent a packed word-level transcript
plus an on-demand filmstrip image, has the model write an EDL, renders with
FFmpeg, and re-checks every cut, capped at three passes. It is the baseline to
beat in EVALUATION_PLAN, and its 12 hard rules are worth reading first.

## 2. Findings

### Licences that change the design

| Id | Status | Finding | What Kriya does |
| --- | --- | --- | --- |
| EF-06 | Corrected | **Remotion is not open source.** Its licence is free for individuals, non-profits and for-profit companies of up to 3 employees; anyone else needs a Company License. The licence text does not settle a product that lets end users make videos, and it announces a change in Remotion 5.0. `information.md` lists "Remotion v4" as a pillar | No Remotion in the product. Captions are Kriya's own. `claude-shorts`' Remotion folder is not ported (EDD-08) |
| EF-07 | Corrected | **GSAP is free, not open.** The Standard "No Charge" License (Webflow, effective 2025-04-30) bars use in tools that let users build visual animations without code where that helps compete with Webflow's animation building, unless Webflow gives prior written consent. Kriya Editing Studio is close to that wording. HyperFrames' examples, ghost-editor's templates and most motion skills use GSAP; HyperFrames loads it from a CDN by default | Kriya's own motion templates use WAAPI and CSS with springs computed by our own code, which HyperFrames seeks natively. No GSAP in anything Kriya ships until the owner has Webflow's written answer (EDD-09, EQ-01) |
| EF-08 | Refuted | `motionclone` has no licence, so nothing in it may be copied. It is also not "Local Optical-Flow": it sends frames to ChatGPT, is limited to 120 seconds and 250 MB, and says plainly that reconstruction is approximate. HyperFrames also lists `/reverse-any-video` as a Pro skill | Reference analysis is designed from scratch as Edit DNA (EDITOR_WORKFLOWS §4). No code or text read from that repository is reused |
| EF-09 | Rejected | `yt-dlp` as the default way to fetch references and B-roll. YouTube's Terms (dated 2022-01-05) allow downloading only where the service expressly authorises it or with written permission from YouTube and the rights holders, and bar automated access. Track A rule 5 forbids scraping others and evasion. Also, `--download-sections` selects a time range, not a byte range | The reference path is a file the person supplies. Link import is off by default, owner-gated, needs an attestation, never uses cookies or a login, and never feeds B-roll (EDD-22) |
| EF-13 | Corrected | The awesome list's top picks are not all usable: `explainroo` is MIT; `onetake` is **PolyForm Noncommercial**; `remotion-dev/skills` has no licence on GitHub. The list reports 427 repositories, not 401 | Licence gate in SKILLS_AND_OPEN_SOURCE §2 applies to every item. `onetake` and `remotion-dev/skills` are excluded |
| EF-21 | Corrected | Matting models differ by licence: BiRefNet weights and `rembg` are MIT, while ghost-editor's notes record BRIA RMBG as non-commercial or paid, RobustVideoMatting as GPL-3.0 and MODNet weights as CC BY-NC-SA. The "60 fps real-time matte" is not claimed by anyone | BiRefNet only, offline, only for the seconds that need it. Speed is unknown until EX-05 |
| EF-26 | Unverified | FFmpeg's own legal page could not be read on 2026-11-07 (connection reset, twice). Builds with `libx264` are generally understood to be GPL, and codec patents are a separate question. This is not settled here | EQ-02 goes to counsel before any FFmpeg binary is distributed. The runtime manifest records the exact build and its configure line (EDD-06) |

### Models and cost

| Id | Status | Finding | What Kriya does |
| --- | --- | --- | --- |
| EF-01 | Corrected | **`deepseek/deepseek-v4.1-flash-1017` takes images**, not only text. OpenRouter lists input text and image, 1,048,576 context, structured outputs and tools, at $0.15 per million input tokens, $0.60 output and $0.003 cached. So "no native perception" is true for video and audio but not for stills | The Director can read contact sheets on the budget tier when the person allows frames to leave the machine (EDD-14). Whether `kriya.models.supports_images` is true for it on the live database is not known (status.md 2026-11-06) |
| EF-02 | Refuted | GBNF grammars, `cache_prompt: true` and "pinned in VRAM" are `llama.cpp` features of a model you host yourself. Kriya reaches models through its gateway to OpenRouter (`lib/harness/gateway.ts`), which accepts tier aliases only (track H rule 4). None of this exists on that route | Reliable output comes from tool schemas, structured outputs, one bounded repair and code defaults. Caching comes from a stable prefix order, measured from `usage` (DIRECTOR_AND_AGENT §6) |
| EF-24 | Unverified | "90 %+ cost reduction" has no measurement behind it. List prices do favour Flash: Opus 5.5 is $4, $20 and $0.20 per million, so 27×, 33× and 67× Flash. But price per token is not cost per finished video. ghost-editor measured that frames were about 5 % of its usage, and that context re-read every turn was the real cost (one helper re-read 212 M cached tokens in 464 turns) | The design attacks turns and context, not only price: stateless calls, the project as the state (DIRECTOR_AND_AGENT §5). Cost is measured per accepted video (EVALUATION_PLAN) |
| EF-32 | Confirmed (repo) | All three tiers currently resolve to one model unless the owner sets `routing.balanced` and `routing.escalation`; `kriya doctor` already notes it. "Pro escalation" therefore does nothing today. `DeepSeek-V3.2`, `DeepSeek-R1` and `Qwen3-Coder-Next` named in the brief are not what the catalogue's current text-only Pro is (`deepseek/deepseek-v4-pro-0813`) | Escalation is by tier alias, decided by code (DIRECTOR_AND_AGENT §7). The owner picks the model (EQ-03) |

### Speed claims

| Id | Status | Finding | What Kriya does |
| --- | --- | --- | --- |
| EF-04 | Refuted | The §9 walkthrough promises a 30-minute recording probed, proxied and fetched in under 2 s, transcribed and analysed in under 4.5 s, rendered and checked in under 7.5 s. Published numbers say otherwise: ffmpeg-skill measures `scenes.py` at 241 s and a loudness measure at 66 s on one hour (4 vCPU), export at about 1.2× real time, and ghost-editor reports 15 to 25 minutes of machine time for a 60-second reel on an M3 MacBook Air. "S_viral = 93.2" and "y = 988" are invented examples | No speed number enters a Kriya document as a fact until a spike measures it. Targets are written as targets (EVALUATION_PLAN §5). The honest UX is a staged one: first look in minutes, not seconds (EDD-27) |
| EF-20 | Corrected | "Zero-copy" is not what the pipe does: raw frames over a named pipe are a copy, and at 1080p60 in BGRA that is about 500 MB/s. Headless Chrome has no path to hand a GPU texture to FFmpeg. Default HyperFrames does not write PNGs to disk either: its `streamingEncoder` already pipes frames to FFmpeg, and `parallelCoordinator` splits frames across workers. "3.8× to 4.5×" has no source | Keep HyperFrames' pipe. The real win is rendering far fewer frames in Chrome: the layer-split render (EDIT_ENGINE §6) |
| EF-05 | Corrected | The seek API is `window.__hf`, not `window.__hyperframes` or `__hyperframes_seek`. `beginFrame` capture runs only on Linux with `chrome-headless-shell`, so macOS and Windows take screenshot capture. HyperFrames itself says pixels can vary with Chrome, fonts, codecs and GPU unless those are pinned | Determinism is claimed per machine and per runtime version only, never across machines (EDD-11) |
| EF-17 | Rejected | A 540p all-intra proxy (`-g 1`) of a two-hour file costs many gigabytes, and "under 1.2 ms to any frame" has no source. WebCodecs decodes from the nearest keyframe in a few milliseconds of work per frame | Short-GOP proxy without B-frames, size and seek time measured in EX-03 (EDD-12) |
| EF-18 | Corrected | Stitching 1-second GOPs with `-c copy` is a sound idea with traps: AAC priming gaps at every join, a keyframe every second costing bits, and quality steps at segment edges | Audio is rendered once and muxed once. Segments follow shots, not the clock. Masters get a single pass, or long segments for long form (EDIT_ENGINE §7) |

### Engineering errors in the brief

| Id | Status | Finding | What Kriya does |
| --- | --- | --- | --- |
| EF-03 | Rejected | Tauri v2 and Rust. The harness is a Node 24.9 package serving DSH's Web UI on `127.0.0.1`; a desktop app is out of scope (`docs/kriya-harness/VISION_AND_SCENARIOS.md` §4), and the owner asked for a new section inside the harness UI | A local web app entered from the harness UI, with its own process. No Rust, no installer (EDD-02, EDD-03, EDD-04) |
| EF-10 | Corrected | ghost-editor: 34 styles are shown in its GIF, but the README's table lists 19 in the repository, one "coming soon" and the rest as lab experiments. The style is "Seoul list", not "Serial list". It needs Apple silicon and a paid Claude plan, and uses a Gemini key for its B-roll check and ElevenLabs for one narrator. "Two-pass Whisper with a YIN pitch scan" is not described in its README or HOW-IT-WORKS (17 code-search hits for the word "pitch" were not read) | Kriya's retake auditor is treated as our own design (PERCEPTION_AND_INDEX §4) and proven on fixtures |
| EF-11 | Corrected | threejs-skills: examples use `WebGLRenderer`; `EffectComposer` is still covered; WebGL **1** is what was removed. So an AST linter that rewrites `WebGLRenderer` to `WebGPURenderer` or `EffectComposer` to `RenderPipeline` would break working code. Versions are r3f 9.8 and gltf-transform 4.5, not 9.6 and 4.3. WebGPU in headless capture needs its own check (HyperFrames has `data-requires-webgpu`) | Lint only for the true removals (`RGBELoader`, `Clock`). WebGL is the default for rendered 3D; WebGPU only after EX-02 |
| EF-12 | Corrected | motion-skills has 56 skills, not 50; the GitHub description says 14 packs while the README lists 19. `threejs-3d-and-shaders` and `ai-presenter-skills` are not pack names (`webgl-animation-skills`, `talking-head-skills` are). "Every skill render-verified" is the pack's claim; many render through Remotion or Manim | Each pack is reviewed by itself; Remotion-based steps are rewritten for HyperFrames |
| EF-14 | Corrected | The project schema sets `yuv420p10le` and 60 fps for everything. 10-bit H.264 is poorly supported for delivery, VideoToolbox H.264 is 8-bit, `-spatial_aq` and `-temporal_aq` are NVENC-only, and forcing 60 fps on 30 fps footage adds judder | 8-bit H.264 for social delivery, 10-bit HEVC or ProRes for masters, frame rate follows the source, encoder flags per encoder (EDIT_ENGINE §8) |
| EF-15 | Rejected | Times stored as float seconds (`source_in_sec: 18.42`). Floats drift, and 29.97 fps has no exact decimal form | Integer flicks and rational frame rates (EDIT_ENGINE §2) |
| EF-16 | Rejected | RFC 6902 patches as the model's edit language. Array indexes shift, a patch carries no intent, and nothing checks that it makes editorial sense | Typed intent operations on stable ids and anchors (EDIT_ENGINE §4) |
| EF-19 | Rejected | `bootstrap_kriya_skills.sh`: unpinned `git clone --depth 1`, `pip install -U`, no hashes, and a Markdown link pasted inside the URL so it would not even run. Against track H's exact pins and supply-chain rules | Signed manifest, exact versions, sha256 on every artifact (EDD-05) |
| EF-22 | Corrected | ffmpeg-skill is much more than "cut and resize", and it already refuses raw filter graphs. But each tool goes file to file, so chaining tools re-encodes. Its own docs say long chains belong in one plan | Kriya's compiler emits one graph for the edit. ffmpeg-skill's probe, check, look, sync and platform tables are used directly |
| EF-23 | Corrected | The 5-dimension rubric is real (`references/scoring-rubric.md`), though the archetype list differs from the brief's. It scores with a model, and nothing validates it against real views | Used as a ranking aid only, compared pairwise, and never shown as a forecast of views (EDD-16) |
| EF-25 | Unverified | "±12 ms" for forced alignment has no source; video-use reports 50 to 100 ms drift for its ASR. ghost-editor is tested in English and Russian only. Telugu, Hindi and code-mixed speech are untested anywhere here | EX-04 measures word timing and accuracy per language before any promise (EQ-04) |

## 3. Facts from this repository and the client

| Id | Status | Finding | Consequence |
| --- | --- | --- | --- |
| EF-27 | Confirmed | `studio.*` settings, "Kriya Studio" (`docs/kriya-studio/`) and the `kriya-harness-studio` worktree all belong to Flows (track S) | This track uses `editing.*`, the label "Editing Studio", phases `ED…` and `kriya-harness-edit` |
| EF-28 | Confirmed | The memory of this project and `status.md` (2026-11-06) record that iCloud-synced folders bump file metadata after saves. SQLite and multi-gigabyte caches do not belong in a synced folder | Index and caches live in `~/.kriya/edit/`, never in the person's folder (EDD-13) |
| EF-29 | Confirmed | `ctx.connection.fetch.register` takes `requestBody: "buffered" \| "streaming"` under `/api`, and the bridge writes any `Response` body with backpressure and copies status and headers (`dsh-client-connection`). So uploads stream and a 206 answer can pass. Only owner peers reach these routes | Routes are **exact paths**, with no wildcard, so they can't serve a composition's relative assets. The Studio gets its own server (EH-20) |
| EF-30 | Confirmed | DSH's layout has `main` and `sidebar.panellist` slots (the Projects page uses both), and no seam to hide the sidebars | "The whole dashboard is replaced" is a real navigation to the Studio's own origin. No DSH file is edited (track H rule 5). Proven in EX-07 |
| EF-31 | Confirmed | `kriya.harness_dispatches.kind` is a fixed SQL check of eight kinds; `payload` is capped at 16 KB and `result` at 32 KB; a queued action expires in 10 minutes. `queue()` works under `withUser` and Flows already calls it from code (`lib/flows/store.ts`) | A new kind `edit` needs a new migration and a `DispatchPayloads` entry. The brief travels by reference when long |
| EF-33 | Confirmed | CC-D3: what a computer allows is set on that computer. A web session cannot raise it | The `edit` capability is reported by the computer (TAVI_INTEGRATION §3) |
| EF-34 | Confirmed | `lib/files.ts` allows 5 attachments per message; there is no path for multi-gigabyte uploads, and nothing in this design needs one | Raw footage stays on the computer. Only small previews go to Kriya |
| EF-35 | Confirmed | `node:sqlite` with FTS5 works on this machine (Node 24.22). `ffmpeg` is not installed here; `uv` is | Index needs no new dependency. Nothing assumes FFmpeg is on the machine: the Media Runtime supplies it |
| EF-36 | Corrected | Building Edit Core (ED3) showed the first project schema was incomplete: clips had no home, generated clips had no shape, the `freeze` operation had no effect, and `apply` couldn't validate an anchor without the index | `Sequence.clips`, nullable `Clip.source` and `at`, `until`, `duration`, `peak`, `loop`, `audioLead`, `audioLag`, a `freeze` effect, `Project.nextId`, an `exact` word anchor and `apply(project, ops, ctx)`; a punch-in is a generated clip; undo is replay; one ADMM reframes. EDIT_ENGINE §3, §4, §5, DATA_MODEL §2 |
| EF-37 | Corrected | Homebrew's plain `ffmpeg` 9.0.2, the alpha's FFmpeg (EDD-06), has no `drawtext`, `ass`, `subtitles` or `zscale`. Every other filter the cut path needs is there. `ffmpeg-full` has them, with 47 dependencies, and is keg-only | HDR tone-maps through a computed `.cube` LUT and `lut3d`, needing no extra filter. Captions use tiles (ED8); a direct burn is refused with a plain reason where `drawtext` is missing, and `kriya edit doctor` says so. EDIT_ENGINE §8 |

## 4. What survives from the brief, unchanged in spirit

The owner's strongest ideas stand and are carried into this design: decouple
perception from reasoning; never let a model write shell strings; probe first;
self-verifying gates before anything reaches the person; word-accurate cuts;
behind-the-head depth layering; chin-line and safe-zone geometry; spectral
ducking; zero-crossing splices; two-pass loudness; OKLab colour transfer;
content-addressed partial re-render; proxy editing with a master conform; the
5-panel studio; watch-time and transcript-keyword binding; the reference split
view; and the single-JSON project state.

## 5. Sources

- GitHub API and repository files, read 2026-11-07, for every repository above.
- OpenRouter catalogue `GET /api/v1/models`, read 2026-11-07.
- [GSAP Standard No Charge License](https://gsap.com/community/standard-license/)
- [Remotion LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- [YouTube Terms of Service](https://www.youtube.com/t/terms)
- [browser-use/video-use](https://github.com/browser-use/video-use)
- [ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html): **not read** (EF-26).
