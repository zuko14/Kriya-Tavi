# Harness 2.0: evaluation plan (how the claims would be earned)

Every number in `intent.md` §8 is a **target**. This file says how each is
measured. Runs are paid and need the owner's go-ahead and budget; they run
on the owner's machine or a track C sandbox (KU-ADR-15), metered by the
gateway, with KriyaBench's hidden graders, restored originals and safety
probes. Statistics are KRHE's (`RECURSIVE_HARNESS_EVOLUTION.md` §5): paired
runs, K ≥ 3, exact sign test, Wilson intervals, safety as hard constraints.

## 1. Arms

| Arm | Session tier | Builders | Harness 2.0 switches |
| --- | --- | --- | --- |
| A0 head solo | head | head | all off (0.2.5 defaults) |
| A1 worker solo | worker | worker | all off |
| A2 worker + cartridges + gates | worker | worker | cartridges, gates |
| A3 orchestra | head | worker → head at E | cartridges, gates, orchestra |
| A4 orchestra + critic | head | as A3 | + critic |
| A5 head + harness | head | head | cartridges, gates, critic |

Model ids, seed version, client version and profile id are pinned in every
report (KRHE-3).

## 2. Questions and pass conditions

| Id | Question | Comparison | Target (not a claim) |
| --- | --- | --- | --- |
| E-1 | Do cartridges + gates lift the cheap model? | A2 vs A1 per role set | Shown gain (p < 0.05), safety not worse |
| E-2 | Does the orchestra reach head-solo quality cheaper? | A3/A4 vs A0 | pass ≥ A0 − 5 points (one-sided 95% bound), cost per pass ≤ 0.4 × A0, safety ≤ A0 |
| E-3 | Does the harness lift the frontier model too? | A5 vs A0 | Shown gain, safety not worse |
| E-4 | Contract bus and prefix order cut tokens? | A3 with contracts vs without; prompt tokens and `cached_tokens` from the gateway ledger | Report the measured ratio; "unknown" for providers not reporting cached tokens |
| E-5 | Is the critic worth its cost? | A4 vs A3 on frontend/designer seeds, plus a blinded owner preference test on screenshots | Pass not worse; owner preference recorded as owner judgement, never as a metric of correctness |
| E-6 | 3D and creative work | A3 with Explore vs A3 without vs A0 on a 3D seed set (≥ 20 briefs, hidden G-3D configs) | G-3D pass not worse than A0; blinded owner preference on frames recorded as owner judgement, never as correctness |
| E-7 | Grounding | A2 with `KRIYA_GROUNDING` vs without on tasks against a pinned library version that differs from common training data | Shown drop in `type` failures and attempts per pass |

Power: with 30 tasks × K = 3 per role, only large effects reach p < 0.05
(KRHE §5). A `hold` is a valid outcome. Results go to
`docs/kriya-harness/upgrade_2.0/bench/` as reports and to `status.md` as a
table, with costs from the gateway ledger, never estimated by hand.

## 3. What would change a default

A switch's default turns on only when: its evaluation shows a gain or
non-inferiority as above on at least two roles, no safety count worse, the
owner decides it in `status.md`, and WT-REG tests are updated to the new
defaults in the same commit. Comparisons with other products need a fresh
RG-9 on top (track-A rule 12).
