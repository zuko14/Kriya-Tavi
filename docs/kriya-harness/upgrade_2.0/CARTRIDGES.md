# Role cartridges: how a top-1% engineer works, as data the harness enforces

Part of Harness 2.0. Server data in `skills-harness/kriya-role-*/`, served
to devices only with `harness.workforce` on, mounted one per builder by the
client only with `KRIYA_CARTRIDGES` on.

## 1. What a cartridge is, and what it is not

A cartridge is a library skill (`SKILL.md` + `kriya.json`, the format
`buildCatalog` already validates, **unchanged**) plus a sibling
`cartridge.json`. `kriya.json`'s schema is a `z.strictObject`
(`lib/skill-library.ts` `manifestSchema`), so the cartridge block can't live
inside it without changing the cloud catalogue's validator; a separate file
validated by `lib/harness/cartridges.ts` keeps `lib/skill-library.ts`
untouched. **As built (W1):** the file lives at
`skills-harness/cartridges/<id>.json`, not inside the skill's folder,
because the skill loader refuses any folder holding a file it doesn't read
(`lib/skill-engine.ts` `audit`, REAUDIT RA-30). It holds
four kinds of content, ranked by how much the harness can rely on them:

| Kind | Enforced by | Can a model skip it? |
| --- | --- | --- |
| **Gates** (ids from the client's catalogue, GATES.md) | Exit codes | No: pass needs them |
| **Detectors** (ids of fixed static checks) | `G-DETECT`, severity `error` fails, `warn` is feedback | No for `error`; `warn` is advice |
| **Judgement items** (taste the code can't measure) | The critic, after hard pass; one polish attempt; monotone | Yes, but only after correctness is locked |
| **Guidance** (`SKILL.md`: mental model, method, examples) | Nothing: it is text | Yes: this is why the other three exist |

A cartridge **never** contains: a shell command, a URL to fetch, a tool
name, a risk class, a mode, a limit, a price, or a gate pass condition.
`lintCartridge` (server, SELF_EVOLUTION §7) refuses one that does.

## 2. Schema (`cartridge.json`, zod `z.strictObject`, `lib/harness/cartridges.ts`)

```ts
// cartridge.json
{
  role: "frontend" | "backend" | "fullstack" | "mobile" | "game" | "devops" | "cloud"
      | "systems" | "data" | "ml" | "security" | "qa" | "sdet" | "database" | "designer"
      | "architect" | "graphics",
  owns: ContractName[],                 // contracts this role may write (ORCHESTRA §5)
  reads: ContractName[],                // contracts its builders get slices of
  gates: GateId[],                      // ≥ 1 for every role except architect/designer (G-CONTRACT)
  detectors: { id: DetectorId, severity: "error" | "warn" }[],
  judgement: { id: string, ask: string /* ≤ 200 chars */, severity: "major" | "minor" }[],  // ≤ 12
  escalateAfter?: 0 | 1 | 2 | 3 | 4,    // default 2; KRHE may tune it per profile
  maxPromptChars: number,               // ≤ 6,000; the cartridge text budget (attention, cost)
  globs: string[],                      // ≤ 20 simple globs (*, **, names) that point a step at this role (§5)
}
```

Each cartridge's `kriya.json` is an ordinary manifest: `categories:
["engineering"]`, `roles` as `kriya-visual` has them (`engineer`, `developer`,
`coder`, `code`), no tools, `limits.maxChars` = the cartridge's
`maxPromptChars`, and the two or more `evals` `manifestSchema` requires.

`role` enum, `GateId`, `DetectorId` and `ContractName` are exported from
`lib/harness/cartridge-ids.ts` (server, source of truth), exported into
`docs/kriya-harness/contract.json` and copied into the client's `contract/`
folder, the way the harness contract is shared today. A cartridge naming an
id the client doesn't have is refused at catalogue build time on the server
and skipped (with a log) on an older client.

## 3. The sixteen cartridges

The fifteen below plus `kriya-role-graphics` (3D, WebGL, three.js), designed
in THREE_D_AND_CREATIVE.md §2.

Each row: the principal's mental model in one line, the rules the harness
enforces, the detectors (static, fixed code), the gates, and the judgement
items the critic checks. Full text goes in each `SKILL.md`
(≤ `maxPromptChars`).

### 3.1 `kriya-role-frontend`

- **Mental model:** a screen is a state machine before it is markup; data
  ownership (server cache vs local UI state) is decided first.
- **Rules:** every component in `component_states.json` renders all five
  states; tokens only (no raw colour/size in components); keyboard path for
  every control; optimistic updates roll back on error; no request waterfall
  where data is known up front.
- **Detectors:** `FE-HEX` raw colour literal outside the token file (error);
  `FE-PX` spacing not on the 4-px grid (warn); `FE-IMG-ALT` `<img>` without
  `alt` (error); `FE-CLICK-DIV` click handler on a non-interactive element
  without role and key handler (error); `FE-FETCH-EFFECT` fetch in a render
  effect with no abort (warn).
- **Gates:** G-UI, G-A11Y, G-DETECT, project check.
- **Judgement:** visual hierarchy reads in one glance; one primary action
  per view; empty and error states say what to do next; motion has purpose.

### 3.2 `kriya-role-designer` (product designer: taste)

Owns `design_tokens.json` and `component_states.json`. Details in §4.

### 3.3 `kriya-role-backend`

- **Mental model:** design the failure modes first: duplicate request,
  concurrent write, timeout, partial failure, malicious input.
- **Rules:** transport → service → repository layering; every mutating
  endpoint takes an idempotency key or is naturally idempotent; explicit
  timeouts on outbound calls; validation at the boundary (the project's
  schema library); paginated lists; structured logs with a correlation id
  and no secrets or personal data.
- **Detectors:** `BE-SQL-INTERP` SQL built by string interpolation (error);
  `BE-EMPTY-CATCH` empty or swallow-only catch (error); `BE-NO-TIMEOUT`
  `fetch`/HTTP client call without timeout or signal (warn); `BE-LOG-SECRET`
  logging of an identifier named like a secret or token (error).
- **Gates:** G-API, G-STACK, G-DETECT, project check.
- **Judgement:** error responses are typed and don't leak internals;
  business rules live in the service layer.

### 3.4 `kriya-role-fullstack`

- **Mental model:** one source of truth for every type that crosses the wire.
- **Rules:** client types generated from the contract; session propagated
  server-side; a feature lands as a vertical slice (schema → API → UI →
  test) in one plan.
- **Detectors:** `FS-DTO-DUP` a type declared on both sides with the same
  name and fields where a generated file exists (warn); `BE-SQL-INTERP`.
- **Gates:** G-CONTRACT (generated types current), G-STACK, G-UI, G-API.
- **Judgement:** no raw database column names in the UI.

### 3.5 `kriya-role-mobile`

- **Mental model:** the network is down, the OS will kill you, the thumb is
  on the notch.
- **Rules:** local-first writes with an idempotent sync queue; lifecycle-
  aware listeners; safe-area insets; permission-denied paths; no synchronous
  I/O on the main thread.
- **Detectors:** `MB-SYNC-IO` synchronous file/network APIs in UI code
  (error, per platform list); `MB-HARDCODE-DIM` fixed screen sizes (warn).
- **Gates:** G-SIM (simulator build + launch + offline→online drill where the
  toolchain exists, else `not checked`), G-UI at 390 px for web views.
- **Judgement:** touch targets ≥ 44 pt; gestures have visible alternatives.

### 3.6 `kriya-role-game`

- **Mental model:** a frame budget (16.6 ms at 60 fps, 8.3 ms at 120 fps),
  a fixed-timestep simulation, rendering apart from rules.
- **Rules:** fixed timestep with accumulator; no allocation in `update`/
  `tick`; object pools; seeded RNG; input buffered per tick.
- **Detectors:** `GM-ALLOC-TICK` `new`/array/object literals inside a
  function named `update|tick|fixedUpdate` (warn: heuristic); `GM-DT-MISSING`
  movement without a delta-time factor (warn).
- **Gates:** G-SIM-HEADLESS (10,000 seeded ticks twice: identical state hash;
  frame-time median under the budget on the project's own bench script).
- **Judgement:** game feel (input latency, feedback) is described in the
  plan's `done_when`, not left to chance.

### 3.7 `kriya-role-devops`

- **Rules:** multi-stage builds; pinned base images by digest; health and
  readiness endpoints; backward-compatible migrations (expand → migrate →
  contract); no secrets in images or logs.
- **Detectors:** `OPS-LATEST` `:latest` or unpinned base image (error);
  `OPS-SECRET-ENV` secret-like literal in Dockerfile/CI file (error);
  `OPS-MIGRATE-LOCK` `ALTER TABLE … ADD COLUMN … NOT NULL` without default,
  `CREATE INDEX` without `CONCURRENTLY` on an existing table (warn).
- **Gates:** G-IAC (build in the person's container runtime if present;
  image scan with the scanner the project has), G-SECRETS, G-STACK migration
  up/down.
- **Judgement:** rollback is one command and is written down.

### 3.8 `kriya-role-cloud`

- **Rules:** infrastructure as code; private subnets for state; least-
  privilege IAM; encryption at rest and in transit; autoscaling with a spend
  ceiling.
- **Detectors:** `CL-IAM-STAR` wildcard action or resource (error);
  `CL-PUBLIC` public bucket/DB/ingress `0.0.0.0/0` on non-HTTP ports (error).
- **Gates:** G-IAC (`plan` only, never `apply`; policy-as-code with the
  project's tool, e.g. Checkov/OPA, else `not checked`). **No cloud call
  with the person's credentials is ever made by a gate**; `plan` runs only
  when the project's IaC tool supports an offline/local plan, else
  `not checked`.
- **Judgement:** blast radius of each component is written in the plan.

### 3.9 `kriya-role-systems` (systems / embedded)

- **Rules:** explicit ownership and lifetimes; bounded buffers; no
  allocation in real-time paths; deadlock-free lock order; watchdogs.
- **Detectors:** `SY-UNSAFE-NOCOMMENT` `unsafe` block without a `SAFETY:`
  comment (warn); `SY-SPIN` busy-wait loop without backoff (warn).
- **Gates:** G-SAN (`-Wall -Wextra -Werror` / `clippy -D warnings`, ASan +
  TSan runs where the toolchain supports them), size caps from the plan.
- **Judgement:** every `unsafe` has a stated invariant.

### 3.10 `kriya-role-data`

- **Rules:** idempotent, partitioned, backfill-safe jobs; explicit data
  contracts; dead-letter path for bad rows; no analytical scan on the live
  OLTP database.
- **Detectors:** `DT-INSERT-NOKEY` `INSERT` without `ON CONFLICT` /
  `MERGE` in a job file (warn).
- **Gates:** G-DATA (run the pipeline twice on the project's dirty fixture;
  identical outputs and row counts; zero contract violations).
- **Judgement:** lineage of each output column is stated.

### 3.11 `kriya-role-ml` (ML / AI engineer and researcher)

- **Mental model:** a baseline first; leakage is the default failure; an
  offline score is not an online guarantee.
- **Rules:** split isolation by entity and time where relevant; versioned
  data, prompts and weights; seeds fixed; structured decoding of model
  output; latency, memory and token budgets stated; a change ships only if it
  beats the recorded baseline on the held-out set.
- **Detectors:** `ML-FIT-TEST` fitting or tuning on a variable named like the
  test split (error, heuristic on names in the project's scripts); `ML-SEED`
  training entry point without a seed (warn).
- **Gates:** G-EVAL (the project's eval script on the held-out set; compares
  the metric file to the stored baseline; regress ⇒ fail). The harness never
  invents a metric or a baseline: without a recorded baseline the first run
  records one and the step is `not checked` for "beats baseline".
- **Judgement:** the report states the comparison, the interval and what
  the metric doesn't capture.

### 3.12 `kriya-role-security`

- **Mental model:** every input is hostile; every signed-in user will try
  another tenant's id.
- **Rules:** authN + authZ + row-level security (defence in depth); identity
  from the verified session only, never from a body or query parameter;
  parameterised queries; CSP/CORS headers set explicitly; no custom crypto.
- **Detectors:** `SEC-BODY-ID` a `user_id`/`tenant_id` read from request
  body or query and used in a query (warn: heuristic); `BE-SQL-INTERP`;
  `SEC-EVAL` `eval`/`new Function`/shell with interpolated input (error).
- **Gates:** G-TENANT (cross-tenant probes from `auth_matrix.json`), G-SAST
  (Semgrep if installed, else `not checked`), G-SECRETS.
- **Judgement:** the threat model's every row has a control and a test.

### 3.13 `kriya-role-qa`

- **Mental model:** equivalence classes, boundaries, nulls, the unhappy path.
- **Rules:** writes spec tests **before** the implementation exists
  (ORCHESTRA §7); one test per acceptance criterion, named after it; negative
  and boundary cases for every input.
- **Detectors:** `QA-ONLY` `.only`/`fit`/`fdescribe` (error); `QA-SKIP`
  newly skipped test (warn).
- **Gates:** G-TRACE (every `done_when` and threat-model `test` maps to a
  test that ran and passed in this verify, by name), project check.
- **Judgement:** each bug report carries a reproduction.

### 3.14 `kriya-role-sdet`

- **Rules:** hermetic tests; fixed clocks and seeds; no `sleep` waits; no
  shared mutable state; role/label selectors over CSS paths.
- **Detectors:** `SD-SLEEP` fixed sleeps in tests (error); `SD-XPATH`
  absolute XPath / nth-child selectors (warn).
- **Gates:** G-FLAKE (the suite 3× in a row, in parallel where the runner
  supports it; any differing result ⇒ fail with the flaky test names).
- **Judgement:** test runtime stays within the plan's stated ceiling.

### 3.15 `kriya-role-database`

- **Rules:** RLS on every tenant table with a policy per operation;
  constraints in the database (not only in code); indexes for every foreign
  key and filtered column; reversible migrations; no destructive change
  without a two-step plan.
- **Detectors:** `DB-NO-RLS` `create table` in a tenant schema without
  `enable row level security` in the same migration (error);
  `DB-FK-NOINDEX` foreign key without an index (warn); `DB-DROP` `drop
  table`/`drop column` without a recorded backfill step (warn).
- **Gates:** G-STACK (apply up, apply down, apply up again on the local
  database; `EXPLAIN` the queries the plan names), G-TENANT.
- **Judgement:** naming is consistent; migrations are small.

`kriya-role-architect` is the guidance for architect steps (the milestone
and contract method). Its builders always run on the head tier
(`escalateAfter: 0`, fixed in code for this role, not data), and its gate is
G-CONTRACT. Contract design is where a cheap model's mistakes multiply
through every later step (ARCHITECTURE §1).

## 4. Taste for interfaces, made checkable (designer + frontend)

### 4.1 Direction before pixels

The designer step picks one **direction** from a fixed table and records it
in `design_tokens.json` (`$extensions.kriya.direction`). The table maps a
product archetype to density, type scale, colour temperament and motion
level, so a cheap model chooses among principled options instead of
defaulting to its training average:

| Archetype | Density | Type scale ratio | Colour | Motion |
| --- | --- | --- | --- | --- |
| Developer tool | Compact (4-px base) | 1.200 | Neutral, one accent | Minimal |
| Finance / data dashboard | Compact | 1.200 | Neutral; semantic red/green with non-colour cues | Minimal |
| Consumer / social | Comfortable (8-px) | 1.250 | Expressive brand hue + neutrals | Playful, short |
| Editorial / content | Spacious | 1.333 | Restrained, high-contrast text | Subtle |
| Commerce | Comfortable | 1.250 | Brand + strong CTA colour | Purposeful |
| Native-feeling app (glass material) | Comfortable | 1.250 | Vibrant content behind translucent controls | Fluid, spring |

### 4.2 Token rules (G-DETECT and G-CONTRACT check them)

- Spacing scale from the base (4 or 8 px); radius scale ≤ 5 steps.
- Type: one family for UI, at most one for display; sizes from the ratio;
  `clamp()` for fluid sizes; body line length 45–75 characters; line height
  1.4–1.6 for body. Fonts must have a licence that permits the use (OFL,
  Apache-2.0, or the platform's system font); a font without one is
  refused by `lintCartridge` and by `FE-FONT-LICENCE` (track E rule 8's
  licence gate, reused).
- Colour as semantic tokens (`surface`, `on-surface`, `accent`, `danger` …)
  defined in OKLCH or hex, both light and dark; every `on-*`/`*` pair is
  listed and its contrast computed: text ≥ 4.5:1, large text and UI
  boundaries ≥ 3:1 (WCAG 2.2 AA).
- Motion: durations 100–400 ms by distance; enter ease-out, exit ease-in,
  springs for direct manipulation; everything non-essential disabled under
  `prefers-reduced-motion`.

### 4.3 Glass material (the style Apple calls Liquid Glass)

Apple's guidance (RESEARCH R-08): glass is for controls and navigation that
float above content, not for content itself; it changes with Reduce
Transparency and Increase Contrast, and custom elements must provide those
fallbacks themselves. As rules:

- Glass only on the navigation/control layer (`role` toolbar, navigation,
  dialog chrome, floating buttons); `FE-GLASS-CONTENT` warns on glass behind
  long text.
- Required fallbacks, checked by `FE-GLASS-FALLBACK` (error):
  `@supports not (backdrop-filter: blur(1px))`, `@media
  (prefers-reduced-transparency: reduce)` and `@media (prefers-contrast:
  more)` each give an opaque or near-opaque surface.
- Text on glass must meet contrast against the **worst** backdrop it can
  sit on: G-A11Y samples the backdrop region in screenshots at each scroll
  stop and computes contrast against the lightest and darkest sampled
  luminance; the minimum must pass AA.
- No copied Apple assets, icons or SF Symbols in non-Apple targets; Kriya
  ships no third-party design assets (licence gate).

### 4.4 Banned tropes (detector `FE-TROPE`, warn → critic major)

Placeholder text left in (lorem ipsum); emoji as icons; more than one icon
set; three identical feature cards as the only content; a gradient as the
only brand signal; drop shadows on every surface; centred body paragraphs;
disabled buttons without a reason shown.

The judgement items (hierarchy, rhythm, restraint, focus) are where taste
lives that code cannot measure. They run only after G-UI and G-A11Y pass
and can only trigger one monotone polish attempt (ARCHITECTURE §4).

## 5. Selection: which cartridge a builder gets

1. If the head wrote `role` on the step (enum, validated), that role.
2. Else, deterministic: file globs of `step.files` (e.g. `*.sql` →
   database, `*.tsx`/`*.css` → frontend, `Dockerfile`/`*.tf` → devops/cloud)
   then BM25 over role descriptions (`rankSkills`, existing) with the step's
   `title` + `done_when`; ties go to the role with more gates.
3. Exactly one cartridge per builder (the intent's Pillar 1). Cross-cutting
   rules (security, database) reach other roles only as their detectors and
   gates, not as extra text.
