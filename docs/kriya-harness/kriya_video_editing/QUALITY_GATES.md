# Quality gates (track E)

Nothing reaches the person as "done" on the strength of a model's opinion. The
brief's 4 gates are kept and extended to 14, because most editing defects are
measurable if you measure the output instead of the plan.

## 1. Rules

1. **Gates read the rendered file**, not the project. A correct plan can still render wrong.
2. **Verdicts are code.** Model text is never evidence (track-A rule 7, track N rule 3).
3. **Every gate reports numbers**, its threshold and where in the timeline it failed.
4. **Thresholds are data** in the recipe and deliverable, not constants in code.
5. **A gate that couldn't run is `not checked`**, never `passed`.

## 2. The gates

| Id | Gate | Measures | Fails when (default) | Severity |
| --- | --- | --- | --- | --- |
| QG-01 | Playable and to spec | `ffprobe` against the deliverable; ffmpeg-skill `check.py` per platform | Wrong codec, size, fps, colour tags, or a decode error on a full read | Block |
| QG-02 | Length | Frame and audio counts against the plan | Off by more than 1 frame; audio and video lengths differ by more than 1 frame | Block |
| QG-03 | Sync | Video and audio timestamps across the file; speech onsets against the lip activity of a sampled face | Drift over 40 ms | Block |
| QG-04 | Round-trip speech | Transcribe the output's dialogue, align to the words the project says it keeps | A kept word missing; a removed word audible; order wrong | Block |
| QG-05 | Cut hygiene | At each cut: **source audio energy at the cut point**, click detection, shot length | A pop; a shot under 3 frames unless intended; a cut in voiced speech | Block |
| QG-06 | Loudness | Integrated, true peak, range; dialogue-to-music ratio per section; SFX against voice | Off target by more than 0.5 LU; peak over the ceiling; music masks speech | Block |
| QG-07 | Picture health | Black frames, frozen frames, duplicates, exposure jumps between matched shots, banding on gradients | An unplanned black or frozen span; exposure jump above the recipe's limit | Block or note |
| QG-08 | Layout | Rendered boxes from the DOM at each beat, face boxes on the output, platform safe zones | Text on a face; overlap; outside safe zones; clipped text | Block |
| QG-09 | Legibility | Contrast on real composited pixels behind each text box; size against frame height; reading speed | Contrast under 4.5:1; text too small; words per second over the script's limit | Block |
| QG-10 | Copy | OCR of rendered text against intended text; proper nouns against what was said | A mismatch; broken shaping in an Indic script | Block |
| QG-11 | Motion | Inter-frame change inside animation windows; overlay shows its first and last frames at the right times | A window with no motion; an overlay starting mid-animation | Block |
| QG-12 | Brief | Must-keep present, must-cut absent, asked-for assets used, length in tolerance, requested format | Any miss | Block |
| QG-13 | Rights | Every asset has a rights status | Unknown status on music or third-party footage | Note, shown clearly |
| QG-14 | Blind reviewer | A model sees only what a viewer gets, never the plan, and says what the video is about (EDIT_LOOP §7). Code compares that with the brief | Never fails by itself; it can only add a note | Note |

QG-04 and QG-05 together do what no contact sheet can, and EX-11 says which does what.

- **QG-04 listens to its own output** and compares it with the plan. It caught a removed word 9 times in 10, with no false alarm in 6 clean runs. It is **not** reliable for a clipped word: 1, 8, 3 and 6 of 10 at 20 to 200 ms, because ASR often hears the word anyway.
- **QG-05 checks the signal at each known cut**, so a clip is caught before anything renders: 38 of 38 at 5 to 50 ms into speech, with 0 of 38 false alarms on clean cuts. Synthetic speech is the easy case, so the threshold is set per recording from its own noise floor.

Gates by format: recipes switch off what doesn't apply. A silent montage has no
QG-04; an explainer with no faces has no face checks. A switched-off gate is
reported as `not applicable`.

## 3. What runs when

Gates run at the lowest rung of the fidelity ladder that can see the problem
(EDIT_LOOP §5), so most failures are found before anything is rendered.

| Moment | Gates |
| --- | --- |
| Live preview | Layout and reading speed from the plan: warnings only, instant |
| Draft render | QG-02, QG-05, QG-08, QG-09 on changed segments; QG-06 on the mix |
| Master | All, on the whole file |
| After a change | Only gates whose inputs changed; a master is always re-checked in full |

## 4. The repair ladder

A failure carries a class, and each class has a known fix. Most need no model.

| Rung | Who | Example |
| --- | --- | --- |
| 0 Deterministic fix | Code | Contrast low: add a scrim. Text on face: move to next-best slot. Pop: widen the crossfade. Loudness off: re-run the mix. Flash frame: remove it |
| 1 Re-solve | Code | Change a constraint and run the solver again: a looser pad, a shorter caption page, a different crop |
| 2 Bounded model | Director | Rewrite a caption that won't fit; choose another B-roll. One call, one slot |
| 3 Person | Studio | "This name may be wrong at 0:31." Shown, not hidden |

Rules, in the spirit of Loop v2:

- **At most 3 rounds.** Then deliver with notes, or block.
- **Never keep a worse attempt.** Each attempt gets a rank: count of blocking failures, then notes. A repair that scores worse is set aside and the better one is restored.
- **Never change a must-keep to pass a gate.** A fix that would cut required content goes to the person.
- **Never weaken a threshold.** Only the person can loosen one, per project, and the report says so.
- **Re-render only what the fix touched.**

## 5. Verdicts

| Verdict | Meaning | Shown as |
| --- | --- | --- |
| `delivered` | All applicable gates passed | "Checked" |
| `delivered_with_notes` | No blocking failure; notes exist, or a gate wasn't run | "Checked, with notes" |
| `blocked` | A blocking failure remains | "Needs you", with the exact spot |
| `not_checked` | Gates couldn't run | "Not checked" |

The person can always export anyway. The receipt records it. Model text never
changes a verdict.

From Tavi the verdict is labelled "Checked on your computer": Kriya's servers
can verify the preview's hash, not the measurements (TAVI_INTEGRATION §6).

## 6. The report

One screen, also written beside the export as `<name>.report.html`:

- A verdict and the deliverable's facts.
- Each gate with its numbers.
- Before and after contact sheets.
- A list of cuts and what was removed.
- Notes and rights statuses.
- Tokens and money, from the gateway's replies.

## 6a. As built in ED7

Client `src/edit/gates/`: QG-01, QG-02, QG-05, QG-06 and QG-12 read the rendered
file; every other gate reports `not_checked`. A recipe may set its own thresholds
(the reel's length is 30 to 60 s around 45). QG-05 checks words and the source's own
energy at each cut against its 10th-percentile floor, and pops in the output. QG-06
measures integrated loudness and true peak with `ebur128`; the Engine now masters
a render that names a deliverable with a loudness target: measure, gain, limit a
margin under the ceiling, measure again, up to three passes. QG-12 checks must-keep
and must-cut on the plan's words and the length on the file. Not built: the repair
ladder's rungs (§4); a failed gate ranks the attempt, and the loop tries the
recipe's next variant.

## 6b. As built in ED8

QG-08 and QG-09 (`src/edit/gates/text.js`) read what was drawn. Every text tile is
loaded in the runtime's Chrome, inside the same sandbox, and measured at each beat
(at rest after its entrance, each word, its last frame): box, text, font size,
colours, plate, overflow. **QG-08** fails text on a face (L8 faces mapped onto the
output; text behind the speaker is exempt), outside the frame, outside the
deliverable's safe zone, clipped, or overlapping other text at the same beat.
**QG-09** renders the frames behind each text at rest without the captions (cards
stay) and takes the worst 10 % of WCAG contrast over the box, the plate blended in;
it fails under 4.5:1, text under 2 % of the frame's height, or a page faster than
its script's reading limit (untuned defaults until EX-04's reader check). A plan
with no text reports both `not_applicable`. A stroke isn't credited. Seeded
defects in `tests/edit/media/motion.test.js`: yellow on white, a caption on a face,
a caption under the reel's bottom margin, each caught; a clear karaoke page passes.

## 6c. QG-06 as built in ED9

QG-06 now lists every failure, not the first: off target by more than 0.5 LU, true
peak over the ceiling, a loudness range over the recipe's limit (none by default;
the range is always reported), and, from the Engine's stems, **music masking
speech** (in each stretch of speech of a second or more, the dialogue stem's energy
mean over the music stem's, at least 8 LU) and **an effect over the voice** (an
effect's loudest 400 ms more than 3 LU over the voice's integrated loudness). Both
margins are untuned defaults. Without stems a mix with music or effects reports
`not_checked` after its loudness passes.

## 6d. As built in ED10

All fourteen gates run on every make (`src/edit/gates/`); one that has nothing to
check says `not_applicable`, one whose tool isn't here says `not_checked`, which is a
note, never a pass.

| Gate | Reads | Built as | Not built |
| --- | --- | --- | --- |
| QG-03 | Stream timestamps | Start offset and end drift over 40 ms; AAC that lost its padding note has its 1024 priming samples added back (EG-4 found the gate reading 21 ms short) | Speech onsets against lip activity (needs a mouth track) |
| QG-04 | The verified recogniser on the output | LCS alignment of what was heard with the kept words; a kept word missing (not short or function words), a removed word audible, the wrong order | Runs only when the signed manifest ships the weights (EB-11); else `not_checked` |
| QG-07 | One FFmpeg pass | Black spans over 0.1 s and frozen spans over 1 s that the plan didn't ask for block; exposure jumps at cuts within one source are a note | Banding |
| QG-10 | Each tile at rest, read by Apple Vision (helper compiled once) | Every intended word on screen as itself, and similarity; a caption's names and numbers against what was said | Non-Latin scripts: `not_checked` (no reader here) |
| QG-11 | Each tile's alpha | A tile with no motion in its first second, or fewer frames than its window | The overlay's first frame against the output (ET-HR-04 covers it in tests) |
| QG-13 | The assets used | Unknown rights on music, effects or overlay footage: a note. A reference asset's picture or sound in the output: failed (ED13, EDD-23, ET-SEC-08) | — |
| QG-14 | The recogniser's words only | A model says what the video is about; code compares it with the brief's lines; a note at most | Frames (frame vision is off by default, EDD-14) |

**Repair ladder** (`src/edit/loop/repair.js`): rung 0, low contrast → a scrim; music
masking speech or an effect over the voice → `set_level` by what's missing plus 1 dB;
rung 1, layout failures → captions 15 % smaller and re-solved; everything else goes
to the person, listed in the notes. At most three rounds; an attempt is ranked by
blocking failures, brief misses, then notes; a worse one is set aside and recorded;
a fix that would cut a must-keep isn't rendered; thresholds are frozen when the gates
start. Rung 2 (a bounded model call) isn't built.

**Receipt and report** beside every make's export: `<name>.receipt.json` (output and
input sha256, tool versions, plan hash, every gate's numbers, verdict, tokens; money
"not reported by the gateway" unless it reports one) and `<name>.report.html` (one
self-contained page: verdict in words, gates, before and after contact sheets,
changes, repairs, notes, rights, model use). `kriya edit verify <file> [--receipt]`
matches identical bytes, or re-measures and lists each difference.
`kriya edit replay <job>` repeats a finished make with each Director slot answered
from the journal's `answers` table (no model call), lands nothing, and compares
verdict, plan hash and every gate.

**EG-4** (`tests/edit/media/seeded.test.js`, `seeded-text.test.js`): QG-01, -02, -03,
-05, -06, -07, -12 at 20 seeds and 20 clean each; QG-08, -09, -10, -11 at 10 and 10
(each is a real HyperFrames render): every seed caught at the right time, no false
alarm. Twenty clean cases can't show a rate under 2 %, only that none occurred.
QG-04 isn't measured: it needs the real recogniser (EB-11).

## 7. Testing the gates themselves

A gate that never fires is worthless, so gates have their own suite. The
**seeded-defect suite** (`ET-QG-*`) takes a clean fixture and injects one known
defect at a known place: a one-frame flash, a 1 ms click, a 200 ms offset, a
caption over a face, a misspelled name, a frozen overlay, a dropped word. It
asserts the right gate fires at the right time, and that the clean fixture
passes. Detection rate and false alarms are reported per gate. All fixtures are
synthetic, made by FFmpeg `lavfi` and text-to-audio from the repository, with no
real people or real sites.
