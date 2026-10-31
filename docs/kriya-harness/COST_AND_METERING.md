# Cost and metering (track H)

## 1. Why the harness is cheap to run

The person's machine does the compute. Kriya pays only for model tokens,
which the person's plan already charges with the plan's markup, plus a small
amount of web-service time for streaming. No sandbox, no worker slot, no
storage (except opt-in mirror text and handoff patches, which track C
already accounts for).

## 2. What is recorded

| Item | Where | Notes |
| --- | --- | --- |
| Each model request | `kriya.harness_usage` | Reported cost (OpenRouter usage), estimate (`kriya.models` prices), charge in micro-INR (plan markup, `fx.usdInr`), `charge_status` `final`/`estimated`/`unpriced` |
| Reservations | same row, `status = reserved` until settled | Cap enforcement before forwarding (DATA_MODEL §4) |
| Mirror text | `messages` of the mirror thread | Counts toward nothing extra; bounded per turn |
| Handoff patches | Track C storage (`workspace_storage_bytes`) | Track C's metering |

The person's allowance (`usageSummary`) = chat/agent charges + voice charges
+ harness charges. Unpriced rows are counted and shown as unpriced, never
as zero (invariant 6).

## 3. Controls

| Control | Where enforced |
| --- | --- |
| `plans.harness_monthly_micro_inr` (0 = no harness on that plan) | `reserve_harness_spend` (SQL) |
| Tier allow-list (`plans.allowed_tiers`) | Gateway |
| `max_tokens` cap per tier | Gateway |
| `harness.rpm`, 3 concurrent streams | `kriya.hit_rate_limit` |
| Monthly allowance and overage rules | Existing `checkTaskAllowed` reads `usageSummary` (now including harness) for cloud tasks; the harness cap is separate and lower-or-equal by owner choice |

## 4. Web-service cost

Streaming runs on `kriya-web`. Each stream holds a connection for the length
of the model answer. HT-GW-09 measures CPU and memory at 50, 100, 200
concurrent streams on the staging instance type; the owner sizes the web
plan (or splits the gateway into its own Render service) from that table.
No number is assumed here.

## 5. Unknowns

| Id | Unknown | How it gets known |
| --- | --- | --- |
| HQ-01 | OpenRouter limits for one key at harness volume | Docs/support in writing; staging load test |
| HC-1 | Average tokens per harness session for real users | Pilot (H12) from `harness_usage` |
| HC-2 | Share of requests settling as `estimated` (aborted streams) | Staging and pilot; target < 2 % |
