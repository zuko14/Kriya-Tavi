import { z } from "zod"

// The runner protocol (track C, docs/cloud-execution/TOOLS_AND_CONTRACTS.md
// §2): HTTP JSON on one port inside the sandbox, a bearer token on every
// route but /v1/health. The worker's client (lib/cloud) imports these types
// only; nothing here reaches the database or a Kriya secret.

export const RUNNER_VERSION = "kriya-runner/1"

// Set by the worker at create (KRIYA_RUNNER_LIMITS, JSON) from the cloud.*
// settings; the runner refuses to start on a bad value
export const limitsSchema = z
  .object({
    bodyBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    importBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024 * 1024)
      .default(200 * 1024 * 1024),
    importFiles: z.number().int().min(1).max(200_000).default(50_000),
    checkpointBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    commandTimeoutSeconds: z.number().int().min(1).max(1800).default(600),
    outputMemoryBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024)
      .default(64 * 1024),
    headBytes: z
      .number()
      .int()
      .min(256)
      .max(64 * 1024)
      .default(8 * 1024),
    tailBytes: z
      .number()
      .int()
      .min(256)
      .max(64 * 1024)
      .default(8 * 1024),
    readLines: z.number().int().min(1).max(20_000).default(2000),
    readBytes: z
      .number()
      .int()
      .min(1024)
      .max(4 * 1024 * 1024)
      .default(256 * 1024),
    listEntries: z.number().int().min(1).max(20_000).default(2000),
    searchMatches: z.number().int().min(1).max(5000).default(500),
    searchLineChars: z.number().int().min(20).max(4000).default(400),
    searchSeconds: z.number().int().min(1).max(60).default(10),
    diffBytes: z
      .number()
      .int()
      .min(1024)
      .max(4 * 1024 * 1024)
      .default(200 * 1024),
    // CD-12 profile; a worker that doesn't say gets no network
    network: z.enum(["registries", "offline"]).default("offline"),
  })
  .strict()
export type Limits = z.infer<typeof limitsSchema>

// Relative to /workspace; resolved and checked by the runner (runner/paths.ts)
const relPath = z.string().min(1).max(1024)
// Names a command may set; never PATH, HOME or the dynamic loader's
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
  .refine((name) => name !== "PATH" && name !== "HOME" && !name.startsWith("LD_"), {
    message: "PATH, HOME and LD_* can't be set",
  })

export const execRequest = z
  .object({
    command: z.string().min(1).max(4000),
    cwd: relPath.optional(),
    timeoutSeconds: z.number().int().min(1).max(1800),
    env: z.record(envName, z.string().max(4096)).optional(),
  })
  .strict()

export const readRequest = z
  .object({
    path: relPath,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    // The whole file as base64 (binary files, up to readBytes)
    encoding: z.literal("base64").optional(),
  })
  .strict()

export const writeRequest = z
  .object({
    path: relPath,
    // base64 when encoding says so
    content: z.string(),
    encoding: z.literal("base64").optional(),
    expectSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()

export const editRequest = z
  .object({
    path: relPath,
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict()

export const patchRequest = z.object({ patch: z.string().min(1) }).strict()

export const listRequest = z
  .object({ path: relPath.optional(), depth: z.number().int().min(1).max(8).optional() })
  .strict()

export const searchRequest = z
  .object({
    pattern: z.string().min(1).max(200),
    path: relPath.optional(),
    glob: z.string().min(1).max(200).optional(),
    fixed: z.boolean().optional(),
  })
  .strict()

export const changesRequest = z
  .object({ maxDiffBytes: z.number().int().min(1024).optional() })
  .strict()

export const filesRequest = z
  .object({ changeSetId: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()

export type ExecRequest = z.infer<typeof execRequest>
export type ReadRequest = z.infer<typeof readRequest>
export type WriteRequest = z.infer<typeof writeRequest>
export type EditRequest = z.infer<typeof editRequest>
export type ListRequest = z.infer<typeof listRequest>
export type SearchRequest = z.infer<typeof searchRequest>

// /v1/exec answers NDJSON: out events while they fit in memory, then one end
export type ExecEvent =
  | { type: "out"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "end"
      exitCode: number | null
      signal: string | null
      timedOut: boolean
      durationMs: number
      // Whole output, or head + marker + tail when truncated
      stdout: string
      stderr: string
      truncated: boolean
      // Full output of both streams, readable with /v1/read
      logPath: string
    }

export type ReadResult =
  | { text: string; lines: number; sha256: string; truncated: boolean }
  | { binary: true; bytes: number; sha256: string }
  | { base64: string; bytes: number; sha256: string }

export type ChangeStatus = "added" | "modified" | "deleted"

export type ChangedFile = {
  path: string
  status: ChangeStatus
  added: number
  removed: number
  binary: boolean
  bytes: number
}

export type Changes = {
  changeSetId: string
  files: ChangedFile[]
  diff: string
  truncated: boolean
}

export type ChangeSetFile = {
  path: string
  status: ChangeStatus
  mode: "100644" | "100755" | "120000"
  contentBase64?: string
}

export type ImportResult = { files: number; bytes: number; baseCommit: string }

// Every refusal: an HTTP status and a sentence the model can act on
export class RunnerError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
