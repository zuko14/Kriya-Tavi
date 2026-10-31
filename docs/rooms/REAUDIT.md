# Forensic re-audit (track R: Rooms)

Second pass over `docs/rooms/` on 2026-10-31, against the code at `508bb6a`,
Supabase's Realtime documentation and tracks C and H.

## 1. Checks run

| Check | Method | Result |
| --- | --- | --- |
| Ids defined | Script (strict: first cell of a row or a heading, ranges expanded) | RT-GOAL/RT-NOTE ids were missing → defined (R-05) |
| Existing paths | Script | All exist; others are new files |
| SQL constructs | Each matched to an applied migration: `check_transition`, `touch_updated_at`, composite FKs to `threads`/`agents`, `pg_advisory_xact_lock`, deny-all policy pattern | All have precedents |
| Agent pipeline claims | `runTask` (skill `ask`, belt, settle order), `untrustedSeen`, `privateContentSeen`, `episodes` shape, `checkCitations` statuses, `enqueueTurn` vs `enqueuePart` | Corrections R-02…R-04 |
| Realtime claims | Supabase docs: authorization, broadcast, limits | Matches (dated in REPOSITORY_AUDIT §2) |
| Cross-track | Program doc; shared files and order | Consistent after R-07 |

## 2. Findings in this pass and their resolution

| Id | Finding | Resolution |
| --- | --- | --- |
| R-01 | `enqueueTurn` drops message metadata; room context needs its own entry point | RD-03: owner-gated `enqueueRoomTurn` (the `enqueuePart` precedent) |
| R-02 | `untrustedSeen` works on model messages, which carry no UI metadata, so a `channel: "room"` flag can't reach it | RD-07, CONVERSATION_PROTOCOL §3: the `ROOM_CONTEXT` text marker, the watchers' `UNTRUSTED_DIFF` pattern |
| R-03 | The proof-card example used citation statuses that don't exist | Corrected to `supported`/`unsupported` (`checkCitations`) with the verified episode field shapes |
| R-04 | The invocation cap wording was ambiguous (per requester vs total) and in-flight tasks aren't charged yet | RD-04 and the function row: total of non-owner requests per agent per room per IST day; overshoot bounded to one task by RD-08 |
| R-05 | Goal and note tests and tables were only named | TEST_STRATEGY RT-GOAL/RT-NOTE; DATA_MODEL §7a; CHANGE_IMPACT rows for R7/R8 policy and schema |
| R-06 | `/rooms` without a trailing slash would also match `/roomsx` in `startsWithAny`; the new messages route needs the JSON 401 | `"/rooms/"` in `PROTECTED`, `"/api/rooms/"` in `PROTECTED_API` |
| R-07 | `policy.ts` and `capabilities.ts` are also held by R7 and R8 | Program §4 order updated |
| R-08 | Schedules posting into rooms (RS10, S11) had no mechanism | Marked "later: needs a decision" in both visions; out of scope for v1 |
| R-09 | A sixth bottom tab would crowd 360 px | RD-15: Home, sidebar, command palette |

## 3. Compatibility with existing workflows

| Workflow | Effect | Proof |
| --- | --- | --- |
| Everything, switches off | Room routes 404; prompts, belts, approvals, Inbox, Home unchanged | RT-REG-01 |
| Tenant isolation | Owner-only tables untouched; room tables use membership policies; agents act through their owner's `withUser` | RT-DB-01…08 |
| Queue | `claim_task`, `recover_tasks`, existing enqueue functions unchanged; room tasks are ordinary tasks | `tests/db/queue.test.ts` unchanged; RT-INV-01 |
| Approvals and grants | Unchanged; approvals reach only the owner | RT-AGT-05 |
| Memory quarantine | Stricter for room tasks (unconfirmed after room context) | RT-AGT-06 |
| Skills | Request text only, like crews and watchers | RT-INV-06 |
| Receipts and delivery | Read, never rewritten; re-checks relayed as new system lines | RT-PRF-04 |
| Realtime | New; no existing Realtime use to break | RT-RLT-* |

## 4. Open after this pass

RQ-1…RQ-5; owner approvals of RD-02, RD-03, RD-10, RD-16 and PX-03; the
Realtime "Allow public access" setting on staging and production.

## 5. Result

The documents agree with each other, with the code at `508bb6a`, with
Supabase's documentation and with tracks C and H. No existing assertion
changes in any phase; every existing file touched has a row in
CHANGE_IMPACT §3.
