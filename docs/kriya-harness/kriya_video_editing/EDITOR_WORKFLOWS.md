# Editor workflows (track E)

Written the way an editor thinks: what comes in, what you decide, in what order,
and what "finished" means for each kind of job. Each format is a **recipe**
(SKILLS_AND_OPEN_SOURCE §5). This is the craft the harness encodes, so that a
cheap model only has to make choices, never remember technique.

## 1. What an editor needs before starting

| Resource | Why | How Kriya gets it |
| --- | --- | --- |
| Raw footage | The material | Drop files or add a folder (no copy) |
| Separate audio | Better sound than the camera | Auto-paired by audio sync |
| Screen recordings | Tutorials and demos | Detected by content |
| Script or outline | Intent, take matching | Paste or drop `.txt`, `.md`, `.docx`; matched to takes |
| Reference clips and stills | The feel | Reference slot, the person's own files |
| Brand kit | Logo, colours, fonts, intro, outro | Saved once, reused |
| Music and sound effects | Mood, rhythm, punctuation | The person's files, plus a licensed starter pack (EQ-07) |
| Data | Charts | CSV or JSON |
| Platform and length | Shapes every choice | Asked once, or inferred from the brief |
| Deadline and effort | Draft now, or polish overnight | "Fast" or "Best" |

**Dump it all in one place.** The person can drop a messy folder. The index sorts
it: A-roll (someone talking), B-roll (no speech, or action), screen, music, sound
effects, images, documents, duplicates. The bin shows that sort, and a wrong
guess is one drag to fix.

## 2. Every edit, in order

Whatever the format, an editor's order holds:

1. **Log**: what do I have? (the index)
2. **Select**: what's good? (retakes, moments, quality)
3. **Structure**: what's the story, and in what order?
4. **Rough cut**: the story, in time.
5. **Fine cut**: rhythm, breaths, J and L cuts.
6. **Coverage**: B-roll, cutaways, zooms, to hide cuts and add interest.
7. **Graphics**: titles, captions, cards.
8. **Sound**: clean, music, effects, mix.
9. **Colour**: match, then look.
10. **Review**: watch it through, as a viewer.
11. **Deliver**: per platform, with a master.

The Director follows this order. Picture lock comes before sound and colour, so
later work doesn't get thrown away by a late cut, and anchors make a late cut
survivable anyway.

## 3. Recipes by format

Each row gives the recipe's essentials; the full recipe is data.

### 3.1 Short form

| Recipe | Input | Story rule | Pace | Dressing | Finish |
| --- | --- | --- | --- | --- | --- |
| `reel-talking-head` | One raw take | Best take per line; hook first | Tight, breaths trimmed | Captions, snap zooms, B-roll every few seconds, sound on beats | 9:16, −14 LUFS |
| `reel-depth` | Same | Same | Same | Cards and big words behind the speaker's head (matte) | 9:16 |
| `short-from-long` | Long video | Standalone micro-story; 15 to 60 s | As the speaker, tightened | Reframe, captions, hook text, progress bar optional | Pack per platform |
| `reel-montage` | Many clips, one song | Cut on the beat; energy follows the song | From the music | Light captions | 9:16 |
| `reel-list` | Voice-over | Numbered points | Fast, regular | Step numbers, B-roll per point | 9:16 |
| `reel-text-story` | Script | Reveal line by line | Reading speed | Kinetic type | 9:16 |

The first three seconds decide a short. So every short-form recipe starts by
choosing the opening line separately: the strongest standalone sentence can move
to the front if the story survives it. Moved lines are always in What I did.

### 3.2 Long form

| Recipe | Input | Key technique |
| --- | --- | --- |
| `youtube-longform` | A-roll, B-roll, screen | Story tree, scene-by-scene cuts, retention pacing: a change of picture at the recipe's rate, chapters, an end screen slot |
| `podcast-multicam` | N cameras, N mics | Sync, active-speaker switching, wide shots for overlap and reaction |
| `tutorial` | Screen plus face | Cursor-following zoom, callouts, silence removed but "thinking" kept when something is happening on screen |
| `lecture` | Long talk, slides | Cleaned speech, slide sync, chapters, optional summary card |
| `interview-doc` | Interviews, archive | Paper edit first, soundbites by theme, handoff to an NLE |
| `webinar-cleanup` | A recording | Remove dead time, level speakers, chapters |

### 3.3 Commercial and motion

| Recipe | Input | Key technique |
| --- | --- | --- |
| `product-ad` | Clips, logo, price | 15/30 s variants from one project; CTA end card; one message per shot |
| `ecommerce-demo` | Phone clips of a product | Hero shots by quality score, price badge, review card, subtitles for silent viewing |
| `explainer` | Script | Voice, then picture to the voice; scenes from motion blocks |
| `data-story` | CSV or JSON | Numbers come from the file, never the model; charts animate to the voice |
| `launch-video` | Screens, script | UI recreated or captured; fast type |
| `logo-sting` | Logo | A motion block; custom motion when needed |

### 3.4 Events and personal

| Recipe | Input | Key technique |
| --- | --- | --- |
| `wedding-highlight` | Multi-camera, ceremony audio | Music-led; vows as speech moments; faces by joy and sharpness |
| `event-recap` | Many clips | Structure by time; beat-cut; title cards |
| `travel-vlog` | Clips, voice notes | Voice as spine, B-roll by search; ambient sound kept |
| `sports-highlight` | Long match | Crowd energy peaks, scoreboard OCR changes, slow-motion replay |
| `real-estate-tour` | Walkthrough clips | Stabilize, room order, gentle speed ramps, labels |

## 4. Reference: Edit DNA

"Make it like this." An editor doesn't copy the pixels; they study the choices.
So does Kriya, and this replaces `motionclone` (EF-08).

From a clip the person supplies, Kriya measures only numbers:

| Measure | How |
| --- | --- |
| Pace | Shot length distribution and curve across time |
| Structure | Hook length, where the first cut falls, ending type |
| Caption style | Position, size, words per page, case, emphasis colour (OCR and regions) |
| Motion feel | Zoom frequency and size, easing family by fitting curves to tracked boxes |
| Colour | OKLab mean and covariance, contrast, saturation |
| Sound | Music level against speech, SFX density, loudness |
| Layout | Faces and text positions as a share of the frame |

Curve fitting follows the brief: cubic-bezier by least squares for monotonic
motion, a damped spring for overshoot. Output is a **Look**: plain parameters
that drive Kriya's own templates on the person's own footage.

Rules:

- **Only numbers are kept.** Reference frames and audio are deleted from the project after analysis, unless the person keeps them for the split view on their own machine.
- **No reference pixels or audio can enter the output.** QG-13 checks that no reference asset is on a track, and a perceptual-hash spot check runs on the output.
- **Text isn't copied.** Wording, logos, faces, characters and music from the reference are never reproduced.
- **Only clips the person supplies**, with their confirmation that they may use them for reference. Link import is separate and off (EDD-22).

The **split view** plays reference and result side by side, locked to the same
frame, for judging pace and look.

**As built in ED13** (client `src/edit/engine/dna.js`): pace (shot count, cuts a minute,
median, 10th and 90th percentile, the median shot in each tenth of the running time, from
L6's hard cuts), structure (first cut, last shot), colour (OKLab mean and covariance, a
16-bin lightness histogram, contrast, saturation, over 24 sampled frames), where burned-in
captions sit (rows of bright, sharp-edged pixels across frames: top and bottom as a share
of the height, never the words), and sound (integrated loudness, range, true peak). Frames
and samples go through a pipe and are dropped; `checkDna` refuses any field that isn't a
number in this shape, so no text, path or pixel can ride along (a measured reference is
under 600 bytes). `paceFromDna` gives a recipe's pace: the longest a picture holds is the
reference's median shot (2–30 s), and its opening and closing tenths keep their speed
against it (×0.3–1.5); `youtube-longform` takes it. QG-13 fails an output that holds a
reference asset's picture or sound, however it got there (ET-SEC-08). Not built: caption
size, case and colour (L10), motion feel (tracked boxes), music against speech (stems),
the perceptual-hash spot check, the split view, keeping a Look from the numbers. Shot
counts are only as good as L6, which misses cuts between shots of similar brightness.

## 5. Music

| Technique | Method |
| --- | --- |
| Choosing | The person's file, or the starter pack by mood and tempo |
| Beat grid | `beat_this` for beats and downbeats |
| **Fit to length** | Choose an edit path through the song's sections with cuts on downbeats, so the song starts and ends properly at the target length; a small dynamic program over sections, with short crossfades |
| Cutting to the beat | Montage recipes snap cuts to beats, with a tolerance, and prefer downbeats for big changes |
| Energy matching | Section energy curve against the edit's intensity |
| Duck | Band-limited sidechain (EDIT_ENGINE §10) |
| Stingers | The last hit lands on the last frame of picture |

## 6. Colour

1. **Normalise.** Convert each source to the working space; tone-map HDR.
2. **Balance per shot.** Auto white balance and exposure, within small limits, only when a shot is off against its neighbours.
3. **Match.** For multi-camera, or B-roll against A-roll: transfer colour statistics. In OKLab, fit each shot's mean and covariance, and use the closed-form Gaussian transport map from the brief, T = Σs^(−1/2) (Σs^(1/2) Σt Σs^(1/2))^(1/2) Σs^(−1/2). Bake into a 33×33×33 `.cube`, applied through FFmpeg `lut3d`.
4. **Protect skin.** Limit the transfer on skin-tone regions, so faces don't go green to match a green scene.
5. **Look.** A look LUT last, at a chosen strength.

A LUT from a still or a reference is **a look**, not a copy of an image. Each
grade is an operation, so it can be undone or changed by asking.

**As built in ED13** (client `src/edit/engine/color.js`): `.cube` 3D LUTs (2³ to 65³,
`DOMAIN_*` or `LUT_3D_INPUT_RANGE`) are read and checked before FFmpeg sees them; a 1D
LUT, a wrong row count, a non-number, a value past ±16, an unknown line or a file over
16 MB is refused in words. The Host adds a `.cube` as a `lut` asset that way. Step 2
(`balanceOps`) proposes `match_color` for each clip that is off against the one before
(lightness 0.04 or chroma 0.015 in OKLab), to the last one that wasn't. Step 3 is the
transport map above, with a ridge of 1e-4 on both covariances (a grey shot stays
invertible; equal shots map to themselves), its scales held to 0.5–2, the lightness
shift to 0.25 and the chroma shift to 0.08, baked into a 33³ `.cube`. The compiler turns
`match_color` into the matched clip's whole range and the reference clip's, so every
segment of a clip shares one LUT; the Engine measures both from the sources (12 frames
each), bakes the cube as a cached node and FFmpeg applies it with `lut3d`. A plan with a
LUT or a match needs the colour pack (FFmpeg's `lut3d`), checked before rendering. On a
synthetic scene, a dark, warm take came from lightness 0.455 to 0.601 against the
reference's 0.605, with its cast gone. Not built: skin protection (step 4), a look LUT's
strength control, HDR sources measured in their own space, the WebGPU preview of a grade.

## 7. Captions

Captions are half of what makes a short watchable, and where most tools feel
cheap.

| Rule | Detail |
| --- | --- |
| **Word-true** | Text comes from the transcript as corrected. Punctuation and casing are a model's light job; words are not rewritten without the person's say |
| **Phrase breaks** | Break at clause boundaries, not at a word count: 2 to 5 words per page, never orphaning a word. Never split a name or a number |
| **Reading speed** | A limit per script, set in EX-04's check with readers: Latin, Devanagari and Telugu differ. The solver adjusts page length, not the speech |
| **Emphasis** | Numbers, names and stressed words (energy from L5) get the accent colour |
| **Language** | Native script or romanised, by the person's choice. Fonts per script, with proper shaping (HarfBuzz through Chrome); QG-10 checks with OCR |
| **Placement** | Layout solver (EDIT_ENGINE §5.1): off the face, inside safe zones, stable |
| **Styles** | A look's caption block: font, size, stroke, animation. Bold, Bounce and Clean are written as Kriya's own CSS and WAAPI (no GSAP, no Remotion) |
| **Corrections** | Fix a word once in the transcript, and it's fixed everywhere |

SRT and VTT are always available as sidecars. Burned-in text can be switched
off per deliverable.

## 8. B-roll and coverage

| Step | Method |
| --- | --- |
| Where | At jump cuts that QG-05's face-position check rates as harsh, at list items, at named things, on a pacing rule |
| What | `edit_find` over the person's own footage by meaning; then images and motion blocks |
| Fit | Length from the sentence it covers; quality score must clear the recipe's floor; never the same shot twice in a row |
| Audio | B-roll sound muted by default, kept for a beat when it adds life |
| **Jump-cut healer** | A cut with the same framing is harsh. Code measures how far the face moved across the cut; if it is small but nonzero, an alternating punch-in (about 1.1×) hides it, with no B-roll needed |
| Stock | Only from a source with an official API and a licence the person agrees to (EQ-07); never scraped. Off until decided |

"Nothing on screen says anything the speaker didn't say" is ghost-editor's rule,
and it is adopted: generated claims don't appear on screen unless they came from
the person's script or words.

## 9. Multi-camera

1. **Sync.** Cross-correlate audio envelopes (GCC-PHAT) to find offsets, then fit a clock drift per file. ffmpeg-skill's `sync.py` and `multicam.py` are the starting point. Each pairing has a confidence, shown to the person. Below a floor, ask.
2. **Best audio.** Prefer the dedicated mic per speaker. Camera audio stays as a sync reference.
3. **Switch.** A camera per speaker from face identity and diarization. Rules: minimum shot length, no switch inside a short reply, a wide shot for overlap and laughter, a cutaway to the listener at reactions. A small cost-based path search keeps it from flickering.
4. **Match.** Colour match between cameras.

**As built in ED12** (client `src/edit/recipes/multicam.js`, recipe `podcast-multicam`,
no model call). Sync: sound at 8 kHz mono; a coarse lag by cross-correlating 10 ms
loudness envelopes (FFT, ±60 s, only lags where half the shorter recording overlaps); in
six windows, each placed where the master is loudest, a local lag on the envelopes and a
GCC-PHAT peak on the samples with sub-sample interpolation; a Theil–Sen line through the
windows, outliers over 2 ms dropped, then least squares, gives offset and drift. On
synthetic sound it recovers offsets within 0.5 ms and drift of +100 and −200 ppm within 10 ppm (the unit test's bounds);
through AAC in real files, ±2 ms, and the picture lands on the right frame. Confidence is
the windows' median peak sharpness × the share kept; under 0.3 the recipe stops and asks.
Who speaks: each speaker's own source (a dedicated mic, else the camera on them) above its
quietest 5 %, held 0.5 s, within 6 dB of the loudest over that stretch, and preferring a
voice heard now over one held by the hangover; unknown where a source isn't recording.
Switch: a path search over (angle, steps on it) with a 2.5 s minimum shot and a cost per
switch; the speaker's camera for one voice, the wide for several or for the unknown; the
listener's camera costs a little more than the wide, so a one-second reply holds the shot.
Then a 3 s look at the listener every 12 s of one voice, at the listener's loudest moment
over the speaker (a laugh), never at a reply. Angles go on as picture over the master,
which carries the programme's sound throughout. Not built: dedicated mics as programme
sound (needs an operation that places dialogue from another asset), face identity and
diarization (L4, L8 identity), laughter detection (L13), colour match (step 4), removing
dead air.

## 10. Long form at scale

| Concern | Technique |
| --- | --- |
| Reading it all | Story tree (PERCEPTION_AND_INDEX §8) |
| Structure | Scenes as nested sequences; the Director works one scene at a time and keeps a one-paragraph running state |
| Pace | A target rate of picture change over time; a report shows flat stretches |
| Continuity | Cross-scene checks: colour drift, loudness drift, a speaker's name card used consistently, repeated B-roll |
| Silence and filler | Per-speaker thresholds from that speaker's own pause distribution, so a slow speaker isn't over-cut |
| Chapters | From the story tree; written to the container and a YouTube-ready list |
| Work in stages | Rough cut, then review, then fine cut, with the person's notes per scene |
| Overnight | Jobs resume after sleep; "Best" mode runs when the machine is idle and on power |
| Handoff | OTIO and FCPXML at any stage |

**As built in ED12** (client `src/edit/recipes/youtube.js`, recipe `youtube-longform`, no
model call): scenes from the story tree; best takes, fillers and long pauses out; over the
length asked for, each scene keeps its share and its opener. Pace: the picture changes at
least every 12 s (6 s in the first scene, 9.6 s in the last), by the cuts themselves and a
1.12 punch-in on every other stretch of a long run; one B-roll clip on each later scene's
second line when B-roll is given. Chapters: one per scene at its first played word, as
markers; the first at 00:00 named Intro; at least three, each 10 s or more, none named
like the one before, else none and a note. Captions go out as SRT, not burned. The last
20 s are reported as the end-screen slot. Other tracks (music, effects) stay as they were.
Not built: chapters written into the MP4 container, per-speaker pause thresholds, the
cross-scene continuity checks, rough-then-fine stages, a model naming chapters (titles are
the scene's distinctive words; "Intro" for the first).

## 11. Sound design

| Moment | Rule |
| --- | --- |
| Transitions | A soft whoosh only when motion is fast (velocity from the plan, the brief's "velocity-peak sonification") |
| Text and cards | Soft ticks, on the frame they land |
| Punchlines | Air after the line; the reaction sound lands on or after, never before |
| Bindings | "At 12.40", "when I say fifty thousand", "on the logo spin": all become `peak_at` anchors |
| Density | Three levels: restrained, standard, rich, by recipe |
| Levels | SFX levelled against this speaker's measured voice, not a fixed number (from ghost-editor) |
| Rule of restraint | No effect within a set distance of another; music rests under important lines when the recipe says so |

## 12. Motion and graphics

The compiler instantiates **blocks**: small HyperFrames compositions with typed
variables, written by Kriya with WAAPI and CSS (EDD-09).

| Family | Examples |
| --- | --- |
| Lower thirds | Name and role, in the look's style |
| Cards | Quote, stat, list item, polaroid drop, notification |
| Titles | Chapter card, opening title, end card, CTA |
| Data | Odometer, bars, line, from real numbers |
| Screen | Zoom-to-click, callout, highlight, cursor glow |
| Transitions | Whip, zoom, match cut helper; `xfade` for plain ones |
| 3D | Device mockup, logo spin: WebGL via three.js r186 |
| Math | Manim scenes rendered to a tile, in the optional pack |

Springs and curves are computed by Kriya's own code into WAAPI keyframes, so one
definition drives the live preview and the render.

## 13. Delivery packs

One project, many outputs. A pack names variants; the compiler re-solves layout
per format, instead of cropping the finished video.

| Pack | Outputs |
| --- | --- |
| Social vertical | Reels, Shorts, TikTok with each platform's safe zones and loudness |
| YouTube | Master, chapters, end-screen timing, thumbnail candidates, description draft |
| Ad variants | 6, 15 and 30 s; 9:16, 1:1, 16:9 |
| Podcast | Video, audio-only, clips, transcript |
| Handoff | OTIO, FCPXML, stems, SRT, overlays |

Thumbnails: candidate frames by face, expression, sharpness and composition, with
title text from a look. Platform specs change, so the tables are data, reviewed
at each runtime release (OPERATIONS_RUNBOOK §5).
