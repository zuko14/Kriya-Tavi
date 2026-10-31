# Universal resume prompt (tracks C, H, R)

Paste everything below the line into any new session (Claude Code or any
other agent). It works out where the work stopped and continues with the
next phase. To force a phase, replace `NEXT` with its id (e.g. `C3`).

---

You are continuing the Kriya Tavi build of three tracks: cloud execution (C,
`docs/cloud-execution/`), the Kriya Harness (H, `docs/kriya-harness/`) and
Rooms (R, `docs/rooms/`). Their shared plan is `docs/program/C_H_R_PROGRAM.md`.
Work on exactly **one** phase in this session.

Phase to work on: `NEXT`

## 1. Find where we are (read, don't change anything yet)

1. Read `AGENTS.md` in full.
2. Read `status.md`: the Coordination board at the top, then the sections
   "Program: tracks C, H, R", "Cloud execution (track C)", "Kriya Harness
   (track H)" and "Rooms (track R)": each overview table, blockers, owner
   approvals, and the latest "Session result" / "Next exact action".
3. Read `docs/program/C_H_R_PROGRAM.md` §3 (waves) and §4 (shared files).
4. Run:
   ```bash
   git status --short
   git branch --show-current
   git log --oneline -5
   ```

## 2. Choose the phase

If the phase above is `NEXT`, pick the first phase that meets **all** of:

- its status is `NOT_STARTED`, or `IN_PROGRESS` with a recorded "Next exact
  action" and no active claim on the board;
- every phase it depends on is `COMPLETE` (the "Depends on" column);
- its wave in `C_H_R_PROGRAM.md` §3 has started (all earlier waves done, or
  the dependency allows it);
- no other agent on the Coordination board holds the phase or any file it
  needs (§4 order);
- its decisions are approved under that track's "owner approvals";
- its blockers don't need something only the owner can give (an account,
  money, a deploy, a counsel answer). If they do, skip it and say so.

If several qualify, prefer track C, then H, then R. If **none** qualifies,
stop and tell me exactly what is blocking each candidate and what I need to
do.

Tell me in two lines which phase you picked and why, then continue.

## 3. Do the phase

Open that track's master prompt and follow it exactly, with `<PHASE>` set to
the phase you picked:

- C → `docs/cloud-execution/AGENT_MASTER_PROMPT.md`
- H → `docs/kriya-harness/AGENT_MASTER_PROMPT.md`
- R → `docs/rooms/AGENT_MASTER_PROMPT.md`

That prompt's rules come first: preflight, claim on the board, a session
plan in `status.md` before coding, `CHANGE_IMPACT_AND_SAFETY.md` limits,
tests first, no external side effects or live database, never fabricate.

## 4. Stop cleanly (always, even if you run out of time)

Before ending the session:

1. Run `env -u OPENROUTER_API_KEY npm run check` and paste the real output.
2. In `status.md`, under the phase: a dated **Session result** with what was
   done, files changed, tests and results, exit checks ticked or not, and the
   **Next exact action** (precise enough that a new session with no memory
   can continue from it). Set the phase `COMPLETE` only if every exit check
   passed; otherwise leave it `IN_PROGRESS`.
3. Update the track's overview row and release your board row.
4. Don't commit, push or deploy unless I said so in this session.
5. Tell me in plain words: what's done, what failed or is blocked, what
   wasn't tested, and which phase comes next.
