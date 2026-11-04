# KRHE records

Experiment records for `../RECURSIVE_HARNESS_EVOLUTION.md`.

| Path | What |
| --- | --- |
| `profiles/b0.json`, `b3.json`, `b4.json`, `b5.json` | The bench arms of 2026-11-04 as profiles (B3 = 0.1.x defaults: loop and budget off; B4 = 0.2.0's defaults) |
| `lessons.json` | The lesson library (written by `lib/harness/evolve/cli.ts evaluate --library`) |
| `candidates/*.json` | Candidates proposed from B4, not yet probed |

## 2026-11-04: first offline turn (no model call, no spend)

Inputs: `harness_upgradation/bench/r-cap2-{b0,b3,b4,b5}-{1,2,3}.json`
(DeepSeek V4.1 Flash 1017, capability set `989dcfbc9eab`, K = 3, recorded
2026-11-04). Commands, with `arm b4` standing for the three B4 reports:

```bash
npx tsx lib/harness/evolve/cli.ts evaluate --incumbent <b3 ×3> --candidate <b4 ×3> --incumbent-profile docs/kriya-harness/krhe/profiles/b3.json --candidate-profile docs/kriya-harness/krhe/profiles/b4.json --model deepseek/deepseek-v4.1-flash-1017 --library docs/kriya-harness/krhe/lessons.json
npx tsx lib/harness/evolve/cli.ts propose --incumbent-profile docs/kriya-harness/krhe/profiles/b4.json --reports <b4 ×3> --k 3 --library docs/kriya-harness/krhe/lessons.json --model deepseek/deepseek-v4.1-flash-1017 --out-dir docs/kriya-harness/krhe/candidates
```

Output (verdict lines, the metric JSON left out):

```text
$ evaluate b3 → b0
CANARY: ca5ee23d7a1c against 2f567b8883f0
  - gain not shown at 95%: only-candidate 1 vs 0, p = 1.000
Lesson 31fe4b4eed0a: proposed. On deepseek/deepseek-v4.1-flash-1017, seed 989dcfbc9eab: minimalTools false → true passed 1 pairs the incumbent failed and failed 0 it passed (21 pairs, p = 1.000), cost per pass -36.3%.
$ evaluate b3 → b4
HOLD: 39c148271e98 against 2f567b8883f0
  - cost per passed task +43.4% (limit +5%)
  - gain not shown at 95%: only-candidate 4 vs 0, p = 0.125
Lesson 4b11ccb9bb52: proposed. On deepseek/deepseek-v4.1-flash-1017, seed 989dcfbc9eab: budget false → true, loop false → true passed 4 pairs the incumbent failed and failed 0 it passed (21 pairs, p = 0.125), cost per pass +43.4%.
$ evaluate b3 → b5
HOLD: 920e3dc03289 against 2f567b8883f0
  - cost per passed task +7.4% (limit +5%)
  - no pass gain: only-incumbent 1, only-candidate 0
Lesson 17407a59cceb: proposed. On deepseek/deepseek-v4.1-flash-1017, seed 989dcfbc9eab: budget false → true, loop false → true, minimalTools false → true passed 0 pairs the incumbent failed and failed 1 it passed (21 pairs, p = 1.000), cost per pass +7.4%.
$ evaluate b4 → b5
HOLD: 920e3dc03289 against 39c148271e98
  - no pass gain: only-incumbent 5, only-candidate 0
Lesson 34e43117fa96: proposed. On deepseek/deepseek-v4.1-flash-1017, seed 989dcfbc9eab: minimalTools false → true passed 0 pairs the incumbent failed and failed 5 it passed (21 pairs, p = 0.063), cost per pass -25.1%.
$ propose from B4 (= 0.2.0 defaults)
Incumbent 39c148271e98; failure signals {"failed":3,"timedOut":1,"tampered":7,"multiFailed":3,"passed":18,"costly":true}
087a72c4f8c8 (loop-v2-on, signal 13): loopV2 false → true
  why: Dependency-aware steps, classified failures and set-aside attempts fix multi-part and repeated failures
b546b2339d4f (anchor-on, signal 4): anchor false → true
  why: Keeping the request word for word stops long sessions losing a requirement in compaction
6aa9ac9a4f04 (more-steps, signal 3): maxSteps 150 → 300, turnMinutes 60 → 120
  why: Tasks that ran out of time or steps pass with a larger turn budget
```

Reading: no candidate reaches `adopt` on 21 pairs. B0 (minimal tools) reads
`canary` because it is cheaper with one more pass, which is weak evidence.
Every lesson is `proposed` (one cohort each). Probing the three candidates
is the owner's call (spec §10).
