# Evaluation plan (track E)

"Better than Claude Code with Opus 5.5" is a claim, so it needs a test that could
fail. The method follows `docs/kriya-harness/harness_upgradation/BENCHMARK_PLAN.md`:
paired runs, intervals, cost per success, and no claim beyond the data.

**KriyaEditBench-R has not been run.** Every Q, C and L number here is a target or a limit,
and no comparative claim exists. KriyaEditBench-M runs today (`npm run bench:m`), with results
in `bench/edit/results/` in the client; it says what the harness does around a scripted
model, and nothing about how good an edit is.

## 1. Two suites

| Suite | Measures | Model | Cost | Where |
| --- | --- | --- | --- | --- |
| **KriyaEditBench-M** (mechanics) | What the harness does around a model: gates catch defects, jobs resume, plans compile, budgets hold, every job ends in a verdict | Scripted, deterministic | Free; real FFmpeg, so about half an hour, not in `npm run check` | `tests/edit/bench-m/`, `npm run bench:m` |
| **KriyaEditBench-R** (real) | Finished edits on real models, judged by people | The plan's tiers and the competitor's | Paid; owner's go-ahead per run | `bench/edit/` |

## 2. Arms (R)

| Arm | Configuration | Question it answers |
| --- | --- | --- |
| **A1** | Kriya Harness, `budget` tier, Flash-1017 | The product, cheap |
| **A1m** | Kriya Harness, `balanced` tier, a medium model the owner picks | The product, medium |
| **A2** | Claude Code, Opus 5.5, with `video-use`, the HyperFrames skill and `ffmpeg-skill` installed as their READMEs say | The strongest public stack: the baseline to beat |
| **A3** | Claude Code, Opus 5.5, no video skill | The floor. The awesome list found a skill-free run passed its 4 basic checks |
| **A4** | Kriya Harness with Opus 5.5 behind a staging tier | How much is the harness, how much the model |
| **A5** | The same cheap model in a free agent loop: DSH's tools, the same skills, no Director | Does the Director earn its place? |

A5 against A1 tests the central bet in DIRECTOR_AND_AGENT §2. If A1 doesn't beat
A5, the Director is a cost with no benefit, and the design must change.

Ablations of A1 keep each mechanism honest: no tournament, no fidelity ladder, no
blind reviewer, no round-trip gate. Whatever doesn't pay for itself is removed.

Each arm gets the same footage, the same written brief, the same time limit, and
a single human reply where the arm asks a question, from a fixed script. Versions
of every tool and the resolved model id are recorded per run.

## 3. Task set

Corpus: footage the owner shot or has signed releases for. **No scraped or
downloaded footage.** Sizes are decided when the corpus is built.

| Group | Tasks | Examples |
| --- | --- | --- |
| Talking head | 6 | Raw take with retakes, in English, Hinglish, Telugu |
| Long to short | 4 | A 60-minute podcast into 3 clips |
| Long form | 3 | 40 minutes of A-roll and B-roll into a 12-minute video |
| Podcast multi-camera | 2 | Two cameras, two mics |
| Tutorial | 2 | Screen plus face |
| Montage | 2 | Clips and a song |
| Ad | 3 | Clips, logo, price, three variants |
| Explainer, data | 2 | Script; CSV |

Each task has an audited pass list: must-keep lines, must-cut lines, length,
format, and a hand-marked list of the raw take's true retakes. Each is checked as
in the capability set: an oracle edit passes, an empty edit fails, and a lazy
edit (trim only) fails.

Plus **revision tasks**: on a finished edit, 5 scripted changes ("bigger
captions", "remove the second story", "swap the song", "more zoom in the first 5
seconds", "fix this name"), measuring time and whether anything else broke.

## 4. Seeded defects (M)

| Measure | Limit | Reason |
| --- | --- | --- |
| Detection per blocking gate | ≥ 95 % of seeded defects, at the right time | A gate that misses is worse than none |
| False alarms on clean fixtures | ≤ 2 % per gate | People ignore noisy gates |
| QG-04 smallest clipped word detected | Reported, no limit until EX-11 | |

Gates that miss these limits are noted as `advisory` until fixed.

## 5. Metrics and targets

| Id | Metric | How | Target (unmeasured) |
| --- | --- | --- | --- |
| Q1 | Blind preference against A2 | §6 | Win rate ≥ 55 %, lower 95 % bound > 50 % |
| Q2 | Objective defects per finished minute | Independent grader, §7 | ≤ A2's |
| Q3 | Task pass rate | Audited lists | ≥ A2's |
| C1 | Money per **accepted** video | Ledger; Anthropic's list prices for A2's tokens | ≤ 1/5 of A2's |
| L1 | Time to first look | From drop to a playable cut | ≤ 3 minutes for a 5-minute source on the reference machine |
| L2 | Time to finished short | From drop to a checked master | ≤ A2's |
| R1 | Revision turnaround | A caption change on a 60-second reel | Median ≤ 60 s to a checked draft |
| R2 | Collateral damage | Unrequested changes after a revision | 0 |
| F1 | Jobs ending in a verdict | Not a crash or a hang | ≥ 99 % |
| F2 | pass^k | Same task, k runs, all acceptable | Report; target set after the first run |
| H1 | Human interventions | Count | ≤ A2's |
| T1 | Phone note to new preview | From **Send** in the Review Room to a new preview, on a 60-second reel | Report; target after the first run |
| G1 | Live chat harmed by a running edit | 429s seen by a scripted chat during a job | 0 |

Reference machines: an Apple-silicon laptop with 16 GB, and an x86 machine with a
consumer NVIDIA GPU. Names and specs are recorded in `status.md` at the run.

## 6. Human preference

The heart of the claim, because taste can't be measured by code.

- **Raters**: at least 3 working editors and 5 viewers from the target audience. Not Kriya staff.
- **Blind**: outputs renamed, order randomised, no watermarks, same player. Metadata stripped.
- **Pairwise**: "Which would you post?", with "about equal" allowed, plus three short scores: story, polish, sound.
- **Analysis**: Bradley-Terry over arms with bootstrap 95 % intervals. Paired sign test by task. Ties split.
- **Honest size**: with 24 tasks and 3 raters, 72 comparisons give a standard error of about 5.9 points, so a win rate under about 61.5 % doesn't exclude 50 %. If the first run lands near that, the sample has to grow before anything is claimed.
- **Pre-registered**: tasks, arms and thresholds are frozen in `status.md` before the first paid run. A run is reported whichever way it goes.

## 7. Independent grading

Kriya's gates can't grade Kriya, or A2 would be judged by our own definition of
good. `bench/edit/grade/` is a separate script set that shares no code with
`src/edit/`, measures all arms with plain `ffprobe`, `ebur128`, OCR and an
independent ASR run, and is reviewed against hand labels first.

As built in ED16: `bench/edit/grade/` measures format, length, black, frozen, silent, loudness
and clipping, and was checked against files with labelled defects (synthetic, so not yet real
hand labels on real footage). OCR and the independent recogniser aren't there: speech lines
come out `notMeasured`, which can't pass. `bench/edit/analyze.js`, `corpus.js` and `blind.js`
hold the analysis, the corpus and go-ahead checks and the rater package, written before any
run. What runs each arm isn't built: it needs the accounts and the go-ahead.

## 8. Rules for any public claim

1. No comparative claim before EG-8 passes.
2. Competitor facts re-read on their own pages on the date of publishing (RG-9).
3. A claim states the arm, date, versions, task set and sample size.
4. Losses are published with wins, in the same record.
5. "World's best" is not said. A sentence the data supports is.
6. Anthropic's and others' product names are used factually only.

## 9. Running it

| Step | Who | Needs |
| --- | --- | --- |
| Build corpus and audited lists | Owner, ED16 | Releases for anyone on camera |
| Dry run on 2 tasks | Agent | Owner's go-ahead, small spend |
| Cost estimate | Agent, from the dry run | Written down before the full run |
| Full run, K = 3 interleaved | Owner's go-ahead | Accounts for each arm |
| Rating | Owner recruits | Payment for raters |
| Report | Agent | `docs/kriya-harness/kriya_video_editing/bench/` |

A paid run's price can't be estimated yet (EC-5), since token use is unknown.

## 10. After launch

Offline bench results become a regression gate: a release can't drop Q3, F1 or
seeded-defect detection. KRHE (`docs/kriya-harness/krhe/`) may later tune recipe
values through its gate; quality gates, thresholds and rights rules are never
tuned by it (voice rule 11's spirit).
