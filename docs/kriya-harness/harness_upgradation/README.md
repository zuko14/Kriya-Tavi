# Kriya Harness upgrade (track HU)

A programme inside track H: make Kriya Harness measurably better at
finishing real tasks on the same model, with bounds, recovery and evidence
enforced by code around the pinned DeepSeek Harness kernel. Started
2026-11-04 from the owner's mandate in this folder.

**Agents start from [AGENT_MASTER_PROMPT.md](AGENT_MASTER_PROMPT.md).**
Progress is in [status.md](status.md) (one line also goes to the root
`status.md`, track H section).

| Document | What it holds |
| --- | --- |
| [kriya_world_class_harness_reserach_and_excecutiion.md](kriya_world_class_harness_reserach_and_excecutiion.md) | The owner's mandate (unchanged) |
| [FORENSIC_AUDIT.md](FORENSIC_AUDIT.md) | Verified current architecture, the turn reconstructed from source, capability/provenance matrix, findings HU-F-01…15, risk register, baseline |
| [RESEARCH.md](RESEARCH.md) | 61 primary sources (R-01…), 20 technique decisions with falsifying experiments, benchmark methodology |
| [DECISIONS.md](DECISIONS.md) | KU-ADR-01…18 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Target architecture (Option A+: DSH kernel, Kriya control layer), refined invariants |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Phases U0–U10, exit checks, status, dependencies, rollback |
| [BENCHMARK_PLAN.md](BENCHMARK_PLAN.md) | KriyaBench-M (free, real DSH, scripted model) and KriyaBench-R (paid), arms, statistics, thresholds, results |
| [TEST_STRATEGY.md](TEST_STRATEGY.md) | Test ids HU-… and commands |
| [CHANGE_IMPACT_AND_SAFETY.md](CHANGE_IMPACT_AND_SAFETY.md) | What this programme may touch; stop conditions |
| [RELEASE_0.2.0.md](RELEASE_0.2.0.md) | What 0.2.0 ships (B4 on by default), server changes, the owner's release steps and rollback |
| [DSH_UPGRADE.md](DSH_UPGRADE.md) | The gates and checklist for bumping the pinned DeepSeek Harness |
| [bench/](bench/) | Recorded reports (`mechanics-2026-11-04.json`) |

## In one paragraph

The audit found that DSH bounds nothing inside a turn, that the gateway hid
context-overflow errors so DSH's recovery could never run, that Kriya never
told DSH any model's real limits, and that KriyaBench is saturated and
records no cost. U1–U4 fix those four things (behind `--budget` for the
turn budget; data-driven for limits; additive in the contract) and prove
each on the real pinned DSH with before/after runs. Whether the upgraded
harness completes more real tasks per rupee is **not yet measured**: that
needs the owner-approved KriyaBench-R runs and the capability task set
(U6).
