# AS-CTX with summary checkpoints (C1), 2026-10-18

The same suite as `2026-10-18-as-ctx-baseline.md`, now with thread summary
checkpoints (MEMORY_AND_CONTEXT §7). Compared against the **off** baseline,
as the A1 target requires.

| Item           | Value                                                  |
| -------------- | ------------------------------------------------------ |
| Date           | 2026-10-18                                             |
| Commit         | `bdf223f` plus the uncommitted A1 work of sessions 1–4 |
| Suite          | AS-CTX, n = 20                                         |
| Model          | Scripted: one model call per task; scripted summariser |
| Command        | `KRIYA_EVAL_OUT=<file> npx vitest run tests/eval`      |
| Token estimate | characters ÷ 4                                         |

## How it was measured

Before the switch-on measurement, each thread goes through the real job
path, as if the previous task had ended: `enqueueSummary` (queues a job only
if the thread passed 24,000 stored characters since the last checkpoint),
`claimJob`, `runJob`. The job uses the real cut rule (last 6 person turns
kept), the real fact check and the real budget/balanced retry. The
summariser is scripted: it keeps each distinct person line (first 160
characters) and every amount, date and link the check requires. **Its
length is not a prediction of a real model's summary**; a paid run is
needed for that.

## Results (tokens)

| Statistic | Off (baseline) | On, with checkpoints |
| --------- | -------------- | -------------------- |
| Mean C1   | 5,669.75       | **5,351.4** (−5.6 %) |
| Median C1 | 5,699          | 5,458                |
| Min C1    | 4,345          | 2,851                |
| Max C1    | 7,756          | 7,059                |

| Scenario  | Checkpoint | Off: C1 | On: system | On: history | On: tools | On: C1 | Change  |
| --------- | ---------- | ------- | ---------- | ----------- | --------- | ------ | ------- |
| AS-CTX-01 | done       | 7,756   | 1,332      | 953         | 767       | 3,052  | −60.6 % |
| AS-CTX-02 | done       | 7,200   | 1,277      | 878         | 767       | 2,921  | −59.4 % |
| AS-CTX-03 | not due    | 6,062   | 1,112      | 4,861       | 767       | 6,739  | +11.2 % |
| AS-CTX-04 | done       | 7,084   | 1,276      | 859         | 767       | 2,901  | −59.0 % |
| AS-CTX-05 | not due    | 6,419   | 1,071      | 5,221       | 767       | 7,059  | +10.0 % |
| AS-CTX-06 | not due    | 6,225   | 1,096      | 5,002       | 767       | 6,865  | +10.3 % |
| AS-CTX-07 | done       | 6,628   | 1,287      | 797         | 767       | 2,851  | −57.0 % |
| AS-CTX-08 | not due    | 6,210   | 1,084      | 5,021       | 767       | 6,872  | +10.7 % |
| AS-CTX-09 | not due    | 5,753   | 1,077      | 4,568       | 767       | 6,412  | +11.5 % |
| AS-CTX-10 | not due    | 5,645   | 1,100      | 4,436       | 767       | 6,302  | +11.6 % |
| AS-CTX-11 | not due    | 5,145   | 1,062      | 3,956       | 767       | 5,785  | +12.4 % |
| AS-CTX-12 | not due    | 5,467   | 1,088      | 4,283       | 767       | 6,137  | +12.3 % |
| AS-CTX-13 | not due    | 5,796   | 1,103      | 4,591       | 767       | 6,460  | +11.5 % |
| AS-CTX-14 | not due    | 4,530   | 1,088      | 3,361       | 767       | 5,215  | +15.1 % |
| AS-CTX-15 | not due    | 4,671   | 1,081      | 3,480       | 767       | 5,328  | +14.1 % |
| AS-CTX-16 | not due    | 4,733   | 1,074      | 3,552       | 767       | 5,392  | +13.9 % |
| AS-CTX-17 | not due    | 4,345   | 1,074      | 3,180       | 767       | 5,020  | +15.5 % |
| AS-CTX-18 | not due    | 4,860   | 1,078      | 3,680       | 767       | 5,524  | +13.7 % |
| AS-CTX-19 | not due    | 4,419   | 1,072      | 3,255       | 767       | 5,094  | +15.3 % |
| AS-CTX-20 | not due    | 4,447   | 1,070      | 3,263       | 767       | 5,099  | +14.7 % |

## What it shows

- **The A1 target (C1 −30 %) is not met: −5.6 % mean.** Where a checkpoint
  was written (4 of 20), C1 fell by 57–61 %. The other 16 threads stay
  below the 24,000-character trigger (their message text is about
  12,700–20,900 characters, from history tokens × 4), so they only pay
  memory v2's overhead (+10 to +15.5 %, AF-25).
- The trigger, not the mechanism, decides the suite result. Lowering it, or
  trimming the v2 tool definitions, are tuning choices for the owner (AD-25:
  changed only with evidence, measured on this suite). Neither was changed
  here.
- The trigger counts stored JSON characters (`parts::text`), a little more
  than the text itself, so it fires slightly earlier than 24,000 characters
  of text would.

## Limits

As in the baseline: synthetic threads, one model call per task, only the
memory tools in the tool belt, characters ÷ 4. Real summaries (a paid run,
owner's go-ahead) may be longer than the scripted ones.
