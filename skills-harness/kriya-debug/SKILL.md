---
name: kriya-debug
description: Use when something fails (a test, a build, a crash, wrong output): reproduce it, read the real error, form one hypothesis at a time and test it, fix the root cause once, then prove it with kriya_verify.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers systematic-debugging (MIT); ECC agent-introspection-debugging (MIT)
  default: Kriya default skill
---

# Debug from evidence

Guessing at fixes burns attempts. The loop gives you four per step; spend them on evidence.

1. **Reproduce.** Run the failing check (`kriya_verify`) or the smallest command that shows the failure. No reproduction, no fix.
2. **Read the failure.** The loop classifies it (syntax, type, assertion, environment, timeout) and cuts the output to the failing lines: start there, at the first error, not the last.
3. **One hypothesis at a time.** Say what you think is wrong and what would prove it; check that one thing (read the code, log a value, run one test).
4. **Fix the root cause once**, in the shared code, not at each caller. Grep the callers of what you change.
5. **Prove it.** The original failure passes, and nothing else broke.

Special cases:
- **Environment failures** (command not found, missing module, refused connection) aren't code bugs: tell the person what's missing instead of editing code around it.
- **Worse after a change?** Go back: `kriya undo` (or the loop sets a worse attempt aside for you) and try a different hypothesis.
- **Same failure twice** becomes a proposed project rule the person can confirm (`kriya rules`).
