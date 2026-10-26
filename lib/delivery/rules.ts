import type { Verification } from "@/db/schema"
import { verificationOf } from "@/lib/agent/verify"
import { REPO } from "@/lib/connectors/github"
import { SPREADSHEET_ID } from "@/lib/connectors/sheets"

// Which runs the late re-check may look at again, and what to look at
// (ND-04, TOOLS_AND_CONTRACTS §3.2). One rule for the worker step and for the
// "Kriya will check again by …" line, so they can't disagree. Pure; imports
// no next/*.

// Between 2 and 30 minutes after the run finished, once
export const RECHECK_AFTER_MS = 2 * 60_000
export const RECHECK_UNTIL_MS = 30 * 60_000

// The tools that have a reader. Not re-checkable in v1: gmail_draft,
// drive_share, gmail_send_draft, instagram_publish, github_comment,
// github_label, github_open_pr (no exported reader), calendar_delete_event
// (its own read-back already proves "gone"). An MCP run is re-checked by its
// own read-back spec (see the "mcp" target), not by a tool name here.
export const RECHECK_TOOLS = [
  "calendar_create_event",
  "github_create_issue",
  "sheets_append",
  "sheets_update",
] as const

type Cell = string | number

export type RecheckTarget =
  | {
      kind: "calendar"
      eventId: string
      title: string
      attendees: string[]
      // Only when the input carried an explicit offset or Z
      startMs: number | null
    }
  | { kind: "github_issue"; repo: string; number: number; title: string }
  | { kind: "sheets"; spreadsheetId: string; range: string; rows: Cell[][] }
  // `result`: the app's structured answer as far as the run's summary kept it
  // (undefined when it was cut); the worker looks up the pinned read spec
  | { kind: "mcp"; kriyaName: string; input: unknown; result: unknown }

export type RecheckRun = {
  toolName: string
  input: unknown
  verification: unknown
  undo?: unknown
  outputSummary?: string | null
}

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {}
const text = (value: unknown) => (typeof value === "string" ? value : null)

// Evidence the run recorded about what it made: its own provider id
const providerId = (verification: Verification | null) =>
  verification?.evidence.find((e) => e.kind === "provider_id")?.value ?? null

// The thing to read again, or null when the run isn't eligible: its
// read-back must have been inconclusive (unverified) or missing, never
// failed (ND-04), and it must say what it made and what it was told to make.
const MCP_NAME = /^mcp_[a-z]{2,12}_[a-z_]{2,22}$/

// The structured result an MCP run's summary kept; the summary is cut at 500
// characters, so a long answer is gone and the lookup may then be unverified
function savedResult(summary: string | null | undefined): unknown {
  try {
    return summary ? (JSON.parse(summary) as { result?: unknown }).result : undefined
  } catch {
    return undefined
  }
}

export function recheckTarget(run: RecheckRun): RecheckTarget | null {
  const verification = verificationOf({ verification: run.verification })
  if (MCP_NAME.test(run.toolName))
    // No verification at all means the owner gave it no read-back spec
    return verification?.status === "unverified"
      ? {
          kind: "mcp",
          kriyaName: run.toolName,
          input: run.input,
          result: savedResult(run.outputSummary),
        }
      : null
  if (verification && verification.status !== "unverified") return null
  const input = obj(run.input)
  const undo = obj(run.undo)
  const id = providerId(verification)

  if (run.toolName === "calendar_create_event") {
    const eventId = id ?? (undo.kind === "calendar_event" ? text(undo.eventId) : null)
    const title = text(input.title)
    if (!eventId || !/^[A-Za-z0-9_-]{5,1024}$/.test(eventId) || !title) return null
    const start = text(input.start)
    const parsed = start && /(Z|[+-]\d{2}:?\d{2})$/.test(start) ? Date.parse(start) : NaN
    return {
      kind: "calendar",
      eventId,
      title,
      attendees: Array.isArray(input.attendees)
        ? input.attendees.filter((a): a is string => typeof a === "string")
        : [],
      startMs: Number.isNaN(parsed) ? null : parsed,
    }
  }

  if (run.toolName === "github_create_issue") {
    const fromUndo =
      undo.kind === "github_issue" ? `${text(undo.repo)}#${String(undo.number)}` : null
    const match = /^(.+)#(\d{1,9})$/.exec(id ?? fromUndo ?? "")
    const title = text(input.title)
    if (!match || !REPO.test(match[1]) || !title) return null
    return { kind: "github_issue", repo: match[1], number: Number(match[2]), title }
  }

  if (run.toolName === "sheets_append" || run.toolName === "sheets_update") {
    const spreadsheetId = text(input.spreadsheetId)
    const range = id
    const rows = input.rows
    if (
      !spreadsheetId ||
      !SPREADSHEET_ID.test(spreadsheetId) ||
      !range ||
      !Array.isArray(rows) ||
      !rows.every(
        (row) =>
          Array.isArray(row) &&
          row.every((cell) => typeof cell === "string" || typeof cell === "number")
      )
    )
      return null
    return { kind: "sheets", spreadsheetId, range, rows: rows as Cell[][] }
  }
  return null
}

// When a run that is waiting for its re-check will have had it, or null
export function recheckBy(finishedAt: Date | null, now: Date) {
  if (!finishedAt) return null
  const by = finishedAt.getTime() + RECHECK_UNTIL_MS
  return by > now.getTime() ? new Date(by) : null
}
