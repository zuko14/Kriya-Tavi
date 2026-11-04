# Kriya loop v2: a dependency-aware, self-correcting loop (H14e, track HU)

Status: **built behind `--loop-v2` (default off), not yet measured** (2026-11-04).
Owner request in chat (2026-11-04, the "Kriya Loop V2" brief). Extends
`KRIYA_LOOP.md` (v1: H14a–c); track H rules, `harness_upgradation/CHANGE_IMPACT_AND_SAFETY.md`
and AGENTS.md apply in full. Nothing here changes a risk class, an approval,
a mode, a limit, a price or the gateway's spend reservation. No server
(Kriya) code changes: v2 lives in the client and needs no contract change.

## 1. What v1 does, and where it loses

v1 composes H = S ⊕ I ⊕ A ⊕ V ⊕ R with I a list of ≤ 7 ordered steps, one
fresh builder per attempt, ≤ 4 attempts per step, the verdict from the
confirmed check's exit code, a checkpoint before each file change, and a
stale-pass re-check (U8). Measured: B4 (`--budget --loop`) 18/21 vs 14/21,
at +43 % cost per passed task (BENCHMARK_PLAN §6.3; not significant at n = 21).

Weak points found reading the code (`src/loop.js`, `src/verify.js`), not
benchmark claims:

| # | v1 behaviour | Cost |
| --- | --- | --- |
| W1 | A blocked step doesn't stop later steps; every later step builds on it | Builders spent on work that can't pass |
| W2 | A retry always builds on the previous attempt's files | A worse attempt (e.g. one that breaks parsing) poisons every later one |
| W3 | Retry feedback is the output's last 3,000 characters | Long runner output pushes the failing lines out; no failure type |
| W4 | A pass that edited tests is reported, never re-checked | A weakened assertion still counts as "pass" |
| W5 | H14d (rules from repeated failures) was never built | The same mistake costs attempts in every session |

## 2. The model (formal)

Plan. P = (g, V, E) with steps V = {1…k}, k ≤ 7, and edges E ⊆ {(d, n) :
d < n}. Because every edge points to an earlier index, the listing order is
a topological order and no cycle can be written (`dependencies()` rejects
d ≥ n); there is no sort step to get wrong. A step without `after` gets
E ∋ (n−1, n), which is v1's chain.

Step state. s(n) ∈ {not started, fail, pass, blocked, skipped}, computed
by code from recorded runs (`verdict`, `planStatus`), in one pass in plan
order:

    s(n) = skipped  if no run for n and ∃(d, n) ∈ E: s(d) ∈ {blocked, skipped}
    s(n) = blocked  if failures(n) ≥ 4
    s(n) = pass     if the last run of n exited 0 (and, v2, held on the originals)

A step runs only when ∀(d, n) ∈ E: s(d) = pass. Done (v1's formula 9,
unchanged): ∀n: s(n) = pass ∨ s(n) ∈ {blocked, skipped}.

Failure class. c = classify(output, exit, timedOut) ∈ {timeout,
environment, syntax, type, assertion, tests changed, unknown}, by fixed
patterns (`src/failure.js`), most specific first. Rank r(c): timeout =
environment = 0 < syntax = 1 < type = unknown = 2 < assertion = tests
changed = 3 < pass = 4. The rank is "how far the code got": it parsed, it
type-checked, it ran.

Attempts (beam width 1 with backtracking). For attempts t = 1…4 of step n,
the files after the builder are saved, T_t = checkpoint(), and verified. Let
b = argmax over earlier attempts of r(c_b) (latest on ties). If r(c_t) <
r(c_b), the working tree is restored to T_b before builder t+1, which is
given c_b's error and a note that attempt t was set aside. Otherwise
builder t+1 builds on T_t, as in v1. The attempt bound and so the spend
bound (≤ 7 × 4 builders) are unchanged.

Feedback E → Δ. The builder gets c and excerpt(output): the lines that
match a failure pattern or name a project file:line, ±1 line, deduplicated,
≤ 2,500 characters; library frames (`node_modules`, `node:internal`,
`site-packages`) are dropped. Without a recognisable line it falls back to
v1's tail.

Test integrity. Let C = check files changed vs HEAD (`checkFiles`). On a
pass with C ≠ ∅, the check runs again with C as at HEAD (added ones moved
aside), then the work's versions are put back. pass ∧ ¬pass_originals ⇒
the run is recorded as a failure of class `tests changed`. A test added
next to a real fix passes both runs.

Rules. sig = (command, c, first failing line with digits normalised).
count(sig) ≥ 2 ⇒ one proposal, from a fixed sentence per class plus the
evidence. R_{n+1} = R_n ⊕ rule only on the person's `kriya rules confirm`;
confirmed rules go into each builder prompt and into `kriya_verify`'s
failure text.

## 3. As built (client worktree `../kriya-harness-upgrade`)

| Id | Part | Where | Closes |
| --- | --- | --- | --- |
| KV2-1 | `after` on plan steps (v2 schema only), DAG validation, `skipped` | `src/loop.js` (`dependencies`, `validatePlan`, `planStatus`, `runStep`), `plugins/loop/index.js` (`PLAN_STEP_V2`, `GUIDANCE_V2`) | W1 |
| KV2-2 | Failure classes, ranks, excerpts, signatures | `src/failure.js` (new) | W3 |
| KV2-3 | Attempt snapshots and set-aside restore | `src/loop.js` (`runStep`), `src/checkpoints.js` (`restoreTree`, undo's restore shared) | W2 |
| KV2-4 | Originals re-run | `src/verify.js` (`onOriginals`, `verifyStep` `v2`) | W4 |
| KV2-5 | Proposed and confirmed rules | `src/rules.js` (new), `bin/kriya.js` (`kriya rules`) | W5 |
| — | Switch | `src/modes.js` `SWITCHES` (`--loop-v2`, `KRIYA_LOOP_V2`, default off); read once in the plugin's `apply` | HT-REG-01 |

Off (the default), the plan tool's schema, the guidance, the builder
prompts, `kriya_verify`'s results and the progress files are v1's
byte for byte (KV2-REG-01, KV2-RUN-02, every existing loop test unchanged).

## 4. Safety

- **The person's repository.** Restores use the same code as `kriya undo`:
  Kriya's own index file, `checkout-index` of the differing paths only, and
  the replaced state saved on `refs/kriya/undone/*` first, so a set-aside
  attempt is listed in `kriya undo --list` and can be brought back. HEAD,
  branches, the index and the stash are untouched (KV2-BT-03 checks HEAD
  and the index byte for byte). The originals re-run first saves the work
  on a checkpoint (if that fails, there is no re-run), reads git (`show`),
  rewrites only the changed check files and restores them in `finally`.
- **Read only.** No snapshot, restore or originals re-run happens in Read
  only (KV2-TG-03); rules are kept in `~/.kriya/rules/`, never in the project.
- **Rules can't be forged by the agent.** Proposals and confirmations live
  in `~/.kriya/rules/<project hash>.json`, written only by the CLI and the
  plugin's code, outside the session's folder. A deviation from
  `KRIYA_LOOP.md` §3 (`.kriya/rules.md` in the project): a file there is
  writable by the agent's own file tools, so it couldn't mean "confirmed".
- **Spend.** Same attempt and plan bounds as v1; v2 adds at most one extra
  run of the person's check per passing verify that changed check files. No
  model calls are added. The gateway reservation is untouched.
- **What the model can't do.** It still can't choose the check, mark a
  step passed, confirm a rule or skip the originals re-run: all of those
  are decided in code from exit codes and git state.

## 5. Known limits (written down, not hidden)

- The originals baseline is HEAD (`shortcut:` comment in `onOriginals`). The
  person's own uncommitted test edits count as changes; commit them first,
  or run without `--loop-v2`. Upgrade path: use the session's first
  checkpoint as the baseline.
- A legitimate change to an existing test (an intended API change) fails as
  `tests changed` under v2 until the person commits the test change.
- `package.json` is a check file (its `scripts` define the check). A step
  whose code needs a manifest change it made itself can fail on the
  originals; same remedy.
- The failure classes are pattern lists for the common runners (node,
  TypeScript, pytest, go, cargo, npm); anything else is `unknown`, rank 2.
- Rule text is a fixed sentence per class; the person can reword it on
  confirm. Confirming in Kriya (phone, like memory) needs a contract change
  and stays open (`KRIYA_LOOP.md` §7).

## 6. Considered and not built (with reasons)

| Asked | Why not now | What it would need |
| --- | --- | --- |
| Recursive sub-decomposition of a step | Builders are one level deep (`maxDepth: 1`) so spend stays ≤ 7 × 4 builders; recursion multiplies it. A blocked step's evidence already lets the parent re-plan (≤ 3 plans) | An owner-set depth and spend cap, and a benchmark showing gain |
| Parallel beam search (several hypotheses per attempt) | k hypotheses cost k× builders; on 21 tasks the loop already costs +43 % per pass | K5 worktrees, an owner spend go-ahead, a paired benchmark |
| Parallel DAG execution | Independent steps still run one at a time; concurrent builders in one working tree would race | K5 (worktree per step, merge after verify) |
| Property-based checks | Needs project-specific generators; nothing generic is sound | Per-project opt-in, later |

## 7. Tests (client)

| Id | What | File |
| --- | --- | --- |
| KV2-FC-01/02 | 13 real runner outputs classified; excerpt keeps failing lines, drops noise, falls back to the tail | `tests/loop-v2.test.js` |
| KV2-DAG-01…03 | DAG validation (cycles, self and forward edges refused); blocked → dependants skipped with no builder spent, independent steps still run; order enforced | same |
| KV2-BT-01…03 | Worse attempt set aside, next builder sees the best attempt's error; ties and v1 build on latest; `restoreTree` keeps HEAD and the index byte-identical | same |
| KV2-TG-01…04 | Weakened test fails as `tests changed` and the work's file is restored; added test + real fix passes; deleted test folder restored and removed again; no re-run in Read only or before a first commit; the work is on a checkpoint before the swap | same |
| KV2-RL-01/02 | Seen twice → one proposal; confirmed/dismissed never re-proposed; only confirmed rules reach prompts; v1 notes nothing | same |
| KV2-REG-01 | Default off; v1 schema, guidance and prompts unchanged | same |
| KV2-CLI-01 | `kriya rules` lists proposals apart from confirmed rules; confirm with the person's wording; bad numbers and commands exit 1 | same |
| KV2-RUN-01/02 | Real pinned DSH, scripted model, real git repo: assertion → syntax (set aside) → pass, 3 builders, set-aside state kept on `refs/kriya/undone`; without `--loop-v2` no `after` | `tests/loop-v2-run.test.js` |

## 8. How v2 earns default-on (owner's call)

Not measured on a real model. The comparison that would decide it:
KriyaBench-R, capability set (7 tasks) plus the multi set (5 tasks), B4 vs
B4 + `--loop-v2`, K = 3 interleaved runs per arm on the budget tier, same
seed; report pass count, paired discordant tasks, ₹ per passed task, and
how often each v2 part fired (`skipped`, set-aside, `tests changed`,
proposals). Estimate ₹130–200: one B4 arm on the capability set cost
₹60.04 for 21 task-runs (§6.3), and the multi set adds 30 task-runs.
Reusing §6.3's B4 runs instead would roughly halve it but lose the
interleaving. It needs the owner's go-ahead and a bench device; until then
`--loop-v2` stays off.
