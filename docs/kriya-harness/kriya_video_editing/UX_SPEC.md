# UX spec (track E: Kriya Editing Studio)

The person drops footage, says what they want, watches, and changes it by asking.
Everything else is there when wanted. The aim is an editor a beginner can finish a
video in, and a professional won't outgrow.

## 1. Getting in

Harness sidebar: **Editing Studio** (`sidebar.panellist` row). Shown only with the
switch on and a server that allows it. Clicking it **replaces the whole window**:
the tab navigates to the Studio app. **Back to Kriya Harness** returns. A running
render continues, because the Edit Host owns it. `kriya edit` opens the same app
directly, and works without DSH running. It can be **installed as an app** with its
own window and icon (STUDIO_APP_AND_BROWSER §8).

## 2. Three modes, one window

| Mode | For | Shows |
| --- | --- | --- |
| **Direct** (default) | Everyone | Monitor, Kriya panel, transcript. You talk; it edits |
| **Edit** | Hands-on work | Full multi-track timeline, bin, trim tools |
| **Finish** | The last 10 % | Colour with scopes, mix with meters, export |

One switch at the top, remembered per person. The project is the same in all three.

## 3. Screens

| # | Screen | Purpose |
| --- | --- | --- |
| 1 | Setup | First run: what will be downloaded, how big, what it enables |
| 2 | Home | Recent projects, New project |
| 3 | New project | Drop, say, go |
| 4 | Workspace | The editor, in its three modes |
| 5 | Variations | Options playing side by side |
| 6 | Export | Deliverables, handoff, send to phone |
| 7 | Report | Gates, cuts, rights, cost |
| 8 | Looks and brand | Styles, brand kit |
| 9 | Taste | Confirmed rules |

### 3.1 Setup

"Editing Studio needs a few tools on this computer." A list with real sizes from the
manifest: Core, then packs (CAPABILITY_PACKS), each with what it enables and a line
from this machine's hardware: "This Mac: M3, 16 GB. Everything works. Cut-outs will
be slow." **Install** is the person's approval. Resumable.

### 3.2 New project

```text
+----------------------------------------------------------------+
| ← Kriya Harness                                                 |
|        What are we making?                                      |
|  +----------------------------------------------------------+  |
|  |  Drop footage, audio, images, a script, or a whole folder |  |
|  |          [ Add a folder ]      [ Choose files ]           |  |
|  +----------------------------------------------------------+  |
|  [ Reel ] [ Shorts from a long video ] [ YouTube ] [ Podcast ]  |
|  [ Tutorial ] [ Ad ] [ Montage ] [ Explainer ] [ More ]         |
|                                                                 |
|  Tell Kriya what you want, in your own words          🎙        |
|  [ Make a 45 second reel, keep the part about pricing...     ]  |
|  References: [ + clip or image ]    Fast ◉  Best ○   [ Start ]  |
+----------------------------------------------------------------+
```

A format card is optional: words alone are enough. **Add a folder** links files in
place with no copy, through the Studio's own folder browser, and is the right path
for big footage. **Dropped files** stream into the project's `media/` folder as a
copy, because a browser gives bytes and no path (EH-21).

### 3.3 Workspace, Direct mode

```text
+------------------------------------------------------------------------+
| ← Harness | Pricing reel ▾  Cut A ▾ | ↶ ↷ | Direct·Edit·Finish | Export |
+-----------------------------------------------+------------------------+
|                                               | Kriya                  |
|                                               |  ✓ Read your footage   |
|               Program monitor                 |  ✓ Chose the takes     |
|         safe zones · faces · phone · A/B      |  ● Adding captions     |
|                                               |  ○ Checking            |
|        ▶  00:12.40 / 00:44.80  Preview        |  What I did ▸          |
|                                               |  Check this: name 0:31 |
|                                               |  [ Ask for a change ]🎙 |
+-----------------------------------------------+------------------------+
| We built this in a week. ~~So, um,~~ here's what it cost. Fifty        |
| thousand rupees, in total. [take 3 of 3]  ...                          |
| ▮▮▮▮▮▮▮●▮▮▮▮▮▮▮▮▮▮▮▮▮▮  story strip                                    |
+------------------------------------------------------------------------+
```

Edit mode swaps the strip for the full timeline and opens the bin on the left.
The regions keep the brief's five panels: vault, reference hub, viewport, timeline,
console.

## 4. The signature interactions

These are what should make it feel like nothing else. Each is a real feature with a
test, not a flourish.

| Interaction | What it does | Why it matters |
| --- | --- | --- |
| **Proposal mode** | Kriya's changes arrive as ghost clips and dashed captions on the timeline; a compact list says what each is. Accept all, accept one, or reject | The person stays in charge, and trusts what they can see |
| **Variations wall** | Three cuts, hooks or looks play side by side in sync. Tap the one you like | Choosing is easier than describing. It uses the tournament's top results |
| **Talk to the frame** | Draw on the monitor, then say "blur this", "remove that", "follow her" | Words are bad at space. A drawing is a selection |
| **Say it** | Hold a key and speak a change. Local speech recognition; audio stays on the machine | Hands stay on the footage |
| **Semantic zoom** | Zooming the timeline moves through Story → Scenes → Shots → Frames, with text at the top and pixels at the bottom | A 2-hour film and a single frame in one control |
| **Text is the timeline** | Delete words to cut. Drag a sentence to move it | The fastest way to edit speech |
| **Attention ribbon** | A strip under the timeline shows pace, energy and flat stretches, from measured signals. Advisory only, and never a forecast of views | Editors feel this. Now it's visible |
| **Phone preview** | The cut inside a phone frame with a drawn platform interface | "Will my caption hide under the buttons?" |
| **Version graph** | Every cut as a branching history; jump to any point, compare any two | Fearless experiments |
| **Ask your footage** | "Where do I talk about pricing?" jumps there | The index is a search engine |
| **Two screens** | Program monitor on a second display, full-screen | How editors really work |

**Proposal mode is the default for changes the person didn't precisely ask for**
(a whole-edit "make it punchier"). An exact request ("punch in here") applies at
once, with undo.

## 5. Asking for a change

| Input | Meaning |
| --- | --- |
| Plain words | "make the captions bigger" |
| A selection | Becomes a chip: "this part". "Punch in here" needs no timecode |
| A drawing | Becomes a spatial chip |
| `@` | An asset: `@sub_drop.wav` |
| `#` | A time or a word: `#00:12.40` |
| A dropped file | Attached |

**What changed** lists each result in plain words, each with its own undo:
"Punched in at 'fifty thousand' · Added whoosh". This is the Director console, with
no chat session behind it, so one request is one small model call.

## 6. Finish mode

Colour: wheels, curves, the LUT strength, match-to-reference, and live scopes.
Sound: bus faders, a BS.1770 meter against the deliverable's target, ducking amount.
Both show the same gates the export will run.

## 7. Export

Choose deliverables (a pack or items). For each: size, length, format, what will be
checked. **Export** renders masters, runs all gates, then shows the Report. Handoff
tab: Premiere, Resolve, Final Cut, plain files. **Send to my phone** uploads a small
preview if the plan allows it, and opens the Review Room there.

## 8. Report

QUALITY_GATES §6, each failure clickable to its exact frame. Verdict words:
**Checked**, **Checked, with notes**, **Needs you**, **Not checked**. Cost: "This
edit used ₹x of your Kriya Harness limit."

## 9. Interaction rules

- **Nothing blocks.** Indexing, rendering and models run behind the UI.
- **No dead controls.** A feature whose pack isn't installed says what's needed, with one click. What isn't built isn't shown.
- **Honest progress.** Real steps and percentages; a time estimate only once measured on this machine.
- **Undo everything**, across model and manual edits.
- **Saves itself.** There is no Save button.
- **Never surprise.** Moved lines, removals and anything unsure appear in What I did or Check this.
- **Tell the truth about the preview.** "Preview" until a draft exists for that span.
- **The person always wins.** Their edit lands at once, and running agent work rebases around it (EDIT_LOOP §9).

## 10. Keyboard

Editors' muscle memory first, and everything reachable without a mouse. The Studio
owns its window, so there are no clashes.

| Key | Action |
| --- | --- |
| `Space`, `J` `K` `L` | Play, shuttle |
| `←` `→`, `Shift+←` `→` | Frame, one second |
| `I` `O` | Mark in, out |
| `S` or `Cmd/Ctrl+K` | Split |
| `Backspace`, `Shift+Backspace` | Delete, ripple delete |
| `Cmd/Ctrl+Z`, `Shift+…` | Undo, redo |
| `/` | Focus the prompt |
| `V` hold | Speak a change |
| `1` `2` `3` | Direct, Edit, Finish |
| `Cmd/Ctrl+E` | Export |
| `?` | All shortcuts |

## 11. Look

The same identity as the harness (`plugins/brand/DESIGN.md`): glass over cloth, teal
for action, saffron for the agent at work. Two exceptions, for craft: the monitor's
surround is neutral grey so colour reads true, and the timeline is flat, for
legibility and speed. Clip colours by role, always paired with an icon or label.

The moment to remember: when the first cut appears, the running stitch draws along
the timeline as clips land. Once only; drawn complete under reduced motion.

The Studio is a separate app, so tokens are copied into its own stylesheet at build
time, with a check that they still match.

## 12. Small screens and accessibility

- **Width under 760 px: Review mode.** Preview, What I did, prompt, approve, export. No timeline. The same app at 360 px; on a phone, the Review Room is the better place.
- 44 px targets; timeline handles have larger hit areas than they draw.
- Full keyboard path. A hidden focusable list mirrors visible clips for screen readers (STUDIO_APP_AND_BROWSER §7).
- `aria-live` for progress, politely.
- Light and dark. Reduced motion and transparency respected.
- Transcript editing is itself an accessible way to cut.

## 13. Copy

Plain, in the harness's voice: **Kriya**, never DeepSeek (status.md 2026-11-06).

| Moment | Copy |
| --- | --- |
| First drop | "Reading your footage. You can start working now." |
| Long job | "This one's long. You can close this; it picks up where it left off." |
| Needs a choice | "Two takes are close. Which one sounds more like you?" |
| Rights | "I don't know where this music came from. Check you can use it before you post." |
| Refusal | "I can't make it look like someone said something they didn't." |
| Cap reached | The harness's existing line |
| Offline | "I can't reach Kriya, so I can't make changes by asking. You can still edit by hand." |
| Disk | "Needs 12 GB more. Clear the cache in Settings, or choose another drive." |

## 14. In Kriya Tavi

TAVI_INTEGRATION: thread cards, decision cards, the Review Room at `/edits/[id]`, and
an Edits place in the sidebar with `editing.tavi` on.

## 15. Browser checks

Operator rule 7, per screen phase: 360 and 1280 px, light and dark, console clean,
targets ≥ 44 px, neighbours unchanged, screenshots in
`screenshots/kriya-editing/<phase>/`. The Studio runs against the fake Kriya; server
pages run on the isolated stack (`docs/operator/UI_VERIFICATION.md`).
