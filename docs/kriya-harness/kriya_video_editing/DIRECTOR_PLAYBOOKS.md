# The Director's playbooks (track E, phases DP1–DP6)

Owner's brief, 2026-11-09: from a basic prompt, the Director should think like a top
editor: understand what is being said and what kind of video it is, work out what the
footage has and what it lacks, and choose cuts, focus, images, captions, colour and sound
accordingly. This file is the spec. Results go in `status.md`.

## 1. What this can and can't promise

"Top 1%" is the aim, not a claim. Nothing here measures it. Track E rule 14 forbids a
comparative claim before gate EG-8 and a fresh RG-9, and only people preferring the output
in KriyaEditBench can show it. A model can't watch other editors' films through these
tools, so taste reaches the Director as playbooks a person reviewed, and the internet
reaches it as licensed media and cited facts (§5).

## 2. How editors decide, as rules code can hold

Sources are in §8. Most public advice is vendor blogs, so numbers are starting points to
tune by KriyaEditBench, not facts.

| Principle | What it becomes |
| --- | --- |
| Emotion and story outrank rhythm and tidiness (Murch's ranking); ease of cutting tempts over-cutting | Each cut has a reason in the plan. A personal or emotional line stays on the speaker. No fixed "cut every N seconds" |
| The interruption should renew clarity, curiosity or evidence, not just change the picture | A picture change must come from the words: something to show, a new idea, a name or a number |
| Picture follows meaning; sound carries across | Visuals sit under continuing speech (built: scenes); a place named gets that place (DP4) |
| Show who is talking, and sometimes who is listening; automatic switching misses moments | The multicam switcher's cost search and listener cutaways (built, unreachable until DP2) |
| Layers: dialogue, then ambience, then foley, then designed effects; dialogue stays on top; a few well-placed hits beat a whoosh on every cut | A density per genre, a limit per minute, peaks on the frame (built), QG-06 |
| Readable before stylish: bold sans, high contrast, one style through a film, 3 to 5 words a page | Caption styles are checked by QG-08, -09; the Director picks one per film (DP3) |

## 3. The playbook

A playbook is data, like a recipe (SKILLS §1, ET-RCP-01): no command, path, URL, model or
price. The Director classifies the video from its transcript, code loads the playbook, and
the person's words outrank it.

| Genre | Picture | Pace | Captions | Colour | Sound |
| --- | --- | --- | --- | --- | --- |
| Science explainer | Scenes, diagrams, sourced images | Moderate; breathe after a hard idea | Clean, bold | Cool, restrained | Soft bed, sound on reveals |
| Documentary or place story | Real images of what's named, slow moves, the speaker less | Slow, room to look | Small or none | Natural, warm | Ambience first, low score |
| Podcast or interview | Speaker focus, listener cutaways, term cards | Follows the talk | Clean | Natural | Voice only, little else |
| Tutorial | Screen, zoom on the action | Tight on the action | Clean | Natural | Quiet |
| Opinion or talking head | Punch-ins on the point, numbers on screen | Brisk, one breath | Karaoke | Vivid or natural | Light hits |
| Promo | One message, end card | Fast | Bold, boxed | Vivid | Beat-led |
| Vlog or story | Own B-roll, no diagrams | Varied | Light | Warm | Ambience, music |
| Music-led montage | Cuts on beats | The song's | None | Reference's | The person's song |

The classifier already exists for scenes (`contentType` in `director/beats.js`). The plan
slot gets the playbook's lines and what the footage lacks: "names a place, no picture of
it", "one camera, two voices".

## 4. Phases, in order

| Phase | Delivers | Switch | Needs |
| --- | --- | --- | --- |
| **DP1** | Playbooks in the plan: genre, reasons, sound density, each setting filled from the playbook unless the person said otherwise | `editing.playbooks` | Nothing new |
| **DP2** | Podcast path: two or more cameras reach `planMulticam` from a plan; key-term cards from the speaker's words | `editing.playbooks` | One-camera speaker focus needs the Speakers pack and EQ-05 |
| **DP3** | Caption styles: more looks, font and colours chosen per film and swappable on the card; a stroke counts in QG-09 | `editing.playbooks` | Each added font needs its licence (SKILLS §2) |
| **DP4** | EV3: real images and clips of what's named, from Wikimedia Commons, NASA and Openverse through a Kriya route, CC0, public domain and CC BY only (EDD-52), previewed on the card before download, credits file, slow move on stills | `editing.mediaSearch` | Nothing else for those sources |
| **DP5** | The person's song: cuts on its beats for a montage; the plan may use a song in the bin | `editing.playbooks` | Rights stay the person's (QG-13) |
| **DP6** | Definitions of hard terms from a cited source, shown with the citation | `editing.mediaSearch` | Lifts VISUAL_SCENES §3.2 only for quoted, cited text (EDD-57, approved) |

Model-written scenes (EV2) run beside these, as VISUAL_SCENES §2 says.

## 5. Refused, with reasons

| Asked | Answer |
| --- | --- |
| Video downloaded from YouTube or any site | No: EDD-22, and those sites' terms. Openly licensed clips only (DP4) |
| Any image Google finds | No: search results carry no licence. A temple's picture comes from a source that states one, and when none has it, the Director says so and the speaker stays on screen |
| Stock footage by key (Pexels and similar) | Not until the owner decides (EDD-52) |
| Generated people or video | No: EDD-24, EDD-54 |
| Claiming the output matches top editors | No: rule 14, until EG-8 |

## 6. Off-behaviour

Each switch defaults off, and off keeps the same plan, prompt and calls. ET-DP-REG-01
compares them, as ET-VS-REG-01 does.

## 7. Known problem found on real footage, needs the owner

Clean captions over real video fail QG-09 (11 of 29, worst 2.2:1 on one take), since a stroke
isn't credited. The repair's scrim is a rung for that, yet the run stayed blocked and took
three rounds. DP3 credits the stroke. Until then a real make with clean captions can end
blocked and take much longer.

## 8. Sources (read 2026-11-09)

[Murch's Rule of Six](https://www.studiobinder.com/blog/walter-murch-rule-of-six/);
[pattern interrupts and clarity](https://www.creatoressentials.com/glossary/pattern-interrupt/);
[podcast cutting](https://www.finchley.co.uk/finchley-learning/video-engineering-in-a-professional-podcast-post-production-cutting-when-to-cut-and-why);
[reaction shots](https://www.bhphotovideo.com/explora/node/124651);
[sound layers](https://krotos.studio/blog/post-production-sound-design);
[restraint with whooshes](https://sfxengine.com/blog/cinematic-sound-design-tips);
[captions](https://www.3playmedia.com/blog/closed-caption-styling-formatting-best-practices-you-need-to-know/).
