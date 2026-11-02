# Harness API and contracts (track H)

Base path `/api/harness/v1` on `kriya-web`. Every schema below is defined
once in `lib/harness/contract.ts` (zod) and exported to
`docs/kriya-harness/contract.json`; the client repository tests against that
file (HD-03). JSON unless stated. Unknown fields are refused.

## 1. Common rules

| Rule | Value |
| --- | --- |
| Auth | `Authorization: Bearer <device token>` on every route except `/device/code` and `/device/token`; verified by `authenticateDevice` (`lib/auth.ts`) |
| Version | `X-Kriya-Harness: <semver>` required; below `harness.minClientVersion` → 426 `{ error: "upgrade", message, minVersion }` |
| Switch | `harness.api` off → 404 on every route (the route exists but says nothing) |
| Suspended person | 403 `{ error: "suspended" }` |
| Errors | `{ error: <code>, message: <plain sentence> }`; never a stack or provider payload |
| Rate limits | 429 `{ error: "rate_limited", retryAfter }` (HD-16) |
| Proxy | `proxy.ts` exempts `/api/harness/` from the browser origin check (`TOKEN_API`, HF-07: a command-line client sends no `Origin`; these routes read no cookies, so CSRF doesn't apply) and doesn't list it in `PROTECTED_API` (the routes answer 401 themselves) |
| Logs | ids, status, durations only (HD-17) |

## 2. Device flow (H2)

| Method and path | Request | Response | Notes |
| --- | --- | --- | --- |
| `POST /device/code` | `{ deviceName: string 1–60, platform: "darwin"\|"linux"\|"win32", clientVersion }` | `{ deviceCode, userCode, verificationUrl, expiresIn: 600, interval: 5 }` | `deviceCode` 32 random bytes (base64url), stored as sha256; `userCode` 8 characters from a 32-character alphabet (A–Z without I and O, digits 2–9; DATA_MODEL check `^[A-HJ-NP-Z2-9]{8}$`), shown `ABCD-1234`; IP rate limit 10/hour |
| `POST /device/token` | `{ deviceCode }` | 200 `{ token, deviceId }` once; 428 `pending`; 403 `denied`; 410 `expired`; 429 if polled faster than `interval` | Token 32 random bytes, sha256 stored; the code is consumed |
| page `/connect/device?code=` | session (`PROTECTED`, so sign-in returns here, HF-08) | Shows device name, platform and request time; the person picks the agent and approves or denies | `actions/harness.ts` `approveDevice` / `denyDevice` (`withUser`, zod) |
| `GET /me` | — | `{ displayName, plan, harness: { enabled, capMicroInr, usedMicroInr, unpriced }, agent: { id, name }, minClientVersion }` | |
| `DELETE /device` | — | 204 | Revokes the calling device (also `kriya logout`) |

## 3. Gateway (H3)

| Method and path | Contract |
| --- | --- |
| `GET /models` | OpenAI list: `{ data: [{ id: "budget"\|"balanced"\|"escalation", owned_by: "kriya" }] }`, only tiers the plan allows |
| `POST /chat/completions` | OpenAI Chat Completions request; `model` must be an allowed alias; `stream` true or false; `tools`, `tool_choice`, `response_format` passed through; `max_tokens` capped at the tier's limit; `user`, `provider`, `models`, `route` fields stripped (Kriya routes). Response: OpenAI-compatible stream or JSON from OpenRouter, unchanged except the `model` field reporting the alias |

Steps and refusals are in ARCHITECTURE §3.2. Refusal codes: `harness_off`,
`plan_not_allowed` (cap 0), `tier_not_allowed`, `cap_reached`,
`rate_limited`, `upstream_unavailable` (OpenRouter 5xx after the existing
fallback model is tried once, `routing.fallback`).

## 4. Approvals (H5)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /approvals` | `{ sessionRef ≤ 100, tool ≤ 60, summary ≤ 300, input: object ≤ 8 KB, cwd? ≤ 300 }` | `{ id, expiresAt }` (input passed through `redactInput` before storing) |
| `GET /approvals/{id}?wait=25` | — | `{ status: "pending"\|"approved"\|"declined"\|"expired"\|"canceled" }` after up to 25 s |
| `DELETE /approvals/{id}` | — | 204: the person answered locally; status `canceled` |

There is **no** device endpoint that answers an approval. Answers come only
from a signed-in session (`actions/harness.ts` `answerHarnessApproval`), so
code running on the machine with the device token can't approve itself (HS-4).

## 5. Mirror (H6)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /sessions` | `{ deviceSessionId ≤ 100, project ≤ 80, title ≤ 80 }` | 201 (200 when already open) `{ sessionId, threadId, mirror: "summary"\|"full" }` (one thread per device session, in the device agent's threads; `mirror` tells the client whether to send `full`); 409 `no_agent` when the device works as no agent |
| `POST /sessions/{id}/turns` | `{ seq: int, text ≤ 64 KB, tools: [{ name ≤ 60, status: "ok"\|"error"\|"declined", ms }] ≤ 100, full?: object ≤ 64 KB }` | 204; duplicate `seq` ignored; `full` only in `full` mode, else 403 `mirror_summary_only` |

Requires `harness.mirror` on and the device's mirror setting not `off`
(else 404, saying nothing). Each turn is stored as an assistant message
starting with "Mirrored from Kriya Harness (mode)" (`MIRROR_CONTEXT`), which
`untrustedSeen` treats as untrusted content (owner decision 2026-11-01, H6).

## 6. Skills and memory (H7)

| Method and path | Contract |
| --- | --- |
| `GET /skills` | `ETag` (304 on `If-None-Match`); `{ skills: [{ id, name, version, description, activation: { always, keywords } }] }`: the cloud's catalogue rules with the device's belt (no Kriya tools): `agents.skillLibrary` on; required skills plus the device agent's assigned ones (or its role's defaults); active, not in `skills.disabled`, needing no Kriya tool, with their dependencies; `skills.pins`; v2 with `next.skillsV2`; the person's active Studio skills with `next.skillStudio`. Empty without an agent |
| `GET /skills/{id}/{version}` | `text/markdown` body of that version (same loaders as the cloud: `readSkill`, `loadSkillV2`, Studio `load`) |
| `POST /memory/search` | `{ query ≤ 500, limit ≤ 20 }` → `{ notes: [{ id, content, kind, confirmed, shared }] }`: the notes the device's agent sees (its own and shared, `recallNotes` through `withUser`), confirmed notes first; 404 while `agents.memoryV2` is off |
| `POST /memory` | `{ content ≤ 1000 }` → 201 `{ id, confirmed }` (`confirmed` is false unless the same note already exists confirmed); written with `writeMemory` (`lib/memory/write.ts`) through `withUser` with `untrusted: true`, so `source = 'agent'`, `trust = 'unconfirmed'`; 1 000 is `writeMemory`'s own limit (`AGENT_NOTE_MAX`; this row said 2 000 before H7); sensitive values refused (400) as in the cloud; 409 `no_agent`; the person confirms in Kriya |

## 7. Handoff and pull (H8)

| Method and path | Contract |
| --- | --- |
| `POST /handoff` | `multipart/form-data`: `meta` JSON `{ repo, baseRef, baseSha, note ≤ 2000, sha256, bytes }` + `patch` file ≤ `cloud.maxCheckpointMb`. Checks: `harness.handoff` and `cloud.workspaces` on; the person has a GitHub connection (`kriya.connections` row, provider `github`); hash and size match. Access to `repo` and to `baseSha` is proven when the cloud workspace imports the tarball (track C, `githubTarball`); a failure is reported in the new thread. Object path from `lib/cloud/paths.ts` (PX-02). → `{ threadId, workspaceId, taskId, url }` |
| `GET /workspaces/{id}/checkpoint` | The latest checkpoint patch of one of the person's workspaces (`application/octet-stream`, `X-Kriya-Sha256`, `X-Kriya-Base-Sha`) |

As built (H8, 2026-11-01): `POST /handoff` answers 201; 404 while
`harness.handoff` or `cloud.workspaces` is off or `cloud.provider` is
`none`; 409 `no_agent` (the device has no agent); 403 `not_connected` (no
GitHub row) or `plan_not_allowed` (the plan's `workspace_minutes` is 0); 413
`too_large` (declared `Content-Length` or the part over the limit); 400
`patch_mismatch` (sha256 or bytes differ); a task that can't start
(`enqueueTurn`'s `TurnError`) answers its status with `task_refused`, and
the stored patch, thread and row are removed. Every check runs before
anything is stored. `bytes: 0` hands off the base commit with no checkpoint.
The task's message names the repository, branch and commit, asks the agent
to open the workspace (`workspace_open`), then the person's note. The
stored patch is metered as `workspace_storage_bytes` like track C's
checkpoints. `GET /workspaces/{id}/checkpoint` reads the row through the
person's session (RLS), checks the stored bytes against the row's sha256
before serving them (else 500), 404 `no_checkpoint` when there is none, and
404 while `harness.handoff` is off.

## 8. Contract tests (both repositories)

- This repository: every route's request/response validated against
  `contract.ts` in HT-API-* tests; `contract.json` regenerated and compared
  in CI (a stale export fails).
- Client repository: plugins' requests and expected responses validated
  against the same `contract.json` pinned to a commit.
