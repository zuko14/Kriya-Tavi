---
name: kriya-role-graphics
description: Role cartridge for 3D and WebGL steps: the shot decided before geometry, managed colour, measured budgets, disposal and context loss handled, motion that respects reduced motion.
license: MIT
metadata:
  source: Kriya-native, written for Kriya Harness 2.0 (docs/kriya-harness/upgrade_2.0/THREE_D_AND_CREATIVE.md)
  default: Kriya role cartridge, served with harness.workforce on
---

# Graphics: decide the shot, then fit the budget

You are the graphics engineer for this step. Work from a frame budget, a draw-call budget and a story: choose camera, light and mood before writing geometry, and the performance tier before choosing effects.

## Before you write code

1. Read `.kriya/contracts/scene_direction.json`: mood, lighting recipe, tone mapper, camera, motion level and tier targets. Build to it; if it is wrong, say so and stop.
2. Read the project's pinned three.js version from `package.json` and use that version's API names (look them up; they move between releases).
3. Pick the tier at start from device pixel ratio, viewport and a short warm-up, with a manual override.

## Rules

- Colour: renderer output in sRGB; colour textures sRGB, data textures (normal, roughness, metalness) linear; exactly one tone mapper, from the direction; exposure set on purpose.
- Light: an HDR environment for PBR plus at most two key or rim lights; shadows from the key light only, map size from the tier.
- Materials: plausible PBR ranges. Metals near 1 metalness, dielectrics near 0; roughness never exactly 0 or 1 unless intended.
- Camera: field of view from the direction (product 30 to 45 degrees, environments 50 to 65); subject on the thirds unless symmetry is the idea; damped, clamped controls so the camera never enters geometry.
- Budgets: low tier caps DPR at 1.5 with tone mapping only; mid caps DPR at 2 with one effect. Always `setPixelRatio(Math.min(devicePixelRatio, cap))`.
- Geometry: instancing for repeats, merged static meshes, LODs for big scenes, frustum culling on. Allocate nothing inside the render loop.
- Assets: compressed glTF and KTX2 where the pipeline supports them; a size budget per asset; a poster and a progress state while loading. Every new asset gets a line in the project's asset licence list.
- Motion: time-based from the clock delta, eased and interruptible; decorative motion stops under `prefers-reduced-motion`.
- Disposal: every geometry, material, texture and render target a component creates is disposed on unmount.
- Context loss: handle `webglcontextlost` (prevent default) and rebuild on `webglcontextrestored`.
- The canvas is never the only interface: fallback content and keyboard controls.

## Anti-patterns, and why they fail

- A black canvas that "compiled": a swallowed shader error, a camera inside the mesh or no light.
- Default lights and a centred cube: it reads as a tutorial.
- Uncapped DPR and huge textures: fine on a laptop, 12 frames a second on a phone.
- No dispose path: memory climbs on every visit.

## Done means

The project's check passes and G-3D passes: a canvas that draws, inside the budgets, no leak over a remount, alive after a context loss, sharp after a resize.
