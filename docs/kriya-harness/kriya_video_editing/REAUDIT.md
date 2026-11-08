# Re-audit (track E: Kriya Editing Studio)

The consistency record of this document set, against Kriya `d46bb0c`, client
`0ebfd0c`, and the sources in SOURCE_AUDIT §5, on 2026-11-07. The hazards themselves
are in FORENSIC_AUDIT.md; this page records how the set was checked.

## 1. Checks run

| Check | Method | Result |
| --- | --- | --- |
| Full suite, Kriya | `env -u OPENROUTER_API_KEY npm run check` | **Test Files 263 passed, 5 skipped; Tests 3106 passed, 63 skipped; exit 0.** Typecheck and format clean; 8 lint warnings, 0 errors, all existing |
| Full suite, client | `npm run check` (pins, seams, notices, brand, tests) | **390 tests, 390 passed, 0 failed; exit 0** |
| Changes in the repositories | `git status --short` | Kriya: `AGENTS.md`, `status.md`, this directory. Client: nothing but its existing `.DS_Store` |
| Ids defined | Script: every EDD, EQ, EF, EH, ES, EG, QG, EX, EC and ET id used is the first cell of a table row or a heading here; ranges and shorthand expanded | All defined |
| Phases | Every phase id used is a row in IMPLEMENTATION_PLAN | 20 defined, none undefined |
| Section references | Script: each `DOC §n` resolves to a heading in that document | All resolve |
| Existing paths | Script over backticked paths in both repositories, new files excluded | All exist; misses are planned new files and one upstream path in `claude-shorts` |
| Placeholders | Search for `TODO`, `TBD`, `FIXME`, `XXX` | None |
| Stale terms after the redesign | Search for terms from the first design | None left outside the audit records |
| Diagrams | Mermaid blocks scanned for `;`, which ends a statement | 5 found and fixed. Not rendered by a Mermaid parser |
| Arithmetic | Flicks for all 11 rates, by script: exact integers. 2^53 flicks = 147.7 days. Standard error at n = 72 is 5.9 points, so a lower bound above 50 % needs about 61.5 %. Costs in COST_AND_METERING §3 re-computed | Correct |
| Severity counts | `FORENSIC_AUDIT.md` counted by script | 17 S1, 13 S2, 12 smaller, 42 in all |
| Upstream claims | Read on 2026-11-07 from the GitHub API, repository files and OpenRouter's public catalogue | SOURCE_AUDIT |
| Licences | GSAP, Remotion and YouTube's Terms read on their own pages; repository licences through the GitHub API, 19 packs one by one | SOURCE_AUDIT. FFmpeg's page unreadable: EF-26 |
| Code claims | FORENSIC_AUDIT §6 lists every file read | Findings EH-01…42 |
| `node:sqlite` with FTS5 | Run on Node 24.22 | Works |

## 2. First-pass findings, now closed

| Id | Finding | Resolution |
| --- | --- | --- |
| EA-01 | ED16's dependencies differed between table and diagram | Consistent |
| EA-02 | A setting's phase wasn't allowed by CHANGE_IMPACT | Rows fixed |
| EA-03 | ED2 listed only client files | Holds fixed |
| EA-04 | A planned skill needed `skills/index.ts` | Removed entirely (EH-12) |
| EA-05 | `kriya edit run` was a headless agent | It's plain code with no agent loop |
| EA-06 | Allow editing pointed at a Settings page | Follows Remote Control |
| EA-07 | No route for the player to read a preview | `GET /api/editing/preview/[id]` |
| EA-08 | Agent preset and folder picker assumed | Folder browser is the Studio's own; preset is checked in EX-07 |
| EA-09 | Plan mode not covered | Refused |
| EA-10 | `resource_usage.kind` has a SQL check | DATA_MODEL §4 |

## 3. Reviewed against what the owner asked

| Asked | Where it is |
| --- | --- |
| Read `information.md` pin to pin | SOURCE_AUDIT |
| Forensic audit: no bugs, no workflow damage | FORENSIC_AUDIT, with a protection matrix for every workflow |
| A separate execution loop for video editing | EDIT_LOOP |
| Most advanced engineering | EDIT_LOOP §4 to §8; EDIT_ENGINE §2, §5, §6; STUDIO_APP_AND_BROWSER §4 |
| Own techniques beyond the brief | The above; DIRECTOR_AND_AGENT §5, §8; QUALITY_GATES §2, §4; EDITOR_WORKFLOWS §4, §5, §8 |
| Every kind of editing | VISION_AND_SCENARIOS §5; EDITOR_WORKFLOWS §3 |
| Default and advanced skills, tools | SKILLS_AND_OPEN_SOURCE §4, §5; CAPABILITY_PACKS |
| Browser use | STUDIO_APP_AND_BROWSER §4 to §10 |
| Best UI | UX_SPEC §2, §4 |
| Harness and Tavi engagement | TAVI_INTEGRATION |
| Studio section; dashboard replaced | UX_SPEC §1; STUDIO_APP_AND_BROWSER §1 |
| Upload clips, sounds, references; export | UX_SPEC §3.2, §7; EDITOR_WORKFLOWS §1, §13; EDIT_ENGINE §11 |
| Think like an editor | EDITOR_WORKFLOWS |
| Quality, cost, a reliable loop | QUALITY_GATES; COST_AND_METERING; EDIT_LOOP; ARCHITECTURE §7 |
| Better than Claude Code with Opus 5.5 | VISION_AND_SCENARIOS §2 for the reasoning; EVALUATION_PLAN for the proof |
| Docs in the style of tracks C and H, with `status.md` | This directory; `status.md` "Editing Studio (track E)" |
| Phase by phase | IMPLEMENTATION_PLAN |
| 100 % production level | Exit checks per phase; EG-1…8. Earned phase by phase: a blueprint isn't production code |

## 4. Not checked

- The only product code is Edit Core (ED3), uncommitted on `feat/editing-studio`. ED1's throwaway experiments are in SPIKES.md: one fast Mac, synthetic fixtures.
- No hosted model was called. How Flash-1017 behaves as the Director's model is unknown until EX-08.
- Windows and Linux are untested, as is installing the Studio as an app.
- Mermaid diagrams weren't rendered.
- Competitor products beyond the repositories named weren't surveyed. No market claim is made, and RG-9 stands.
- Legal questions are open (EQ-01, EQ-02, EQ-07, EQ-09, EQ-10).
- A green suite here proves the documents broke nothing. It says nothing about future code: that is what ET-REG-01 and each phase's exit checks are for.
