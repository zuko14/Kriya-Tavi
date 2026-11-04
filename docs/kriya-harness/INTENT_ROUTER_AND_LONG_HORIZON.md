# Kriya Harness: the intent router and long-horizon work on a small window (H20)

Status: **built in the client behind switches (default off), tested on the
real pinned DSH with a scripted model; not yet measured on a real model**
(2026-11-04). Owner request in chat (2026-11-04): skill and tool selection
"based upon the tasks … very advanced", and "the long horizon task should be
perfectly done … our default model context window is very light". Track H
rules and AGENTS.md apply in full; nothing here changes a risk class, an
approval, a limit or a price.

## 1. What the evidence already said

- **Hiding tools hurt this model.** KriyaBench §6.4: the minimal tool list
  plus the loop (B5) lost 0–5 to the full list plus the loop (B4), and
  solved neither hard task. So the router hides nothing and adds no tool:
  it only points.
- **The catalog is long and costs every request.** On the owner's machine
  the Skills page reports about 7,600 tokens for 100 skills on every
  request; the model must pick from all of them on its own.
- **Long tasks lose their place in summaries.** HU-M-06: a compaction
  summary that drops a requirement loses it unless `--anchor` keeps the
  person's words. A plan's progress had no such protection.
- **Windows.** Kriya caps the working window at 262,144 tokens
  (KU-ADR-09); a tier with a smaller window gets earlier compaction.

## 2. The intent router (`--router`, `KRIYA_ROUTER`, default off)

For the person's newest message, code (no model call) writes a brief into a
late system-prompt section (after DSH's sections, so their cached prefix is
unchanged):

```text
Routing for this request, chosen by Kriya Harness from its words (a hint, not a rule):
Intent: fix a failure; tests.
Skills likely to help: kriya-debug. Load the ones that fit with the skill tool before you start.
Start with: kriya_verify (reproduce the failure first), grep (find where it happens), read (read the code), edit (fix the cause once).
Finish with kriya_verify: only its result says the work passes.
```

| Part | How | File |
| --- | --- | --- |
| Skills | BM25 (k1 1.2, b 0.75) over each live-catalog skill's name (counted twice), description and when-to-use, with the request plus its intent labels as the query; top 4 with a positive score; skills the model can't invoke are never named | `src/intent.js` `rankSkills` |
| Intent | Nine fixed classes (fix, build, test, refactor, web, review, explain, git, security) by word matches; short words only as whole words ("pr" isn't "print"); at most two | `classify` |
| Tools | Each class's starting tools, in order, named only if this agent has them (`ctx.tools.schemas`) | `brief` |
| Catalog | `ctx.skills.list({ cwd, scope })`, read when the plugin starts (awaited, at most 3 s) and on every message; the prompt section is synchronous, so it uses the newest copy | `plugins/router/index.js` |

Bounds: at most 700 characters, one per agent, the person's own messages
only (never tool output). Deterministic.

**Found while testing on the real DSH.** The first build left the brief
without skills on a headless run's first request: the catalog read (about
0.1 s) finished after DSH assembled the prompt. The plugin now awaits its
first read at start. A stemming bug ("debugging" → "debugg") hid
`systematic-debugging` from "debug"; doubled final consonants are now
collapsed.

## 3. Long horizon on a small window (`--loop-v2`)

The loop already keeps long work out of the chat: each plan step is built
by a fresh builder with only the goal, the plan and its step (short
contexts), the check's results live in `~/.kriya/progress/`, and
checkpoints keep every step's files. What was missing was telling the
*parent* agent where it is after a compaction. Loop v2 now adds a late
system-prompt section, per agent, from the loop's own records:

```text
Where this task stands, kept by Kriya Harness from its own check runs (it outranks any summary of the conversation):
Goal: Ship the report
1. Parse: passed (2 runs)
2. Render: not started
Next: kriya_step with step 2.
Last check: 1 Parse, passed.
```

The system prompt is never compacted, so this survives any number of
summaries; it changes only when a step's state does.

## 4. Evidence (real pinned DSH, scripted model; nothing left the machine)

| Test | What it shows |
| --- | --- |
| **HU-M-11** (`tests/long-horizon-run.test.js`) | A four-step plan on a **32k-token window**, a context overflow in the middle and a compaction whose summary forgets the plan. Both arms finish (exit 0, 4/4 files). Only with `--loop-v2` does the next request show the state: `stateShown`, `1. … passed`, `2. … passed`, `Next: kriya_step with step 3.` all true; without it all false |
| IR-RUN-01 (`tests/intent.test.js`) | `kriya run --router` puts the brief in the real prompt from the real catalog: names `kriya-debug`, not `gst-invoices`, starts with `kriya_verify`; off, no brief |
| IR-01…05 | Tokens, BM25 ranking, intent classes, the brief's bounds and determinism, the router's per-agent state |
| KV2-LS-01 | The state text from real records |

Client `npm run check` **238/238, exit 0**.

## 5. What this can't show yet, and how to measure it

A scripted model doesn't need memory or hints, so these tests prove what a
real model is *shown*, not that it does better. The measurement:

- **KriyaBench-R, long-horizon set:** the multi set (5 tasks, visible
  tests) plus the capability set, on the budget tier with its window forced
  small (`KRIYA_MODEL_LIMITS` at 32k), arms B4 vs B4 + `--loop-v2` vs
  B4 + `--loop-v2 --router`, K = 3 interleaved; report pass, paired sign
  test, cost per pass, compactions per task. Estimate ₹200–300 (one B4 arm
  cost ₹60.04 on 21 task-runs). Needs the owner's go-ahead.
- **Skill selection:** the H7 skill-selection eval with and without the
  router, on a real model (paid, small).

Until then both switches stay off (track H rule 2). KRHE
(`RECURSIVE_HARNESS_EVOLUTION.md`) can probe them as candidates: its
profile would need `router` as a field (a one-line change once measured).

## 6. Not built (and why)

- **Hiding skills or tools per task:** evidence says it costs passes
  (§1); revisit only with a measured win.
- **A model-written routing step:** costs a call per message and its
  choice can't be checked; the deterministic brief costs nothing.
- **Catalog shortening** (only the top skills described in full): changes
  DSH's own catalog text every turn and breaks its cached prefix; worth it
  only if the router proves itself first.
