# What makes Kriya Harness different (features, not claims)

Part of Harness 2.0 (second round, 2026-11-23). These are product features
designed here. No sentence in this file says another product lacks one of
them: that needs RG-9 (track-A rule 12). Each feature rests on something
Kriya already computes by code.

| # | Feature | Rests on | Phase |
| --- | --- | --- | --- |
| D1 | Proof receipts, tamper-evident | Ledger, gates, evidence hashes | W19 |
| D2 | Live verification (Run strip, chips, gate overlays on the frame) | Ledger, gate evidence | W18 |
| D3 | Explore: best of up to 3 gated takes, chosen by the person | v2 snapshots, gates, critic | W14 |
| D4 | Time scrubber over checkpoints | `refs/kriya/*` checkpoints, `kriya undo` | W18 |
| D5 | Contract map | `.kriya/contracts`, owner roles, drift hashes | W18 |
| D6 | Release readiness computed by code | G-RELEASE | W17 |
| D7 | Version-exact API grounding | Installed type definitions | W15 |
| D8 | Capability matrix (`kriya doctor`) | Gate self-tests | W17 |
| D9 | Phone approvals and remote control | Existing H5, Remote Control | exists |
| D10 | Cost by tier per verified step | Gateway ledger, orchestra tiers | W18 |

## D1. Proof receipts

At the end of a task the client writes `receipt.json` (and a readable
`receipt.md`) to `~/.kriya/receipts/<project>/<session>.json`:

```json
{
  "receipt": 1,
  "project": "<sha256 of the root path, 16 hex>",
  "commit": "<HEAD after the work, or the checkpoint tree>",
  "client": "0.3.0", "profileId": "…", "cartridges": { "kriya-role-backend": "1.0.2" },
  "steps": [{ "n": 1, "role": "database", "verdict": "pass", "attempts": 2,
              "tiers": ["worker", "worker"],
              "gates": [{ "id": "G-STACK", "status": "pass", "evidence": "sha256:…" }] }],
  "release": { "ready": true, "lines": [ … ] },
  "cost": { "workerMicroInr": "…", "headMicroInr": "…", "settled": true },
  "chain": "sha256:…"
}
```

- Every field is copied from the ledger, progress files and gate results;
  nothing comes from model text (track-A rule 7, track N rule 3's spirit).
- `chain` is a hash chain over the run records in order
  (`h_i = sha256(h_{i-1} ‖ canonical(run_i))`), so editing any run record
  afterwards breaks it; `kriya receipt verify <file>` recomputes it from the
  ledger and the evidence files and says which link fails.
- The draft PR body (`pr_create`) starts with `receipt.md`; the person can
  share it. It carries no file contents, prompts, URLs with query strings
  or secrets. It is evidence of what the harness checked, labelled as such
  ("checked on this computer"), never a guarantee.

## D2. Live verification

The Run strip, chips and Live overlays (HARNESS_UX §3) make each gate's
result visible where it applies: a failing overflow is drawn as a box on
the 390 px frame, a failing contrast pair is outlined, a failing tenant
probe shows "Tenant A read B's order #2 (expected 403, got 200)". The
person sees the same evidence the builder gets as feedback.

## D3. Explore

THREE_D_AND_CREATIVE §5: up to three takes on a creative step, each fully
gated, compared side by side; the person picks (or, headless, the critic).
Bounded by `MAX_ATTEMPTS`.

## D4. Time scrubber

Every attempt already leaves a checkpoint (`refs/kriya/…`). The Changes
track draws them as ticks with their verdicts; restoring a point is the
existing `kriya undo` path (Kriya's own index, `checkout-index` of the
differing paths, the replaced state saved first). HEAD, branches, the index
and the stash stay untouched, as today.

## D5. Contract map

A small graph in Proof: each contract, its owning role, the steps that read
it, its hash and whether anything drifted. Clicking a contract opens it in
DSH's file viewer. It makes the head/worker division of labour legible.

## D6–D8

Release readiness (DELIVERY §2), version-exact API grounding
(GROUNDING §5) and the capability matrix (DELIVERY §5) are described where
they are designed.

## D10. Cost by tier

The ledger records each builder's tier. The client learns spend only from
the device's own usage total (`GET /me`, the same reading KriyaBench's
`--meter` uses), so a builder's cost is the difference of that total
around it, which includes any advisor call made during it; the gateway
itself is protected and unchanged. Proof can then show "this feature: 9 worker builds (₹3.10), 2 head builds
(₹4.80), 1 critique (₹0.90)". Estimates are labelled until the gateway
settles them (HD-16's rule: never zero, never invented).
