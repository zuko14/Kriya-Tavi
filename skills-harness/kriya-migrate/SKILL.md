---
name: kriya-migrate
description: Use when a change touches a database schema, stored data, an integration or a deployment: make it reversible, prove it on a copy, and check the data afterwards, not just that the command exited 0.
license: MIT
metadata:
  source: Written for Kriya Harness, based on ECC database-migrations (MIT)
  default: Kriya default skill
---

# Change data and systems safely

A migration that exits 0 can still lose data. Check the data, not the exit code.

**Needs:** the project's migration tool, a local or test database, and the rollback path. Never run against a production database from here: if the only connection is live, stop and ask.

1. **Inspect.** Read the current schema and recent migrations; follow the project's conventions. Applied migrations are never edited.
2. **Write the change forward-only and small:** add first, backfill, then remove in a later change. Keep old readers working in between.
3. **Write the rollback** with it, or say why there can't be one.
4. **Prove it on a copy:** apply, roll back, apply again.
5. **Validate the data:** row counts, nulls, constraints, a few real rows, before and after.
6. **Integrations and deploys:** check the other side actually received the change (read it back), and that a health check passes.

**Output:** what changed, the rollback, and the before and after numbers.

**Done when** apply, rollback and re-apply all work, the data checks match, and `kriya_verify` passes.

**If it fails:** stop at the first mismatch. Don't patch data by hand to make numbers agree; find out why they differ. Deploys and production changes are the person's to approve.
