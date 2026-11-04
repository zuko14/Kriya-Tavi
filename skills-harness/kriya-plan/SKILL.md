---
name: kriya-plan
description: Use for a task with several parts: split it into at most seven small steps with kriya_plan, each with files and a done-when the project's check can prove, and the steps each one needs, then run them with kriya_step.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers writing-plans (MIT); Superpowers executing-plans (MIT)
  default: Kriya default skill
---

# Plan in verifiable steps

Kriya Harness runs plans for you: each step gets a fresh builder and the project's own check decides pass, retry or blocked. Your job is to make the steps good.

**Make each step:**
- **One idea**, small enough to build and check in one go (a builder sees only the goal, the plan and its step).
- **Checkable:** `done_when` names what the project's check (tests, typecheck, build) will show, not a feeling.
- **Located:** `files` lists what it expects to touch.
- **Ordered by need:** with loop v2, `after` lists the earlier steps it needs; independent steps need none, so one blocked step skips only its dependants.

**Then:**
1. Call `kriya_plan` once with the goal and the steps (at most seven; split bigger work into separate jobs).
2. Run `kriya_step` 1, 2, … in order. Don't redo a step's work yourself.
3. A blocked step is information: read its output, tell the person what failed and why, and re-plan only if the plan itself was wrong (at most three plans).
4. Finish with each step's result as the harness reported it.

No confirmed check in this project? Say so: work there ends "not checked", never "passed".
