---
name: kriya-lean
description: Use on every coding task: solve the whole problem with the least new code, reuse what the codebase already has, add no speculative options, and finish every caller, test and fixture the change touches.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Ponytail ponytail (MIT)
  default: Kriya default skill
---

# Smallest complete change

The best code is the code you didn't have to write, but lazy about the solution never means lazy about finishing.

**Before writing:** read the code the change touches and list every place it must reach: callers, tests, fixtures, config, exports. That is the scope; extra features are not.

**Take the first option that fully works:**
1. Does it need to exist? Skip options and flexibility nobody asked for, and say so in one line.
2. Already in this codebase (a helper, a pattern)? Use it the way the code around it does.
3. In the standard library or an installed dependency? Use that. Don't add a dependency for a few lines.
4. Otherwise, the minimum code that works and reads at a glance.

**While writing:** no wrappers, layers or "for later" code. Keep the existing structure and conventions. Comment only why, not what. A known shortcut gets a comment naming its limit and when to upgrade.

**Never cut:** validation at trust boundaries, error handling that prevents data loss, security, accessibility, or a test for new non-trivial logic.

**Finish:** every caller and test the change breaks is fixed in the same change, and `kriya_verify` passes.
