# 3D, WebGL and creative work: competition-grade output from a cheap model

Part of Harness 2.0 (second design round, 2026-11-23). Adds the sixteenth
cartridge `kriya-role-graphics`, the gate **G-3D**, the **Explore** step
kind and a creative-direction method. Switches: `KRIYA_CARTRIDGES`,
`KRIYA_GATES`, `KRIYA_EXPLORE` (client, all default off).

## 1. Why 3D is where cheap models fail, and what fixes each failure

| Failure of an unguided model | Cause | Harness fix | Enforced by |
| --- | --- | --- | --- |
| Black or empty canvas, "it compiled" | Shader or loader error swallowed, camera inside the mesh, no light | Render, then look: canvas not blank, not single colour, WebGL errors and shader compile logs captured | G-3D (code) |
| Washed-out or muddy colour | Wrong colour space and tone mapping | Fixed colour-management rules (sRGB output, linear workflow, one tone mapper) | Detector `GX-COLOR` + cartridge |
| Looks like a tutorial | Default lights, default materials, centred cube, no composition | Art-direction table, lighting recipes, camera and composition rules, critic on several frames | Cartridge + critic (advisory) |
| Fast on the laptop, 12 fps on a phone | Unbounded draw calls, full-res DPR, huge textures | Hardware-independent budgets: draw calls, triangles, texture bytes, programs, DPR cap | G-3D (code) |
| Leaks on navigation | Geometries/textures never disposed | GL object create/delete balance over a mount → unmount → mount cycle | G-3D (code) |
| Dies when the GPU resets | No context-loss handling | Forced `WEBGL_lose_context` → restore; canvas must draw again | G-3D (code) |
| Stretched or blurry on resize | Canvas size not synced to CSS size × DPR | Viewport changes; drawing buffer vs client size checked | G-3D (code) |
| Inaccessible | Canvas as the only UI, motion forced | Fallback content, keyboard controls, `prefers-reduced-motion` | G-3D + G-A11Y |
| Assets with unclear licence | Models/HDRIs grabbed from anywhere | Licence gate on every asset file the step adds | `FE-ASSET-LICENCE` (code) |

The principle is the same as everywhere in Harness 2.0: anything that can be
measured is a gate; taste that can't is a judgement item checked by a
fresh-context critic only after the gates pass.

## 2. `kriya-role-graphics` (creative technologist / graphics engineer)

- **Mental model:** a frame budget, a draw-call budget and a story. Decide
  the shot (camera, light, mood) before writing geometry; decide the
  performance tier before choosing effects.
- **Rules (guidance + detectors):**
  - Renderer: the project's pinned three.js version (read from its
    `package.json`, never assumed); WebGL2 path always available as the
    fallback where a WebGPU renderer is used. API names come from the
    installed version's type definitions (GROUNDING §2), because three.js
    renames and moves APIs between releases.
  - Colour: output in sRGB, textures for colour in sRGB and data textures
    (normal, roughness, metalness) linear; exactly one tone mapper chosen
    from the direction table; exposure set deliberately.
  - Light: image-based lighting from an HDR environment for PBR materials,
    plus at most two key/rim lights; shadows only from the key light, map
    size from the tier.
  - Materials: PBR with plausible ranges (metals near 1 metalness, dielectric
    near 0; roughness never exactly 0 or 1 unless intended).
  - Camera and composition: focal length/FOV from the direction (product
    shots 30–45° vertical FOV, environments 50–65°); subject off-centre by
    thirds unless symmetry is the idea; damping on controls; a clamped orbit
    so the camera never enters geometry.
  - Performance tiers: `low` (mobile, DPR ≤ 1.5, no post-processing beyond
    tone mapping), `mid` (DPR ≤ 2, one effect), `high` (desktop, effects
    allowed). Tier picked at start from `devicePixelRatio`, viewport and a
    short warm-up frame-time probe, with a manual override.
  - Geometry: instancing for repeats, merged static meshes, LODs for large
    scenes, frustum culling on; no per-frame allocation in the render loop.
  - Assets: glTF/GLB with mesh compression (Draco or meshopt) and KTX2/Basis
    textures where the project's pipeline supports them; a size budget per
    asset; a poster image and a progress state while loading.
  - Motion: time-based (delta from the clock), eased, interruptible; scroll-
    linked motion throttled to the frame; everything decorative stops under
    `prefers-reduced-motion`.
  - Disposal: every geometry, material, texture and render target created by
    a component is disposed on unmount.
- **Detectors:** `GX-COLOR` (renderer output colour space or tone mapping
  never set; error), `GX-ALLOC-LOOP` (`new THREE.` / `new Vector3` etc.
  inside the animation callback; warn), `GX-NO-DISPOSE` (component creates
  GPU resources and has no dispose path; warn), `GX-DPR` (`setPixelRatio`
  with an uncapped `devicePixelRatio`; error), `FE-ASSET-LICENCE` (a new
  `.glb/.gltf/.hdr/.exr/.ktx2/.png/.jpg` under the asset folders without an
  entry in the project's asset licence list; error).
- **Gates:** G-3D, G-UI, G-A11Y, G-DETECT, project check.
- **Judgement items (critic, on frames from three camera positions and two
  times):** a clear focal point; light reveals form (no flat, shadowless
  object unless intended); materials read as their substance; motion has
  weight (ease, no linear snaps); the loading moment is designed; nothing
  looks like an unmodified example scene.

## 3. Art direction before code (designer step, 3D variant)

The designer step for 3D writes `scene_direction.json` (a new contract,
owned by `designer`): `{ mood, palette tokens, lighting recipe, tone mapper,
camera, motion level, tier targets, references }`. `references` are short
descriptions of the look ("late-afternoon studio, soft contact shadows"),
never copied images or another work's assets (track E rule 9's principle:
a reference gives numbers and words only).

| Recipe | Light | Tone mapping | Typical use |
| --- | --- | --- | --- |
| Studio product | HDR studio environment + soft key + rim, contact shadow | Filmic-style (e.g. AgX or ACES, whichever the pinned version provides) | Product hero, configurators |
| Daylight exterior | Sky environment + directional sun, cascaded or single shadow | Filmic-style | Architecture, worlds |
| Night / neon | Dark environment, emissive materials, restrained bloom | Neutral | Brand moments, music |
| Soft clay / illustrative | Ambient environment + one soft key, no hard shadows | Neutral | Explainers, onboarding |
| Data / abstract | Unlit or minimal light, instanced points/lines | None or neutral | Visualisations |

## 4. G-3D: the gate (client code, `src/gates/three.js`)

Runs in the agent's localhost browser on each route the step names in
`scene_direction.json`, at 390 × 844 and 1440 × 900. Before the page loads,
an init script (`page.addInitScript` on the gate's **own** page, opened with
`context.newPage()` and closed afterwards, never on the agent's shared page
or the whole context) wraps the page's `getContext` so that
every WebGL/WebGL2 context the **page** creates is counted by the gate, not
by the app (the app can't report its own numbers, so it can't flatter them):

| Check | How | Fails when |
| --- | --- | --- |
| Context and errors | Wrapped context; `gl.getError()` sampled after each frame for 120 frames; console errors (three.js logs shader compile/link failures there) | Any GL error, any console error, no context created |
| Not blank | Screenshots of the canvas at frame 30 and 90: luminance variance and distinct-colour count over a downsampled grid | Variance below threshold or fewer than 8 distinct colours (black/white/one-colour canvas) |
| Alive (if `motion ≠ none`) | Pixel difference between the two screenshots | No difference when motion was declared |
| Draw budget | Wrapped `drawArrays/drawElements/*Instanced` counted per frame, median over 120 frames; primitive counts from `count` arguments | Median draw calls or primitives over the tier's budget in the contract |
| GPU memory estimate | Wrapped `texImage2D/texStorage2D/bufferData`: bytes uploaded minus deleted | Over the tier's texture/buffer byte budget |
| Leaks | Mount → navigate away (or the route's unmount hook in `scene_direction.json`) → mount again; live counts of textures, buffers, programs, framebuffers | Live objects after the second mount exceed the first by > 5% |
| Context loss | `WEBGL_lose_context.loseContext()` then `restoreContext()`; wait 2 s; not-blank check again | Canvas blank after restore |
| Resize and DPR | Viewport change; compare drawing-buffer size with `clientWidth × min(DPR, cap)` | Off by more than 2 px, or DPR uncapped |
| Reduced motion | Re-run "alive" with `prefers-reduced-motion: reduce` emulated | Decorative motion still running |
| Frame time (reported) | `requestAnimationFrame` deltas over 120 frames, median and p95 | **Never gated**: headless Chrome often renders on a software path, so its timings say nothing about a phone's GPU. Reported with the renderer string so a person can judge |
| Load | Time to first non-blank frame; total transferred bytes of the route | Bytes over the route budget (gated); time reported |

Budgets come from `scene_direction.json` tier targets, bounded by fixed
ceilings in code (e.g. `low`: ≤ 100 draw calls, ≤ 300k triangles, ≤ 64 MB
textures; the ceilings are code constants, the contract can only tighten
them). Evidence (frames, counts) goes to `~/.kriya/evidence`.

Spike W13 S1: confirm the installed Chrome's headless mode creates WebGL2
contexts on macOS, Linux and Windows CI images and which renderer string it
reports; where none can be created, G-3D returns `not_checked: no WebGL in
this browser`, never pass.

## 5. Explore: several takes, the best one kept (creative steps)

For a step marked `explore: 2 | 3` (only for roles `frontend`, `designer`,
`graphics`), the loop builds **variants one after another in the same
folder**, because a spawned builder can't get its own working directory
(`AgentOptions` has no `cwd`; FORENSIC R-06):

```
base = checkpoint()                          (v2 snapshot, refs/kriya/…)
for v in 1..N (N ≤ 3):
    restoreTree(base); build variant v on the worker tier with a different direction hint
    gates(v); snapshot T_v
survivors = { v : every hard gate passed }
if survivors = ∅ → normal retry rules from the best-ranked failure (v2 rank)
else rank survivors: critic (head, fresh context) scores judgement items on each one's frames
     → the person picks in the Explore gallery (UI), or, with no UI (kriya run), the critic's first
restoreTree(T_winner); the others stay listed in `kriya undo --list`
```

- Bound: N variants + at most one polish = N + 1 ≤ 4 builders, so
  `MAX_ATTEMPTS` holds; a failed variant counts as an attempt.
- Variants differ by a fixed **direction hint** from the direction table
  (§3), chosen by code (first: the contract's direction; others: the
  nearest two rows), so diversity isn't left to sampling temperature.
- Pass is still only gates; the critic and the person choose among passing
  results, never turn a failure into a pass.
- The dev server must serve each variant: the gate waits for the server's
  file-watch reload (HTTP ETag/`last-modified` of the route's main module
  changes) up to 20 s, else `not_checked: dev server didn't reload`.

Why this lifts a cheap model most on creative work: quality of creative
output varies a lot between samples; picking the best of several gated
samples with a strong judge converts the cheap model's variance into
quality (sampling-and-selection, RESEARCH R-16). It costs N worker builds
plus one head critique, usually still under one head-built attempt.

## 6. "Competition grade", stated as a checklist

The harness can't promise a jury's verdict. It can make sure nothing a jury
punishes is left: every row of §1 checked by code, a direction chosen
deliberately, three takes compared on the same frames, and a loading
moment, mobile tier and reduced-motion mode designed. EVALUATION_PLAN E-6
measures it: a 3D seed set (≥ 20 briefs with hidden gate configs) and a
blinded owner preference test on frames, recorded as owner judgement.
