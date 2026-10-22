import { and, asc, eq, gt, inArray, isNotNull, isNull, like, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { privileged, withUser } from "@/db"
import { toolExecutions, type UndoSpec, type Verification } from "@/db/schema"
import {
  calendarDelete,
  ConnectorError,
  driveUnshare,
  gmailDeleteDraft,
  readBack,
} from "@/lib/connectors"
import {
  githubCloseIssue,
  githubDeleteComment,
  githubRemoveLabels,
} from "@/lib/connectors/github"
import { log } from "@/lib/log"

// The Undo window (K3, AD-29). A tool with a reliable reverse records, from
// its own result, the provider ids its compensation needs; for 10 minutes
// the person (never an agent: there is no undo tool) can ask to reverse
// it. The request marks the run and queues the compensation as its own
// tool run in one transaction; the worker runs it and reads the result back.
// Not undoable: sheets_append (rows may have shifted), Instagram and
// YouTube posts (RG-10), browser commits, a sent email (G2).

export const UNDO_WINDOW_MS = 10 * 60_000

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0
const verified = (o: Record<string, unknown>) =>
  (o.verification as Verification | undefined)?.status === "verified"

// How to reverse a finished run, from its result; null when it can't be
export function undoOf(tool: string, output: unknown): UndoSpec | null {
  const o = (output && typeof output === "object" ? output : {}) as Record<
    string,
    unknown
  >
  switch (tool) {
    case "calendar_create_event":
      return str(o.id)
        ? {
            kind: "calendar_event",
            eventId: o.id,
            notifies: Array.isArray(o.attendees) && o.attendees.length > 0,
          }
        : null
    case "gmail_draft":
      return str(o.draftId) ? { kind: "gmail_draft", draftId: o.draftId } : null
    case "github_comment":
      return verified(o) && str(o.repo) && typeof o.commentId === "number"
        ? { kind: "github_comment", repo: o.repo, commentId: o.commentId }
        : null
    case "github_label":
      return verified(o) &&
        str(o.repo) &&
        typeof o.number === "number" &&
        Array.isArray(o.added) &&
        o.added.length > 0
        ? {
            kind: "github_labels",
            repo: o.repo,
            number: o.number,
            labels: o.added.filter(str),
          }
        : null
    case "github_create_issue":
      return verified(o) && str(o.repo) && typeof o.number === "number"
        ? { kind: "github_issue", repo: o.repo, number: o.number }
        : null
    // G2: only the permissions it added, even if it stopped part-way
    case "drive_share":
      return str(o.fileId) && Array.isArray(o.permissionIds) && o.permissionIds.length > 0
        ? {
            kind: "drive_permissions",
            fileId: o.fileId,
            permissionIds: o.permissionIds.filter(str),
          }
        : null
    default:
      return null
  }
}

// The columns run-task.ts writes when a run succeeds (agents.undo on)
export function undoColumns(tool: string, output: unknown, now = Date.now()) {
  const undo = undoOf(tool, output)
  return undo ? { undo, undoUntil: new Date(now + UNDO_WINDOW_MS) } : {}
}

// What the button does, in the person's words
export function undoLabel(undo: UndoSpec) {
  switch (undo.kind) {
    case "calendar_event":
      return undo.notifies
        ? "Delete the event. Invitees get a cancellation from Google."
        : "Delete the event."
    case "gmail_draft":
      return "Delete the draft."
    case "github_comment":
      return "Delete the comment."
    case "github_labels":
      return `Remove ${undo.labels.length === 1 ? "the label" : "the labels"} it added.`
    case "github_issue":
      return "Close the issue as not planned (GitHub doesn't let most people delete one)."
    case "drive_permissions":
      return "Remove the access it gave."
  }
}

/* ───────────────────────── the person's request ─────────────────── */

// Called by actions/undo.ts after requireUser. The update re-checks owner,
// window and "not yet" in SQL, so a second click or a late one changes
// nothing; the compensation row is inserted in the same transaction.
export async function requestUndo(userId: string, executionId: string) {
  const queued = await privileged.transaction(async (tx) => {
    const [row] = await tx
      .update(toolExecutions)
      .set({ undoneAt: sql`now()` })
      .where(
        and(
          eq(toolExecutions.id, executionId),
          eq(toolExecutions.userId, userId),
          eq(toolExecutions.status, "succeeded"),
          isNotNull(toolExecutions.undo),
          isNull(toolExecutions.undoneAt),
          gt(toolExecutions.undoUntil, sql`now()`)
        )
      )
      .returning()
    if (!row) return false
    await tx.insert(toolExecutions).values({
      taskId: row.taskId,
      userId: row.userId,
      attempt: row.attempt,
      toolCallId: `undo:${row.toolCallId}`,
      toolName: `undo:${row.toolName}`,
      sideEffect: true,
      input: row.undo,
    })
    return true
  })
  if (queued) return { ok: true as const }

  // Why not, read as the person
  const [row] = await withUser(userId, (tx) =>
    tx
      .select({ undo: toolExecutions.undo, undoneAt: toolExecutions.undoneAt })
      .from(toolExecutions)
      .where(eq(toolExecutions.id, executionId))
  )
  if (!row) return { error: "That action wasn't found." }
  if (!row.undo) return { error: "That action can't be undone." }
  if (row.undoneAt) return { error: "That action is already being undone." }
  return { error: "The 10-minute undo window has closed." }
}

/* ──────────────────────────── the worker ────────────────────────── */

async function compensate(userId: string, undo: UndoSpec) {
  switch (undo.kind) {
    case "calendar_event":
      return calendarDelete(userId, undo.eventId, undo.notifies)
    case "gmail_draft":
      return gmailDeleteDraft(userId, undo.draftId)
    case "github_comment":
      return githubDeleteComment(userId, undo.repo, undo.commentId)
    case "github_labels":
      return githubRemoveLabels(userId, undo.repo, undo.number, undo.labels)
    case "github_issue":
      return githubCloseIssue(userId, undo.repo, undo.number)
    case "drive_permissions":
      return driveUnshare(userId, undo.fileId, undo.permissionIds)
  }
}

const target = (undo: UndoSpec) => {
  switch (undo.kind) {
    case "calendar_event":
      return undo.eventId
    case "gmail_draft":
      return undo.draftId
    case "github_comment":
      return String(undo.commentId)
    case "drive_permissions":
      return undo.fileId
    default:
      return `${undo.repo}#${undo.number}`
  }
}

// Queued compensations, oldest first. No lock is held across the API calls
// (they need their own connection for the token): two workers may run the
// same one, and a worker that dies mid-way leaves it queued for the next
// pass. Both are safe because every compensation treats "already gone" as
// done, and only the first result is recorded.
// ponytail: duplicate work possible with several workers; a lease column if
// that ever costs anything
export async function runUndos(limit = 5) {
  const rows = await privileged
    .select()
    .from(toolExecutions)
    .where(
      and(eq(toolExecutions.status, "running"), like(toolExecutions.toolCallId, "undo:%"))
    )
    .orderBy(asc(toolExecutions.startedAt))
    .limit(limit)
  for (const row of rows) {
    const undo = row.input as UndoSpec
    const started = Date.now()
    let verification: Verification | null = null
    let error: string | null = null
    try {
      const reversed = await compensate(row.userId, undo)
      verification = readBack(
        reversed,
        [{ kind: "provider_id", value: target(undo) }],
        reversed ? "Read back: the change is reversed." : "Read back: it is still there."
      )
      if (!reversed) error = "The read-back shows it is still there."
    } catch (e) {
      error = e instanceof ConnectorError ? e.message : "The undo failed."
      log.error("undo failed", { executionId: row.id, error: e })
    }
    await privileged
      .update(toolExecutions)
      .set({
        status: error ? "failed" : "succeeded",
        verification,
        error,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      })
      .where(and(eq(toolExecutions.id, row.id), eq(toolExecutions.status, "running")))
  }
  return rows.length
}

/* ───────────────────────────── for the UI ───────────────────────── */

export type UndoState = {
  executionId: string
  label: string
  // GitHub issues can only be closed (SIGNATURE_FEATURES K3)
  verb: "Undo" | "Close"
  until: string
  state: "available" | "expired" | "queued" | "done" | "failed"
  error: string | null
}

// The Undo state of the person's own runs (withUser). Runs without an undo
// record (non-undoable tools) aren't returned, so they get no button.
export async function undoStates(
  userId: string,
  executionIds: string[]
): Promise<UndoState[]> {
  if (executionIds.length === 0) return []
  const comp = alias(toolExecutions, "compensation")
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        id: toolExecutions.id,
        undo: toolExecutions.undo,
        undoUntil: toolExecutions.undoUntil,
        undoneAt: toolExecutions.undoneAt,
        status: comp.status,
        error: comp.error,
      })
      .from(toolExecutions)
      .leftJoin(
        comp,
        and(
          eq(comp.taskId, toolExecutions.taskId),
          eq(comp.attempt, toolExecutions.attempt),
          eq(comp.toolCallId, sql`'undo:' || ${toolExecutions.toolCallId}`)
        )
      )
      .where(
        and(inArray(toolExecutions.id, executionIds), isNotNull(toolExecutions.undo))
      )
  )
  const now = Date.now()
  return rows.map((row) => ({
    executionId: row.id,
    label: undoLabel(row.undo!),
    verb: row.undo!.kind === "github_issue" ? "Close" : "Undo",
    until: row.undoUntil!.toISOString(),
    state: !row.undoneAt
      ? row.undoUntil!.getTime() > now
        ? "available"
        : "expired"
      : row.status === "succeeded"
        ? "done"
        : row.status === "failed"
          ? "failed"
          : "queued",
    error: row.error,
  }))
}
