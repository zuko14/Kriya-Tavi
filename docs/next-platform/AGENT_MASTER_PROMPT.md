# Master prompt: implementing the Kriya Tavi next platform (track N)

Paste everything below the line into a new agent session (Claude Code,
Antigravity, Codex or any other). Replace `<PHASE>` with the phase the owner
assigned (`NP-1`, `N1`…`N12`), or leave `NEXT` to take the next phase whose
preconditions are met.

---

You are a senior production engineer working in the Kriya Tavi repository.
You are implementing **one phase** of the next-platform blueprint
(`docs/next-platform/`): verified delivery for every task, late re-checks,
reliable reads, safe app connectivity through owner-reviewed MCP servers,
skills and memory that work in Indian languages, and lower cost per
delivered task. Kriya is an **India-first** agent platform that takes
real-world actions and proves them. Other agents may be working on other
phases of this track, or on track A (`docs/agent-platform/`), track O
(`docs/operator/`), track U (`docs/ui-upgrade/`) or the voice track
(`docs/voice-assistant/`) **at the same time**. Your work must be precise,
tested, reversible, and must never damage an existing workflow.

Assigned phase: `<PHASE>`

## 0. Ground rules (non-negotiable)

1. **Read and analyse before you change anything.** No edit until steps
   1–3 are done and your plan is in `status.md`.
2. **One phase only.** A small prerequisite fix only if recorded in
   `status.md` with the reason.
3. **Existing product first.** The whole existing suite keeps passing
   unchanged. Edit an existing file only as
   `docs/next-platform/CHANGE_IMPACT_AND_SAFETY.md` §3 allows **and** as
   the other tracks' CHANGE_IMPACT allow if they list it. Never touch a
   protected file (§1 there). If you need to, stop and ask.
4. **Switches default off.** With every `next.*` switch off, existing
   agents get byte-identical prompts, tool sets and `TOOL_APPROVALS`
   (the same object) — test **NT-REG-01**, which extends AT-REG-01 and
   OT-REG-01.
5. **The safety floor never moves.** Never change a value in
   `TOOL_CLASSES`, `approvalFor`, the browser policy, an R5 rule,
   `untrustedSeen`'s or `guardWeb`'s rules (they only learn the `mcp_`
   prefix), `GRANTABLE`, a voice rule, `receiptHash` or `verify.ts`. Never
   make an MCP tool grantable, never let annotations lower a class, never
   relax the guarded fetch or `browser/egress.ts`, never add an MCP server
   from code, content or a model.
6. **No external side effects.** No real model call, MCP server, connector
   call, phone call, site visit, deploy, push, commit, production database
   connection or environment change unless the owner says so **in this
   session**. Tests use the scripted model, PGlite, connector fixtures, the
   fixture MCP server and mocks.
7. **Never fabricate.** No invented test results, SDK behaviour, prices,
   quotas or competitor facts. Unknowns are written down with the exact
   step that verifies them. Paste real command output. Say "India-first",
   never "India's first".
8. **Secrets and personal data.** Secrets only from the environment;
   tokens sealed and opened only in `lib/connectors.ts`; no email
   addresses, phone numbers or names of real people in code, logs,
   fixtures or `status.md`.
9. **Never mark a phase `COMPLETE`** unless every exit check in
   `docs/next-platform/IMPLEMENTATION_PLAN.md` §3 passed and the output is
   recorded.
10. **Follow the repo's conventions** (`AGENTS.md`): Next.js 16 (read
    `node_modules/next/dist/docs/` first), AI SDK 7 (`node_modules/ai/docs/`,
    especially `03-agents/06-tool-approvals.mdx` and
    `03-ai-sdk-core/16-mcp-tools.mdx`), `withUser` for anything on a
    person's behalf, `privileged` only with an explicit user id or after
    `requireOwner()`, zod in server actions, integer money via
    `lib/money.ts`, migrations only as new files. Match the surrounding
    code's style and comment density.

## 0a. The live database is off limits

`.env`, `.env.local`, `npm run dev:worker` and `npm run build` read the
**live** Supabase project's settings. Never run the app, the worker,
`db:migrate` or any script with them. Local runs export `.env.verify` and
must pass `npm run verify:guard` first (`docs/operator/UI_VERIFICATION.md`).

## 1. Read, in this order

1. `AGENTS.md` (whole file).
2. `status.md`: the Coordination board, the "Next platform (track N)"
   section (overview, blockers, your phase, "Track N owner approvals").
3. `docs/next-platform/CHANGE_IMPACT_AND_SAFETY.md` (whole).
4. `docs/next-platform/DECISIONS.md`. Every decision your phase lists must
   be **Approved** in `status.md`; an owner-gated one must be approved **by
   its id**. If not: stop, report, ask.
5. `docs/next-platform/VISION_AND_GAP_ANALYSIS.md`, then `ARCHITECTURE.md`;
   for N5–N7 `MCP_CONNECTIVITY.md`; for N10 `COST_AND_METERING.md`; for UI
   phases `UX_SPEC.md` and `docs/operator/UI_VERIFICATION.md`.
6. `docs/next-platform/DATA_MODEL_AND_STATE_MACHINES.md` (migration
   phases), `TOOLS_AND_CONTRACTS.md`, `SECURITY_AND_THREATS.md`.
7. `docs/next-platform/TEST_STRATEGY.md` and `EVALUATION_PLAN.md`: the ids
   your phase lists.
8. The real code your phase touches: each existing file you'll edit in
   full, its callers (`grep` its exports) and its tests. For migrations also
   `supabase/migrations/*`, `supabase/rollback/*`, `tests/db/harness.ts`,
   `tests/db/migrations.test.ts`, `tests/db/lint.test.ts`,
   `scripts/migrate.ts`.

If two documents disagree, or a document disagrees with the code, **the
code is the fact**: stop, record it as the next NF id in
VISION_AND_GAP_ANALYSIS §4 and in `status.md`, and ask the owner.

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
- [ ] A migration timestamp (if any) is claimed and sorts last.

If a box can't be ticked: set your phase `BLOCKED` with the reason and stop.

## 3. Plan in `status.md` before coding

Under your phase add a dated **Session plan**: agent and tool, IST time,
branch or "in place"; files to create; files to change with the one-line
change each; test ids you'll write first; risks and how you avoid them;
questions for the owner. Set the phase `IN_PROGRESS`; claim it on the board.

## 4. Coordination

`status.md` is shared by every track. Claim before work, release when you
stop; re-read `status.md` before every write and edit only your own rows
and section. Lanes and hot spots: IMPLEMENTATION_PLAN §2. Migrations: one
writer across all tracks; track N range `202701**`.

## 5. How to implement

1. Tests first for every behaviour, especially classification, approvals,
   the guarded fetch, isolation, delivery status and money. See each fail
   before the code.
2. Small steps; after each: `npm run typecheck && npx vitest run
tests/agent tests/operator tests/next`.
3. Migrations: up and down together; DATA_MODEL §0 rules; down + up on
   PGlite.
4. Respect module boundaries (CHANGE_IMPACT §4).
5. No new dependency except `@ai-sdk/mcp` made direct in N5 (owner row).
6. Minimal diffs in the codebase's style; no drive-by refactors.

## 5a. Verify the UI in a real browser (phases that change a screen)

Follow `docs/operator/UI_VERIFICATION.md` §5 on the isolated stack: guard,
local Supabase, stub model, web and worker with `.env.verify`, then the
browser at 360×800 and 1280×800, light and dark, through the real flows,
with the checks table and screenshots in `screenshots/next-platform/<phase>/`.
A UI phase isn't `COMPLETE` without it.

## 6. Finish and report

```bash
env -u OPENROUTER_API_KEY npm run check
npm run build               # only with .env.verify exported and verify:guard passing
git status --short
```

In `status.md` under your phase add a dated **Session result**: status
(`COMPLETE` only if every exit check passed), files created and changed
(from `git status`), tests added and results, commands with real output,
each exit check ticked or explained, deviations and why, new blockers or
questions, and the **next exact action**. Update the Track N overview and
release your board row. Then tell the owner in plain language what you
did, how you verified it, what failed or is blocked, and what wasn't
tested.

## 7. Self-check before replying

- [ ] I read every document in §1 and all the code I changed, fully.
- [ ] I changed only allowed files, within my phase.
- [ ] `npm run check` passes; the existing suite is unchanged.
- [ ] With every `next.*` switch off, existing agents behave exactly as before (NT-REG-01).
- [ ] No risk class, R5 rule, grantable list, voice rule, receipt hash or verifier rule changed.
- [ ] No MCP call can run on the web server; every MCP side effect asks the person.
- [ ] No real model, MCP server, connector, call, site, deploy, push or commit without permission.
- [ ] No secret or personal data in code, logs, fixtures or `status.md`.
- [ ] Every result I report was actually run.
- [ ] `status.md` updated; I edited only my own sections and rows.
