# Skills and open source (track E)

What Kriya takes from others, under what rule, and how default editing skills
reach every person. Facts are from SOURCE_AUDIT (read 2026-11-07).

## 1. Four kinds of reusable knowledge

| Kind | Form | Decides | Lives in | Reaches the person by |
| --- | --- | --- | --- | --- |
| **Skill** | `SKILL.md` + `kriya.json` | How the agent thinks and talks about a job | `skills-harness/kriya-edit-*` | `/api/harness/v1/skills`, behind `editing.skills` |
| **Recipe** | JSON, validated | The stages, thresholds and defaults of a format | `src/edit/recipes/` in the client | Ships with the client |
| **Look** | JSON + assets | Captions, colour, motion, sound of a style | `src/edit/looks/`, plus the person's own | Client; saved Looks stay local |
| **Block** | A HyperFrames composition with typed variables | One animated element | `src/edit/blocks/` | Client, copied into a project when used |

A recipe is **code's** knowledge; a skill is **the model's**. Anything that can
be a rule goes in a recipe, because a rule in a recipe always holds and a line in
a skill sometimes doesn't.

One source of guidance serves everyone: agents in coding sessions read these skills
through DSH, and the Director loads the same text into block 1 of its prompts, per
role. With `editing.skills` off, short built-in role notes ship in the client. Tools
beyond the core are in CAPABILITY_PACKS.md.

## 2. The licence gate

Nothing enters the product, in code, text, template, font, sound or weights,
unless it passes this table. The gate applies **per item**, not per repository.

| Licence | Rule |
| --- | --- |
| MIT, BSD, ISC, Apache-2.0, Unlicense, CC0, OFL | Allowed, with notices |
| MPL-2.0 | Allowed unmodified as a dependency (Mediabunny) |
| LGPL | Allowed as a separate process or library, with obligations recorded (`mlt` not used; FFmpeg per EQ-02) |
| GPL, AGPL | Separate process at most, with counsel's yes; never linked or copied. Ideas only otherwise |
| Non-commercial (CC BY-NC, PolyForm NC) | **Never** |
| No licence stated | **Never**: that means all rights reserved |
| Custom terms | Owner decision by id: Remotion refused (EDD-08), GSAP held (EDD-09) |
| Model weights | Their own licence, checked separately from the code |
| Fonts | Only with a licence that allows embedding in video |
| Sound and music | Only with a licence allowing this use, and redistribution if bundled |

Owner exception, 2026-11-07: PSF-2.0, CNRI-Python, Zlib and 0BSD are allowed in the
alpha Media Runtime only, pending counsel (EQ-15). They arrive as dependencies of
`mlx-whisper`, from PyPI, and Kriya doesn't ship them.

Each imported item records: project, commit, path, licence, what was changed.
`NOTICES.md` (server skills), `THIRD_PARTY_NOTICES.md` (client) and
`scripts/notices.js --check` hold it to that. ET-LIC-01 fails the build on an
unrecorded asset or a licence outside the table.

**As built in ED13** (client `src/edit/runtime/licences.js`): the table as code, per item
and per place (client, runtime, weight); a choice (`OR`) passes on one side; the owner's
alpha exception applies to the runtime only. `tests/edit-packs.test.js` checks the
lockfile (Remotion and GSAP refused by name, dev tools included), every release
package's licence, the Studio bundle's metafile (its own code only), the sources of
`src/edit`, `studio/src` and `plugins/edit` for a Remotion or GSAP import, and the
Media Runtime manifest Kriya serves. The same check refuses a runtime or a pack at
install, before anything downloads. It found five Python packages in
`lib/editing/runtime/manifest.2026.11.0.json` recorded only as "BSD"; they now name
their licence (BSD-3-Clause; numba BSD-2-Clause). That manifest isn't signed yet (EB-09).

**Clean room for anything with no licence.** No text or code is read into an
implementation prompt from `motionclone`, `onetake` or
`generative-illustration-skills`.

## 3. What is taken from each project

| Project | Licence | Taken | Left behind |
| --- | --- | --- | --- |
| `heygen-com/hyperframes` | Apache-2.0 | `@hyperframes/engine`, `producer`, `lint`, `player`, as pinned dependencies in the Media Runtime and UI; `/hyperframes` skill ideas; registry blocks that don't use GSAP | CDN loading of GSAP; HeyGen's paid services; `/reverse-any-video` and `/style-sampling` (Pro) |
| `kajisho5/ffmpeg-skill` | MIT | The tools, vendored at a pinned commit in the runtime: `probe`, `check`, `look`, `sync`, `multicam`, `color`, `silence`; delivery tables and safe zones; the "contract" idea | Chained file-to-file editing as the main path |
| `kurbaitaev/ghost-editor` | MIT code; packs per `docs/THIRD_PARTY/` | Recipes as design references for `reel-*`; rules (face-safe captions, SFX levelled to voice, nothing on screen the speaker didn't say); take selection; matte recipe; cost lessons | Reel demo media; Mixkit downloads; GSAP-based templates as they are; dependence on Gemini and ElevenLabs |
| `browser-use/video-use` | MIT | The 12 hard rules, which become tests; transcript packing; cut-boundary self-check | ElevenLabs Scribe as a requirement |
| `AgriciDaniel/claude-shorts` | MIT | Rubric, boundary snapping, content classifier, cursor tracking, platform specs | Remotion project; CUDA assumptions |
| `iart-ai/*` (18 packs) | MIT | Selected technique notes: `kinetic-typography`, `data-animation`, `lower-thirds`, `b-roll`, `explainer-video`, `ecommerce-video`, `ad-video`, `motion-design`, `map-animation`; `deliver-and-verify` idea | `generative-illustration-skills`; Remotion-specific steps; `talking-head-skills`' generated humans (EDD-24) |
| `CloudAI-X/threejs-skills` | MIT | Into `kriya-edit-3d`: r186 rules, common mistakes | Blanket rewrites (EF-11) |
| `vincentsch/explainroo` | MIT | Reviewed for the explainer recipe | To be read in ED13 |
| `echris6/motion-video-kit` | MIT on GitHub | Identity to confirm: the list's entry may be another repository (EQ-08) | Everything until confirmed |
| `feitangyuan/onetake` | PolyForm Noncommercial | **Nothing** | All of it |
| `remotion-dev/*` | Custom, or none | **Nothing** | All of it |
| `austriandev/motionclone` | None | **Nothing** | All of it |
| `yt-dlp/yt-dlp` | Unlicense | Only if EDD-22 is approved | Default path |

Engines used as pinned runtime dependencies are in PERCEPTION_AND_INDEX §2. Also:
OpenTimelineIO (Apache-2.0, tests), Mediabunny (MPL-2.0), Manim (MIT, pack),
Anime.js (MIT, optional), lottie-web (MIT).

**Not used**, with reasons: `mifi/lossless-cut` (GPL-2.0, ideas only);
`facebookresearch/co-tracker` (licence not clearly open, not needed);
`facebookresearch/demucs` (archived; stems are optional, revisit with care);
`Netflix/vmaf` needs its own licence read before use.

### 3.1 The GSAP question

Most open-source motion templates assume GSAP, so EDD-09 costs real work: blocks
are written by Kriya. In exchange, the product doesn't rest on a licence clause
that Webflow can read against us. If the owner gets Webflow's written consent,
HyperFrames' registry opens up, and GSAP-based blocks can be added with no
architecture change (EQ-01).

## 4. Default skills

Added to `skills-harness/`, in the format of `kriya-visual`, validated by
`buildCatalog`, credited, with activation keywords in English and common
Indian-language terms. Served only with `editing.skills` on, and only their
guidance: they name `edit_*` tools and never contain commands.

| Skill | Teaches |
| --- | --- |
| `kriya-edit-core` | How to work: brief first, use `edit_make`, read results, never promise what the gates didn't confirm |
| `kriya-edit-talking-head` | Reels from raw takes |
| `kriya-edit-shorts` | Long to short; what makes a clip stand alone |
| `kriya-edit-longform` | Story first, scene by scene, notes per scene |
| `kriya-edit-podcast` | Multi-camera and clips |
| `kriya-edit-tutorial` | Screen work, zoom and callout judgement |
| `kriya-edit-montage` | Music-led edits |
| `kriya-edit-ad` | One message, variants, the end card |
| `kriya-edit-captions` | Caption taste, languages |
| `kriya-edit-sound` | Mix judgement, restraint |
| `kriya-edit-color` | Match first, look second |
| `kriya-edit-motion` | When motion helps, when it distracts; `edit_motion` rules |
| `kriya-edit-3d` | three.js r186, from threejs-skills |
| `kriya-edit-data` | Numbers from the file, never invented |
| `kriya-edit-reference` | Study a reference without copying it |
| `kriya-edit-handoff` | Finishing in another editor |
| `kriya-edit-story` | Structure: hook, build, payoff; what to cut when everything seems good |
| `kriya-edit-review` | Giving and reading notes; what a blind viewer will miss |

ET-SK-01 checks each is chosen for its tasks and not for others, using the
existing skill-selection eval's shape, offline.

**As built in ED13:** all eighteen, Kriya-native (no wording copied; `source` empty),
in `skills-harness/kriya-edit-*`, exported apart as `HARNESS_EDIT_SKILL_MANIFESTS` and
joined to the default set by `defaultSkillSet()` only with `editing.skills` on (off, it
is the same object). Keywords are phrases, never a bare word a coding agent uses for
something else ("color", "hook", "resolve", "edit"), and `tests/editing/skills.test.ts`
proves a list of everyday coding asks selects none. No `edit_*` tool exists on a device
until ED14, so the skills name no tool and carry no command.

## 5. Recipes

```json title="src/edit/recipes/reel-talking-head.json"
{
  "id": "reel-talking-head",
  "version": 1,
  "format": { "aspect": "9:16", "target": { "min": 15, "max": 90 } },
  "stages": ["brief", "index", "story", "assemble", "dress", "check"],
  "layers": { "required": ["L0", "L1", "L2", "L5", "L8"], "wanted": ["L3", "L6", "L7"] },
  "story": { "mode": "takes", "hook": true, "candidates": 6 },
  "cut": { "padInMs": 120, "padOutMs": 240, "minShotFrames": 8 },
  "pace": { "pictureChangeEverySec": [2.5, 5] },
  "captions": { "look": "clean", "wordsPerPage": [2, 5] },
  "sound": { "density": "standard", "musicDb": -22 },
  "gates": { "off": [], "thresholds": { "lufs": -14, "truePeak": -1 } }
}
```

Values shown are starting points to tune. A recipe has no field for a command, a
path, a URL, a model or a price: ET-RCP-01 proves it. A person can copy a recipe
and change values; only code reads it.

## 6. Blocks

A block is a folder: `index.html`, `block.json` (variables, sizes, duration
rules, licence), a thumbnail. Rules: seekable through HyperFrames' runtime; no
network; no clock; fonts local; passes `hyperframes lint`. Variables are typed
and escaped, so a caption's text can't inject markup (ES-05).

## 7. Supply-chain rules

1. **Nothing installs at run time from a moving reference.** No `npx skills add`, no `pip install -U`, no `git clone` of a branch.
2. **Vendored means pinned.** Commit hash, sha256, reviewed diff at each bump.
3. **Every prompt-bearing text is read by a person** before it ships: a third-party `SKILL.md` is untrusted input and may carry injected instructions. The awesome list's security grades are a third party's opinion, not a review.
4. **Skills are rewritten as `kriya-*`, credited**, never copied in bulk (WP-D2).
5. **Owner approves each version** (WP-D3).

## 8. Giving back

Fixes found in Apache or MIT projects can go upstream if the owner agrees. That
is the owner's call and needs its own approval each time.
