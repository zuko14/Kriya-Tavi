# Harness 2.0: forensic re-audit of this design

Done 2026-11-23, after the first draft of every document here, by checking
each design assumption against source in `Kriya-Tavi@b0ed4c2` and
`kriya-harness@217ccda`. Every finding below was **fixed in the documents**
unless marked open. "Would have" describes the bug the draft would have
caused in production.

## 1. Defects found and fixed

| # | Severity | Draft said | Evidence | Would have | Fix (where) |
| --- | --- | --- | --- | --- | --- |
| RA-01 | High | A `cartridge` block inside `kriya.json` | `manifestSchema` is `z.strictObject` (`lib/skill-library.ts:17`) and `buildCatalog` parses every manifest at import | Thrown at module load of `skills-harness`: **every** device's skills route down, and the cloud catalogue's validator changed if "fixed" there | Sibling `cartridge.json` validated by `lib/harness/cartridges.ts`; `lib/skill-library.ts` protected (CARTRIDGES §1–2, CHANGE_IMPACT §1) |
| RA-02 | High | Scout run (≤ 50 fetches + model calls) as one scheduler step | `schedulerLoop` awaits each step inline every 30 s and also expires approvals and starts schedules (`worker/index.ts:250–361`) | Approvals expiring and schedules starting minutes late on every scout run | One unit of work per tick, 60 s abort, resumable run state (SELF_EVOLUTION §2.1) |
| RA-03 | High | QA spec-test steps judged by the normal verify | Spec tests are red until the code exists; normal verify needs exit 0 | Every spec step blocked after 4 attempts: the adversarial-QA design could never work | `expect: "red"` reusing the strict loop's red-phase proof (`onOriginals`, `src/verify.js:378`) (ORCHESTRA §7) |
| RA-04 | High | Escalation at attempts 3–4 | The loop guard (default on) blocks a step when the same signature repeats untouched (`src/loop.js:398`) | Escalation never reached the stuck-worker case it exists for | Untouched stall yields one head attempt first; `cantRun` never escalates (ARCHITECTURE §5) |
| RA-05 | High | Gates read their configuration from the project | Builders can edit any file in the folder | A builder writes an empty `.semgrep.yml` or a clean "dirty" fixture and its gate passes: reward hacking | Gate configuration read at `HEAD` (GATES rule 9); contracts hash-locked; tenants file defeated by controls |
| RA-06 | High | G-TENANT checked only "A on B's object ⇒ 403/404" | — | A server that answers 404 to everything, or two "tenants" that are the same user, would pass | Paired positive control per probe; identity distinctness proved first; object unchanged after probe (GATES §3) |
| RA-07 | Medium | `semgrep --config auto` style scanning | `--config auto` fetches rules and sends metrics | Network egress from a gate; non-deterministic rules | Local rules only, `--metrics off`, else `not_checked` |
| RA-08 | Medium | Outcome counts "with the person's HD-24 opt-in" | No opt-in exists in the client (`src/`, `plugins/mirror/` searched) | Counts sent with no consent mechanism, or the feature silently dead | `kriya share on/off/status` built in W11 before any count (IMPLEMENTATION_PLAN W11) |
| RA-09 | Medium | Mirror "session summary" field | Mirror payload is `TurnRequest`, a `z.strictObject` (`lib/harness/contract.ts:178`) | Old servers reject the field (400) if sent unadvertised | Field on `TurnRequest`, sent only after the `/models` `workforce` advert (DATA_MODEL §4) |
| RA-10 | Medium | Bench command `--seed role:frontend --pair --runs 3` | Real flags: `--agent`, `--level`, `--only`, `--profile`, `--meter`, `--status` (`lib/harness/bench/cli.ts`) | An implementer building to a CLI that doesn't exist; pairing is KRHE-5, unbuilt | Real flags plus two marked new ones; arms alternated by hand until KRHE-5 (SELF_EVOLUTION §3) |
| RA-11 | Medium | CLI "downloads the candidate with the owner session token" | No such route; a device token must never reach owner data (track H rule 3) | A new owner-data route reachable outside a browser session | Candidate offered as a file from the owner page; bench reads a local file (bench-only env) |
| RA-12 | Medium | Contracts shared "via `contract/cartridge.json`" with a vendored copy | Server ships first; client `contract/` is copied from `docs/kriya-harness/contract.json` | Two sources of truth drifting | `lib/harness/cartridge-ids.ts` is the source; exported and copied (IMPLEMENTATION_PLAN W1) |
| RA-13 | Medium | Architect role "has no builder" | Steps are always built by builders (`runStep`) | Contract steps silently on the worker tier, against the design's own reasoning | Architect builders on the head tier, fixed in code (CARTRIDGES §3) |
| RA-14 | Low | Outcomes/sources tables with bare `uuid` user columns | Harness tables reference `auth.users` with cascade/set null (`20270301000000_harness.sql`) | Rows left after account deletion (personal data retention) | Foreign keys with `on delete cascade` / `set null` (DATA_MODEL §1) |
| RA-15 | Low | `harness.workforce` alone serves cartridges | Defaults are served only with `harness.defaultSkills` on (`lib/harness/skills.ts`) | Owner turns on workforce and nothing changes, with no explanation | Dependency stated in the setting hint and owner page |
| RA-16 | Low | Milestone file written "like progress" | Two sessions in one project can run at once | Lost update between sessions | Atomic write + lock file (ORCHESTRA §4); `writeJson`'s temp+rename verified (`src/verify.js:158`) |
| RA-17 | Low | Probe logs as evidence | Probes carry test credentials | Credentials in evidence files | Redaction of `Authorization`, cookies, `tenants.json` values (GATES rule 7) |
| RA-18 | Low | JSON Schema validator to be written or found | `ajv@8.17.1` is already a direct client dependency (MIT) | Unneeded code | Use ajv (GATES §4) |
| RA-19 | Process | Master prompt "never push to origin without authorisation" | AGENTS.md: never push to `origin`, full stop | A weakened rule | Wording restored |

## 2. Checked and found sound

| Assumption | Evidence |
| --- | --- |
| A spawned child can run on another model | `AgentOptions.model` (`dsh-agent/lib/types/runtime-types.d.ts:21`); spawn honours `agentOptions` (package README); capability check `dsh-subagent/lib/types/index.js:444` |
| The gateway accepts any plan-allowed alias per request | `chatCompletion`: `isTier(alias) && plan.allowedTiers.includes(alias)` |
| A tool mask can be applied to a child before its first step | `plugins/loop/index.js:702` (`agent.ctx.tools.restrict({ deny })` for agents owned by the masked parent) |
| The run ledger can't be forged by the agent | `~/.kriya/progress/<project>/<session>.json`, outside the folder (`src/verify.js:392`), written via temp + rename |
| Spend is capped before every call | `reserve()` in the gateway; refusal codes `cap`, `plan`, `open` |
| Cached tokens are measurable | `prompt_tokens_details.cached_tokens` parsed (`lib/harness/metering.ts:102`) |
| Verbatim-quote check exists | `quoteFound` (`lib/radar/extract.ts:17`) |
| A platform model call path exists in the worker | `createGatewayModel(modelId)`, `modelForTier`, `usageFromMetadata` (`lib/models.ts`) |
| Monthly windows are IST | `date_trunc('month', now() at time zone 'Asia/Kolkata')` in the harness migration; reused for the scout |
| New `resource_usage` kinds need the constraint re-created | Done before in `20270901000000_flows.sql`, `20271102000000_editing_tables.sql` |

## 3. Open risks (not fixable on paper)

| # | Risk | Mitigation | Owner of the check |
| --- | --- | --- | --- |
| ~~OR-01~~ | ~~The `kriya` provider row may not resolve a child's `model: "budget"`~~ **Closed 2026-11-23 by W0 S1**: it does | — | — |
| ~~OR-02~~ | ~~Which agent may parent the advisor~~ **Closed 2026-11-23 by W0 S2**: the head; a builder's own child is refused at depth 2 | — | — |
| OR-03 | Gate configuration "at HEAD" misses rules the person wrote but didn't commit | Reported as `not_checked: rules not committed`, never pass | W3 tests |
| OR-04 | Heuristic detectors (`SEC-BODY-ID`, `GM-ALLOC-TICK`) have false positives | They are `warn` only: feedback, never a failure | Detector fixture tests |
| OR-05 | 30 tasks × K = 3 detects only large effects | `hold` is a valid outcome; no default changes without evidence | EVALUATION_PLAN |
| OR-06 | Lint can't catch every poisoned guidance | Over-strict lint + safety probes in the bench + owner review + overlay off by default + one-click rollback | W9, W11 |
| OR-07 | Glass-backdrop contrast sampling is a screenshot heuristic | Fails closed (the minimum sampled contrast must pass); reduced-transparency fallback is required regardless | W4 |
| OR-08 | DSH is an unaudited preview; seams may change on upgrade | `check:pins`, `check:seams`, WT-ORC-02; DSH_UPGRADE.md gates | Every DSH bump |

## 4. Regression posture

Every change is additive and behind a switch that defaults off. Off is
asserted byte-for-byte (WT-REG-01/02, HT-REG-01, WT-SK-02, WT-ORC-03), the
protected files of CHANGE_IMPACT §1 are untouched, `MAX_STEPS`,
`MAX_ATTEMPTS`, caps, prices, modes, approvals and the gateway are
unchanged, and no existing table, column, constraint value, route field or
test assertion is removed. The one shared constraint that is re-created
(`resource_usage_kind_check`) keeps every existing value and is tested.

## 4a. Found while building W1 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix |
| --- | --- | --- | --- | --- | --- |
| RA-30 | High | `cartridge.json` beside `SKILL.md` and `kriya.json` in each skill folder | `lib/skill-engine.ts` `audit()` throws "The skill has a file Kriya doesn't run" for any other file; `readSkill` audits on every read | Every cartridge body 404 on every device | `skills-harness/cartridges/<id>.json`; WT-CAR-02 asserts each folder holds exactly `SKILL.md` and `kriya.json` |
| RA-31 | Medium | Scout lint refuses a candidate whose **text** contains words like "token" | The shipped security and backend cartridges use those words legitimately | Every candidate for those cartridges refused forever | Lint judges added/changed lines only (SELF_EVOLUTION §7) |
| RA-32 | Medium | `defaultSkillSet()` builds a new array | ET-SK-02 asserts `toBe(HARNESS_DEFAULTS)` (identity) when off | Track E's regression test failing | Both switches off returns the same object |
| RA-33 | Low | Plan step gets `role`, `contracts`, `spec_tests` in W1 | `contracts`/`spec_tests` have no behaviour until W3/W5 | The model offered fields that silently do nothing | W1 adds `role` only |
| RA-34 | Low | `kriya-tools` would "pass through" an existing invocation field | It hard-coded `modelInvocable: true` (W0 S4) | Cartridges listed in the head's own catalogue | Uses the server's value; WT-CAR-RUN-03 proves exclusion on the real DSH with a positive control |

## 4b. Found while building W2 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-35 | High | The advisor is masked "through the same `masks` mechanism JIT tools use" | The `agent/created` hook that applies masks was registered only `if (jitOn)` (`plugins/loop/index.js`) | With JIT tools off, the advisor would have kept `bash`, `write` and `edit` | Hook registered `if (jitOn \|\| levels)`; WT-ORC-RUN-01 asserts the advisor's real request has no writer tool |
| RA-36 | Medium | "The session itself runs on the head" | `kriya run` started on `KRIYA_START_TIER` (first plan tier, `balanced`) whatever the orchestra | Head work (plans, contracts) on the wrong level | With `--orchestra` and the advert, `runDsh` starts the session on the head; WT-ORC-RUN-01 asserts every head request is `escalation` |
| RA-37 | Low | `kriya_advise` "registered only for builders" | DSH tools are registered for the whole process; children share the list | The head sees the tool | It refuses for anyone but a live builder ("Only a step's builder asks for advice"); RUN-02 shows it absent with the orchestra off. Open: hide it from the head with a mask if measurement shows wasted head steps |
| RA-38 | Low | `escalateAfter` per cartridge | No shipped cartridge sets it, and the profile field is W10 | — | Default 2 everywhere until W10; `tierFor` already takes the value |

## 4c. Found while building W3 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-39 | High | Gates run "inside `verifyStep` after the person's check" via `kriya_step` | A direct `kriya_verify` (`verifyTool`) calls `verifyStep` separately (`plugins/loop/index.js`) | The model could mark a step passed by calling `kriya_verify` itself, skipping every gate | Both paths take `host.gates`; WT-GATE-RUN-02 proves a direct `kriya_verify` fails G-SECRETS on the real DSH |
| RA-40 | High | — | `loopHost.contracts = …` was written before `const loopHost` was declared | A `ReferenceError` the moment the plugin started with `--gates` | Moved into the object literal; the real-DSH runs start the plugin with the switch on |
| RA-41 | Medium | — | The `AC-n` pattern had the `g` flag and was used with `.test()` | `lastIndex` carried between lines: G-TRACE passing or failing depending on the previous line | A separate non-global pattern for `.test()`; WT-GATE-05 repeats the same call |
| RA-42 | Low | — | `SY-SPIN` used `\([^)]*\)`, which stops at a call inside the condition | `while (!flag.load()) {}` missed | Greedy to the end of the line; WT-DET-01 covers it |
| RA-43 | Medium | GATES §3 lists `REQUIRED` gates for security and frontend | Those gates (G-TENANT, G-UI) don't exist until W4/W5 | Every security/frontend step failing "not built yet" | `REQUIRED` is empty and frozen in W3; W4/W5 add entries when their gates exist (WT-GATE-00 asserts it) |
| RA-44 | Low | G-CONTRACT checks generated types are current | Needs the project's generator command, read at the base commit (GATES rule 9) | — | Deferred to W4 with G-STACK; recorded as open |
| OR-15 | Open | Detectors and G-SECRETS judge lines changed vs HEAD | The person's own uncommitted edits are part of that diff | A finding in a file the person, not the agent, edited | Reported with file:line; the base-commit pinning of W16 narrows it to this session's work |

## 4d. Found while building W4 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-45 | High | G-STACK applies migrations "in one transaction, always rolled back" | Supabase-style migrations often carry their own `begin; … commit;`; psql `\\i` runs them inside ours | A `COMMIT` in a migration ends our transaction: its changes **kept in the person's database** | `ownsTransaction()` refuses any file with transaction statements or psql meta-commands (outside comments and dollar-quoted bodies) before any SQL is sent; WT-GATE-STK-02 asserts no SQL was sent. A multi-line `CASE … END` at a line start is also refused (safe direction) |
| RA-46 | Medium | G-A11Y uses "axe-core from the project's own `node_modules`" | `node_modules` is in the folder the builder can edit | A builder edits axe to report nothing (GATES rule 9) | W4 uses only built-in checks (names, `lang`, headings, contrast, glass backdrop); project axe deferred until its file can be verified against the lockfile's integrity hash |
| RA-47 | Medium | Gates use "a separate page of the agent browser" (`src/browser.js` `gatePage`) | The agent browser is one persistent profile per process | Shared cookies and storage between the agent and the gate | Gates launch their own short-lived non-persistent headless browser from the same installed Chrome with the same `localUrl` guard (`src/gates/page.js`); `src/browser.js` is unchanged |
| RA-48 | Low | — | WT-REG-03 compared run records from two fixture repos committed a moment apart | A test that passed only when both commits fell in the same second | Fixed commit dates in the fixture; passes three runs in a row and in the full suite |
| OR-16 | Open | G-STACK's real-database run | No `psql` or Postgres on this machine; no local Postgres image; nothing downloaded | — | Logic tested with a scripted psql (WT-GATE-STK-01…03). Owed: one run against a real local Postgres (the owner starts one, or approves pulling an image) |

## 4e. Found while building W5 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-49 | Medium | G-API and G-TENANT "call the local app" | Their examples, bad inputs and probes include writes (POST/PATCH/DELETE) to the person's local app | The person surprised by test rows in their local data | `kriya stack use` now says so when confirming; requests are budgeted (80 per gate run), loopback-only, never follow redirects |
| RA-50 | Medium | A spec step fails on "syntax or type" errors in its tests | In TypeScript, a test importing a module the next step will create fails as a type error (TS2307): that *is* the expected red | Every TS spec step refused | Only `syntax` disqualifies a red; WT-PLAN-05 covers the right and wrong reds |
| RA-51 | Low | — | My fixture server threw without answering, so requests hung 10 s | — | Fixture answers 500 like a framework; the gate already reported the hang as a failure (correct) |
| RA-52 | Low | ORCHESTRA §7 "tenant matrix ⇒ security step" | The rule needs roles (cartridges) and the contract bus (gates) | A plan refused for a field the model wasn't offered | Applies only with both switches on; never to a plan the person drew (Flows seed) |
| OR-17 | Open | G-SAST with real Semgrep | Semgrep isn't installed here | — | Logic tested with a scripted Semgrep and real git (rules from HEAD, no registry, metrics off). Owed: one run with Semgrep installed |

## 4f. Found while building W6 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-53 | High | G-EVAL "runs the confirmed eval command" | The evaluation script is in the folder the builder edits | A builder changes the evaluation and passes its own gate (reward hacking) | When the work changed evaluation files, G-EVAL is `not_checked` ("can't judge itself"); the metrics file must be written by this run; the baseline lives in `~/.kriya` and only `kriya eval baseline confirm` sets it |
| RA-54 | High | "The polish counts as one of the four attempts" | A failed polish adds a failed run; a step is blocked at 4 failures and its status is its last run | A passing step blocked by its own polish | Polish only while failures ≤ 2, and a failed polish is reverted and checked again, so the step ends on a pass (WT-CRI-03, WT-CRI-RUN-02) |
| RA-55 | Medium | Gates run "the confirmed pipeline / eval / build command" | No mechanism confirmed those commands (only `kriya verify use` existed) | Either a model-written command (WD-04 broken) or gates that could never run | `kriya gates use <gate> "<command>"` with its options, stored in `~/.kriya/gates.json`; without it, `not_checked` |
| RA-56 | Medium | — | The critic took its step number from `indexOf` on a freshly read plan | Step number 0 for every critique: the wrong step reviewed | `runStep` passes the number |
| OR-18 | Open | The critic judges "frames" and screenshots | The critic gets the changed files, the role's standards and the gates' notes; screenshots aren't passed as images yet | Visual taste judged from code and notes only | Image input to a review child needs the tier's image support (`/models images`) and a seam for image parts in a spawn prompt: a later phase, measured in E-5 |

## 4g. Found while building W7 (2026-11-23)

| # | Severity | Design said | Evidence | Would have | Fix / status |
| --- | --- | --- | --- | --- | --- |
| RA-57 | High | `url text … check (url ~ '^https://[^\\s]{4,500}$')` (DATA_MODEL §1) | Postgres caps a regex repetition count at 255; the check only runs on insert, so the migration applied and its down/up test passed | The owner's **first** source add failing in production with "invalid regular expression" | Length checked separately (`char_length(url) between 12 and 500`), pattern `^https://[^[:space:]]+$`; WT-SC tests insert sources |
| RA-58 | Medium | The reply is validated as one array | One malformed item failed the whole array | Valid, quote-checked findings discarded with it | Each item validated on its own; at most five per page (WT-SC-04, WT-SC-09) |
| RA-59 | Medium | — | `finish`, run starts and finding times used the database's or the process's clock | "Due" and "an hour later" judged against two clocks: a finding confirmable at once | Every time from the run's own clock (`deps.now()`) |
| RA-60 | Low | One migration for every Harness 2.0 table (`20271201000000_harness_workforce.sql`) | Candidate, version and outcome tables have no reader until W9/W11 | Unused tables shipped, and a later design change forcing an applied migration to be edited | `20271201000000_harness_scout.sql` holds the Scout's tables only; W9/W11 add theirs |
| RA-61 | Low | The distil prompt is marked `FOREIGN` | `FOREIGN` (`lib/agent/tools.ts`) says "content from the person's accounts", which a public page isn't | A misleading notice | The Scout's own untrusted-text instruction and fenced page text |
| RA-62 | Low | The owner nav link "only with harness.scout on" | `components/owner/nav.tsx` is a static client list; every section shows whatever its switch | — | Follows the house pattern: "Evolve" is listed; the page says when the Scout is off |
| OR-19 | Open | Browser check of `/owner/harness` (operator rule 7) | `npm run verify:guard` passes with `.env.verify`, but the local Supabase stack isn't running: the Docker daemon is off and no Supabase images are on this machine | — | Owed: with the owner's go-ahead to start Docker and let `supabase start` download its images, check 360/1280, light/dark, console, ≥ 44 px targets. The same stack also settles OR-16 |

## 5. Second round (2026-11-23): 3D, connectors, delivery, interface

Re-audit of THREE_D_AND_CREATIVE, GROUNDING_AND_CONNECTORS,
DELIVERY_AND_STABILITY, HARNESS_UX and DIFFERENTIATORS against
`kriya-harness@217ccda` and the pinned DSH. All fixed in the documents
unless marked open.

| # | Severity | Draft said | Evidence | Would have | Fix |
| --- | --- | --- | --- | --- | --- |
| RA-20 | High | Gates (G-UI, G-3D) drive "the agent browser" | `src/browser.js:156`: one shared page, `context.pages()[0]`, used by the agent's tools and the Live view | A gate navigating away under the agent mid-task and replacing what the person watches; G-3D's init script injected into the agent's own browsing | Gates open their own page (`context.newPage()`), page-level init script, closed in `finally` (GATES G-UI, THREE_D §4, CHANGE_IMPACT `src/browser.js`) |
| RA-21 | High | `repo_commit` as a local "execute" tool | `onOriginals` reads `HEAD:<path>` (`src/verify.js:261–268`); strict-loop reads too (`~l.300–342`); GATES rule 9 read config at HEAD | A builder commits weakened tests or an empty rules file and they become the "originals": reward hacking through git | `base` commit recorded by `kriya_plan`; those reads use it when repository tools are on; branch and commit need approval in every mode (GROUNDING §2, GATES rule 9, WT-REPO-15) |
| RA-22 | High | Auto mode would let `repo_commit` run without asking | Auto = "works in this folder without asking" (`src/modes.js`) | HEAD and branches moved silently, breaking the "never touches your branches" promise (`KRIYA_LOOP_V2.md` §4) | Approval in every mode; Auto refuses |
| RA-23 | Medium | Per-builder cost "from the gateway ledger" | The client sees only its usage total (`GET /me`); `lib/harness/gateway.ts` is protected | A new server field on a protected file, or invented per-builder costs | Difference of `/me` around each builder, labelled; includes advisor calls (DIFFERENTIATORS D10, HARNESS_UX §3.1) |
| RA-24 | Medium | Python grounding via `inspect` in the project's interpreter | Importing a module executes it | Running arbitrary package code just to read a signature | Stubs and text search only; WT-GRD asserts nothing is executed |
| RA-25 | Medium | G-RELEASE starts the production server itself | Whether a sandboxed command may listen on loopback is unverified per platform | A gate that fails for sandbox reasons and reads as a product failure | Spike W17 S2; else the person starts it; otherwise `not_checked` and `ready` withheld |
| RA-26 | Medium | Exact deploy CLI flags in a table | Not verified against provider docs in this session | Adapters built on wrong flags | Marked intended; W17 S1 verifies or drops each adapter |
| RA-27 | Low | `gh pr checks --json`, `--body-file`, `git switch` assumed | Flags depend on installed versions | Tools failing on older installs with confusing errors | W16 S0: minimum versions, clear refusal below them |
| RA-28 | Low | Evaluation table rows E-6/E-7 | A blank line split the Markdown table | Rows rendered as a broken paragraph | Removed |
| RA-29 | Low | README still said 15 cartridges | `kriya-role-graphics` added | Stale index | Fixed |

Checked and found sound: the AppFrame slots and `openRightbar` the
interface relies on (`dsh-client-ui-layout` README); WebGL counting from the
outside of the app is possible with a page init script (Playwright API);
`execFile` argv and the credential-stripping of remotes already exist in
`src/overview.js`; `writeJson` atomicity (`src/verify.js:158`).

Open (need code to settle):

| # | Risk | Mitigation |
| --- | --- | --- |
| OR-09 | Headless Chrome may not create WebGL2 on some CI images | W13 S1; `not_checked`, never pass |
| OR-10 | DSH may not let a plugin create background jobs for the CI poll | W16 S1; fallback: poll while the session is open |
| OR-11 | `dsh-mcp-client`'s OAuth token storage location unknown | W16 S2; servers needing it stay cloud-only until known |
| OR-12 | `kriya undo` across a commit restores files but leaves the commit | The undo message says so and names the commit; the person reverts it |
| OR-13 | Sidebar and command-UI seams for Missions and commands unverified | W18 S1/S2 with fallbacks (main panel only; buttons only) |
| OR-14 | Renaming four tracks moves things people know | Old ids aliased for one release if the owner chooses (DECISIONS question 5) |
