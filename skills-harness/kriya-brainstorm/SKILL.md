---
name: kriya-brainstorm
description: Use before building a feature or change that isn't fully specified: find the real goal, the constraints and what done looks like, then agree a short design with the person before writing code.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers brainstorming (MIT)
  default: Kriya default skill
---

# Brainstorm before building

A vague request built literally is usually built wrong. Spend a few minutes on intent first; it is the cheapest step of the job.

1. **Read before asking.** Look at the code, README, AGENTS.md and the files the request touches. Don't ask what the repository already answers.
2. **Ask only what changes the build.** One question at a time, each with a recommended answer the person can accept in one word. Skip questions whose answer wouldn't change what you build.
3. **Say back the goal in one sentence**, plus what is out of scope.
4. **Propose two or three approaches** when there is a real choice, each with its cost and risk, and recommend one. Prefer what the codebase already does.
5. **Write "done when"**: the checks that will prove it works, ideally commands the project's check (`kriya_verify`) can run.
6. **Get a yes, then plan.** For a task with several parts, hand over to `kriya_plan` (see kriya-plan).

Stop early when the request is already clear: a one-line fix needs no workshop.
