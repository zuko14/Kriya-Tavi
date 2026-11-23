# The Orchestra: head model, worker model, advisor, critic, contracts, milestones

Part of Harness 2.0 (ARCHITECTURE.md). Client code in `kriya-harness`; one
additive server field. Switch `KRIYA_ORCHESTRA` (client, default off) and
`harness.workforce` (server, default off).

## 1. Roles of the two models

The owner picks a **head** tier and a **worker** tier in `/owner/config`
(`harness.orchestraHead`, default `escalation`; `harness.orchestraWorker`,
default `budget`). The models behind each tier are the owner's existing tier
settings (`modelForTier`). The client never sees a model id.

| Job | Model | Why |
| --- | --- | --- |
| Talk to the person, decompose into milestones and plans, write contracts (architect steps) | Head (the session itself) | Decomposition and contract design are where a weak model's errors multiply through every later step (ARCHITECTURE §1, series product). Measured pattern: delegation is reliable only when the orchestrator is strong (RESEARCH R-02) |
| Build one step from one cartridge, one contract slice, one goal | Worker | The narrowest, most constrained context; 75–85% of tokens by design |
| Answer a builder's question mid-step (`kriya_advise`) | Head, read-only, no file changes | The advisor pattern: the strong model is consulted at hard points and never acts (RESEARCH R-01) |
| Attempts after `E(role)` or when stuck | Head as builder | Surgical escalation inside the 4-attempt bound (ARCHITECTURE §5) |
| Critique a passing result against judgement items | Head, read-only | Fresh context with the spec and rendered evidence, not the builder's reasoning (RESEARCH R-05) |

If the person's plan allows only one of the two tiers, or the server sends no
advert, the orchestra is off for that session and everything runs on the
start tier exactly as 0.2.5 (logged once, `orchestra: unavailable`).

## 2. The seam

```js
// plugins/loop/index.js, inside loopHost.spawn (existing call, one new key)
const activation = await subagents.startActivation({
  provider: "spawn",
  label,
  request: {
    prompt: [{ type: "text", text: prompt }],
    parent: exec.agent,
    signal: exec.signal,
    maxDepth: 1,
    ...(tier && { agentOptions: { model: tier } }),   // new: an alias the plan allows
  },
  signal: exec.signal,
  delivery: "caller",
})
```

- `tier` comes from `orchestra.tierFor({ role, attempt, failures, profile })`
  (pure, `src/orchestra.js`) and is checked against `KRIYA_ALLOWED_TIERS`
  (already set by `launchEnv`). An alias outside the list is a programming
  error: thrown, never sent.
- Off: `tier` is `undefined`, the spread adds nothing, the request object is
  identical to 0.2.5 (WT-ORC-01 compares it structurally).
- `agentOptions` is accepted only by the `spawn` provider (FORENSIC R-06);
  the loop uses only `spawn`. A future change of provider fails WT-ORC-02.
- The bundle's `kriya` provider lists only allowed aliases as models
  (`bundle/cordis.patch.yml`), so DSH resolves `model: "budget"` the way it
  resolves the session's own start tier. **Proved by W0 spike S1**
  (2026-11-23): with the head on `balanced`, a child given `agentOptions:
  { model: "budget" }` sent every request as `budget`; a child without it
  inherited `balanced`.

## 3. Advisor tool `kriya_advise`

- Registered only for builders (`isBuilder(exec)`), only with the orchestra
  on. Input: `{ question: string ≤ 2,000 chars }`. Output: text ≤ 4,000 chars.
- Implementation: a `spawn` child on the head tier, **parented to the
  head** (the agent that called `kriya_step`), whose tool list is masked to
  read tools (`read`, `grep`, `glob`, `ls`) through the same `masks`
  mechanism JIT tools use. Settled by W0 spike S2 on the pinned DSH
  (2026-11-23, `kriya-harness/tests/workforce/spike-w0.test.js`): a builder
  spawning its own child is refused ("subagent depth 2 exceeds maxDepth 1");
  a child parented to the head, started from inside the builder's tool call
  while the head's own call is pending, runs, on the tier it is given; a
  mask set before `startActivation` removed the denied tool from the child's
  first request (30 → 29 tools).
- Bound: 2 calls per builder (counted in the builder's live record), 1
  minute each; a third call returns "Advice limit reached for this attempt".
- The advisor's answer is guidance to the builder, never evidence. It is not
  shown to gates, not stored as a rule, not mirrored as fact.

## 4. Milestones (long horizon)

Plans stay bounded (≤ 7 steps, ≤ 4 attempts). Long work is a sequence of
plans:

```
Milestones M = (m₁ … m_q), q ≤ 12, each m = { title, done_when, roles[] }
Ledger: ~/.kriya/progress/<project>/milestones.json   (outside the folder; written only by plugin code)
Status: s(m) ∈ {todo, active, done, blocked}; done ⇔ its plan's planStatus is done with every step pass
Advance: the head may call kriya_plan for m_{i+1} only when s(m_i) = done; blocked ⇒ stop and tell the person
```

- Two sessions in one project may run at once, so `milestones.json` is
  written atomically (temp file + rename, as `writeProgress` does) under a
  lock file with a 10-second stale timeout; a second writer waits or
  reports "another session is updating milestones".
- `kriya_milestones` (head only, once per project unless the person says
  "replan"): writes the list; a second call while one is active is refused
  the same way `kriya_plan` refuses a builder.
- Resume: a new session in the same project reads the ledger and the head is
  told, in the late system-prompt section, which milestone is active and its
  last verdicts. Nothing is replayed; the files and the ledger are the state.
- The milestone ledger records, per milestone: plan hash, step verdicts,
  contract hashes, checkpoint ref, tokens and cost per tier (from the live
  records). It is the "execution ledger" the intent puts in `status.md`
  (F-02), in the place the agent can't forge.

## 5. Contract bus

Contracts are files the head writes in **architect** steps, under
`.kriya/contracts/` in the project (so they are reviewable and versioned
with the code):

| Contract | Format | Validated by (code) |
| --- | --- | --- |
| `api.openapi.json` | OpenAPI 3.1, JSON | JSON parse + structural schema (paths, operations, `$ref`s resolve, every operation has `responses`, security schemes declared) |
| `schema.sql` | Postgres DDL | G-STACK applies it to the local database (`psql -v ON_ERROR_STOP=1`); without a local stack: `not checked`, never pass |
| `auth_matrix.json` | `[{ resource, action, roles[], tenantScoped: bool }]` | JSON Schema; every `tenantScoped` resource must appear in `schema.sql` with RLS enabled (checked by G-STACK) |
| `design_tokens.json` | W3C Design Tokens (DTCG) subset | JSON Schema; contrast pairs computed (CARTRIDGES §4.3) |
| `component_states.json` | `{ component: { states: ["loading","empty","partial","error","populated"] } }` | JSON Schema; G-UI renders each listed state |
| `threat_model.json` | `[{ asset, boundary, threat, control, test }]` | JSON Schema; every `test` must name a gate id or a test file that exists |
| `scene_direction.json` | `{ mood, palette, lighting, toneMapper, camera, motion, tiers, routes, references }` (THREE_D_AND_CREATIVE §3) | JSON Schema; tier budgets ≤ the code ceilings; owned by `designer` |
| `release.json` lives outside the project (`~/.kriya/release.json`), confirmed by the person (DELIVERY §2) | — | — |

Rules:

1. **Ownership by role.** Each contract has one owning role (architect for
   API/auth, database for SQL, designer for tokens/states, security for the
   threat model). After its owning step passes, the plugin records
   `sha256(file)` in the ledger.
2. **Drift is a failure class.** Before a non-owning step's verify, current
   hashes are compared; any change ⇒ the run is recorded as class
   `contract changed` (rank 3, beside `tests changed`), the excerpt names
   the file. The builder is told to build to the contract or report that the
   contract is wrong; only a new architect step (planned by the head) may
   change it.
3. **Slices, not dumps.** A builder gets only the contract parts its step
   names (`step.contracts: ["api#/paths/~1orders", "tokens#color"]`), via
   JSON Pointer. Slices are deterministic, so prompts are byte-stable.
4. **Shared types are generated, not written twice.** Where the project
   already has a generator (e.g. `openapi-typescript`, `supabase gen
   types`), the cartridge's gate config names it and G-CONTRACT checks the
   generated file is current. Kriya adds no generator dependency.

The token saving the intent predicts (70–85%) is a hypothesis measured in
EVALUATION_PLAN E-4 from the gateway's recorded `prompt_tokens`, never
assumed.

## 6. Byte-stable prompts (KV-cache prefixing)

Builder prompt order, fixed:

```
[1] cartridge text for the role (versioned, identical across builders of that role)
[2] confirmed project rules (v2)              — stable within a session
[3] contract slices for this step             — stable within the step
[4] the plan and this step                    — stable within the step
[5] attempt-specific: previous failure class + excerpt, advisor note, critic defects
```

Nothing variable (time, attempt number, ids) appears before [5]. Providers
that cache prompt prefixes can reuse [1]–[4] across attempts and across
steps of one role; whether they do is read from `cached_tokens`
(`lib/harness/metering.ts`), reported per tier in the ledger, and is
`unknown` for a provider that doesn't report it. Moving the existing
`builderPrompt` sections into this order is a change to v1/v2 text, so it
happens **only with `KRIYA_CARTRIDGES` on** (off: the 0.2.5 text, WT-REG-02).

## 7. Adversarial passes as plan shape, checked by code

The intent's Pass 3 (critique in isolated contexts) is realised as **step
roles and DAG order**, which code can check, rather than as more agents
talking:

| Rule | Check (in `validatePlan` with cartridges on) |
| --- | --- |
| Spec tests before code | A `qa` step marked `spec_tests: true` must have no `after` edge to the implementation steps it covers, and they must have an edge to it. The QA builder therefore runs before the code exists and writes tests from contracts and `done_when` only |
| A spec step is judged **red**, not green | Its tests can't pass before the code exists, so a normal verify would block it forever. With `spec_tests: true`, `verifyStep` uses `expect: "red"`: pass ⇔ (1) the step changed only check files (`checkFiles`), (2) the check now fails, (3) the check with the new files moved aside passes (`onOriginals`, the strict loop's existing red-phase proof), (4) the failure isn't class `syntax` in a new test file. The implementation steps after it are then judged green as usual, and v2's originals re-run stops them weakening those tests |
| Tests can't be weakened later | Existing v2 originals re-run: a later step that edits the QA step's test files and passes only on its own versions is recorded as `tests changed` |
| A tenant-scoped resource gets a probe | If `auth_matrix.json` has a `tenantScoped` entry, the plan must contain a `security` step whose gates include G-TENANT; otherwise `kriya_plan` returns the missing step as an error to the head |
| UI work gets rendered | A `frontend`/`mobile` step's gates always include G-UI (where a dev server is confirmed) |

The head can still plan anything else; these four rules only refuse plans
that would skip the checks the cartridges promise.

## 8. Failure handling

| Failure | Handling |
| --- | --- |
| Gateway refuses the head tier (`tier_not_allowed`, plan changed mid-session) | `tierFor` falls back to the worker tier for the rest of the session; logged in the ledger |
| `cap_reached` | Existing behaviour: the step stops, the ledger says why, the person is told |
| Advisor or critic times out | Treated as no advice / no defects; never blocks a pass |
| Worker stalls (same signature, no file changed) | One head-tier attempt instead of the stall, if attempts remain and the head hasn't tried (ARCHITECTURE §5) |
| Head builder also fails twice on the same signature | Step `blocked` (existing rule); the ledger records both tiers' attempts for KRHE |
| Network loss mid-milestone | Files and ledger persist; resume reads them (§4) |
