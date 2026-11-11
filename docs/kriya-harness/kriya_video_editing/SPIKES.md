# ED1 spikes: results (track E)

Run 2026-11-07 on one machine: Apple M5, 10 cores, 16 GB, macOS 27.2, Node 24.22,
in a scratch folder outside both repositories. Throwaway code; nothing here is
product code. Tools: HyperFrames 0.9.19, FFmpeg 6.0 (`--enable-gpl`, from
`ffmpeg-static`), Mediabunny, faster-whisper 1.2.1, mlx-whisper, ONNX Runtime 1.31.

> [!IMPORTANT]
> Every number is from this one fast machine, on **synthetic fixtures**. No real
> person's footage or voice was used. Expect a typical laptop to be slower. Numbers
> show direction and feasibility, not what a customer will see.

## 1. Verdict

**The architecture stands.** No pillar failed, and the plan to ED2 holds. Four claims
in the blueprint were wrong or too strong, and are corrected below.

| Id | Question | Result | Effect |
| --- | --- | --- | --- |
| EX-01 | Alpha tiles from HyperFrames | **Holds** | WAAPI with no GSAP works |
| EX-02 | Capture, repeatability, WebGL, WebGPU | **Holds, claim weakened** | Pixels aren't bit-exact even on one machine |
| EX-03 | Frame-accurate preview of 2 hours | **Holds** | 0 wrong of 200; short-GOP proxy confirmed |
| EX-04 | Speech in Indian languages | **Partial; needs real samples** | Language must be set, never detected |
| EX-05 | BiRefNet speed | **Changed the design** | 0.2 fps on CPU: hybrid matte |
| EX-06 | The Studio's own origin | **Holds** | Every attack refused; isolated; 10 GB streams |
| EX-07 | Entry from DSH | **Holds** | 114 ms, console clean |
| EX-08 | Flash-1017 as Director | **Not run** | Needs a paid go-ahead (EB-07) |
| EX-09 | Runtime install | **Partial: macOS only** | About 4.8 GB on a Mac |
| EX-10 | Layer split, sparse checks | **Holds, claim reduced** | 1.3× first render, 5× on a change |
| EX-11 | Round-trip speech, retakes | **Changed the design** | Text can't catch a clipped word; a signal check can |
| EX-12 | Governor protects a live session | **Holds, a number corrected** | Open answers are the real limit |
| EX-13 | WebGPU compositor | **Holds, one rule added** | One device for the Studio's life |
| EX-14 | Confinement | **Holds on macOS** | Network and home blocked; GPU keeps working |

## 2. Results

### EX-01 Alpha tiles

5-second 1080×1920 card, springs computed in code and baked to WAAPI keyframes, **no
GSAP**. To ProRes 4444 (`yuva444p12le`, 150 frames): 8.3 s first run, 22 MB. To PNG
sequence: 2.9 s, with capture about 13 ms a frame. WebM alpha: 378 KB.

Alpha is real and the motion is right: 0 % covered at t=0, then the spring overshoots
to y=1115 and settles at y=1180.

- `--start` and `--end` are documented for MP4 only, so **a tile is its own short composition**.
- Each composition costs about 4 s of fixed setup: 3 tiles of 8 s total took 13.7 s. Batch tiles, or keep a browser warm.
- Non-GSAP compositions need `data-no-timeline`, or lint fails.
- `hyperframes` downloads Chrome to `~/.cache/hyperframes` (193 MB) on first use: the Media Runtime must place it itself.
- **The CLI sends PostHog telemetry by default.** Set `HYPERFRAMES_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` always (EH-43).

### EX-02 Capture and repeatability

Live process flags: `--no-sandbox`, `--use-gl=angle`, `--use-angle=metal`,
`--enable-gpu-rasterization`. Screenshot capture on macOS. WebGL2 and WebGPU both
work in capture, with an adapter present, and a WebGL canvas follows the seek clock.

Two identical renders of 150 frames: **4 frames differed**, by 2 to 2,750 pixels of
2 million, up to 64 levels, at text edges during motion. So pixels are **not**
bit-exact on one machine. The RenderPlan is what's deterministic (EH-45).

### EX-03 Frame-accurate preview

A proxy with an 18-bit frame barcode burned in, read back after each seek. 200 random
seeks per file, through a real browser, over HTTP Range.

| Proxy (960×540, no B-frames) | Size | Wrong frames | Seek p50 | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| GOP 15, 10 min, 1.5 Mbps | 120 MB | 0 | 7.8 ms | 9.8 | 11.1 |
| GOP 30, 10 min | 120 MB | 0 | 9.8 ms | 12.0 | 14.9 |
| GOP 60, 10 min | 120 MB | 0 | 12.1 ms | 15.8 | 16.4 |
| All-intra, 10 min, x264 CRF 24 | 220 MB | 0 | 6.9 ms | 7.5 | 8.3 |
| **GOP 30, 2 hours** | 1.44 GB | **0** | 10.0 ms | 12.7 | 24.5 |

All-intra buys 3 ms. **GOP 30, no B-frames** is the setting. Encoding the 2-hour proxy
took 247 s with VideoToolbox. `<video>` over Range seeks in a 2-hour file too. Sizes
come from a fixed bitrate on synthetic content.

### EX-04 Speech (smoke only)

macOS voices reading known text. **This says little about real people.** EB-04 stands.

| Input | Faster-whisper, CPU | mlx-whisper, Apple GPU | WER |
| --- | --- | --- | --- |
| English (Rishi) | 3.2× real time | **12.4×** | 0.06 |
| Hindi (Lekha) | 1.5× | **9.7×** | 0.38–0.41 |
| Telugu (Geeta), language forced | 1.3× | **5.9×** | 0.39–0.45 |
| Telugu, auto-detected | 0.7× | — | **1.00: detected as Tamil, nonsense** |
| Hinglish, Latin script | 1.4× | 9.6× | Not meaningful: came back in Devanagari |

- CTranslate2 has no GPU path on a Mac, so faster-whisper is the wrong engine here (EH-48).
- Auto-detection failed on Telugu, so the language must be set by the person (EH-49).
- Even on clean synthetic speech, Hindi and Telugu WER near 0.4 is too high to caption without review. EX-04 with real samples, and the alternatives, decide this.

### EX-05 Matte

| Engine | Speed | Note |
| --- | --- | --- |
| BiRefNet lite, ONNX, CPU, 1024² | **5.08 s a frame (0.2 fps)** | The brief's "60 fps" is 300× away |
| BiRefNet lite, CoreML | **Failed to compile** | After several minutes |
| MediaPipe selfie segmenter, 1080p | **2.1 ms a frame (477 fps)** | 0.25 MB model; rougher edges |
| BiRefNet through PyTorch Metal | Not tested | ghost-editor's documented path; ED8 |

Quality wasn't judged, because there was no real person to judge it on. Five seconds of
behind-the-head effect costs over 12 minutes on BiRefNet CPU, so the plan is a hybrid
(EH-50).

### EX-06 The Studio's own origin

| Attack or check | Result |
| --- | --- |
| No session | 401 |
| Foreign `Host`; DNS-rebinding `Host` | 403, 403 |
| Foreign `Origin` | 403 |
| `Sec-Fetch-Site: cross-site` | 403 |
| Launch token reused | 401 |
| `crossOriginIsolated` with our headers | true; `SharedArrayBuffer` available |
| Cookie visible to JavaScript | No |
| 10 GB streaming upload | 7.2 s; server memory 107 MB. Best case: sparse file to `/dev/null` |

### EX-07 Entry from DSH

In a scratch clone with a throwaway plugin, on the real DSH against the fake Kriya: the
row renders in the real sidebar (below Projects); click to Studio in **114 ms**; back
returns to the harness with no bounce; console clean; no activation problems. About 20
lines of plugin.

### EX-08 Not run

Needs real model calls on staging (EB-07). Unknown: schema compliance, cached tokens,
image cost, and answer latency, which EX-12 had to assume.

### EX-09 Runtime (macOS only)

| Item | Size | Time here |
| --- | --- | --- |
| FFmpeg, ffprobe | 64 MB | Seconds |
| HyperFrames packages | 505 MB | 90 s |
| Headless Chrome | 194 MB | About 85 s |
| Python core (mediapipe, OpenCV, librosa and more) | 1.4 GB | 301 s |
| mlx-whisper environment | 1.1 GB | Minutes |
| Whisper turbo weights | 1.5 GB | 522 s |
| **Total on a Mac** | **About 4.8 GB** | Tens of minutes on this connection |

- `ffprobe-static` is Intel-only on arm64, and fails with "bad CPU type". Its replacement here is an older 4.4.1. The manifest needs one matched pair (EH-51).
- The tested FFmpeg is `--enable-gpl`. EQ-02 stands.
- Windows and Linux weren't tested.

### EX-10 Layer split and sparse checks

60-second 1080×1920 reel with 8 seconds of overlays, tagged 4.5 Mbps source.

| Path | Time |
| --- | --- |
| Whole video through Chrome | **31.2 s** |
| Split: 3 tiles 13.7 s + x264 medium 9.5 s | **23.2 s** |
| Split, tiles already cached | 9.5 s (x264 medium), 5.5 s (veryfast), 6.8 s (VideoToolbox) |
| **Change one caption:** whole | **31 s** |
| **Change one caption:** tile + its segment | **5.8 s** (4.5 + 1.3) |

So the split is about **1.3× on a first render and 5× on a change**. Its value is
revisions, which is where people spend their time. Cost scales with the whole video
for Chrome, and only with overlays for tiles, so the gap should grow with length, but
that wasn't measured. An earlier run on a heavy-noise 105 Mbps fixture showed no gain
with x264, so encoder cost can dominate.

**Quality**, SSIM against the source: split 0.98–0.99; whole 0.97 on a tagged source.
On an **untagged** source, whole fell to 0.80 with visibly wrong colour, while the
split held. So normalise colour before anything reaches Chrome (EH-46). Overlay
timing matched between paths to within a pixel on a moving spring.

**Sparse checks:** 150 risk frames took 0.8 s in one `select` pass, against 9.5 s by
seeking to each and 5.5 s for a full draft. One pass is the way.

### EX-11 Round trip and retakes

Seeded defects in 23 seconds of speech, comparing transcribed text.

| Defect | Caught by text comparison |
| --- | --- |
| Clean re-runs (false alarms) | 0 of 6 |
| Whole word removed | **9 of 10** |
| First 20 / 50 / 100 / 200 ms of a word clipped | 1, 8, 3, 6 of 10: **erratic** |

Whisper's word starts are too loose to define the clip, and it often "hears" the word
anyway. A **signal check at the cut point** does the job:

| Check on source audio energy at a cut | Flagged |
| --- | --- |
| Clean cuts in real gaps | **0 of 38** |
| Cut 5, 10, 20, 50 ms into speech | **38 of 38** each |
| Cut 100 ms into speech | 35 of 38 |

Clean synthetic speech is the easy case; a noisy room needs a floor per recording.

Retakes, simple rules with no model, on a synthetic raw take: **0 false cuts in 13 good
lines; 6 of 9 bad lines caught.** Misses: a restart with a restart phrase between the
attempts, and "one more time". Not tuned, as that would fit the fixture.

### EX-12 Governor

Virtual-time model of the real limits: 3 open answers per person, 60 requests a minute
per device across all routes. A chat with 12-second answers, Remote Control posting
every 2 seconds, and 200 Director calls of 10 to 20 seconds. Answer times are
**assumed** until EX-08. Five seeds each.

| Case | Chat 429s | Other 429s | Chat answers per hour | Job time |
| --- | --- | --- | --- | --- |
| Naive fan-out | **310** | 9,285 | **61** | Never finished |
| Governor, chat and Remote Control live | **0** | 0 | 240 | 50 min |
| Governor, nothing else live | — | 0 | — | 25 min |

The Governor works. **The limit is open answers, not calls a minute** (EH-47).

### EX-13 WebGPU compositor

WebCodecs to external texture, one WGSL pass with crop and a 33³ 3D LUT, 1080×1920 out.

| Source | Play | Scrub p50 | p95 |
| --- | --- | --- | --- |
| 540p proxy | 713–1,208 fps | 9.6 ms | 14.1 ms |
| 1080p, GOP 30 | 960–1,180 fps | 15 ms | 17 ms |
| 1080p, GOP 250 | 890–1,080 fps | 45–50 ms | 92–94 ms |

Well inside the 100 ms target, in headless Chrome, unthrottled.

**An intermittent hang:** creating a new GPU device for each clip hung 1 of 3 sequences
of repeated runs, with no pattern in codec or size. Unclosed decoders were tested and
ruled out (24 open, no problem). The cause is unknown. With **one long-lived device**:
5 runs, 1,000 clip switches, 31,000 frames, zero hangs, first frame 12 ms p50, 79 ms
p95 (EH-52).

### EX-14 Confinement (macOS)

`sandbox-exec`, with outbound network denied except loopback, and home denied except
HyperFrames' cache.

| Check | Inside | Control, outside |
| --- | --- | --- |
| Read a file in home | Refused | — |
| Write to home | Refused | — |
| Reach `1.1.1.1` directly | Refused | 301 |
| A composition's `fetch` | **"net: blocked"** | **"net: REACHED"** |
| FFmpeg local work | Works | — |
| HyperFrames render, hardware GPU | Works; pixels match outside | — |

The control matters: **HyperFrames doesn't stop a composition reaching the internet
during a render** (EH-44). The sandbox is the only barrier. Linux and Windows weren't
tested. `sandbox-exec` is deprecated by Apple, and still works here.

## 3. What these results changed

| Id | Was | Now | Where |
| --- | --- | --- | --- |
| EH-43 | HyperFrames assumed quiet | Telemetry off by environment, and blocked by the sandbox | ES-24 |
| EH-44 | Sandbox "for model-written code" | Sandbox for **every** Chrome render | ES-05 |
| EH-45 | "Reproducible per machine" | The plan is deterministic; pixels are close, not identical | EDIT_ENGINE §12, EDD-11 |
| EH-46 | Layer split sold on speed | Sold on revisions; colour normalised first; tiles batched | EDIT_ENGINE §6 |
| EH-47 | "200 calls is 10 minutes" | 25 to 50 minutes; a first cut uses at most 8 calls | EDIT_LOOP §8 |
| EH-48 | faster-whisper everywhere | Speech engine per platform | PERCEPTION_AND_INDEX §2, EDD-48 |
| EH-49 | Language detected per chunk | Set by the person; never auto-detected for Indian languages | PERCEPTION_AND_INDEX §5 |
| EH-50 | BiRefNet for every frame | Fast mask for preview; BiRefNet where quality is asked for | EDD-49 |
| EH-51 | Any FFmpeg package | One matched, native pair per platform, in the manifest | EDD-06 |
| EH-52 | GPU per clip, unstated | One device for the Studio's life, plus a watchdog | STUDIO_APP_AND_BROWSER §4, EDD-50 |
| EH-53 | QG-04 for clipped words | QG-04 for dropped words; QG-05 for clipped ones | QUALITY_GATES §2, EDD-20 |

## 4. Still open

| Item | Needs |
| --- | --- |
| EX-04 on real speech, with alternatives (IndicConformer, sherpa-onnx) | Owner's labelled samples (EB-04) |
| EX-08 | Paid go-ahead (EB-07) |
| EX-05 quality; PyTorch Metal speed | A consenting person's footage; ED8 |
| Windows and Linux for EX-02, EX-09, EX-14 | Those machines (ED17) |
| A slower laptop for every timing | A reference machine |
| Cause of the GPU hang | Not needed while one device holds; watch in ED6 |
| Whether the split's gain grows with length | ED12 |

Left on this machine by the spikes: `~/.cache/hyperframes` (194 MB) and a uv-managed
Python in `~/.local/share/uv/python` (145 MB), both safe to delete.

## 5. Top-tier spikes for TP3 (2026-11-11)

Throwaway scripts in the session's scratch folder, run on this Mac (darwin-arm64, Node
v24.22.0, FFmpeg 9.0.2, the installed Google Chrome headless), against the client at the
TP2 commit (`1db980c` on `feat/editing-assembly-tp1-tp2`). No product code was changed to run them.

### TPX-01 Live tiles over a scrubbing monitor

The renderer's own tile documents (`captionComposition` in three looks, the `title` and
`lower-third` blocks) in sandboxed frames (`sandbox="allow-scripts"`, the tile CSP, no network)
over a canvas that seeks a real proxy (540×960, GOP 30, no B-frames), as the Studio's monitor
does. Each scrub step: seek, wait for `seeked`, draw, post the time to every tile, and wait until
**every** tile has paused its animations at that time and painted (it answers after a
`requestAnimationFrame`). Five seconds per run; then five seconds of playback, posting the
time on each `requestVideoFrameCallback`.

| Tiles | Scrub steps a second, all tiles in step: idle machine | The same, under load | Page frames a second while scrubbing (idle) | Playback frames drawn a second, 30 fps source (idle) |
| --- | --- | --- | --- | --- |
| 0 | 308 | 97.5 | 60.2 | 30.0 |
| 1 | 60.3 | 60.2 | 60.3 | 29.9 |
| 5 | 60.2 | 60.1 | 60.2 | 29.9 |
| 20 | 60.2 | 49.2 | 60.2 | 29.9 |

"Under load": the same script while the client's `test:media` ran on the machine. With tiles,
a step waits for the tiles' next paint, so 60 a second is the display's rate, not a limit of the
tiles. Without the lock-step wait the scrub ran 146 to 169 steps a second at every count (under load). **Decision:**
live tiles stay on while scrubbing; the fallback (stills while scrubbing) isn't needed. The monitor
mounts only the tiles showing at the playhead, usually one to three.

### TPX-06 Are cached draft segments exact after a change?

A 30 s chart (540×960, 30 fps, a 220 Hz tone) cut whole, five `caption_style` captions each in its
own 6 s segment, rendered as a draft; the third caption's text changed (`caption_edit`); the draft
rendered again on the same cache; then the changed project rendered on an empty cache.

| | Before TP3 (client `1db980c`) | With each segment's input naming only its own tiles |
| --- | --- | --- |
| Segment keys changed by the edit | 1 of 5 | 1 of 5 |
| Segments encoded again | **5 of 5** | **1 of 5** |
| Sound mixed again | no | no |
| Time of the re-render | 15.9 s | 3.0 s (12.9 s on an empty cache) |
| Decoded frames different from the full render | 0 of 900 | 0 of 900 |
| Audio samples | identical | identical |
| File bytes | differ (container) | differ (container) |

**Found:** the plan's segment keys already changed only where a caption changed, but every draft
segment's graph input carried the whole plan's tile list, so one caption change re-rendered the
whole film. **Decision:** behind `editing.livePreview`, a draft segment's input names only the tiles
it draws (`engine/index.js`, `partial`). The joined film is exact, so neighbours need not render
again. The sound is one mix of the whole film and a master one encode, as before (EH-66).

### ET-PV-01's floor, measured on the TP2 code

Today's monitor (no tiles, no effects: what it draws exactly) against the rendered draft, a plain
cut of a structured test chart, SSIM of the monitor's canvas against the rendered frame at the
canvas's size, six samples each:

| Project | Monitor canvas | Draft | Worst | Best |
| --- | --- | --- | --- | --- |
| 640×360 (16:9) | 640×360 | 1280×720 | 0.997354 | 0.997753 |
| 720×1280 (9:16, from a 16:9 take) | 720×1280 | 720×1280 | 0.997464 | 0.998174 |

The floor is **0.997**. Also measured for TP3's preview: FFmpeg's `xfade` on flat frames (fade
linear; dip and flash a two-phase smoothstep mix; wipe and slide move at W·(1−p); zoom magnifies
the held frame by 1/smoothstep(0.5, 1, P)), and `scale … force_original_aspect_ratio=decrease:
force_divisible_by=2` rounding to the nearest even size (405 → 406), with pad and overlay flooring
the offset to even (437 → 436). The Studio's preview follows both (`studio/src/preview.js`).
