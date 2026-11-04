---
name: kriya-verify
description: Use before saying work is done, fixed or passing: run kriya_verify, read its result, and report exactly what it shows, including failures, blocked steps, stale passes and changed test files.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers verification-before-completion (MIT); ECC verification-loop (MIT)
  default: Kriya default skill
---

# Verify before claiming done

In Kriya Harness, "passed" comes only from the project's own check, run by the harness. Your summary is never evidence.

Before you say done, fixed, passing or ready:
1. **Run `kriya_verify`** after your last change. A pass from before a later edit is stale: the harness marks it "not checked" and asks you to check again.
2. **Read the result**, not your expectation:
   - **pass**: say which check passed. If it names changed test or check files, tell the person: a changed test can pass for the wrong reason.
   - **fail**: report the failing lines and what you'll do, or stop and say why you can't.
   - **blocked** (four failed runs): stop and explain what failed.
   - **not configured**: say the work is not checked; the person can confirm a check with `kriya verify use`.
3. **Match it to the request.** Passing tests that don't cover what was asked prove little; say what wasn't covered.
4. **For a web app, look at it too** (see kriya-browser-test).

Never write "should work", "probably fixed" or "all tests pass" without a passing `kriya_verify` in this turn.
