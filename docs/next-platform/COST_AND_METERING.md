# Cost and metering (next platform, track N)

Invariant 6: money is integers (micro-USD, micro-INR, paise in `bigint`),
math in `lib/money.ts`, and reported cost, estimated cost and customer
charge stay apart. **No price or exchange rate in this document is
assumed**: every figure comes from `kriya.models` (synced from OpenRouter
by `npm run models:sync`), `kriya.voice_prices`, a dated setting such as
`fx.usdInr` with `fx.source`, or it is null ("not priced").

## 1. What track N adds to the bill

| Source                                                   | Who pays                      | Recorded where                                                                                                                            | Priced by                                                             |
| -------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Extra input tokens from MCP tool definitions and results | Customer (part of the task)   | Existing `usage_events` per model call (`recordUsage`) → `chargeTask` → `kriya.charges` (unchanged, protected)                            | Existing path                                                         |
| The `APPS_LINE` prompt line                              | Customer (part of the task)   | Same                                                                                                                                      | Same                                                                  |
| MCP server's own charges to the person                   | The person, with the provider | **Not Kriya's**: the person's own account with the app                                                                                    | Not shown as Kriya cost; the Apps card says "Uses your <App> account" |
| Late re-check reads (no model)                           | Platform                      | Nothing (provider API reads, no metered resource today)                                                                                   | —                                                                     |
| Read retries (no model)                                  | Platform                      | Nothing                                                                                                                                   | —                                                                     |
| MCP read-back calls (no model)                           | Platform                      | Nothing                                                                                                                                   | —                                                                     |
| Embeddings for memory rerank (N9)                        | Platform                      | `kriya.resource_usage` kind `embedding_tokens` (already allowed by the check), `cost_micro_usd` from the provider's reported cost or null | OpenRouter usage report (NRG-3); null when not reported               |
| Skill text (v2 skills)                                   | Customer (part of the task)   | Existing `skill_activations.chars` + `usage_events`                                                                                       | Existing path                                                         |

Nothing in track N touches `lib/agent/metering.ts`, `kriya.usage_events`,
`kriya.charges` or `lib/billing.ts` (protected).

## 2. Cost controls

| Control                                         | Where                                                | Effect                                                                       |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `next.mcpMaxTools` (default 20)                 | `lib/mcp/registry.ts`                                | Caps tool-definition tokens per step                                         |
| Kriya-side descriptions ≤ 400 characters        | `mcp_tools.description`                              | The model sees the short owner text, not the server's long description       |
| Result cap 20,000 characters + `compactContext` | `lib/mcp/tools.ts`, existing `lib/agent/messages.ts` | Old results become stubs, as for every tool                                  |
| Per-agent enablement                            | `mcp_enablements`                                    | Agents that don't need an app don't carry its tools                          |
| Breaker                                         | `lib/reliability/breaker.ts`                         | A dead app stops eating steps (each failed step is a paid model call)        |
| Read retries                                    | `lib/reliability/retry.ts`                           | A transient 503 no longer costs a whole re-plan by the model                 |
| Re-check instead of re-run                      | `lib/delivery/recheck.ts`                            | Proof without a second model task                                            |
| Task budget, step budget, deadline              | Existing (`task.costBudgetMicroUsd`, `stepBudget`)   | Unchanged hard stops                                                         |
| Maintenance cap                                 | Existing `agents.maintenanceCapMicroUsd`             | Embedding jobs stop for the day when reached                                 |
| Prompt caching                                  | `next.promptCache` (N10, only after NRG-2)           | Cache-friendly prefix exists (T1); markers only where proven to pass through |

## 3. Measurements (no estimates in reports)

| Metric | Definition                                                                                                                                                                                                           | Source                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1     | Input tokens per task (track A)                                                                                                                                                                                      | `usage_events`                                  |
| C3     | Cached-token ratio Σ`cached_tokens` / Σ`input_tokens`, per model route (track A)                                                                                                                                     | `usage_events`                                  |
| NM6    | **₹ per delivered task**: Σ `charges.charge_micro_inr` of tasks whose delivery status is `delivered` ÷ their count; with the `final`/`estimated` label of each charge, unpriced tasks counted apart ("n not priced") | `charges` + `deliveryOf`                        |
| NM7    | MCP tool-definition share: characters of MCP tool definitions on the belt ÷ total tool-definition characters, per task                                                                                               | Computed at belt build, logged as a number only |
| NM10   | Wasted steps: model calls in steps whose only tool result was a transient error or an open breaker                                                                                                                   | `tool_executions.error` + `usage_events` join   |

Reports never round a measured value and always state n (track O rule).

## 4. Before/after method (N10)

1. On staging, with the owner's go-ahead for spend, run EVALUATION_PLAN's
   AS-CST suite (10 fixed tasks, scripted where possible, real model only
   where needed) with every `next.*` off. Record C1, C3, NM6, NM10.
2. Turn one switch on at a time (`next.reliability`, then `next.mcp` with
   the fixture app, then `next.promptCache` if NRG-2 passed). Re-run.
3. Record the deltas with n, date, commit and the total cost of the
   measurement run (from `charges`, not estimated).
4. A switch that raises C1 by more than 10 % on tasks that don't use its
   feature is a regression: it stays off until fixed.

## 5. Unknowns (written down, not guessed)

| Unknown                                                                                     | Verification step                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Whether OpenRouter honours Anthropic cache markers sent through `@ai-sdk/openai-compatible` | NRG-2                                    |
| Embedding model price and whether OpenRouter reports its cost per call                      | NRG-3                                    |
| Whether any registry MCP provider charges per call on the person's plan                     | NRG-1 per server; shown on the Apps card |
| Real C3 on the live routes today                                                            | Step 1 above                             |
