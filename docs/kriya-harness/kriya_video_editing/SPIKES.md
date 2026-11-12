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

## 6. TPX-02 for TP5 (2026-11-11): which filters does the runtime's FFmpeg have?

The signed Media Runtime on this Mac (`~/.kriya/media/2026.11.0`) ships Chrome, Python and the models,
**not FFmpeg**: Kriya uses the computer's own, here Homebrew's FFmpeg 9.0.2 (`engine/capabilities.js`
reads its `-filters`). Present: `gblur`, `boxblur`, `unsharp`, `vignette`, `noise`, `curves`, `hue`, `eq`,
`colorchannelmixer`, `colorize`, `colorbalance`, `negate`, `hflip`, `rgbashift`, `crop`, `scale`, `pad`,
`drawbox`, `fade`, `deshake`, `reverse`, `split`, `blend`, `lut3d`, `zoompan`, `geq`, `pseudocolor`,
`lutrgb`. **Absent: `vidstabdetect`, `vidstabtransform`.**

Decisions: every registry row in `core/effects.js` names only present filters (ET-FX-02 pins the
list); a stored `stabilize` is drawn with `deshake`, not vid.stab. On another computer the row of a
missing filter is left out at compile with a note, never faked. Also measured on this FFmpeg for the
tests: an effect's output is the same decoded frames twice (ET-FX-M1, all 21 rows); an encode alone
moves about 0.2 % of a coloured barcode frame's pixels by more than 8 levels, which ET-FX-M1 uses as its
noise floor.

## 7. TPX-05 and the TP7 preflights (2026-11-11): fonts in the sandbox, which scripts the reader reads

Throwaway code in the session's scratch folder; the runtime's Chrome 152.0.7977.30 (headless shell)
inside the macOS sandbox profile `engine/confine.js` writes, the tile's own CSP
(`font-src 'self' data:`), and the candidate fonts downloaded from `github.com/google/fonts` at commit
`5bb28733cec313b63fbd415b574b5ae35c8aa8b8`, each checked against its `METADATA.pb` (`license: "OFL"`)
and `OFL.txt` (SIL OFL 1.1) and hashed. macOS 27.2 (26B123), Apple silicon.

**A font file loads inside the sandboxed tile (TP7 preflight).** One Telugu caption, three ways, each
`document.fonts` status and the fonts DevTools says drew the glyphs (`CSS.getPlatformFontsForNode`):

| `@font-face src` | Status | Drawn with |
| --- | --- | --- |
| `file://` path into the runtime's `packs/pack-fonts/` | loaded | Noto Sans Telugu (custom), 16 glyphs |
| relative path from the tile's folder | loaded | Noto Sans Telugu (custom), 16 glyphs |
| `data:font/ttf;base64,…` | loaded | Noto Sans Telugu (custom), 16 glyphs |
| `file://` path outside the sandbox's read list (control) | **error** | Kohinoor Telugu (system), Courier |

No CSP report in the console for any of them: for a `file://` tile Chrome treats `file:` as `'self'`.
**Decision:** fonts go in as `data:` (`engine/fonts.js` `withFonts`), put in by the renderer, not the
composition. Only `data:` works in all three places a tile is drawn: Chrome on a `file://` page, the
HyperFrames path (served over loopback HTTP) and the Studio's tile preview (`/tile-preview`, HTTP).
The composition names a font only by id (`url("kriya-font:<id>")`), so tile keys stay path-free.

**Which scripts the OCR helper reads (TPX-05, EQ-17).** Vision's `supportedRecognitionLanguages` on
this Mac: en, fr, it, de, es, pt-BR, zh-Hans/Hant, yue, ko, ja, ru, uk, th, vi, ar, ars, tr, id, cs,
da, nl, no, nn, nb, ms, pl, ro, sv, fi, **hi-IN, mr-IN**. One rendered caption per script (64 px bold,
white on grey, the Noto face), read by `gates/text.swift`:

| Script | With `en-US` (today's QG-10) | With `hi-IN,en-US` |
| --- | --- | --- |
| Latin | exact, c = 1.0 | exact, c = 0.5 |
| Devanagari | nothing read | **exact**, c = 0.5 |
| Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Gurmukhi | nothing read | garbage in Devanagari or Latin letters, c = 0.3 |

A second batch, 6 phrases × 2 sizes (64 and 46 px): Latin 12 of 12 exact with `en-US` (c = 1.0);
Devanagari 12 of 12 exact with `hi-IN` (c always 0.5, under QG-10's `UNSURE` 0.8, so its words count as
"unsure", which the judge already tolerates). **Settled (EQ-17):** the reader carries QG-10 for Latin
and Devanagari; the glyph check of CRAFT §5.1 carries Telugu, Tamil, Kannada, Malayalam, Bengali,
Gujarati and Gurmukhi. Windows and Linux have no OCR helper at all (`ocrHelper` says so), so the glyph
check is the only QG-10 there; the motion layer itself is still macOS-only (EQ-11), so that is unmeasured.

**What the glyph check can see, found while building it.**
- DevTools' platform fonts alone are not enough: a code point no font has (a noncharacter U+FDD1, or the
  Kawi letter U+11F04) is drawn with the *first* shipped font's empty box and reported as that font
  ("Inter"), never as LastResort. The check therefore also draws each grapheme cluster on a canvas in
  its element's own font and compares the pixels with U+FDD0's (a noncharacter no font maps): identical
  means an empty box. Seeded: both found; a Kannada line clean; Arabic (no shipped font) found as
  drawn with Arial, not the shipped fonts.
- Inter has glyphs in the Private Use Area (U+E000…), so a private-use character is not a missing one.
- Cluster counts use `Intl.Segmenter` in the same Chrome: "మీకు స్వాగతం" is 5 clusters, "క్ష" one.
- Not detectable this way: a cluster the shaper draws with a dotted circle (broken shaping inside a
  font that has every glyph). Written down as a limit.

**Line heights.** Each shipped font's box (hhea ascent + descent + gap, over units per em), measured from
the pinned files: Inter 1.210, Oswald 1.482, Montserrat 1.219, Lora 1.280, JetBrains Mono 1.320,
Caveat 1.260, Noto Sans Devanagari 1.304, Telugu 1.352, Tamil 1.240, Kannada 1.349, Malayalam 1.247,
Bengali 1.325, Gujarati 1.304, Gurmukhi 1.304. Chrome counts a box past the line as overflow (a
Devanagari word at 134 px in a 1.18 line: scrollHeight 160 against 158; Oswald at 60 px in a 1.2
line: 80 against 72), which QG-08 reads as clipped. Each font's `line` in `engine/fonts.js` is this
number rounded up, and a kit tile's lines are never shorter than the fonts it uses need.

**The previous client reads the new manifest (EH-68 preflight).** `src/edit/runtime/manifest.js` at
`0eb1d69` (TP3, the last committed client; byte-identical to the file TP7 leaves) opened
`lib/editing/runtime/manifest.2026.11.1.json`, signed for the test by an ephemeral Ed25519 key, with
no error, and `install` (unchanged since `0eb1d69`, sha256 `48802a51…`) installed its core from the
same shape on loopback, leaving `packs/` untouched; `installPack("pack-fonts")` then installed all
fourteen (`tests/edit-type.test.js`, ET-TY-REG-02). An older client simply ignores a pack it doesn't
know: `packStatus` iterates its own `PACKS`.

## 8. TPX-03 for TP6 (2026-11-11): can code tell a cut from a dissolve, a dip, a wipe and a zoom, and find text?

Run on this Mac (darwin-arm64, macOS 27.2, Node v24.22.0, Homebrew FFmpeg 9.0.2, the runtime's Chrome
152.0.7977.30 for caption and graphic tiles). **The references were made by Kriya itself**, so the truth
is what Kriya placed and no one else's video was used (EB-05 is not needed for this part): scenes of
plain colour (a soft ramp, a slow bright box, light noise, a voice of tone bursts) cut and joined by the
Engine (`tests/edit/media/reference-made.js`) with its own six transitions, punch-ins, caption looks,
graphics, effects and code-made beds. Six references, 24 to 34 s each, 540×960 and 960×540:

| Reference | What was placed |
| --- | --- |
| joins | 9 joins at 0.4 s: cut, fade, dip, flash, wipe, slide, zoom, cut, fade |
| joins2 (wide) | 9 joins at 0.6 s, under 2.39:1 bars, a 0.8 vignette and grain 20 |
| joins3 | 9 joins, 0.2 s (the shortest Kriya makes) and 0.8 s (the longest), alternating |
| styled | 3 slides and 4 cuts; `karaoke` captions two words a page (16 pages); a name strap and a title; two ×1.25 punch-ins; an `upbeat` bed (112 bpm) |
| clean (wide) | 5 cuts; `clean` (outlined) captions four words a page (6 pages); one eased ×1.3 punch-in |
| bare | 7 cuts; a `calm` bed and no voice |

**Method.** Three bounded passes through a pipe, frames and samples dropped as they are read: grey
frames 96 px on the long side at 15 a second (motion); RGB frames 480 px at 4 a second (text, colour);
mono sound at 11,025 Hz. A join's kind is read by fitting the frames inside it to four models (a
least-squares mix, a straight moving edge, a push, a zoom into the outgoing picture mixing to the
incoming one); through black and through white are read from brightness alone. A punch-in is a frame
that is the frame before it, scaled.

**Joins: 46 of 46, by kind, none missed and none made up.**

| Kind | Placed | Found as that kind | Found as another | Made up |
| --- | --- | --- | --- | --- |
| Hard cut | 19 | 19 | 0 | 0 |
| Fade (dissolve) | 5 | 5 | 0 | 0 |
| Dip to black | 4 | 4 | 0 | 0 |
| Flash (through white) | 4 | 4 | 0 | 0 |
| Wipe | 4 | 4 | 0 | 0 |
| Slide | 7 | 7 | 0 | 0 |
| Zoom | 3 | 3 | 0 | 0 |

Precision and recall are 1.0 for every kind **on these references**, at 0.2, 0.4, 0.6 and 0.8 s. Every
join was found within 0.07 s (one sample) of where the plan put it. The winning model left 0.1 % to
5.7 % of the join unexplained (mean absolute difference over the difference between the two pictures);
the next model left 2.8 % to 43 %. A zoom join is fitted as a dissolve with one more freedom, so it must
beat the dissolve by a factor (`JOIN_FIT.zoomEdge` 0.7): real fades read 0.9 to 1.4 % as a fade and 2.8
to 6.8 % as a zoom; real zooms read 2 to 13.6 % as a zoom and 10.5 to 57.6 % as a fade.

Thresholds set from this, all in `src/edit/engine/dna2.js`: a frame is changing above a mean difference
of 1.2 grey levels; a one-frame change of 6 or more that moves a quarter of the picture is a cut; a
model must leave 30 % or less unexplained or the join is **unread**; darker than half of both ends is
through black; 60 % of the way to white is through white; a scale must explain 55 % of a change to be a
zoom; under 10 samples a second (a reference longer than 12 minutes) the kinds of joins are not read at
all.

**Found on the way, and what was done:**

- A 0.6 s dip sat on black long enough to look finished, and was read as a cut and a fade. The reader
  now holds a join open while the frame is black or white.
- A caption page changing with a cut made the cut look gradual, and a page changing alone was a tenth of
  the size of a cut. A join must now move a quarter of the picture; a change carried by one frame is a
  cut whatever else moves with it.
- A zoom join out of a letterboxed, vignetted picture brightens (the bars leave the frame) and was read
  as a flash at the first threshold (35 % of the way to white). Raised to 60 %; a real flash at 15
  samples a second reaches 67 % or more.
- A scale fit is thrown by a caption changing at the same moment; each pixel's difference now counts up
  to 24 levels.

**Text regions.** Cells of 8×8 pixels where sharp vertical strokes of both polarities crowd together
(a box's edge has one polarity and is not text), joined across a word gap.

| Trait | Truth | Read |
| --- | --- | --- |
| Captions present | styled, clean: yes; the other four: no | 6 of 6 |
| Caption band (top to bottom, share of height) | drawn at 0.84 to 0.88 | 0.840 to 0.883; 0.837 to 0.881 |
| Caption height | `karaoke` 4.6 % font, `clean` 4.2 % | 4.17 %, 4.07 % (the letters measure about 0.93 of the font size) |
| Pages a minute | 35.3 (16 in 27.2 s); 15.0 (6 in 24 s) | 35.2; 15.0 |
| Plate | `karaoke`: a plate; `clean`: an outline, no plate | box; none |
| Word-by-word highlight | `karaoke` yes; `clean` no | yes; no |
| Graphics | styled: 2 (a strap lower left, a title); others 0 | 2, strap found lower left; 0 everywhere else |
| Text where there is none (four references) | 0 regions | 0 |

**Could not be read, and so is not in an Edit DNA 2 at all** (never guessed):

- **Words on a caption page.** Counting gaps between words gave 3, 1 and 2 for four words (`clean`,
  letters 11 px tall at analysis size) and 1 for two (`karaoke`). Not reliable at any size tried.
- **An outline.** A one-pixel outline can't be told from no outline; only a plate is read. On a dark
  picture a plate and no plate look the same, so the plate is then unread (`null`).
- **Music's share of the time, its level under the voice, and hits that aren't speech.** These need the
  voice apart from the rest. What is read instead: what is left in the gaps against the loud parts
  (voice only −45 dB; voice over a bed −19 dB; a bed alone −7 dB; a bed counts above −30 dB).
- **Faces in the shots.** The face helper reads files on disk; a reference's frames are never written.

**Tempo.** Read only where tracked beats have hits on them (`pulseOf`). Eight of Kriya's ten beds
score 0.96 to 0.99 and read within 0.1 bpm; `upbeat` under a voice scores 0.89 (112.0 read for 112);
`calm` and `dreamy` have no drums, score 0.11 to 0.12 and are **not read**, though their tempo happened
to come out right (79.9 for 80, 71.3 for 70). A voice alone scored 0.33 to 0.59 against a floor of 0.7:
the margin is thin on these fixtures, whose "speech" is tone bursts.

**The look.**

| Trait | Plain references | With the effect |
| --- | --- | --- |
| Grain (mean distance of a pixel from its neighbours on flat picture, grey levels) | 0.18 to 0.26 | 3.15 (grain 20) |
| Corner falloff | −0.02 to 0.06 | 0.43 (vignette 0.8) |
| Bars (share of the height) | 0 | 0.252 (0.256 for 2.39:1 on 16:9) |

A trait counts as there above 0.8, 0.2 and 0.04 (`PRESENT` in `core/style-brief.js`).

**Punch-ins.** 3 of 3 found at the right moment; scale read as 1.25, 1.25 and 1.25 for 1.25, 1.25 and
1.3. Whether a punch-in is eased or snapped is **not reliable** (the eased one was read as snapped):
the field is kept but nothing uses it.

**Cost.** One measure of a 27 to 34 s reference takes 1.0 to 1.5 s here (5.2 s under grain, which keeps
every frame "changing"). Work is bounded: at most 7,200 motion frames, 1,200 detail frames and 600 s of
sound, however long the reference. An Edit DNA 2 is about 1.8 kB of numbers and fixed words.

**What this settles (EQ-19, for references Kriya makes) and what it does not.** On Kriya-made references
every kind of join, punch-ins, caption band, size, plate, highlight and cadence, graphics, grain,
corners, bars, a bed and a drummed tempo are read within tolerance. **Nothing here says how the reader
does on real footage**: these pictures are clean, their joins are FFmpeg's own, and their captions are
Kriya's. Hand-held movement, busy backgrounds, other tools' transitions, light or coloured caption
plates and dark footage are unmeasured until EB-05's cleared set. That is why every trait carries a
confidence, an unread join is counted as unread, and QG-16 is a note.

**Also found (existing behaviour, not TP6's, not changed): EH-88.** Two caption pages with the same
words and look are drawn once: the second never shows. Seen while building these references (every shot
said "Start small keep going", and only the first shot was captioned); with different words on every
page, all show. Recorded in TOP_TIER_FORENSIC_AUDIT §4.1.
