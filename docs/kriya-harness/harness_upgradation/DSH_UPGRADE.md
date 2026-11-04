# Upgrading the pinned DeepSeek Harness (U5, KU-ADR-18)

DSH is a release-candidate line (`0.2.1-rc.5` today) composed, never edited
(track H rule 5). A bump is a recorded change: one version, one review, one
commit the owner approves. Work in a worktree, never in the person's
`kriya-harness` checkout.

## What protects a bump

| Gate | Catches | Where | Runs in |
| --- | --- | --- | --- |
| `check:pins` (HT-REL-01) | A range instead of an exact version; lockfile out of step | `scripts/check-pins.js` | `npm run check`, release gate |
| **`check:seams` (HU-SEAM-01)** | A renamed or removed hook, type, export, pattern or default that a Kriya plugin or row relies on, **named with its user** | `scripts/check-seams.js` (10 seams) | `npm run check`, release gate |
| Profile dumps (HT-REL-03) | Any change in the composed rows of the three profiles | `expected/*.dump.yml`, `tests/profiles.test.js` | `npm test` |
| KriyaBench-M (HU-M-01…08) | Behaviour on the real kernel: budget stops, overflow recovery, declared limits, resume, stream cut, kept request, stale pass | `tests/upgrade-run.test.js`, `tests/drills-run.test.js` | `npm test` (CI: Ubuntu and macOS on every push) |
| All other client tests | Approvals, mirror, skills, handoff, ACP, loop on real DSH | `tests/*.test.js` | `npm test` |
| Notices and licences (HG-5) | A new dependency's licence | `scripts/notices.js` | `npm run check`, release gate |

## Checklist

1. Read the DSH release notes and the READMEs of the seams in
   `scripts/check-seams.js` at the new version (they state their contracts).
2. In the worktree: `npm install @deepseek-ai/dsh@<exact version> --save-exact`.
3. `npm run check:seams`. A failure names the seam and the Kriya code that
   uses it: fix that code against the new contract (never edit DSH), then
   update the seam's pattern in the same change.
4. `node scripts/dump-config.js`, then review `git diff expected/`: every
   changed row is either expected from the release notes or explained in the
   commit message. A new DSH row that sends data off the machine (telemetry,
   accounts, web search) is disabled in `bundle/cordis.patch.yml` (HD-17).
5. `npm run check` (all tests, including KriyaBench-M on the new kernel).
6. If `No built-in turn budget` is gone from the agent loop's README, compare
   DSH's budget with `plugins/budget` and keep one (KU-ADR-04).
7. `npm run notices` if dependencies changed; `npm run release:check`.
8. Record in this folder's `status.md`: old → new version, seam changes,
   dump diff summary, test counts. Then ask the owner to approve the commit.
9. Before turning the new pin on for people, one KriyaBench-R regression run
   (easy + hard, BENCHMARK_PLAN §7) with the owner's go-ahead.

## Rolling back

Revert the bump commit (package.json, lockfile, dumps, notices); nothing
else depends on the version. Sessions saved by a newer DSH may use a newer
session format: DSH migrates forward only (`dsh-session-format-v*`), so
keep a backup of `~/.kriya/sessions` before trying a new version on a real
home.
