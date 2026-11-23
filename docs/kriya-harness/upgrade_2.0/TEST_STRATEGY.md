# Harness 2.0: test strategy (ids WT-…)

Free tests only in `npm test` (both repositories): scripted models, fixture
repositories, loopback servers started by the test, PGlite or a local
Postgres. No real model, no real web fetch, no real site, no hosted
database. Paid runs are evaluations (EVALUATION_PLAN), never tests.

## 1. Regression (the most important tests)

| Id | Repo | Asserts |
| --- | --- | --- |
| WT-REG-01 | client | With every new switch at its default: `SWITCHES` env values, plan tool schema, guidance text, tool list, `kriya_verify` output for the existing fixtures are byte-identical to snapshots taken at `217ccda` |
| WT-REG-02 | client | `builderPrompt` output for every existing loop fixture is byte-identical with `KRIYA_CARTRIDGES` off |
| HT-REG-01 (updated) | server | Harness keys and defaults, now with the eight new keys, all off/0/defaults |
| WT-SK-02 | server | `defaultSkillSet()` with `harness.workforce` off equals today's set (with and without `editing.skills`) |
| WT-ORC-03 | server | `/models` body with `harness.workforce` off is byte-identical |
| KV2-REG-01, HU-EV-01, HU-EV-03, ET-SK-02, HT-BEN-* | both | Unchanged and passing |

## 2. Units by area

| Area | Ids | Key cases |
| --- | --- | --- |
| Cartridge data | WT-CAR-01…05, WT-SK-01/03/04, WT-CT-01/02 | Every `cartridge.json` parses strictly; unknown gate/detector id refused at build; `maxPromptChars` ≤ 6,000 and ≥ the body; selection by role, globs, BM25 tie-break; one cartridge per builder; cartridge text first in the prompt |
| Orchestra | WT-ORC-01…08 | Spawn request identical when off; tiers per attempt; `environment` never escalates; same signature twice escalates; WT-ORC-09: an untouched stall on the worker yields one head attempt, a head stall blocks as today, a `cantRun` stall never escalates, and with the orchestra off the guard is byte-for-byte today's; disallowed alias throws pre-request; no advert ⇒ single tier; `cap_reached` path unchanged; advisor limit 2 and read-only mask |
| Contract bus | WT-CB-01…05 | Owner role may change its contract; non-owner change ⇒ `contract changed`; slices deterministic; dangling `$ref` fails; generated types stale fails |
| Gates | WT-GATE-00 (framework), one block per gate | Every gate: clean fixture passes, every mutant fails, missing tool ⇒ `not_checked`, required + `not_checked` ⇒ step `not checked`, non-loopback URL refused (including a DNS name resolving to a public address and a redirect to one), evidence outside the folder with recorded sha256, no shell string (argv spy) |
| Stack | WT-STK-01…04 | `kriya stack use` refuses non-loopback; project env with a hosted DB URL makes stack gates refuse; Read only mode runs none |
| Plan rules | WT-PLAN-01…05 | Spec-test step ordering; tenant matrix requires a security step; UI steps get G-UI; WT-PLAN-05: a spec step passes only red-for-the-right-reason (only test files changed, suite fails, suite without them passes, no syntax class), and a spec step whose tests already pass is refused |
| Critic | WT-CRI-01…05 | Runs only after pass; ≤ 1 polish; polish that breaks a gate is reverted (tree byte-equal to the passing snapshot); invalid critic JSON ⇒ no defects; counts toward 4 attempts |
| Milestones | WT-MS-01…06 | ≤ 12; advance only after done; ledger outside the folder; resume reads it; builders can't call it |
| Scout | WT-SC-01…08 | Lease (two concurrent runs ⇒ one); cap 0 ⇒ zero model calls; quote must be verbatim; second fetch ≥ 1 h; dedupe; `FOREIGN` marker present in the prompt; scheduler survives a thrown error; janitor removes old snapshots only |
| Lint | WT-LINT-01…12 | One refusing fixture per rule of SELF_EVOLUTION §7, plus a passing realistic candidate |
| Proposals | WT-PRO-01…06 | Transitions only along allowed edges; `rejected` can't be approved; verdict only from `gate()`; evidence hash/profile/seed/model mismatch refused; immutability trigger raises; audit event written |
| Overlay | WT-OV-01…07 | Off ⇒ repository cartridges only; canary hashing stable and ≈ pct; one active and one canary per id (unique index); rollback serves the previous version and changes the ETag; outcomes written only with opt-in; guard rule threshold |
| Database | WT-DB-01…04 | RLS: platform tables unreadable by `authenticated`; outcomes readable only by their user; `resource_usage` kinds constraint accepts every schema kind and rejects unknown; migration down/up |
| Security | WT-SEC-01 | Every owner route and action calls `requireOwner()`; device token can't reach any of them |
| Evolve | WT-EV-01/02 | New profile fields bounded and left out of ids at defaults; propose emits them as one-factor moves |
| Bench | WT-BEN-01 | Role seed hashes stable; graders hidden; `--cartridge-candidate` sets bench-only env; the client ignores `KRIYA_CARTRIDGE_FILE` without `KRIYA_BENCH=on` |

## 2a. Second round

| Area | Ids | Key cases |
| --- | --- | --- |
| G-3D | WT-GATE-3D-00…10 | Seam test for the init script; blank, shader-error, leaking, over-budget, no-context-loss, uncapped-DPR mutants fail; clean scene passes; frame time never fails a step; no WebGL ⇒ `not_checked` |
| Explore | WT-EXP-01…07 | See IMPLEMENTATION_PLAN W14 |
| Grounding | WT-GRD-01…06 | Nothing imported or executed; version-exact resolution; offline |
| Repository | WT-REPO-01…15, WT-MCP-01…05 | See W16; credentials never read or shown |
| Release and deploy | WT-REL-01…08, WT-DEP-01…10, WT-DOC-01…03 | See W17; G-DEPLOYED limits; WD-22 refusals |
| Interface | WT-UX-01…12 | See W18 |
| Receipts | WT-RCP-01…06 | Hash chain breaks at the edited link; no sensitive content |

## 3. Browser checks (owner pages)

Operator rule 7 on the isolated verify stack: `/owner/harness/evolve` at
360 and 1280 px, light and dark, console clean, targets ≥ 44 px, owner
neighbours unchanged; screenshots recorded in `status.md`.
