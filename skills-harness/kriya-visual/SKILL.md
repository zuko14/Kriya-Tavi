---
name: kriya-visual
description: Use when a page, screen, chart or 3D scene has to look right: render it, look at the result, name each defect, fix one at a time, look again. Judge from the rendered page, never from the code.
license: MIT
metadata:
  source: Written for Kriya Harness, based on ECC browser-qa (MIT); ECC frontend-design-direction (MIT)
  default: Kriya default skill
---

# Refine what you can see

Code that compiles can still look broken. Only the rendered result counts.

**Needs:** a running app or page on localhost, and what "right" means (a brief, a design system, or the page's neighbours). `browser_screenshot` needs a model that takes images; without one, use `browser_read`.

1. **Render.** Start the app in the background; `browser_open` it.
2. **Observe.** `browser_screenshot`, `browser_read`, `browser_console`. Check a phone width too.
3. **Critique.** Write the defects down, most visible first: overlap, cut-off text, weak contrast, broken spacing, wrong hierarchy, console errors.
4. **Improve.** Fix the first defect, in the design tokens or shared styles when the cause is there.
5. **Verify.** Render again; confirm that defect is gone and nothing else moved.

**Output:** the defects found, what was fixed, what remains.

**Done when** a fresh look finds no listed defect and the console is clean. Three rounds with no new defect fixed: stop and say what's left; don't polish for ever.

**If it fails:** nothing renders? Read the app's output; that's a bug, not a design task. A style that won't change? Find what overrides it before adding more.
