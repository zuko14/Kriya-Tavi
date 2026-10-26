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
// (its own read-back already proves "gone"). MCP read-back belongs to N7.
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

export type RecheckRun = {
  toolName: string
  input: unknown
  verification: unknown
  undo?: unknown
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
export function recheckTarget(run: RecheckRun): RecheckTarget | null {
  const verification = verificationOf({ verification: run.verification })
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
