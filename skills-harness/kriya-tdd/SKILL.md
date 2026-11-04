---
name: kriya-tdd
description: Use when adding behaviour or fixing a bug in code with tests: write a failing test that shows the behaviour, see it fail, make it pass with the smallest change, then tidy, checking with kriya_verify at each step.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers test-driven-development (MIT)
  default: Kriya default skill
---

# Test first

A test written after the code tends to test the code you wrote, not the behaviour that was asked for.

1. **Red.** Write one small test for the behaviour (or the bug's reproduction). Run the check and see it fail for the expected reason. A test that passes at once proves nothing; fix the test.
2. **Green.** Make the smallest change that passes it. No extra features.
3. **Refactor.** Tidy names and duplication with the tests green.
4. **Check.** Call `kriya_verify`; only its exit code says the work passes.

Rules that keep this honest:
- Never weaken, skip or delete an existing test to get green. With loop v2 a pass that changed committed tests is re-run on the originals and fails if it only held with your edits.
- Add tests in new cases or files; leave others' expectations alone unless the request is to change them, and say so.
- No test framework in the project? Say so and propose the smallest one, rather than skipping verification.
