# The gate catalogue: deterministic verification, exit codes only

Part of Harness 2.0. Client code in `kriya-harness/src/gates/`, switch
`KRIYA_GATES` (default off; needs the loop). Gates run inside
`verifyStep` after the person's confirmed check, in the same DSH sandbox
and mode as that check.

## 1. Rules every gate obeys

1. **Code, not model.** A gate is a function in client code with fixed
   logic. Its configuration is typed data (contracts, the cartridge's gate
   list, `kriya stack use`); no field can hold a command, a script, a
   regex the model wrote, or a pass condition. A model never writes,
   edits or chooses the arguments of a gate (F-06).
2. **Three outcomes.** `pass`, `fail` (with failure class and excerpt), or
   `not_checked` (with the reason: tool missing, no stack, read-only mode).
   `not_checked` is never reported as passed.
3. **Required gates are fixed in code.** `REQUIRED[role]` in
   `src/gates/index.js` lists gates whose `not_checked` makes the whole step
   `not checked` (the existing H14a status). Example: `security` requires
   G-TENANT when `auth_matrix.json` has a tenant-scoped row; `frontend`
   requires G-UI when a dev server is confirmed. Data (cartridges, scout
   proposals) can add gates, never remove a required one.
4. **Loopback only.** Every URL a gate opens must resolve (all addresses,
   `dns.lookup(..., {all:true})`) to `127.0.0.0/8`, `::1` or a `.localhost`
   name; redirects to anything else are refused. One helper, shared with
   `plugins/browser`'s existing localhost guard, never copied. The single
   exception is G-DEPLOYED (DELIVERY_AND_STABILITY §4, WD-21): GET/HEAD
   only, only the host captured from the person's own deploy, no browser.
5. **No shell strings.** Tools are run with `execFile(argv)` through the
   same runner the check uses (`host.run`), fixed flags, paths as separate
   arguments. Tools are used only if already installed in the project or on
   `PATH`; Kriya installs nothing.
6. **Bounded.** Each gate ≤ 5 minutes (configurable down, never up, by
   profile); total verify ≤ the builder's `turnMinutes`. A time-out is class
   `timeout`.
7. **Evidence outside the folder.** Probe logs redact `Authorization`,
   cookies and any value from `tenants.json`. Screenshots, DOM reports, probe logs go
   to `~/.kriya/evidence/<project>/<session>/<step>/<attempt>/`; the ledger
   records their sha256. The agent can't edit what the gate saw.
8. **Read only mode runs no gate** that starts or writes anything
   (KV2-TG-03 pattern); they return `not_checked`.
9. **Configuration the builder could edit is read at the plan's base
   commit.** When `kriya_plan` saves a plan, the plugin records `base =
   git rev-parse HEAD` in the ledger. Anything a gate takes from the project
   (Semgrep rules, the dirty-data fixture, eval files, generator configs,
   `component_states.json` preview routes) is read with `git show
   <base>:<path>`, never from HEAD (a session with repository tools may
   have committed since, GROUNDING §2) and never from the
   working tree, so a builder can't weaken its own gate by editing its
   configuration (the same reasoning as v2's originals re-run). Exceptions,
   each with its own guard: contracts (hash-locked by owner role, ORCHESTRA
   §5) and `tenants.json` (G-TENANT's identity-distinctness check and paired
   positive controls make a gamed file fail, not pass).

## 2. The local stack (`kriya stack use`)

Live checks need a running app and database. The harness never starts
Docker or a database by itself (it would need the network and a daemon
outside the folder sandbox, and could hit a live database by mistake).
Instead the person confirms, once per project:

```bash
kriya stack use --app http://localhost:3000 --db postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

- Stored in `~/.kriya/stack.json` by project root (like `verify.json`).
- Refused unless both URLs are loopback (rule 4). A `DATABASE_URL` in the
  project's env that is **not** loopback makes every stack gate refuse with
  "this project's database URL isn't local" (F-11), so a gate can never run
  migrations or probes against a hosted database.
- For Supabase projects the hint printed is `supabase start` (the person
  runs it); Kriya's own repository uses `.env.verify` and `npm run
  verify:guard` (operator rule 6), unchanged.

## 3. Catalogue

| Id | What it proves | Algorithm (fixed) | Needs | Fails on |
| --- | --- | --- | --- | --- |
| **G-CONTRACT** | Contracts parse, are internally consistent, and are unchanged by non-owners | Parse JSON; validate against the contract's JSON Schema (§4); resolve `$ref`s; compare sha256 to the ledger; check generated files are newer than and consistent with their source (the project's generator re-run to a temp dir, then byte-compare) | Nothing | Invalid contract, dangling ref, drift (`contract changed`), stale generated types |
| **G-DETECT** | Banned patterns absent | Fixed detectors (`src/gates/detectors.js`), each a pure function over changed files' text, bounded regex compiled once from code constants | Nothing | Any `error`-severity finding in files the step changed |
| **G-UI** | The interface renders and holds together | In **its own page** of the agent browser's Chrome (`context.newPage()`, closed in `finally`), never the shared page the agent and the Live view use (`context.pages()[0]`, `src/browser.js`): for viewports 360, 390, 1440 and each light/dark scheme: open each route and state preview in `component_states.json`; wait for network idle; collect console errors, same-origin 4xx/5xx, horizontal overflow (`scrollWidth > innerWidth`), cumulative layout shift from `PerformanceObserver('layout-shift')`; interactive elements' boxes; screenshots | Confirmed app URL, Chrome | Any console error; any unexpected failed request; overflow; CLS > 0.1; interactive target < 24 × 24 CSS px (WCAG 2.2 AA; < 44 is a warning) |
| **G-A11Y** | Accessible and legible | axe-core from the project's own `node_modules` if present, injected into each G-UI page; otherwise the built-in subset: accessible names, `lang`, heading order, focus visible on Tab path, text contrast from computed colours; for glass surfaces, contrast against the lightest and darkest sampled backdrop pixel (CARTRIDGES §4.3) | G-UI pages | Any serious/critical axe violation; contrast below AA |
| **G-STACK** | Schema and migrations really apply | `psql -v ON_ERROR_STOP=1` (or the project's migrate command if confirmed) against the **local** DB: up, down (if the project has downs), up; then RLS check: every table named tenant-scoped in `auth_matrix.json` has `relrowsecurity = true` and ≥ 1 policy per command it allows | `kriya stack use --db`, `psql` | Apply error; down/up mismatch (schema dump differs); missing RLS/policy |
| **G-API** | The API matches its contract and survives bad input | For each operation in `api.openapi.json` with `x-kriya-example`: call it on the local app, validate the response against the schema. Seeded boundary inputs (missing required, wrong type, min/max ± 1, oversized string) must give 4xx, never 5xx. Operations marked `x-kriya-idempotent` receive the same request with one `Idempotency-Key` ×10 concurrently: all responses equal and the `x-kriya-count` endpoint shows one effect. p50/p95 latency recorded, not gated | App URL | Schema mismatch; any 5xx on bad input; idempotency violated |
| **G-TENANT** | No tenant can read or change another's data | Two local test identities (A, B) from the seed the security step writes (`.kriya/gates/tenants.json`: how to sign each in against the **local** app). The gate first proves A ≠ B (two different subjects from the auth endpoint in the matrix). For every tenant-scoped resource × action: **positive control** (B on B's object ⇒ 2xx) and **probe** (A on B's object ⇒ 403/404, and B's object unchanged after the call) | App URL, seed | Any probe that succeeds; any positive control that fails (a server that refuses everything is not "secure") |
| **G-SAST** | Known dangerous code patterns | `semgrep scan --config <local rules file> --error --json --metrics off`, where the rules file is one the project already has (`.semgrep.yml`, `.semgrep/`) or one the person confirmed with `kriya stack use --sast <file>`. Never `--config auto` or a registry config: those fetch rules over the network. No local rules or no Semgrep ⇒ `not_checked` | Semgrep, local rules | Findings at ERROR |
| **G-SECRETS** | No secret enters the diff | Built-in scan of changed lines: provider key prefixes, private-key headers, high-entropy (Shannon ≥ 4.5 over ≥ 32 chars) strings in assignments; `gitleaks detect --no-git --source <changed files>` additionally if installed | Nothing | Any finding (the excerpt shows file:line, **never** the value) |
| **G-FLAKE** | The suite is deterministic | The confirmed check 3× in a row (parallel where the runner has a flag the cartridge names from a fixed list); compare per-test outcomes from the runner's JSON/JUnit output if available, else exit codes | Check command | Any difference between runs |
| **G-TRACE** | Every acceptance item is tested | Map each `done_when` clause id and threat-model `test` to a test name in the runner's report of **this** verify | Runner report | An item with no passing test |
| **G-DATA** | Pipelines are idempotent | Run the confirmed pipeline command twice on the project's dirty fixture into a temp output; compare row counts and a content hash per output | Fixture, command | Any difference; any contract violation the pipeline reports |
| **G-EVAL** | A model change beats its baseline | Run the confirmed eval command; read its metrics JSON; compare to `~/.kriya/evidence/<project>/baseline.json` with the direction and margin the eval file declares | Eval command | Regression beyond margin. First run records the baseline and returns `not_checked` |
| **G-SAN** | Native code is memory- and race-safe | The confirmed build with warnings-as-errors; sanitizer builds/runs (ASan, TSan, UBSan) if the toolchain supports them; binary size against the plan's cap | Toolchain | Warning, sanitizer report, size over cap |
| **G-IAC** | Infrastructure is least-privilege and planned | The IaC tool's offline validate/plan; policy tool (Checkov/OPA) if installed; container build if a runtime is present; image scan with an installed scanner | Tools | Policy failure, build failure, critical CVE |
| **G-SIM** | Mobile builds and survives lifecycle | Simulator/emulator build and launch with the installed toolchain; offline → online drill via the project's UI test target if it has one | Toolchain | Build/launch failure, drill failure |
| **G-3D** | A WebGL scene renders, stays within budget, survives context loss, doesn't leak | THREE_D_AND_CREATIVE §4: init-script–wrapped WebGL contexts (counts by the gate, not the app), not-blank and alive checks, draw/primitive/byte budgets, mount-unmount-mount leak check, forced context loss, resize/DPR, reduced motion; frame time reported, never gated | Agent browser with WebGL | Any GL or console error; blank canvas; over budget; leak; no recovery after context loss |
| **G-RELEASE** | A production build is ready to leave the machine | DELIVERY_AND_STABILITY §2 | `kriya release use` | Any release line |
| **G-DEPLOYED** | A deployment answers correctly | DELIVERY_AND_STABILITY §4 (GET/HEAD to the captured host only) | A captured deploy URL | Non-2xx, wrong content, invalid TLS, a configured header missing |
| **G-SIM-HEADLESS** | Game simulation is deterministic and fast | The project's headless sim entry, 10,000 ticks with a fixed seed, twice; compare final state hashes; frame-time median from its output | Entry point | Hash mismatch; median over budget |

## 4. Contract schemas

Shipped in the client as JSON Schema files (`contract/schemas/*.json`,
draft 2020-12). Validated with **ajv**, already a direct dependency of
`kriya-harness` (`ajv@8.17.1`, MIT; `npm ls ajv`, 2026-11-23), imported from
its 2020 entry point. No new dependency. Spike S3 only confirms the 2020
dialect loads under the pinned version.

## 5. Interface

```js
/** @typedef {{ id: string, status: "pass"|"fail"|"not_checked", class?: string, excerpt?: string, reason?: string, evidence?: string[] }} GateResult */
/** @param {{ cwd, sessionId, step, role, attempt, run, stack, contracts, ledger, signal }} ctx */
export async function runGates(ctx) /* → GateResult[] in catalogue order */
```

`verifyStep` combines: step passes ⇔ the person's check exits 0 ∧ every
gate result is `pass` or (`not_checked` and not in `REQUIRED[role]`). The
first failing gate's class and excerpt become the builder's feedback (v2
excerpt rules, ≤ 2,500 chars). Every result goes to the ledger and the
progress file's run record, which is what KriyaBench and KRHE read.

## 6. Gate quality is measured too

A gate that lets wrong work through raises `f` (ARCHITECTURE §1). Each gate
ships with **mutants**: fixture repositories where a known defect is
planted (an IDOR, an overflow, a missing RLS policy, a flaky test). WT-GATE-
tests require every gate to fail on every one of its mutants and pass on the
clean fixture. KriyaBench's `radius-mutants` pattern (`harness_upgradation/
bench/radius-mutants-kriya.json`) is the precedent.
