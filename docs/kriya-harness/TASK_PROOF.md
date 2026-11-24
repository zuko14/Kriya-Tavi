# S-3 Task proof: web-started tasks, checked on the computer

Owner decisions, 2026-11-24 in chat (`status.md`):

- the proof card shows **files and line counts only**, so no code leaves the
  computer;
- **commit or PR from the web is not in S-3**; it would be its own reviewed
  phase.

S-3 builds on the Control Center (`CONTROL_CENTER.md`, H10), which already
queues typed tasks that `kriya daemon` runs as `kriya run`. The source is
`STRATEGIC_INTENTS_SOVEREIGN_COMPUTE_AND_ONBOARDING.md` milestone S-3, which
is internal.

## What the person sees

A task started on `/harness` (or the phone) shows, under its row:

- **While it runs:** its plan's steps, refreshed every 3 s by the daemon.
- **When it ends:** a proof card headed "Checked on your computer", with:
  - the verdict computed by code on that computer: verified, partly verified,
    checks failed, blocked, or not checked;
  - for each step: tries, who built each try (Worker or Head, the model's
    name, and "on your computer" for a local model from S-1), and its gate
    chips;
  - a warning when the task changed test or check files (the loop's
    `touched`);
  - the changed files: status and +/− lines, at most 200 listed, with the
    total count. No content: the diff stays in the local app.

## Rules

1. **Off by default.** `harness.taskProof` is off unless the owner turns it on,
   and it needs `harness.controlCenter`. Off: run payloads carry no `proof`
   (one sent by the browser is dropped), and nothing new is shown (HT-PRF-01).
2. **Kriya asks, the computer computes.** `queue()` sets `proof: true` from
   the switch. The daemon then:
   - gives the run a progress file and `KRIYA_TASK_PROOF=on`;
   - snapshots the working tree before and after with Kriya's own index (no
     commit, no change to the person's git);
   - reports `result.proof`.

   The loop writes the verdict from its ledger (`verify.js` `verdict`), never
   from model text (track N rule 3).
3. **Untrusted until it parses.** `RunProof` (`lib/harness/contract.ts`, also
   `runProof` in `contract.json`) is strict: unknown fields, file content,
   bad gate ids or a verdict outside the list mean nothing is shown
   (HT-PRF-02). The card says the result was reported by the computer.
4. **Older daemons** ignore `proof`, and their tasks show as before.
5. **`kriya daemon --local-model`** passes S-1's local worker to the tasks it
   runs (and `kriya daemon install` keeps the flag).

## Tests

- **Client:** `tests/task-proof-run.test.js`.
  - PR-RUN-01 (real DSH, the real daemon, the orchestra on): live steps
    mid-run; verdict verified; 2 tries by the worker; `.runs` the only changed
    file; no file content in any report; the output validates against the
    contract's `runProof`.
  - PR-RUN-02: without `proof`, nothing new.
  - PR-01: `stepsProof` for one level, a local worker, and no plan.
- **Server:** `tests/harness/task-proof.test.ts` HT-PRF-01 and 02, and
  HT-REG-01.

## Not built

- Commit or PR from the web (owner decision above).
- Seeing the diff in Kriya (owner decision above).
- Live chips for a step's current try before its first check ends: the
  steps show `building`, and the card fills as checks finish.
