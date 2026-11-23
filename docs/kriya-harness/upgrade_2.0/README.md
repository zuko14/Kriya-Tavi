# Harness 2.0 (programme W, "the Workforce", inside track H)

Goal (owner, 2026-11-23, `intent.md`): a cheap or mid-tier model inside
Kriya Harness delivers work at the level of a top-1% engineer in each
discipline, a frontier model inside it does better than alone, and the
harness keeps learning new practice, under the owner's approval.

**Agents start from [AGENT_MASTER_PROMPT.md](AGENT_MASTER_PROMPT.md).**
Status: **Proposed**; nothing built. Decisions WD-01…16 await the owner.

| Document | What it holds |
| --- | --- |
| [intent.md](intent.md) | The owner's brief (unchanged) |
| [FORENSIC_AUDIT.md](FORENSIC_AUDIT.md) | What already exists and is reused; where the intent can't be taken literally (F-01…14); risks in today's code |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The thesis as math, layers, intent → real seams, one step end to end, routing and escalation, invariants |
| [ORCHESTRA.md](ORCHESTRA.md) | Head and worker models, the advisor, milestones, the contract bus, byte-stable prompts, adversarial plan rules |
| [CARTRIDGES.md](CARTRIDGES.md) | The 16 role cartridges (with graphics): rules, detectors, gates, judgement; design taste (directions, tokens, glass material) |
| [GATES.md](GATES.md) | The deterministic gate catalogue, the local stack, loopback-only probes, gate mutants |
| [SELF_EVOLUTION.md](SELF_EVOLUTION.md) | The R&D Scout, candidates, lint, benchmark, owner approval, canary and rollback, on top of KRHE |
| [DATA_MODEL_AND_CONTRACTS.md](DATA_MODEL_AND_CONTRACTS.md) | Tables, RLS, spend function, settings, additive API fields |
| [DECISIONS.md](DECISIONS.md) | WD-01…24 and the owner's questions |
| [CHANGE_IMPACT_AND_SAFETY.md](CHANGE_IMPACT_AND_SAFETY.md) | Exactly which existing files may change, in both repositories; stop conditions |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Phases W0–W19, steps, tests, exits, rollback |
| [TEST_STRATEGY.md](TEST_STRATEGY.md) | Test ids WT-… |
| [EVALUATION_PLAN.md](EVALUATION_PLAN.md) | How the intent's targets would be measured (paid, owner's go-ahead) |
| [RESEARCH.md](RESEARCH.md) | Sources with honesty markers; technique decisions with falsifiers |
| [THREE_D_AND_CREATIVE.md](THREE_D_AND_CREATIVE.md) | 3D/WebGL cartridge, G-3D, art direction, Explore (best of up to 3 gated takes) |
| [GROUNDING_AND_CONNECTORS.md](GROUNDING_AND_CONNECTORS.md) | GitHub through the person's own login, typed repo tools, CI loop, MCP, version-exact API grounding |
| [DELIVERY_AND_STABILITY.md](DELIVERY_AND_STABILITY.md) | Release gate, deploy adapters, post-deploy smoke, harness stability, `kriya doctor` |
| [HARNESS_UX.md](HARNESS_UX.md) | The interface rebuilt around proof: Run strip, four tracks, cards, Mission Control |
| [DIFFERENTIATORS.md](DIFFERENTIATORS.md) | Proof receipts, live verification, time scrubber, contract map, cost by tier |
| [REAUDIT.md](REAUDIT.md) | The forensic re-audit of this design, two rounds: 29 defects fixed, 14 open risks |

## In one paragraph

Harness 2.0 doesn't add a second agent runtime. It adds four things to the
existing Kriya loop, KriyaBench and KRHE: **role cartridges** (one
discipline's rules, detectors and judgement per builder), a **gate
catalogue** (deterministic checks: rendered UI, accessibility, live local
stack, API contract, cross-tenant probes, flake runs), an **orchestra**
(the owner's head tier plans, writes contracts, advises and takes over when
the worker tier is stuck, inside the existing four attempts), and a
**Scout** (owner-scheduled reading of owner-listed sources, turned into
linted cartridge candidates that are benchmarked off-server and applied
only on the owner's click). The second round adds 3D/WebGL work (a
graphics cartridge, the G-3D gate, Explore: the best of up to three gated
takes), GitHub through the person's own login with typed repository tools
and a CI loop, version-exact API grounding, a release gate with deploy
adapters and one narrow post-deploy smoke check, proof receipts, and an
interface built around the state of the work and its proof. Everything is
off by default, and off is byte-identical to client 0.2.5. Whether it makes a cheap model match a
frontier one is a target measured in EVALUATION_PLAN, not a claim.
