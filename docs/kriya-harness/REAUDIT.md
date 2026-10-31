# Forensic re-audit (track H: Kriya Harness)

Second pass over `docs/kriya-harness/` on 2026-10-31, against the code at
`508bb6a`, the DeepSeek Harness source at `ce7073d`, npm, and tracks C and R.

## 1. Checks run

| Check | Method | Result |
| --- | --- | --- |
| Ids defined | Script: every HT/HD/HF/HS/HG/HQ/HC id used is the first cell of a table row or a heading in this directory (ranges expanded) | All defined |
| Existing paths | Script over backticked paths, new files excluded | All exist; the rest are new files or upstream DSH paths |
| Upstream claims | Each read in the pinned clone: `apps/cli/README.md`, `packages/*/README.md` summaries, `SAFETY.md`, `BRAND_GUIDELINES.md`, `package.json` publish fields; `npm view` for published versions | Matches; two corrections (H-02, H-03) |
| Server claims | `proxy.ts`, `lib/auth.ts`, `lib/entitlements.ts`, `share_links`, `usage_events`/`charges` nullability, `memories` constraints, Inbox badge source | Matches after H-04…H-07 |
| Cross-track | Program doc §2–§6; track C CD-26/27, CT-IMP-03 exception | Consistent |

## 2. Findings in this pass and their resolution

| Id | Finding | Resolution |
| --- | --- | --- |
| H-01 | Scenario phase numbers were set before the H and R phase lists were final | VISION §3 rewritten against IMPLEMENTATION_PLAN (H4 local agent, H5 approvals, H8 handoff, R4/R5/R7) |
| H-02 | DSH's interactive surface is a local Web UI; no terminal UI ships (`apps/cli/README.md`) | VISION §1, DSH_DISTRIBUTION §2, HF-06: `kriya` opens the local UI; `kriya run` for scripts |
| H-03 | DSH's `SAFETY.md`: not audited, not production-ready; README warns of breaking changes | HF-05; HD-02 "Safety status"; beta label; HG-6 |
| H-04 | `proxy.ts` refuses non-GET requests without Kriya's `Origin`: every harness POST would be 403 | HF-07; `TOKEN_API` exemption; HT-API-10 |
| H-05 | `/connect/device?code=` would lose the code at sign-in unless in `PROTECTED` | HF-08; `"/connect/"` in `PROTECTED` |
| H-06 | `memories.source` allows only `agent`, `user`, `derived`; a `harness:<id>` source would violate the check; no provenance column exists | API §6: `writeMemory`, `source = 'agent'`, `trust = 'unconfirmed'`; no schema change |
| H-07 | The user-code alphabet in the API doc (31) didn't match the data model check (32 characters) | API §2 corrected to 32 (A–Z without I, O; 2–9) |
| H-08 | The handoff route claimed to probe repository access with a tarball request | API §7: checks a GitHub connection exists; access is proven when track C imports the tarball |
| H-09 | Handoff on `kriya-web` would import `lib/cloud` (forbidden by CT-IMP-03) | PX-02: pure `lib/cloud/paths.ts`; C's CT-IMP-03 exception; boundary diagram |
| H-10 | Live notifications for phone approvals need the protected `/api/events` | PX-03 combined owner decision; fallback to Inbox and badge |
| H-11 | Research gaps named H3 for client-side questions | VISION §5: HQ-02, HQ-03, HQ-05 block H4 |

## 3. Compatibility with existing workflows

| Workflow | Effect | Proof |
| --- | --- | --- |
| Everything, switches off | Harness routes 404; nothing else changes | HT-REG-01 |
| Sign-in and identity | Session helpers unchanged; device tokens accepted only by `authenticateDevice` on harness routes | HT-AUTH-08 |
| CSRF guard | Unchanged for every cookie route; bearer routes exempt | HT-API-10 |
| Billing | `lib/agent/metering.ts`, `usage_events`, `charges` untouched; `usageSummary` adds harness rows only when they exist | HT-MTR-02 |
| Agents, tools, approvals | No `TOOL_CLASSES`, belt or prompt change in this repository | HT-REG-01 |
| Memory | Writes through the existing `writeMemory`, unconfirmed | HT-API-07 |
| Inbox | Additive section behind `harness.api` | HT-APR-01 |
| Track C | Uses its checkpoint format and (H10) runner protocol; no change to its tables except H10's own widening migration | PX-02, PX-06 |

## 4. Open after this pass

HQ-01…HQ-05, HQ-C1/HQ-C2 (counsel), owner approvals of HD-02, HD-03, HD-05,
HD-06, HD-07, HD-12, HD-14 and PX-03, the `kriya-harness` repository and npm
scope (owner).

## 5. Result

The documents agree with each other, with the code at `508bb6a`, with the
pinned DeepSeek Harness source and with tracks C and R. No existing
assertion changes in any phase; every existing file touched has a row in
CHANGE_IMPACT §3.
