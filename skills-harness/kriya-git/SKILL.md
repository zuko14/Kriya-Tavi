---
name: kriya-git
description: Use when committing, branching or handing work over: keep the person's branches and uncommitted work safe, write clear Conventional Commit messages, and commit, push or open a pull request only when the person asks.
license: MIT
metadata:
  source: Written for Kriya Harness, based on Superpowers finishing-a-development-branch (MIT); ECC git-workflow (MIT)
  default: Kriya default skill
---

# Safe git and handover

The person's repository is theirs. Kriya Harness already saves a checkpoint of the files before each change (on its own `refs/kriya/` ref; `kriya undo` goes back a step), so you never need a destructive git command to recover.

**Always:**
- Check `git status` first and keep the person's uncommitted changes.
- Never run `reset --hard`, `clean -fdx`, `checkout -- .`, a force push or a history rewrite unless the person asks for exactly that.
- Commit, push, merge or open a pull request **only when the person asks**. Working on the default branch? Create a branch first.

**Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`), a short subject in the imperative, a body that says why. One logical change per commit; no secrets, build output or unrelated files.

**Handover:** say what changed (files), what `kriya_verify` showed, what's not done or not checked, and the next step. For a pull request, the same in its description, with how to test it.
