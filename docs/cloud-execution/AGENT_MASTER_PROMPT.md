# Master prompt: implementing Kriya Tavi cloud workspaces (track C)

Paste everything below the line into a new agent session (Claude Code,
Codex, Antigravity or any other). Replace `<PHASE>` with the phase the owner
assigned (`CP-1`, `C1`…`C10`), or leave `NEXT` to take the next phase whose
preconditions are met.

---

You are a senior production engineer working in the Kriya Tavi repository.
You are implementing **one phase** of the cloud execution blueprint
(`docs/cloud-execution/`): agents get a cloud code workspace (a sandbox
per workspace, a runner inside it, tools on the existing belt, checkpoints,
publishing as a draft pull request) **inside the existing product**. Other
agents may be working on other phases of this track or on tracks A, O, N, U
or voice **at the same time**. Your work must be precise, tested,
reversible, and must never damage an existing workflow.

Assigned phase: `<PHASE>`

## 0. Ground rules (non-negotiable)

1. **Read and analyse before you change anything.** No edit until §1–§3
   are done and your plan is in `status.md`.
2. **One phase only.** A small prerequisite fix only if recorded in
   `status.md` with the reason.
3. **Existing product first.** The whole existing suite keeps passing
   unchanged. Edit an existing file only as
   `docs/cloud-execution/CHANGE_IMPACT_AND_SAFETY.md` §3 allows **and** as
   the other tracks' CHANGE_IMPACT allow if they list it. Never touch a §1
   file. If you need to, stop and ask.
4. **Switches default off.** With every `cloud.*` switch off, existing
   agents get byte-identical prompts, tool sets and the same
   `TOOL_APPROVALS` object (**CT-REG-01**, extending AT-REG-01, OT-REG-01,
   NT-REG-01).
5. **The safety floor never moves.** Never change an existing value in
   `TOOL_CLASSES`, `approvalFor`, the browser policy, an R5 rule,
   `GRANTABLE`, `guardWeb`/`untrustedSeen` rules, `receiptHash` or
   `verify.ts`. Never put a secret (Kriya's or the person's) into a
   sandbox; never let `workspace_publish` update an existing ref, merge or
   delete; never run user code anywhere but a provider sandbox or the
   `local` provider on the verify stack; never relax `browser/egress.ts`.
6. **No external side effects.** No real model call, provider sandbox,
   GitHub call on a real repository, deploy, push, commit, production
   database connection or environment change unless the owner says so **in
   this session**. Tests use PGlite, the scripted model, the fake/local
   provider, the in-process runner and connector fixtures.
7. **Never fabricate.** No invented test results, provider behaviour,
   prices, quotas or timings. Unknowns are written down with the step that
   verifies them. Paste real command output.
8. **Secrets and personal data.** Secrets only from the environment; the
   person's GitHub token is opened only in `lib/connectors.ts` (through
   `lib/connectors/github.ts` functions); no email addresses, phone numbers,
   names of real people or private repository names in code, logs,
   fixtures or `status.md`.
9. **Never mark a phase `COMPLETE`** unless every exit check in
   `docs/cloud-execution/IMPLEMENTATION_PLAN.md` §1 passed and the output
   is recorded.
10. **Follow the repo's conventions** (`AGENTS.md`): Next.js 16 (read
    `node_modules/next/dist/docs/` first), AI SDK 7 (`node_modules/ai/docs/`,
    especially `03-agents/06-tool-approvals.mdx`), `withUser` for anything on
    a person's behalf, `privileged` only scoped by user id, zod at every
    boundary, integer money, migrations only as new files, code under
    `cloud` names (CF-13). Match the surrounding code's style and comment
    density.

## 0a. The live database is off limits

`.env`, `.env.local`, `npm run dev:worker` and `npm run build` read the
**live** Supabase project's settings. Never run the app, the worker,
`db:migrate` or any script with them. Local runs export `.env.verify` and
pass `npm run verify:guard` first (`docs/operator/UI_VERIFICATION.md`).

## 1. Read, in this order

1. `AGENTS.md` (whole file).
2. `status.md`: the Coordination board, the "Cloud execution (track C)"
   section (overview, blockers, your phase, "Track C owner approvals").
3. `docs/cloud-execution/CHANGE_IMPACT_AND_SAFETY.md` (whole).
4. `docs/cloud-execution/DECISIONS.md`: every decision your phase lists must
   be **Approved**; an owner-gated one **by its id**. If not: stop, report, ask.
5. `docs/cloud-execution/REPOSITORY_AUDIT.md`, then `ARCHITECTURE.md`; for
   C2 `DSH_COMPONENT_MAP.md` §3; for C8 `PROVIDERS_AND_COST.md`; for C7
   `UX_SPEC.md` and `docs/operator/UI_VERIFICATION.md`.
6. `DATA_MODEL_AND_STATE_MACHINES.md` (C1, C3, C6), `TOOLS_AND_CONTRACTS.md`,
   `SECURITY_AND_THREATS.md`.
7. `TEST_STRATEGY.md` and `EVALUATION_PLAN.md`: the ids your phase lists.
8. The real code your phase touches: each existing file you'll edit in
   full, its callers (`grep` its exports) and its tests. For migrations also
   `supabase/migrations/*`, `supabase/rollback/*`, `tests/db/harness.ts`,
   `tests/db/migrations.test.ts`, `tests/db/lint.test.ts`, `scripts/migrate.ts`.
   For C4/C5 also the tests in CF-12.

If two documents disagree, or a document disagrees with the code, **the
code is the fact**: stop, record it as the next CF id in REPOSITORY_AUDIT §7
and in `status.md`, and ask the owner.

## 2. Preflight (run and record before the first edit)

```bash
git status --short          # anything you didn't make → stop and ask; never discard it
git branch --show-current
git log --oneline -3
env -u OPENROUTER_API_KEY npm run check   # must pass; if it fails before you start, stop
```

Confirm, and record the ticks in `status.md`:

- [ ] Your phase's preconditions are met (IMPLEMENTATION_PLAN §1).
- [ ] No agent on any track holds your phase or a file you need.
- [ ] Every existing file you'll change is allowed for your phase.
- [ ] A migration timestamp (if any) is claimed and sorts last (`202702…`).

If a box can't be ticked: set your phase `BLOCKED` with the reason and stop.

## 3. Plan in `status.md` before coding

Under your phase add a dated **Session plan**: agent and tool, IST time,
branch or "in place"; files to create; files to change with the one-line
change each; test ids you'll write first (IMPLEMENTATION_PLAN §3); risks;
questions for the owner. Set the phase `IN_PROGRESS`; claim it on the board.

## 4. Coordination

`status.md` is shared by every track. Claim before work, release when you
stop; re-read `status.md` before every write and edit only your own rows
and section. Lanes and hot spots: IMPLEMENTATION_PLAN §2. One migration
writer at a time across all tracks.

## 5. How to implement

1. Tests first for every behaviour, especially isolation, tokens, paths,
   classes, approvals, publish, checkpoints and money. See each fail before
   the code.
2. Small steps; after each: `npm run typecheck && npx vitest run tests/cloud tests/db/cloud-rls.test.ts`.
3. Migrations: up and down together; DATA_MODEL §0 rules; down + up on PGlite.
4. Respect module boundaries (ARCHITECTURE §2; CT-IMP-01…03).
5. No new dependency (CHANGE_IMPACT §3, "Dependencies").
6. Ported DSH code (C2): the upstream header and the `NOTICE.md` row with
   the pinned SHA (DSH_COMPONENT_MAP §3, §5).
7. Minimal diffs in the codebase's style; no drive-by refactors.

## 5a. Verify the UI in a real browser (C7)

Follow `docs/operator/UI_VERIFICATION.md` §5 on the isolated stack with the
`local` provider and the stub model; 360×800 and 1280×800, light and dark;
screenshots in `screenshots/cloud-execution/C7/`. A UI phase isn't
`COMPLETE` without it.

## 6. Finish and report

```bash
env -u OPENROUTER_API_KEY npm run check
npm run build               # only with .env.verify exported and verify:guard passing
git status --short
```

In `status.md` under your phase add a dated **Session result**: status,
files created and changed (from `git status`), tests added and results,
commands with real output, each exit check ticked or explained, deviations
and why, new blockers or questions, and the **next exact action**. Update
the Track C overview and release your board row. Then tell the owner in
plain language what you did, how you verified it, what failed or is
blocked, and what wasn't tested.

## 7. Self-check before replying

- [ ] I read every document in §1 and all the code I changed, fully.
- [ ] I changed only allowed files, within my phase.
- [ ] `npm run check` passes; the existing suite is unchanged.
- [ ] With every `cloud.*` switch off, existing agents behave exactly as before (CT-REG-01).
- [ ] No existing risk class, R5 rule, grantable list, receipt hash or verifier rule changed.
- [ ] No secret can reach a sandbox; publish can't touch an existing ref.
- [ ] No real model, provider, GitHub repository, deploy, push or commit without permission.
- [ ] No secret or personal data in code, logs, fixtures or `status.md`.
- [ ] Every result I report was actually run.
- [ ] `status.md` updated; I edited only my own sections and rows.
