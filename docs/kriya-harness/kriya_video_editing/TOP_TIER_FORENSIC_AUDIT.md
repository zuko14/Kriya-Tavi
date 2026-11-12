# Forensic audit of the top-tier plan (track E, phases TP1–TP12)

Every way the designs in [ASSEMBLY_AND_INTENT.md](ASSEMBLY_AND_INTENT.md) and
[CRAFT_UPGRADE.md](CRAFT_UPGRADE.md) could have broken something that works today, the
evidence in the code, and the guard now written into the design. It continues
[FORENSIC_AUDIT.md](FORENSIC_AUDIT.md), whose ids end at EH-53.

**Read this before any `TP` phase.** The owner's condition for the whole plan
(2026-11-10): the changes must cause no bug and damage no existing workflow.

## 1. How this was done, and its limits

- The first draft of the designs was checked, design by design, against the client at
  `5720384` (0.2.5) and Kriya at `5710890`, by reading the code each design would
  touch and the dated entries in `status.md` for faults already met in use.
- It found **23 hazards and 3 suspicions**. Five would have damaged existing projects or workflows the
  moment the code ran (§2). The designs were corrected in the same session; each row
  names where.
- **Nothing was run.** This is a reading audit. It can't find a fault that only shows
  when code executes, which is why §6 gives every phase a preflight and §5 a
  regression test for every existing workflow. Three items are suspected, not proven,
  and are marked so.
- A hazard not listed here isn't thereby safe. An agent who finds one stops, adds a row
  and asks (CHANGE_IMPACT §9).

## 2. Would have broken existing projects or workflows

| Id | The first draft said | Evidence | What would have happened | Guard, and where |
| --- | --- | --- | --- | --- |
| EH-54 | Give every asset a stored number `n`, added to older projects on read | Each history entry stores `hash: hashProject(result.project)`; `replay` reports any version whose hash no longer matches (`core/history.js`). `add_asset`'s fields are the asset shape itself (`core/ops.js`) | Every stored version of **every existing project** would fail its hash, and old `add_asset` entries would no longer replay | The number is computed from position and never stored; the schema stays 1; only optional fields and new operations are added. ASSEMBLY §2. ET-TP-REG-02 |
| EH-56 | A picture effect named `fit` | `fit` is already the music effect: `AUDIO_EFFECTS` (`core/plan.js`), `fitted(clip)` (`core/solver.js`), `RENDERED` (`core/mix.js`) | A framed picture clip would be treated as fitted music by the solver and the mix | The effect is named `frame`. ASSEMBLY §3, §6.2. ET-ASM-18 |
| EH-57 | Refuse `stabilize` at the operation, since the render can't draw it | `projectAt` rebuilds a version by replaying its operations and throws "no longer replays" when one is refused (`core/history.js`) | A project whose history holds a `stabilize` would stop opening at that version | **No existing operation is ever made stricter or given a new meaning.** Draw it, or skip it at render with a note. CRAFT §3.1. ET-TP-REG-02, the operation table's golden test |
| EH-58 | New Director slots `assembly` and `intent` on the make path | `replayAsk` answers each task from the recording, in order, and throws on a task the recording lacks (`loop/replay.js`) | `kriya edit replay` of any job recorded before the change would stop at the first new slot | A slot is asked only when the make's own brief calls for it; a single take asks `story` once, with today's prompt. ASSEMBLY §6.1. ET-TP-REG-03 |
| EH-63 | The make reads the storyboard stored on the project | `make()` is called by the Studio, by Tavi (`host/tavi.js`), by watch folders, by the command line and by the bench | A Tavi job would make a different film from the exact call its person approved (rule 12); Bench-M's results would move | An assembly is followed only from that make's own brief. ASSEMBLY §3. ET-TP-REG-04 |

## 3. Would have caused a bug in the new work

| Id | Hazard | Evidence | Guard, and where |
| --- | --- | --- | --- |
| EH-55 | An older client opens a project a newer one has labelled or storyboarded | `checkShape` refuses any unknown field ("is not a field here"); an unknown operation fails replay | It is refused whole, never partly read: that is today's rule (`parseProject`). The message is poor and is accepted as it is; changing the schema number instead would trip EH-54. ET-ASM-08 pins the behaviour |
| EH-59 | A default written into every compiled plan (`frame: "fill"`, an empty effects list) | Segments are cached by what produced them; ET-CMP-01 holds a golden plan; a replay compares `planHash` | A default is the **absence** of a key. Today's cuts compile to today's plan with every switch on. ET-TP-REG-01 |
| EH-60 | Cutaways the assembly places are placed again on every remake | A remake deletes the picture, caption and music tracks and the plan's own scenes and graphics (`recipes/reel.js`); B-roll sits on another track. Captions showed twice for this reason on 2026-11-09 | Clips a make places carry `plan: true` and are removed before placing again. ASSEMBLY §6.1. ET-ASM-23 |
| EH-61 | A carried edit lands on the wrong half of a split file | `remapIds` matches footage "by track and shared source" (`director/continuity.js`); one file can now be two parts | Match by overlap of source stretches. ASSEMBLY §6.4. ET-ASM-24 |
| EH-62 | The old order is put back on a new cut | `carryEdits` replays the person's edits since the last make | `set_assembly` and `describe_asset` are never in `replayable`. ASSEMBLY §6.4. ET-ASM-25 |
| EH-64 | A second model call for every message | The Governor shares one rate with the person's live chat (EH-13, EH-14); calls are paid from their allowance | Intent fields ride in the plan or console call that already happens. ASSEMBLY §7.1. ET-NL-09 |
| EH-65 | Escalating to a tier the person's plan doesn't allow | 2026-11-03: every turn failed with 400 `tier_not_allowed` | Only a tier the server lists; a refused or failed escalation keeps the `budget` answer. CRAFT §6.4. ET-DL-08 |
| EH-66 | Joining cached pieces for sound, or for a master | Loudness is mastered over the whole file (QG-06); a master is one encode (ET-TR-M2) and its receipt says so | Partial re-render is for a draft's picture only. CRAFT §2.2. ET-PV-04 |
| EH-67 | Dragging clips on the timeline | Its one pointer gesture today is scrub: press and move anywhere (`studio/src/timeline.js`) | Trim by an edge handle only; reorder lives on the storyboard. CRAFT §2.4. ET-PV-06 |
| EH-68 | Fonts as a new section of the runtime manifest; tiles that can't read them | Every client in use reads the same manifest through `checkManifest`; a tile's policy is `font-src 'self' data:` and Chrome runs in an OS sandbox | Fonts ship as a pack; the previous client must install from the new manifest; a font is proven to load inside the sandbox first. CRAFT §5.1. ET-TY-REG-02 |
| EH-69 | A remake silently restyles a film made before | A font changes every text measure, so every box, line break and gate result | The type kit is stored on the project when chosen; older projects keep the system stacks. CRAFT §5.1. ET-TY-REG-01 |
| EH-70 | A new blocking gate fails good films | QG-15's frame match has no measured threshold (EQ-22) | A note until TPX-04 and its seeded run pass; assembly makes only. ASSEMBLY §6.3 |
| EH-71 | A file name or label licenses words on screen, or steers the model | Graphics may show "the speaker's or the person's own" words; file names arrive from outside | Cleaned, marked as data, matched by code, and never counted as the person's typed words. ASSEMBLY §2. ET-ASM-04 |
| EH-72 | Music beds and sound effects get clip numbers and storyboard cards | A make writes them into the project as assets Kriya owns (`host/projects.js`) | Handles skip what Kriya wrote and references. ASSEMBLY §2. ET-ASM-02 |
| EH-73 | Reading a reference in depth inside a plan or a make | Today's analysis runs when asked and is cached by fingerprint | A job with progress and cancel, bounded samples, a new cache name. CRAFT §4.1. ET-RF2-08 |
| EH-74 | The watch loop adds render rounds, or swaps a passing cut for a failing one | A real take already rendered in 437 to 1,245 s; the loop's rule is never to keep a worse attempt | Inside the make's existing rounds; a passing cut is never replaced by one that doesn't pass. CRAFT §6.4. ET-DL-03 |
| EH-75 | The storyboard changes the Studio for people who have it off; the microphone is asked for where the page can't | The Studio's headers and CSP are fixed in `host/server.js`; ET-UI checks hold 44 px and no sideways scroll at 360 px | Off, the page has the elements it has today. Hold to talk appears only after TP4's preflight shows the page may ask. ASSEMBLY §7.4, §10. ET-ASM-REG-01 |
| EH-76 | Conforming fails a make on a computer missing a filter | One FFmpeg build had no `drawtext`; the Colour pack needs `lut3d` | Conforming degrades with a note and never fails a make. ASSEMBLY §6.2. ET-ASM-20 |

## 4. Suspected, not proven: settle in a preflight

| Id | Suspicion | Why | Settled by |
| --- | --- | --- | --- |
| EH-60a | Today's own B-roll (`brief.broll === "own"`) may already be placed twice by a second make | The remake's delete list (`recipes/reel.js`) names base, caption and music tracks and the plan's scenes and graphics; B-roll clips are none of these. Not run | **Settled 2026-11-11 (TP2's preflight, run): real, but not as suspected.** The old B-roll never played twice: it was anchored to clips of the old cut, so the solver dropped it (`anchor_removed`). It stayed in the project and piled up: 5 B-roll, 9 cut sounds and 5 angle punches more with every make, each raising an issue. Fixed first, as its own change: `remadeClips` in `recipes/reel.js` takes out what hung on a deleted clip, never a person's clip. Test ET-ASM-23 / EH-60a |
| EH-77 | Bin search by spoken words misses a word the person corrected | `status.md`, 2026-11-09: "Corrections don't update the transcript search index (`words_fts`)" | TP1's preflight; if so, search reads corrections too or the limit is shown |
| EH-75 (preflight) | May the Studio's page ask for the microphone, and does a dictation take the recogniser's slot? | The Studio's headers (`host/server.js`) set no Permissions-Policy, and it is served on 127.0.0.1, a secure context | **Settled 2026-11-11 (TP4's preflight):** the page may ask; no header changed. A dictation acquires the scheduler's `gpu` slot, the one the words layer holds, so it waits behind an index job. On this test machine macOS gives the test process no microphone (Chrome's `getUserMedia` never answers, Google Chrome and chrome-headless-shell alike), so the browser test stands a WebAudio tone in for the microphone's stream |
| EH-78 | A still image as a spine part may not render | The operations accept `image` on the main picture (`SEQUENCED`); no render of one is recorded | **Settled 2026-11-11 (TP2's preflight, run): it fails.** A PNG kept for 3 s after a 2 s clip rendered 61 picture frames in a 5 s file, draft and master: one frame, not three seconds. The Host also brings a PNG in as kind `video` with no length. So stills stay out of TP2: a file with no length can't be a part of the film's order (`assemblyProblems` says "can only be heard"), and nothing was changed to draw one |

### 4.1 Found while building TP2 (2026-11-11), by running

Existing behaviour, none of it caused by TP2. Only EH-60a was in TP2's brief to fix; the rest are written down for the owner to decide, since fixing them alters an existing recipe or the Engine (rule 1).

| Id | Found | Evidence | State |
| --- | --- | --- | --- |
| EH-60b | A single take's word-anchored title cards and emphasis punch-ins are placed again by every remake, and these do play | Made three times with `titles: true` and one emphasis word: 1, 2, then 3 title blocks and zooms, all solved onto the timeline. Nothing tells a plan's title from one the person added in chat, so the remake can't remove them without a mark like a plan graphic's | **Not fixed.** Needs a mark on what a make places (an optional field on existing operations), which is the owner's to approve |
| EH-79 | `broll: "own"` refuses the whole reel when another clip in the bin is between 1 and 2.5 s long | `recipes/reel.js` takes B-roll from any other video over 1 s, then asks for 2.5 s of it: "The reel was refused: that range runs past the end of asset" | **Not fixed.** A one-line cap; it changes an existing recipe |
| EH-80 | The Engine shows an overlay (B-roll, and so TP2's `over` parts) one frame after its start, and holds its last frame one frame | Barcoded cutaway planned at frame 208: the film shows the talk at 208, the cutaway's second frame at 209, its last frame twice. Same with and without the `frame` effect | **Not fixed.** In `core/ffmpeg.js`'s overlay timing, shared with every B-roll today |
| EH-81 | A plan's hash differs between two projects that hold the same file and make the same cut | Two plain projects, same bytes, same brief: different `planHash`, identical clips. So a plan hash compares runs of one project only | Not a fault; ET-TP-REG-04 compares the cut itself |
| EH-83 | QG-05 reads a bed's hi-hat within 20 ms of a cut as a pop, at any level | Found building TP10 (2026-11-11), by running: a code-made bed with off-beat hats under a cut 13 ms from one failed QG-05 ("pop", click ratio 10.8 to 12.8 with the hat at 0.06 to 0.15, no accent, no J or L cut). The pop check is the largest sample jump over the mean slope in 40 ms around the cut, so it doesn't scale with level; only `clickMin` (0.05) does. The beds from before TP10 have hats too (`upbeat` at 0.12); they pass where their off-beats miss the cuts | **Not fixed.** Tuning a gate is EG-4's rule and the owner's; TP10's arranged beds pass QG-05 in its exit test because the accent on each join raises the local slope |
| EH-84 | The code-made whoosh says its peak is 22 ms after its loudest moment | Found building TP10 (ET-SD-01, read back from the file): whoosh −22 ms, riser −12, pop −7, hit −2. `add_sfx` lands the stated peak on the cut, so a whoosh's loudest moment is 22 ms early | **Not fixed** (the four sounds from before TP10 stay as they were, rule 1). TP10's sixteen and its accents measure their own peaks |
| EH-82 | TP1's storyboard stored "Fill the frame" as no choice at all | `fitPart` removed the key for fill. TP2's automatic rule (same shape fills, a face is followed, else blur) would then have blurred a clip the person set to fill | **Fixed in TP2:** the card's menu gains Automatic (the absence of the key); Fill is stored like Fit and Blur |
| EH-85 | A person's own PNG enters the bin as `video`, never `image` | Found building TP7 (2026-11-11): `kindOf` in `host/projects.js` is `width ? "video" : …`, so only found pictures are `image`. A logo picked from the bin is a 1-frame "video", and a draft would read its proxy, losing the transparency | **Worked round in TP7, not changed:** a logo may be either kind of picture, and the bug always reads the source file (`engine/index.js`). The classification itself is left as it is (rule 1) |
| EH-86 | Chrome reports a glyph no font has as drawn by the first font of the stack, not by LastResort | Found building TP7's glyph check: U+FDD1 and the Kawi letter U+11F04 in a caption are drawn as Inter's empty box and DevTools names "Inter" | **Fixed in TP7's own check, before use:** each cluster is also drawn on a canvas and compared with U+FDD0's box (SPIKES §7) |
| EH-87 | QG-10's `normalise` replaced combining marks with spaces | Devanagari's vowel signs are marks, so "कुछ" compared as "क छ" and a misread sign passed unseen | **Changed in TP7:** marks stay with their letter (`gates/copy.js`). Latin text after NFKC has no free marks, so its readings are as before; the change matters only to tiles TP7 reads in Devanagari |

| EH-88 | Two caption pages with the same words and the same look are drawn once: the second never shows | Found building TP6's Kriya-made references (2026-11-11), by running: every shot captioned "Start small keep going" in one look, three tiles in the plan at 0.5, 4.5 and 8.5 s, and only the first on the rendered film. With different words on every page all of them show | **Not fixed** (the Engine's tile drawing, shared with every caption today; rule 1). TP6's fixture gives every page its own words. A person who says the same two words twice in one look would lose the second caption: the owner's to schedule |
| EH-89 | `describe` has no words for `apply_lut`, so a make that places one lists it as "apply_lut" | Found in TP6's exit run: ten lines of "apply_lut" in What I did | **Worked round in TP6:** a make's own LUT is said once, in words, by the note that placed it, and left out of the list (`host/projects.js`). `describe` is unchanged |
| EH-90 | The montage's scenes slot (`director/beats.js`) asks `balanced` first whatever the plan lists, and on a refusal asks `budget` | Found reading the code for TP8's EH-65 rule (2026-11-11). On a plan without `balanced`, a make with scenes sends one request Kriya answers 400 `tier_not_allowed` before the budget call; the make still finishes | **Not changed** (an existing slot; rule 1). TP8's escalation never does this: `createAsk` sends `balanced` only when `GET /models` lists it (ET-DL-08). The owner's to schedule |
| EH-91 | A nearly still picture (bars with fine noise) passes QG-07 as a source and fails it as a draft: the draft's lossy encode wipes the noise and `freezedetect` sees a freeze | Found building TP8's media fixture (2026-11-11), by running: noise 4 on bars read 0.10 mean difference and no freeze; after a CRF 30 re-encode 0.0006 and one freeze. A small moving square read 0.036 and no freeze either way | **Not changed** (the gate is right that the draft is frozen). TP8's fixture moves a square inside the crop. It showed EH-74's guard working: the first run's fix round scored 67.6 → 100 and was dropped because the fixed draft failed QG-07 |
| EH-92 | An approved plan's motion kit 2 graphics (TP7: list, count, card, call to action, handle, frame, a callout with no drawn box) are dropped by the make and refused by the Plan Card's preview | Found building TP9 (2026-11-12), by reading and at the function: the make route keeps them with `editing.typeKit` on (`host/server.js`), but `graphicOps` (`recipes/graphic-clips.js`) and `graphicPreview` (`host/projects.js`) clean each with the default MG1 table, and `cleanGraphic({ kind: "list", … })` and `cleanGraphic({ kind: "count", … })` there return `null`. Not run end to end | **Fixed in TP11 (2026-11-12, owner-approved in chat).** The make route stays the switch's gate (kit 2 with `editing.typeKit` on; a drawn callout with `editing.customMotion` on); `graphicOps` places what passed it with the full kit table, keeping `steps`, `stepAt`, `point`, `corner`; `graphicPreview` takes kit 2 with `editing.typeKit` on and shows each in its region's box; the Plan Card's choices list kit 2's kinds and styles then. Off, unchanged. Proven: `tests/edit-eh92.test.js`; `tests/edit/media/type-kit.test.js` "EH-92" (a master with a count and a list, QG-08, -09, -10 passed) and "EH-92 (UI)" (both previews on the Plan Card, 360 and 1280 px, light and dark) |

## 5. Every existing workflow, and what proves it is untouched

A `TP` phase isn't complete until each row it could reach is green, **with every `TP`
switch on as well as off**: off proves the switch works, on proves the old path
survived the new code.

| Workflow today | Could be reached by | Proof |
| --- | --- | --- |
| Opening any existing project; every version's hash | TP1, TP2, TP5 | ET-TP-REG-02: recorded pre-TP projects and logs replay to the same hashes |
| A one-file make (reel, short from long, tutorial, YouTube) | TP2, TP4, TP5, TP8 | ET-TP-REG-01: the golden plan (ET-CMP-01) and the recipe tests unchanged; ET-RCP-02 |
| `kriya edit replay` of an older job | TP2, TP4, TP8 | ET-TP-REG-03 |
| Tavi jobs, watch folders, `kriya edit run` | TP2 | ET-TP-REG-04; ET-TV-*, ET-RV-* |
| Podcast with two cameras; montage on a song | TP2 | ET-DR-M1, ET-DR-M2 |
| A change after a make keeps the cut and the person's edits | TP2, TP3 | ET-REV-M1, ET-REV-UI |
| Captions, scenes, graphics, transitions as drawn today | TP3, TP5, TP7 | ET-VS-*, ET-MG-*, ET-TR-*; ET-TY-REG-01 |
| The 14 gates and their seeded defects | TP2, TP5, TP6 | ET-QG-*; EG-4's 10 of 10 with no false alarm |
| `kriya edit setup` and `doctor` on a client already installed | TP7 | ET-TY-REG-02; ET-RT-01…04 |
| The Studio's screens at 360 and 1280 px | TP1, TP3, TP4 | ET-UI-*, ET-MG-UI, ET-REV-UI, the browser check |
| The person's live chat while an edit runs | TP4, TP8 | ET-GOV-01; ET-NL-09 |
| Bench-M | all | 5 of 5, unchanged |
| Kriya with every `editing.*` switch off | all | ET-REG-01; the readiness test |
| The coding harness | all | Nothing under `src/edit/` loads outside it except lazily (rule 15); `npm run check` |

## 6. Standing rules for every `TP` phase

These are the lessons of §2 and §3 as rules. Breaking one is a stop condition.

1. **Add, never alter.** New operations, new optional fields, new effect names. No
   existing operation, field, effect name, schema number, prompt, schema object or
   task name changes its shape or its meaning.
2. **Nothing is written onto a project when it is opened.**
3. **A default is the absence of a key**, in the project and in the compiled plan.
4. **A new step runs only when the make's own brief asks for it.** Stored state on a
   project never changes what a job from elsewhere makes.
5. **No extra model call on a path that exists today.** A new call needs the Governor
   and a count in the test.
6. **Anything a make places, the next make can find and remove.**
7. **A missing filter, font, pack or tier degrades with a note; it never fails a make
   that would have passed.**
8. **A new gate starts as a note** and blocks only after its seeded run: 10 of 10
   caught, none of 10 clean films flagged.
9. **Preflight before code.** Each phase first runs, on today's `main`, the tests of §5
   for the rows it can reach and records the counts; it runs them again at the end.
   A row that was green and is now red is the phase's to fix before anything else.
10. **One phase, one branch, hot files held on the board** (TOP_TIER_PLAN §2).

## 7. Checked and found safe

| Checked | Result |
| --- | --- |
| A new name in the features answer | Safe for clients in use: `fetchFeatures` reads named booleans and treats anything else as off (`runtime/fetch.js`) |
| The whole features route with `editing.studio` off | Answers 404, so every new switch is off with it (`features/route.ts`) |
| Tiles in a frame over the monitor | The Plan Card already plays previews in sandboxed frames under the Studio's `frame-src 'self'`; frame rate is TPX-01's question |
| Operations from the Studio's own controls | Committed as `author: "person"` (`host/server.js`), so a label can be the person's alone |
| Audio and image files on the main picture | The operations accept them (`SEQUENCED`); rendering a still is EH-78 |
| The server | No table, migration, agent tool, policy row or worker change in TP1…TP10; `lib/agent/*`, metering and connectors are not touched |
