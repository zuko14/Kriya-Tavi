# Visual scenes (track E, phases EV1–EV4)

The Director reads what the speaker says and proposes animated explainer scenes that
take over the frame while the voice keeps playing. The owner approved this design on
2026-11-09 (EDD-51…EDD-55). This file is the spec; `status.md` holds the results.

## 1. Why it exists

A talking-head edit with captions isn't an explainer. A science video shows the idea
while the speaker explains it. Before this work the plan was told "no stock footage or
generated video", the renderer could only draw captions and three text blocks, and
`customComposition` had no caller.

## 2. Build order

| Phase | What | Needs |
| --- | --- | --- |
| **EV1** | Beat detection, cutaway placement, Kriya's ready-made scenes, Plan Card with swap | `editing.visuals` |
| EV2 | Model-written canvas scenes on the `balanced` tier; styles adapted from Lemo-Opuscar | `editing.customMotion`, a chosen `routing.balanced` model, a paid test budget |
| EV3 | Internet media (Wikimedia Commons, NASA, Openverse) through a Kriya server route; credits file | `editing.mediaSearch` |
| EV4 | Scene editing in the Studio, speaker in a corner or cut out over a scene, Tavi | EV1 to EV3 |

Generated video and synthetic people stay off (EDD-24, EDD-54).

## 3. EV1 design

```text
Plan pressed
  → proposeScenes (one model slot, typed JSON, checked by code; code's own beats if no model)
  → settings.scenes on the plan
  → Plan Card: each scene with a live preview, swap its kind, or keep the speaker
  → Approve: brief.scenes
  → planReel: scene clips (add_motion, block "scene") anchored to the spoken words
  → render, gates
```

### 3.1 The scene

A scene is the block `scene`, version 1: a tile with an opaque background, drawn by
`src/edit/engine/scenes.js` from typed variables. **No model writes code here.** Web
Animations only, so it seeks and renders like every other tile: no canvas clock, no
GSAP, no network, no randomness (a seeded hash spreads the particles).

| Kind | Items | Use |
| --- | --- | --- |
| `process` | 2 to 5 | Steps in order |
| `cycle` | 3 to 5 | Something that repeats |
| `hub` | 3 to 6, the first in the centre | A term and its parts |
| `flow` | 2 or 3 | Something moving from one place to another; `mode` is `flows`, `blocked` or `floods` |
| `compare` | 2 | Two things side by side, bars when both have numbers |
| `stat` | 1 with a value | One spoken number |
| `bars` | 2 to 6 with values | Spoken numbers against each other |

Themes: `lab`, `blueprint`, `chalk`, `paper`. Each theme's text and plate colours hold
WCAG 4.5:1, tested.

### 3.2 What code decides

- **Words on screen come from the speaker.** A label's words must appear in the
  transcript; a number must be said in or next to the scene's own lines. A scene that
  fails is dropped, never rewritten. This is `groundProblems`, run at plan time and
  again at make.
- **Placement.** A scene spans whole sentences, so caption pages are wholly in or out
  of it. Never in the first 2 seconds of the story or over a cold open; at least 1.5 s
  between scenes; at most 65% of the cut.
- **Reveals land on the word.** Each label appears when its word is spoken, computed
  from the solved timeline.
- **Layout.** The scene's content box is the frame minus the safe zones and the caption
  row. Captions inside a scene sit on that row, on top of it.

### 3.3 Changes to existing checks

| Check | Change, only for a tile whose block is `scene` |
| --- | --- |
| QG-08 | `on_face` doesn't apply while a scene covers the frame: the face isn't visible |
| QG-09 | A scene's text has an opaque plate, so its contrast doesn't depend on the video |
| QG-10 | Reads the scene when every label is in; compares words as a set, since a diagram has no reading order |
| Second make | Removes the last make's scenes, as it does captions |

### 3.4 Switches and off-behaviour

`editing.visuals` (server, off) and `KRIYA_EDIT` (client). A client asks
`GET /editing/features`; any failure, including a server that has no such route, means
off. Off: no extra model call, the same plan prompt, `brief.scenes` dropped at the make
route. Test: ET-VS-REG-01.

## 4. Limits of EV1, plainly

- Code can't tell if a diagram is scientifically right. It can only hold words to what
  was said. The person watches a scene before posting it, above all on health topics.
- `codeBeats`, used when no model answers, reads English patterns only.
- Scene reveals are computed at make; a later hand edit inside a scene keeps the old
  reveal times, clamped to the scene.
- The Studio's preview monitor doesn't draw scenes, as with captions: the Plan Card's
  preview and the final cut in Finish do.

## 5. Lemo-Opuscar (EV2, recorded now)

Pinned at commit `143f387ad774525dc9abc0ff05fb5f4bfbaa5f02`. MIT for code and docs; demo
films CC BY 4.0; six voice tracks and third-party assets excluded. Taken: the `render(t)`
idea and selected styles, rewritten as `kriya-*` and credited. **Refused:** the plugin as
an install, its `setup.sh`, its voice and music tools, and `DIRECTOR.md` §13, whose map
rules would put China's claimed borders into a product used in India (EDD-53). Kriya's
maps have no borders at all.
