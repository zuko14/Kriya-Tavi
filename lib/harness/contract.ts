import { z } from "zod"

// The Kriya Harness API's wire contract (track H, API_AND_CONTRACTS):
// defined once here, validated on every route, exported to
// docs/kriya-harness/contract.json for the client repository (HD-03).
// Requests are strict: unknown fields are refused. Phases add their routes.

export const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
// 8 characters from A–Z without I and O, digits 2–9; shown ABCD-1234
export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export const Platform = z.enum(["darwin", "linux", "win32"])

export const DeviceCodeRequest = z.strictObject({
  deviceName: z.string().trim().min(1).max(60),
  platform: Platform,
  clientVersion: z.string().regex(SEMVER),
})

export const DeviceCodeResponse = z.strictObject({
  deviceCode: z.string().regex(TOKEN),
  userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
  verificationUrl: z.string().url(),
  expiresIn: z.literal(600),
  interval: z.literal(5),
})

export const DeviceTokenRequest = z.strictObject({
  deviceCode: z.string().regex(TOKEN),
})

export const DeviceTokenResponse = z.strictObject({
  token: z.string().regex(TOKEN),
  deviceId: z.uuid(),
})

export const MeResponse = z.strictObject({
  displayName: z.string().nullable(),
  plan: z.string(),
  harness: z.strictObject({
    enabled: z.boolean(),
    capMicroInr: z.number().int().nonnegative(),
    usedMicroInr: z.number().int().nonnegative(),
    unpriced: z.number().int().nonnegative(),
  }),
  agent: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  minClientVersion: z.string().regex(SEMVER),
})

export const ErrorResponse = z.strictObject({
  error: z.enum([
    "not_found",
    "bad_request",
    "upgrade",
    "unauthorized",
    "suspended",
    "rate_limited",
    "pending",
    "denied",
    "expired",
    "server_error",
    // H3: the gateway's refusals (API_AND_CONTRACTS §3)
    "harness_off",
    "plan_not_allowed",
    "tier_not_allowed",
    "cap_reached",
    "not_priced",
    "upstream_unavailable",
    // H6: the mirror's refusals (API_AND_CONTRACTS §5)
    "no_agent",
    "mirror_summary_only",
    // H8: handoff and pull (API_AND_CONTRACTS §7)
    "not_connected",
    "too_large",
    "patch_mismatch",
    "no_checkpoint",
    "task_refused",
  ]),
  message: z.string(),
  minVersion: z.string().optional(),
  retryAfter: z.number().int().optional(),
})

// H3: OpenAI Chat Completions. The one loose request: the OpenAI fields
// (tools, tool_choice, response_format, temperature…) pass through; Kriya
// sets model, max_tokens and usage and strips user, provider, models, route
export const ChatRequest = z.looseObject({
  model: z.string().min(1).max(100),
  messages: z.array(z.unknown()).min(1).max(2000),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
})

export const ModelsResponse = z.strictObject({
  object: z.literal("list"),
  data: z.array(
    z.strictObject({
      id: z.enum(["budget", "balanced", "escalation"]),
      object: z.literal("model"),
      owned_by: z.literal("kriya"),
      // The model the owner routes this level to, as its catalogue names it
      // (owner, 2026-11-03: the harness shows the model, not the level).
      // Absent when the level isn't routed yet
      name: z
        .string()
        .regex(/^[\p{L}\p{N} .()+\/:_-]{1,60}$/u)
        .optional(),
    })
  ),
})

// H5: a local action waiting for the person (API_AND_CONTRACTS §4). The input
// is the tool's exact arguments, at most 8 KB as JSON; it's redacted before
// it's stored. No route answers one: only a signed-in session does (HS-4)
export const MAX_APPROVAL_INPUT = 8 * 1024

export const ApprovalCreateRequest = z.strictObject({
  sessionRef: z.string().max(100),
  tool: z.string().min(1).max(60),
  summary: z.string().min(1).max(300),
  input: z
    .record(z.string(), z.unknown())
    .refine((input) => JSON.stringify(input).length <= MAX_APPROVAL_INPUT, {
      message: "input is over 8 KB",
    }),
  cwd: z.string().max(300).optional(),
})

export const ApprovalCreateResponse = z.strictObject({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
})

export const ApprovalStatus = z.enum([
  "pending",
  "approved",
  "declined",
  "expired",
  "canceled",
])

export const ApprovalStatusResponse = z.strictObject({ status: ApprovalStatus })

// H6: a device session mirrored into a thread of the device's agent
// (API_AND_CONTRACTS §5, HD-09). The response names the device's mode, so
// the client sends `full` only when the person chose it; turns are
// idempotent by seq
export const MAX_TURN_TEXT = 64 * 1024

export const SessionCreateRequest = z.strictObject({
  deviceSessionId: z.string().min(1).max(100),
  project: z.string().max(80),
  title: z.string().max(80),
})

export const SessionCreateResponse = z.strictObject({
  sessionId: z.uuid(),
  threadId: z.string(),
  mirror: z.enum(["summary", "full"]),
})

export const TurnRequest = z.strictObject({
  seq: z.number().int().min(0).max(2_147_483_647),
  text: z.string().max(MAX_TURN_TEXT),
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(60),
        status: z.enum(["ok", "error", "declined"]),
        ms: z.number().int().min(0),
      })
    )
    .max(100),
  // Only in full mode: each tool's arguments and output, at most 64 KB as JSON
  full: z
    .record(z.string(), z.unknown())
    .refine((full) => JSON.stringify(full).length <= MAX_TURN_TEXT, {
      message: "full is over 64 KB",
    })
    .optional(),
})

// H7: the device agent's skills and memory (API_AND_CONTRACTS §6, HD-10).
// Skill bodies are text/markdown; notes saved from a device are always
// unconfirmed, at most 1 000 characters (writeMemory's own limit)
export const SkillsResponse = z.strictObject({
  skills: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
      name: z.string().min(1).max(60),
      version: z.string().regex(SEMVER),
      description: z.string().min(1).max(240),
      activation: z.strictObject({
        always: z.boolean(),
        keywords: z.array(z.string()),
      }),
    })
  ),
})

export const MemorySearchRequest = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional(),
})

export const MemorySearchResponse = z.strictObject({
  notes: z.array(
    z.strictObject({
      id: z.string(),
      content: z.string(),
      kind: z.string(),
      confirmed: z.boolean(),
      // Shared by all the person's agents, not only this device's
      shared: z.boolean(),
    })
  ),
})

export const MemorySaveRequest = z.strictObject({
  content: z.string().min(1).max(1000),
})

export const MemorySaveResponse = z.strictObject({
  id: z.string(),
  confirmed: z.boolean(),
})

// H8: a laptop's work handed to a cloud workspace (API_AND_CONTRACTS §7,
// HD-11). `meta` is one part of a multipart body, `patch` the other: track
// C's checkpoint format (a git diff from baseSha), sha256 and bytes of
// exactly that part. bytes 0 hands off the base commit with no changes
export const HandoffMeta = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
  baseRef: z.string().min(1).max(100),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  note: z.string().max(2000).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
})

export const HandoffResponse = z.strictObject({
  threadId: z.string(),
  workspaceId: z.uuid(),
  taskId: z.uuid(),
  url: z.string().url(),
})

// H10, HD-12: this device's id and where `kriya serve` connects; 404 while
// harness.deviceWorld is off
export const WorldResponse = z.strictObject({
  deviceId: z.uuid(),
  relayUrl: z.string().url(),
})

// Every route: method, path, whether it needs a device token, its schemas
export const ROUTES = [
  {
    method: "POST",
    path: "/device/code",
    auth: false,
    request: DeviceCodeRequest,
    response: DeviceCodeResponse,
  },
  {
    method: "POST",
    path: "/device/token",
    auth: false,
    request: DeviceTokenRequest,
    response: DeviceTokenResponse,
  },
  { method: "GET", path: "/me", auth: true, request: null, response: MeResponse },
  { method: "DELETE", path: "/device", auth: true, request: null, response: null },
  { method: "GET", path: "/models", auth: true, request: null, response: ModelsResponse },
  // The answer is OpenAI's, streamed or JSON, with `model` set to the alias
  {
    method: "POST",
    path: "/chat/completions",
    auth: true,
    request: ChatRequest,
    response: null,
  },
  {
    method: "POST",
    path: "/approvals",
    auth: true,
    request: ApprovalCreateRequest,
    response: ApprovalCreateResponse,
  },
  // ?wait=0…25 seconds: answers once decided, else the status when it runs out
  {
    method: "GET",
    path: "/approvals/{id}",
    auth: true,
    request: null,
    response: ApprovalStatusResponse,
  },
  // 204: answered in the terminal; a request already answered stays as it is
  {
    method: "DELETE",
    path: "/approvals/{id}",
    auth: true,
    request: null,
    response: null,
  },
  // 201, or 200 for a session already opened; 404 while the mirror is off
  {
    method: "POST",
    path: "/sessions",
    auth: true,
    request: SessionCreateRequest,
    response: SessionCreateResponse,
  },
  // 204; a seq already stored is ignored
  {
    method: "POST",
    path: "/sessions/{id}/turns",
    auth: true,
    request: TurnRequest,
    response: null,
  },
  // ETag and If-None-Match (304)
  { method: "GET", path: "/skills", auth: true, request: null, response: SkillsResponse },
  // text/markdown: the instructions of that version
  {
    method: "GET",
    path: "/skills/{id}/{version}",
    auth: true,
    request: null,
    response: null,
  },
  {
    method: "POST",
    path: "/memory/search",
    auth: true,
    request: MemorySearchRequest,
    response: MemorySearchResponse,
  },
  // 201; 409 no_agent; 404 while memory v2 is off
  {
    method: "POST",
    path: "/memory",
    auth: true,
    request: MemorySaveRequest,
    response: MemorySaveResponse,
  },
  // 201; multipart/form-data: `meta` (this schema, as JSON) + `patch` (a file);
  // 404 while handoff or cloud workspaces are off
  {
    method: "POST",
    path: "/handoff",
    auth: true,
    request: HandoffMeta,
    response: HandoffResponse,
  },
  // application/octet-stream with X-Kriya-Sha256 and X-Kriya-Base-Sha;
  // 404 no_checkpoint when the workspace has none
  {
    method: "GET",
    path: "/workspaces/{id}/checkpoint",
    auth: true,
    request: null,
    response: null,
  },
  { method: "GET", path: "/world", auth: true, request: null, response: WorldResponse },
] as const

export function contractJson() {
  return {
    basePath: "/api/harness/v1",
    headers: {
      version: "X-Kriya-Harness",
      auth: "Authorization: Bearer <device token>",
    },
    error: z.toJSONSchema(ErrorResponse),
    routes: ROUTES.map((route) => ({
      method: route.method,
      path: route.path,
      auth: route.auth,
      request: route.request && z.toJSONSchema(route.request),
      response: route.response && z.toJSONSchema(route.response),
    })),
  }
}
