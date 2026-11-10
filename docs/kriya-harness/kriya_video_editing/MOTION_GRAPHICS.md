# Motion graphics (track E, phases MG1–MG2)

Titles, name straps, opening and end cards, quotes and numbers over the footage. The
owner approved this design in chat on 2026-11-10 (EDD-58). This file is the spec;
`status.md` holds the results.

## 1. Why it exists

Before this work the Director could reach three text blocks and the explainer scenes of
VISUAL_SCENES.md. A cut had no opening title, no name strap, no end card, and chat could
not add one. The owner's direction: the harness is the strength, not the model, so the
graphics are drawn by Kriya's code and a cheap model only chooses among them.

## 2. Build order

| Phase | What | Needs |
| --- | --- | --- |
| **MG1** | The motion kit: seven kinds drawn by code, a brand kit, the Director proposes them, chat adds them, Plan Card with preview, restyle and remove | `editing.motion` |
| MG2 | Animations a model writes, for a request no kit graphic covers (VISUAL_SCENES.md EV2, DIRECTOR_AND_AGENT §11) | `editing.customMotion`, a chosen `routing.balanced` or `routing.escalation` model (EB-06), a paid test budget (EB-07) |

## 3. MG1 design

```text
Plan pressed
  → planGraphics (one model slot, typed JSON, checked by code; none if no model answers)
  → settings.graphics on the plan
  → Plan Card: each graphic with a live preview; restyle, recolour or remove
  → Approve: brief.graphics
  → planReel: graphic clips (add_motion, block "graphic") anchored to their words
  → render, gates

Chat: "add a name strap: Ravi Kumar, Founder"
  → console answers add_graphic → code cleans it, checks its words, turns it into add_motion
  → proposal, accepted by the person
```

### 3.1 The graphic

A graphic is the block `graphic`, version 1, drawn by `src/edit/engine/graphics.js` from
typed variables. **No model writes code here.** Web Animations only: no clock, no
randomness, no network, so it seeks and renders like every other tile, and it passes the
same lint a model's code would have to pass (ET-MG-01).

| Kind | Styles | Lines | Use |
| --- | --- | --- | --- |
| `title` | rise, slam, words | 1 | A few strong words of the line being said |
| `chapter` | wipe | 1 | The name of a new part |
| `quote` | line | 1 | A sentence worth reading as well as hearing |
| `lower` | bar, pill | 2 | Who is speaking: name and role |
| `intro` | sweep | 2 | The video's title over its first seconds |
| `end` | sweep | 2 | The closing call to action over the last seconds |
| `stat` | pop | 2 | One number that was said, and what it counts |

Brand kit, one for the whole cut: an accent (teal, yellow, amber, pink, white), a plate
(dark, light) and a font (sans, serif, condensed, mono). Hex values and font stacks stay
in code; fonts are the system's, so nothing is downloaded. Ink on each plate and the
chip's ink on each accent hold WCAG 4.5:1 (ET-MG-02).

A graphic sits in the box the layout solver gives every overlay, clear of the speaker's
face, the safe zones and the captions, so QG-08 and QG-09 judge it as they judge a title.
Its words are `text` and `subtitle`, so QG-10 reads it with no change to the gates.

### 3.2 What code decides

- **Words on screen are the speaker's or the person's own.** Every word of a graphic must
  be in the transcript or in what the person typed; a number must be said near the
  graphic or typed by the person. One that fails is dropped, never rewritten
  (`graphicProblems`, at plan time and for chat). The model never supplies a title, a
  name, a handle or a claim.
- **Placement in time.** One opening title on the first word, one end card over the last
  seconds, one name strap. Never under an animated scene, a picture or a definition;
  never two at once; a second of rest between them. At most eight, fewer in a short cut.
- **Length.** Long enough to read, capped at 5 seconds; code sets it, not the model.
- **The person's words outrank the plan.** "No graphics" means none and no model call. A
  revision that doesn't mention graphics keeps the ones on the card; a colour or a font
  named in the request restyles them.
- **A remake replaces the plan's own graphics and keeps the person's.** A graphic an
  approved plan made carries `plan: true` and is rebuilt with the cut; one added in chat
  stays where it is.

### 3.3 Switches and off-behaviour

`editing.motion` (server, off) and `KRIYA_EDIT` (client). The client reads
`GET /editing/features`; a server that says nothing of `motion` means off. Off: no extra
model call, the same plan prompt, the same console schema object and prompt, the preview
route answers 404, and `brief.graphics` is dropped at the make route. Test:
ET-MG-REG-01, unit and on a real Host.

## 4. Limits of MG1, plainly

- A graphic lives in the caption-sized box of the layout solver (80% by 12% of the
  frame). A full-frame title card or a graphic placed by pointing at the frame needs a
  layout change and isn't built.
- Not built, though the first design named them: callouts (they need the person to point
  at the frame, an open ED6 item), a progress bar and a logo bug (both span the whole cut
  and belong in the compiler as FFmpeg overlays, not in a Chrome tile).
- `graphicsIn` and `brandIn` read English patterns; the grounding check follows
  VISUAL_SCENES §3.2's tokeniser.
- The Studio's preview monitor doesn't draw graphics, as with captions and scenes: the
  Plan Card's preview and the final cut in Finish do.
- The Director's choice of graphics has been run with a scripted model only (EB-07).

## 6. Transitions (MG1b, 2026-11-10)

Before this, the `transition` operation stored an effect that `core/ffmpeg.js` refused
("this render can't do transition yet"), so a clip that had one failed to render.

**The cut never moves.** A transition is how a clip arrives over the last frame of the
clip before it: that frame is held underneath while the incoming clip comes in over its
own first moments. No clip overlaps another, so the length, every cut point, the sound,
the captions and every word anchor are what they were (ET-TR-02, ET-TR-M1).

| Kind | FFmpeg `xfade` | What is seen |
| --- | --- | --- |
| `fade` | `fade` | The held frame dissolves into the clip |
| `dip` | `fadeblack` | Through black |
| `flash` | `fadewhite` | Through white |
| `wipe` | `wipeleft` | The clip is revealed across the frame |
| `slide` | `slideleft` | The clip pushes in from the side |
| `zoom` | `zoomin` | The clip zooms in from the held frame |

- The kinds are a fixed list in `core/transitions.js`. Code names the FFmpeg transition;
  a kind outside the list is refused by the operation and again by the builder.
- Length: 0.2 to 0.8 seconds, 0.3 by default, on whole frames, never more than half the
  incoming clip nor than the segment it starts in less two frames.
- The compiler puts it on the piece as `enter` (kind, length, the piece before as a held
  frame dressed as it was), in the one segment the piece starts in. It is part of that
  segment's cache key, so only that segment renders again (ET-TR-M3). A master draws it
  in its one encode (ET-TR-M2).
- QG-07 is told where a planned transition is: black inside one (a dip) and a brightness
  jump at a dressed cut aren't faults; anywhere else they still are (ET-TR-05).
- **The Director** may choose one kind for the cut; the person's words outrank it ("slide
  transitions", "no transitions"). The recipe puts it only where the story changes
  moment: out of a cold open, a line moved up, a jump of more than 3 seconds in the take,
  another clip. "On every cut" dresses them all. A filler cut stays a cut.
- **Chat** dresses one cut: `transition` with the clip the picture arrives in.
- Under `editing.motion`: off, the plan's schema and prompt are the objects they were and
  the console doesn't know the operation (ET-TR-REG-01). Rendering a stored transition is
  not behind the switch: refusing it was the bug.

Limits: a punch-in that is eased or focused and still on at the cut is left off the held
frame; the Studio's preview monitor doesn't draw transitions; the OTIO, FCPXML and EDL
handoff doesn't export them; a picture `fade` effect is still refused by the builder (no
operation can set one on footage today).

## 5. What is not taken from the internet

Nothing is searched for and downloaded as code. The licence gate
(SKILLS_AND_OPEN_SOURCE §2) applies per item and a downloaded composition would run on the
person's computer. A project is read by a person or an agent, checked against the gate,
and what is allowed is rewritten as a kit graphic and credited, as §5 of VISUAL_SCENES.md
does for Lemo-Opuscar.
