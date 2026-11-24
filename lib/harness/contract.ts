import { z } from "zod"

import {
  CARTRIDGE_ROLES,
  CONTRACT_NAMES,
  DETECTOR_IDS,
  GATE_IDS,
} from "@/lib/harness/cartridge-ids"
import { CartridgeFile } from "@/lib/harness/cartridges"

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
    // HU: the provider refused a conversation longer than the model's
    // context window; the client compacts and retries
    "context_length_exceeded",
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
      // HU (KU-ADR-09): what that model holds, from the provider's catalogue,
      // and the output cap the gateway allows. Both absent when unknown
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      // Whether that model takes images, from the same catalogue; absent
      // when it doesn't or that's unknown (the client stays text only)
      images: z.literal(true).optional(),
    })
  ),
  // The request-body forms the gateway decodes besides plain JSON
  // (lib/harness/route.ts readBody; owner, 2026-11-04: harness bodies go
  // gzip+base64 past the host's firewall). Absent on an older Kriya
  bodyEncodings: z.array(z.literal("gzip+base64")).optional(),
  // Harness 2.0 W2: the owner's head and worker levels, both in the plan and
  // different; absent unless harness.workforce is on (upgrade_2.0/ORCHESTRA.md §1)
  orchestra: z
    .strictObject({
      head: z.enum(["budget", "balanced", "escalation"]),
      worker: z.enum(["budget", "balanced", "escalation"]),
    })
    .optional(),
  // Harness 2.0 W11: this Kriya takes TurnRequest.cartridgeOutcomes; absent
  // unless harness.workforce is on, so a client never sends what isn't taken
  workforce: z.literal(1).optional(),
  // S-1: a device may build the orchestra's worker steps on its own local
  // model (`kriya --local-model`); absent unless harness.localModels is on and
  // the orchestra is offered (docs/kriya-harness/LOCAL_MODELS.md)
  localModels: z.literal(1).optional(),
  // Developer cockpit: the harness shows its Developer tab; absent unless
  // harness.cockpit is on (docs/kriya-harness/DEVELOPER_COCKPIT.md)
  cockpit: z.literal(1).optional(),
  // Own models: the person may set up their own API keys and their own
  // orchestration in the harness; absent unless harness.ownModels is on
  // (docs/kriya-harness/OWN_MODELS.md)
  ownModels: z.literal(1).optional(),
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
  // Harness 2.0 W11 (WD-15): counts per cartridge version since the last
  // turn, sent only when the person turned sharing on (kriya share) and
  // /models advertised `workforce: 1`. Counts only, never content
  cartridgeOutcomes: z
    .array(
      z.strictObject({
        cartridgeId: z.string().regex(/^kriya-role-[a-z]{2,20}$/),
        version: z.string().regex(SEMVER),
        verified: z.number().int().min(0).max(10_000),
        blocked: z.number().int().min(0).max(10_000),
        notChecked: z.number().int().min(0).max(10_000),
        undone: z.number().int().min(0).max(10_000),
      })
    )
    .max(20)
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
      // Harness 2.0 W1: present only on kriya-role-* cartridges, only with
      // harness.workforce on (upgrade_2.0/DATA_MODEL_AND_CONTRACTS.md §4)
      cartridge: CartridgeFile.omit({ id: true }).optional(),
      invocation: z.strictObject({ modelInvocable: z.literal(false) }).optional(),
    })
  ),
})

// Harness 2.0 W16, MCP P3a: registry servers that need no sign-in, each tool
// with its pinned definition hash and class. No token, client id or secret name
export const McpServersResponse = z.strictObject({
  servers: z.array(
    z.strictObject({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(200),
      url: z.string().url().max(2000),
      tools: z.array(
        z.strictObject({
          name: z.string().min(1).max(200),
          definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
          risk: z.enum(["R0", "R1", "R2", "R3", "R4"]),
          readOnly: z.boolean(),
        })
      ),
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

/* ─────────── Editing Studio (track E; 404 while editing.studio is off) ─────────── */

// `manifest` is the exact text the signature covers; a client verifies it,
// then parses it. A 200 is how a client learns this server has editing (EH-01)
export const EditingManifestResponse = z.strictObject({
  manifest: z.string().min(2).max(524_288),
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/)
    .nullable(),
})

// What this server has switched on for editing. 404 while editing.studio is off; a
// client that gets anything but a real yes treats the feature as off
export const EditingFeaturesResponse = z.strictObject({
  visuals: z.boolean(),
  playbooks: z.boolean(),
  mediaSearch: z.boolean(),
  // Added 2026-11-10 (EDD-58). An older client ignores them; a newer client
  // reads a missing one as off
  motion: z.boolean(),
  customMotion: z.boolean(),
  // Added 2026-11-10 (TP1, EDD-59). The same rule: ignored by an older client, off when missing
  assembly: z.boolean(),
  // Added 2026-11-11 (TP3, EDD-63). The same rule
  livePreview: z.boolean(),
  // Added 2026-11-11 (TP4, EDD-61). The same rule
  intent: z.boolean(),
  // Added 2026-11-11 (TP5, EDD-64). The same rule
  craft: z.boolean(),
  // Added 2026-11-11 (TP7, EDD-67). The same rule
  typeKit: z.boolean(),
  // Added 2026-11-11 (TP6, EDD-65). The same rule
  referenceIntent: z.boolean(),
  // Added 2026-11-11 (TP8, EDD-68). The same rule
  directorLoop: z.boolean(),
  // Added 2026-11-12 (TP11). The same rule. Only after a true here does a computer send
  // DaemonProject.clips, or a job ask an `order` card (rule 17)
  taviOrder: z.boolean(),
})

// Licensed pictures and cited definitions (EDD-52, EDD-57). 404 while editing.mediaSearch is off
const SEARCH_WORDS = z.string().trim().min(2).max(80)
export const EditingMediaRequest = z.strictObject({
  queries: z.array(SEARCH_WORDS).min(1).max(6),
})
export const EditingMediaResponse = z.strictObject({
  results: z.array(
    z.strictObject({
      query: z.string(),
      items: z.array(
        z.strictObject({
          id: z.string(),
          source: z.enum(["wikimedia", "nasa", "openverse"]),
          kind: z.enum(["image", "video"]),
          title: z.string(),
          url: z.string(),
          thumb: z.string(),
          width: z.number().nullable(),
          height: z.number().nullable(),
          licence: z.string(),
          rights: z.enum(["public_domain", "licensed"]),
          creator: z.string(),
          page: z.string(),
        })
      ),
    })
  ),
})
export const EditingDefineRequest = z.strictObject({
  terms: z.array(SEARCH_WORDS).min(1).max(6),
})
export const EditingDefineResponse = z.strictObject({
  definitions: z.array(
    z.strictObject({
      term: z.string(),
      title: z.string(),
      quote: z.string(),
      source: z.string(),
      page: z.string(),
      licence: z.string(),
    })
  ),
})

const PROJECT_ID_EARLY = z.string().regex(/^[a-f0-9]{16}$/)

// A job's preview, poster, clip or report: reserved in SQL, then sent straight to
// Storage by the signed link, never through the web service (EH-23). 404 while
// editing.previews is off
export const EditingPreviewRequest = z.strictObject({
  kind: z.enum(["preview", "poster", "clip", "report"]),
  bytes: z.number().int().min(1).max(1_073_741_824),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationFlicks: z.number().int().min(0).optional(),
})
export const EditingPreviewResponse = z.strictObject({
  id: z.uuid(),
  uploadUrl: z.string().url(),
})
// A decision card (ED15): a default and a timeout, so a person who never answers still
// gets an edit. 404 while editing.review is off. No device route answers one
export const EditingQuestionRequest = z.strictObject({
  // "order" (TP11): which order of the clips a brief meant; only after taviOrder said true
  kind: z.enum(["take", "hook", "file", "name", "taste", "order"]),
  prompt: z.string().min(1).max(500),
  options: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        // A clip this job already uploaded, played on the card
        clip: z.uuid().optional(),
      })
    )
    .min(2)
    .max(6),
  defaultOption: z.number().int().min(0).max(5),
  timeoutSeconds: z.number().int().min(30).max(3600),
})
export const EditingQuestionResponse = z.strictObject({
  id: z.uuid(),
  expiresAt: z.string(),
})
export const EditingAnswerResponse = z.strictObject({
  status: z.enum(["open", "answered", "defaulted", "expired"]),
  option: z.number().int().min(0).max(9).optional(),
})
export const EditingNotesResponse = z.strictObject({
  notes: z.array(
    z.strictObject({
      id: z.uuid(),
      atFlicks: z.number().int().min(0),
      body: z.string().min(1).max(1000),
    })
  ),
})
// A new recording in a watched folder: its name and duration, nothing else (ES-21).
// 404 while editing.watchFolders is off; 409 when the computer doesn't offer the folder
export const EditingFoundRequest = z.strictObject({
  project: PROJECT_ID_EARLY,
  name: z.string().min(1).max(200),
  seconds: z.number().int().min(0).max(604_800),
})
export const EditingFoundResponse = z.strictObject({ id: z.uuid() })

/* ─────────── Control Center (CONTROL_CENTER.md; 404 while harness.controlCenter is off) ─────────── */

const SHORT = (max: number) => z.string().min(1).max(max)
const PROJECT_ID = z.string().regex(/^[a-f0-9]{16}$/)

// A project folder the daemon offers: tasks run only in these. `path` is for
// the person to recognise it ("~/Documents/app"), never used to address it
// A clip the person numbered in the folder's editing project (TP11): its number and their own
// label, nothing else (no file name, path or words). Shown to Tavi as data from the computer
export const DaemonClip = z.strictObject({
  n: z.number().int().min(1).max(999),
  label: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[^\u0000-\u001f\u007f<>]+$/)
    .optional(),
})
export const DaemonProject = z.strictObject({
  id: PROJECT_ID,
  name: SHORT(80),
  path: SHORT(300),
  git: z.boolean(),
  // Optional (TP11): sent only after /editing/features answered taviOrder: true, so an
  // older server never sees it; an older client never sends it
  clips: z.array(DaemonClip).max(50).optional(),
})
// A rule kriya rules lists for a project: proposed by the loop or confirmed
export const DaemonRule = z.strictObject({
  project: PROJECT_ID,
  n: z.number().int().min(1).max(999),
  text: SHORT(400),
  status: z.enum(["proposed", "confirmed"]),
})
// Set on the computer (`kriya daemon` flags), never from Kriya
export const DaemonCapabilities = z.strictObject({
  fullAccess: z.boolean(),
  serve: z.boolean(),
  handoff: z.boolean(),
  // Optional: a client sends it only after /editing/manifest answered 200 (EH-01)
  edit: z.boolean().optional(),
})
export const DaemonHelloRequest = z.strictObject({
  daemonVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  capabilities: DaemonCapabilities,
  projects: z.array(DaemonProject).max(50),
  rules: z.array(DaemonRule).max(200),
})
export const DaemonHelloResponse = z.strictObject({
  pollSeconds: z.number().int().min(1).max(25),
})

export const DispatchKind = z.enum([
  "run",
  "doctor",
  "rule_confirm",
  "rule_dismiss",
  "handoff",
  "pull",
  "serve_start",
  "serve_stop",
  "edit",
])
export const RunSwitches = z.strictObject({
  loopV2: z.boolean(),
  budget: z.boolean(),
  anchor: z.boolean(),
  browser: z.boolean(),
})
// A flow's plan and harness settings (track S, SD-14): the person's own
// steps, saved as written instead of the model's. No field names a command:
// the check stays the project's confirmed one (CC-D1). Older daemons ignore
// both and follow the plan as it's written in the prompt.
export const RunPlan = z.strictObject({
  goal: z.string().min(1).max(600),
  steps: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(120),
        done_when: z.string().min(1).max(300),
        files: z.array(z.string().min(1).max(200)).max(12),
        after: z.array(z.number().int().min(1).max(7)).max(6).optional(),
      })
    )
    .min(1)
    .max(7),
})
const OnOff = z.enum(["on", "off"])
const Digits = z.string().regex(/^[0-9]{1,3}$/)
// The client's existing switches and limits (lib/harness/evolve/profile.ts
// toEnv); nothing protected has a name here (KU-ADR-16 E3)
export const RunProfile = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  env: z.strictObject({
    KRIYA_LOOP: OnOff,
    KRIYA_LOOP_V2: OnOff,
    KRIYA_LOOP_GUARD: OnOff.optional(),
    KRIYA_STRICT_LOOP: OnOff.optional(),
    KRIYA_DEFENSIVE: OnOff.optional(),
    KRIYA_RECON: OnOff.optional(),
    KRIYA_JIT_TOOLS: OnOff.optional(),
    KRIYA_BUDGET: OnOff,
    KRIYA_ANCHOR: OnOff,
    KRIYA_MINIMAL: OnOff,
    KRIYA_MAX_STEPS: Digits,
    KRIYA_TURN_MINUTES: Digits,
    KRIYA_MAX_REPEATS: Digits,
  }),
})
// What each kind carries; validated on queueing and again by the daemon
export const DispatchPayloads = {
  run: z.strictObject({
    project: PROJECT_ID,
    prompt: SHORT(4000),
    mode: z.enum(["ask", "auto", "read", "plan", "full"]),
    switches: RunSwitches,
    plan: RunPlan.optional(),
    profile: RunProfile.optional(),
    // S-3 (TASK_PROOF.md): set by queue() only, with harness.taskProof on;
    // older daemons ignore it
    proof: z.literal(true).optional(),
  }),
  doctor: z.strictObject({}),
  rule_confirm: z.strictObject({
    project: PROJECT_ID,
    n: z.number().int().min(1).max(999),
    wording: z.string().max(400).optional(),
  }),
  rule_dismiss: z.strictObject({
    project: PROJECT_ID,
    n: z.number().int().min(1).max(999),
  }),
  handoff: z.strictObject({ project: PROJECT_ID, note: z.string().max(500).optional() }),
  pull: z.strictObject({ project: PROJECT_ID, workspace: z.uuid().optional() }),
  serve_start: z.strictObject({ project: PROJECT_ID }),
  serve_stop: z.strictObject({}),
  // Track E: one edit on this computer. Only queueEdit() queues it (EH-06)
  edit: z.strictObject({
    project: PROJECT_ID,
    job: z.uuid(),
    brief: SHORT(4000),
    recipe: z
      .string()
      .regex(/^[a-z0-9-]{1,48}$/)
      .optional(),
    effort: z.enum(["fast", "best"]),
    revisionOf: z.uuid().optional(),
    // The one change an agent asked for (a person's notes come from their own route)
    change: z.string().min(1).max(1000).optional(),
  }),
} as const
// S-3 (TASK_PROOF.md): what a computer reports about a task Kriya started,
// computed by code there (kriya-harness src/proof.js). Untrusted until it
// parses here; shown as "checked on your computer". Names and counts only:
// no file content
const ProofLevel = z.enum(["head", "worker", "single"])
export const RunProof = z.strictObject({
  verdict: z.enum(["verified", "partial", "failed", "blocked", "not checked"]).optional(),
  steps: z
    .array(
      z.strictObject({
        n: z.number().int().min(1).max(99),
        title: z.string().max(120),
        verdict: z.enum(["pass", "fail", "blocked", "not run"]),
        attempts: z.number().int().min(0).max(99),
        builtBy: z
          .array(
            z.strictObject({
              level: ProofLevel,
              name: z.string().max(80),
              local: z.literal(true).optional(),
            })
          )
          .max(8),
        gates: z
          .array(
            z.strictObject({
              id: z.string().regex(/^G-[A-Z0-9-]{2,20}$/),
              status: z.string().max(20),
            })
          )
          .max(20),
      })
    )
    .max(12)
    .optional(),
  touchedChecks: z.array(z.string().max(300)).max(20).optional(),
  changes: z
    .strictObject({
      files: z
        .array(
          z.strictObject({
            path: z.string().min(1).max(300),
            status: z.enum(["added", "modified", "deleted", "renamed"]),
            added: z.number().int().min(0).optional(),
            deleted: z.number().int().min(0).optional(),
            binary: z.literal(true).optional(),
          })
        )
        .max(200),
      count: z.number().int().min(0),
      added: z.number().int().min(0),
      deleted: z.number().int().min(0),
    })
    .optional(),
})
export type RunProof = z.infer<typeof RunProof>
export const Dispatch = z.strictObject({
  id: z.uuid(),
  kind: DispatchKind,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
// ?wait=0…25: the oldest queued action for this computer (claimed by this
// answer), and the running ones the person asked to stop
export const DispatchNextResponse = z.strictObject({
  dispatch: Dispatch.nullable(),
  cancel: z.array(z.uuid()).max(50),
})
export const DispatchReportRequest = z.strictObject({
  status: z.enum(["running", "done", "failed", "canceled"]),
  result: z.record(z.string(), z.unknown()).optional(),
})
// What a kriya process runs: no task text from the terminal
// Own models (docs/kriya-harness/OWN_MODELS.md): counts from the person's own
// API keys, batched by the harness. Never a prompt, code or key. The cost is
// what the provider reported, in micro-USD; absent when it didn't say
export const OwnUsageRequest = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        provider: z.string().regex(/^[a-z0-9-]{2,30}$/),
        model: z.string().min(1).max(120),
        requests: z.number().int().min(1).max(10_000),
        inputTokens: z.number().int().min(0).max(1_000_000_000),
        outputTokens: z.number().int().min(0).max(1_000_000_000),
        reportedCostMicroUsd: z.number().int().min(0).max(1_000_000_000_000).optional(),
      })
    )
    .min(1)
    .max(50),
})
export const RunReportRequest = z.strictObject({
  localId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  source: z.enum(["terminal", "dispatch"]),
  kind: z.enum(["app", "run", "acp", "serve", "handoff", "pull"]),
  mode: z.enum(["ask", "auto", "read", "plan", "full"]).optional(),
  switches: z.record(z.string().max(30), z.boolean()).optional(),
  project: z.string().max(80).optional(),
  status: z.enum(["running", "completed", "failed", "blocked", "stopped"]),
  exitCode: z.number().int().optional(),
  dispatchId: z.uuid().optional(),
})

// Remote Control (REMOTE_CONTROL.md): what one session is doing. Tool lines
// carry a short target (a path, a command, an address), never tool output
export const LiveEvent = z.strictObject({
  seq: z.number().int().min(0),
  at: z.number().int().positive(),
  kind: z.enum(["user", "assistant", "tool_start", "tool_end"]),
  text: z.string().max(8000).optional(),
  callId: z.string().max(100).optional(),
  tool: z.string().max(60).optional(),
  target: z.string().max(400).optional(),
  status: z.enum(["ok", "error", "declined"]).optional(),
  ms: z.number().int().min(0).optional(),
})

export const LiveReportRequest = z.strictObject({
  deviceSessionId: z.string().min(1).max(100),
  title: z.string().max(120).optional(),
  project: z.string().max(80).optional(),
  remote: z.boolean(),
  state: z.enum(["running", "waiting", "idle", "ended"]),
  events: z.array(LiveEvent).max(100),
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
  {
    method: "GET",
    path: "/mcp",
    auth: true,
    request: null,
    response: McpServersResponse,
  },
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
  // Editing Studio: 404 while editing.studio is off
  {
    method: "GET",
    path: "/editing/manifest",
    auth: true,
    request: null,
    response: EditingManifestResponse,
  },
  {
    method: "GET",
    path: "/editing/features",
    auth: true,
    request: null,
    response: EditingFeaturesResponse,
  },
  {
    method: "POST",
    path: "/editing/media",
    auth: true,
    request: EditingMediaRequest,
    response: EditingMediaResponse,
  },
  {
    method: "POST",
    path: "/editing/define",
    auth: true,
    request: EditingDefineRequest,
    response: EditingDefineResponse,
  },
  // Editing previews: 404 while editing.previews is off or the job isn't this computer's
  {
    method: "POST",
    path: "/editing/jobs/{id}/previews",
    auth: true,
    request: EditingPreviewRequest,
    response: EditingPreviewResponse,
  },
  // 204: the upload finished; the worker checks the object before anyone can watch it
  {
    method: "POST",
    path: "/editing/jobs/{id}/previews/{pid}",
    auth: true,
    request: null,
    response: null,
  },
  // Decision cards and notes: 404 while editing.review is off
  {
    method: "POST",
    path: "/editing/jobs/{id}/questions",
    auth: true,
    request: EditingQuestionRequest,
    response: EditingQuestionResponse,
  },
  {
    method: "GET",
    path: "/editing/questions/{id}",
    auth: true,
    request: null,
    response: EditingAnswerResponse,
  },
  {
    method: "GET",
    path: "/editing/jobs/{id}/notes",
    auth: true,
    request: null,
    response: EditingNotesResponse,
  },
  // A new recording: 404 while editing.watchFolders is off
  {
    method: "POST",
    path: "/editing/found",
    auth: true,
    request: EditingFoundRequest,
    response: EditingFoundResponse,
  },
  // Control Center: 404 while harness.controlCenter is off
  {
    method: "POST",
    path: "/daemon/hello",
    auth: true,
    request: DaemonHelloRequest,
    response: DaemonHelloResponse,
  },
  {
    method: "GET",
    path: "/dispatch/next",
    auth: true,
    request: null,
    response: DispatchNextResponse,
  },
  // 204; 404 when it isn't this computer's or is already finished
  {
    method: "POST",
    path: "/dispatch/{id}",
    auth: true,
    request: DispatchReportRequest,
    response: null,
  },
  // 204; one row per (computer, localId)
  {
    method: "POST",
    path: "/runs",
    auth: true,
    request: RunReportRequest,
    response: null,
  },
  // 204; own-key usage counts (404 while harness.ownModels is off)
  {
    method: "POST",
    path: "/own-usage",
    auth: true,
    request: OwnUsageRequest,
    response: null,
  },
  // 204; one row per (computer, session), events kept once per seq
  {
    method: "POST",
    path: "/live",
    auth: true,
    request: LiveReportRequest,
    response: null,
  },
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
    // S-3: what a daemon reports as result.proof for a run with `proof: true`
    runProof: z.toJSONSchema(RunProof),
    // Harness 2.0: the ids a role cartridge may name (lib/harness/cartridge-ids.ts)
    cartridgeIds: {
      roles: [...CARTRIDGE_ROLES],
      gates: [...GATE_IDS],
      detectors: [...DETECTOR_IDS],
      contracts: [...CONTRACT_NAMES],
    },
  }
}
