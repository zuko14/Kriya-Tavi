# AS-CTX baseline (C1), 2026-10-18

The A1 baseline for C1 (input tokens per task on long threads), measured
before thread summaries exist, so that A1's target (C1 −30 % on long-thread
scenarios) has something to be compared with.

| Item           | Value                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Date           | 2026-10-18                                                                                                               |
| Commit         | `bdf223f` plus the uncommitted A1 work of sessions 1–3 (memory v2 migration, `lib/memory/*`, v2 tools and runner wiring) |
| Suite          | AS-CTX, n = 20 (`tests/eval/scenarios/AS-CTX/*.json`)                                                                    |
| Model          | Scripted (`MockLanguageModelV4`); no real model, no cost                                                                 |
| Runner         | The real `runTask` on PGlite (`tests/eval/context.eval.test.ts`)                                                         |
| Command        | `KRIYA_EVAL_OUT=<file> npx vitest run tests/eval`                                                                        |
| Token estimate | characters ÷ 4, the same rule as `lib/memory/context.ts`                                                                 |

## How it was measured

Each scenario seeds one agent, its notes and a 42-turn thread (three real
topics, each asked and followed up 14 times; `tests/eval/threads.ts`). The
person then sends the scenario's final question, and the runner answers it
once with `agents.memoryV2` off and once, on a copy of the thread, with it
on. The scripted model records every call's system prompt, message history
and tool definitions. C1 is their sum over the task's model calls; the
scripted model answers in one step, so each task has exactly one call.

## Results (tokens)

| Statistic | Off (today's product) | On (memory v2, no summaries yet) |
| --------- | --------------------- | -------------------------------- |
| Mean C1   | **5,669.75**          | 6,331.1                          |
| Median C1 | **5,699**             | 6,357                            |
| Min C1    | 4,345                 | 5,020                            |
| Max C1    | 7,756                 | 8,434                            |

| Scenario  | Role       | Person turns | Off: system | Off: history | Off: tools | **Off: C1** | On: system | On: tools | On: C1 |
| --------- | ---------- | ------------ | ----------- | ------------ | ---------- | ----------- | ---------- | --------- | ------ |
| AS-CTX-01 | student    | 42           | 971         | 6,530        | 255        | 7,756       | 1,137      | 767       | 8,434  |
| AS-CTX-02 | student    | 42           | 931         | 6,014        | 255        | 7,200       | 1,087      | 767       | 7,868  |
| AS-CTX-03 | student    | 42           | 947         | 4,861        | 255        | 6,062       | 1,112      | 767       | 6,739  |
| AS-CTX-04 | developer  | 42           | 961         | 5,868        | 255        | 7,084       | 1,096      | 767       | 7,731  |
| AS-CTX-05 | developer  | 42           | 943         | 5,221        | 255        | 6,419       | 1,071      | 767       | 7,059  |
| AS-CTX-06 | developer  | 42           | 968         | 5,002        | 255        | 6,225       | 1,096      | 767       | 6,865  |
| AS-CTX-07 | founder    | 42           | 954         | 5,420        | 255        | 6,628       | 1,100      | 767       | 7,286  |
| AS-CTX-08 | founder    | 42           | 935         | 5,021        | 255        | 6,210       | 1,084      | 767       | 6,872  |
| AS-CTX-09 | founder    | 42           | 930         | 4,568        | 255        | 5,753       | 1,077      | 767       | 6,412  |
| AS-CTX-10 | freelancer | 42           | 954         | 4,436        | 255        | 5,645       | 1,100      | 767       | 6,302  |
| AS-CTX-11 | freelancer | 42           | 934         | 3,956        | 255        | 5,145       | 1,062      | 767       | 5,785  |
| AS-CTX-12 | freelancer | 42           | 930         | 4,283        | 255        | 5,467       | 1,088      | 767       | 6,137  |
| AS-CTX-13 | creator    | 42           | 951         | 4,591        | 255        | 5,796       | 1,103      | 767       | 6,460  |
| AS-CTX-14 | creator    | 42           | 915         | 3,361        | 255        | 4,530       | 1,088      | 767       | 5,215  |
| AS-CTX-15 | creator    | 42           | 936         | 3,480        | 255        | 4,671       | 1,081      | 767       | 5,328  |
| AS-CTX-16 | business   | 42           | 926         | 3,552        | 255        | 4,733       | 1,074      | 767       | 5,392  |
| AS-CTX-17 | business   | 42           | 910         | 3,180        | 255        | 4,345       | 1,074      | 767       | 5,020  |
| AS-CTX-18 | business   | 42           | 926         | 3,680        | 255        | 4,860       | 1,078      | 767       | 5,524  |
| AS-CTX-19 | other      | 42           | 909         | 3,255        | 255        | 4,419       | 1,072      | 767       | 5,094  |
| AS-CTX-20 | other      | 42           | 930         | 3,263        | 255        | 4,447       | 1,070      | 767       | 5,099  |

History is identical with the switch on (no summaries yet), so the "On:
history" column is omitted.

## What it shows

- **History is 73–84 % of C1** on these threads. Summary checkpoints (T3)
  are where a −30 % reduction can come from; memory retrieval alone can't
  reach it at these note counts.
- **Memory v2 currently costs more, not less: mean C1 +11.7 %** (6,331.1 vs
  5,669.75). Two causes: the v2 memory tool definitions are 767 tokens
  against 255 for today's two tools (+512 per model call, AF-25), and the
  system prompt is about 150 tokens longer (memory guidance and block
  headings). The A1 target is measured against the **off** baseline, so
  summaries must recover this too.
- C3 (cache ratio) can't be measured on the scripted model: it needs a
  provider that reports cached tokens.

## Limits of this baseline

- The threads are synthetic: real answers are often longer, and real tasks
  run several model calls with tool results, where every call resends the
  history. Both make real C1 larger; the relative effect of summaries is
  what this suite tracks.
- Only the memory tools are in the tool belt here (no web or connected
  accounts in the test environment). A real belt is larger, so the share of
  the +512 tokens is smaller in production.
- The token count is an estimate (characters ÷ 4), not a tokenizer's.
