---
name: kriya-review
description: Use before handing work over or opening a pull request: review your own diff as a skeptical reviewer would, for correctness, edge cases, security, tests and needless code, and fix what you find first.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers requesting-code-review (MIT); Ponytail ponytail-review (MIT)
  default: Kriya default skill
---

# Review the change

Read your diff as someone who has to maintain it and doesn't trust it.

1. **See the whole change:** the Changes tab or `git diff` against where you started; read the connected code too, not only the changed lines.
2. **Check, in order:**
   - **Correct:** does it do what was asked, for empty, large, missing, unicode and concurrent inputs?
   - **Safe:** inputs validated at trust boundaries; no secret logged, committed or returned; nothing destructive without a guard.
   - **Tested:** new logic has a test that would fail without it; no test was weakened.
   - **Needed:** every line earns its place; delete dead code and speculative options.
   - **Consistent:** follows the codebase's own conventions and names.
3. **Fix what you find**, then `kriya_verify` again.
4. **Report** what you checked, what you fixed, and what you couldn't check (with why), in a few lines.

Opening a pull request, pushing or merging is the person's decision: ask first.
