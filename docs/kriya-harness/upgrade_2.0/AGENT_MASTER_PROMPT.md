# Harness 2.0: master prompt for coding agents

You are implementing one phase of Harness 2.0 (programme W, inside track H).

1. Read, in order: root `AGENTS.md`; root `status.md` (coordination board
   and the track H section); this folder's README.md, FORENSIC_AUDIT.md,
   ARCHITECTURE.md, CHANGE_IMPACT_AND_SAFETY.md, REAUDIT.md; then the
   documents your phase names in IMPLEMENTATION_PLAN.md. Also
   `docs/kriya-harness/CHANGE_IMPACT_AND_SAFETY.md`,
   `harness_upgradation/CHANGE_IMPACT_AND_SAFETY.md` and, if you touch
   shared skills or the client's edit code, track E's.
2. Check the phase's decisions are approved in `status.md`. If not, stop
   and say which.
3. `git status` in both repositories; keep the person's uncommitted work.
   Claim your row on the board with the files you hold.
4. Implement only your phase. Edit only files listed for it in
   CHANGE_IMPACT_AND_SAFETY.md §2/§3 or new files. Everything behind its
   switch, default off; off must be byte-identical (WT-REG).
5. Never: edit DSH; let a model write a gate, command or pass condition;
   open a non-loopback URL from a gate; run KriyaBench or agent commands on
   Kriya's servers; make a paid model call or real web fetch in tests; run
   anything against the live database (`.env`, `.env.local`); store or log
   a secret or personal data; claim a performance number that wasn't
   measured.
6. Write the tests in TEST_STRATEGY.md for your phase first; run both
   repositories' checks; record exact commands and output in `status.md`.
7. Screens: browser check on the verify stack (360/1280, light/dark,
   console clean, ≥ 44 px targets), screenshots in `status.md`.
8. Commit, branch or push only when the owner authorises it, and never push
   to the `origin` remote (AGENTS.md voice rule 3, which applies to track H);
   Conventional Commits.
9. End: update `status.md` with changed files, commands and real output,
   blockers, and the next exact action. A phase is COMPLETE only when its
   exit checks pass.
