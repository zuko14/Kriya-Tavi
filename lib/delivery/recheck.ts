import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { deliveryChecks, type Verification } from "@/db/schema"
import { ConnectorError, jsonOf, providerFetch } from "@/lib/connectors"
import { githubReadIssue } from "@/lib/connectors/github"
import { sameCells, sheetsRead } from "@/lib/connectors/sheets"
import {
  RECHECK_AFTER_MS,
  RECHECK_TOOLS,
  RECHECK_UNTIL_MS,
  recheckTarget,
  type RecheckTarget,
} from "@/lib/delivery/rules"
import { log } from "@/lib/log"

// The late re-check (ND-04): once, 2 to 30 minutes after a side-effect run
// finished without being confirmed, read what it made again with the run's
// own person's token and record the answer as one new delivery_checks row.
// Reads only; nothing is retried, and the episode, the run and the receipt
// hash are never touched. Runs in kriya-worker (schedulerLoop). Logs carry
// ids only. Imports no next/*.

export type CheckStatus = "verified" | "unverified" | "failed" | "gone"
type Cell = string | number

// What each provider answered, as far as the rule needs it. A reader throws
// when it can't read (provider error, no access): that's "unverified".
export type Readers = {
  calendar(
    userId: string,
    eventId: string
  ): Promise<
    | { found: false }
    | {
        found: true
        cancelled: boolean
        title: string
        attendees: string[]
        startMs: number | null
      }
  >
  // null: GitHub says 404, which also means "the app can't see that repository"
  githubIssue(
    userId: string,
    ref: { repo: string; number: number }
  ): Promise<{ title: string } | null>
  // "gone": the spreadsheet isn't there
  sheetsRange(
    userId: string,
    ref: { spreadsheetId: string; range: string }
  ): Promise<Cell[][] | "gone">
}

const GOOGLE = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

export const providerReaders: Readers = {
  async calendar(userId, eventId) {
    const response = await providerFetch(
      userId,
      "google",
      `${GOOGLE}/${encodeURIComponent(eventId)}`
    )
    if (response.status === 404 || response.status === 410) return { found: false }
    const event = await jsonOf<{
      status?: string
      summary?: string
      start?: { dateTime?: string }
      attendees?: { email: string }[]
    }>(response, "Reading the event")
    const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN
    return {
      found: true,
      cancelled: event.status === "cancelled",
      title: event.summary ?? "",
      attendees: event.attendees?.map((a) => a.email) ?? [],
      startMs: Number.isNaN(start) ? null : start,
    }
  },
  async githubIssue(userId, ref) {
    try {
      const issue = await githubReadIssue(userId, ref)
      return { title: issue.title }
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.message.startsWith("Not found on GitHub")
      )
        return null
      throw error
    }
  },
  async sheetsRange(userId, ref) {
    try {
      return (await sheetsRead(userId, ref)).rows
    } catch (error) {
      if (error instanceof ConnectorError && error.message.includes("wasn't found"))
        return "gone"
      throw error
    }
  },
}

// The same email addresses, ignoring case, order and display names
const norm = (list: string[]) =>
  [...new Set(list.map((a) => a.trim().toLowerCase()))].sort().join(",")
// A read gives formatted text, a write gave numbers and text: compare as text
const asText = (rows: Cell[][]) => rows.map((row) => row.map(String))

export type Verdict = { status: CheckStatus; note: string }

// What a read of the run's own object says about it. Throws if it can't read.
export async function judge(
  userId: string,
  target: RecheckTarget,
  readers: Readers
): Promise<Verdict> {
  if (target.kind === "calendar") {
    const found = await readers.calendar(userId, target.eventId)
    if (!found.found || found.cancelled)
      return { status: "gone", note: "Checked again: the event is no longer there." }
    const same =
      found.title === target.title &&
      norm(found.attendees) === norm(target.attendees) &&
      (target.startMs === null || found.startMs === target.startMs)
    return same
      ? { status: "verified", note: "Checked again: the event is there as created." }
      : {
          status: "failed",
          note: "Checked again: the event is there but differs from what was created.",
        }
  }
  if (target.kind === "github_issue") {
    const found = await readers.githubIssue(userId, target)
    if (!found)
      return {
        status: "unverified",
        note: "Checked again: GitHub couldn't find it (deleted, or access changed).",
      }
    return found.title === target.title
      ? { status: "verified", note: "Checked again: the issue is there with this title." }
      : {
          status: "failed",
          note: "Checked again: the issue's title differs from what was created.",
        }
  }
  const found = await readers.sheetsRange(userId, target)
  if (found === "gone")
    return { status: "gone", note: "Checked again: the spreadsheet is no longer there." }
  return sameCells(asText(found), asText(target.rows))
    ? { status: "verified", note: "Checked again: the range holds these values." }
    : { status: "failed", note: "Checked again: the range holds different values." }
}

type Candidate = {
  id: string
  user_id: string
  task_id: string
  tool_name: string
  input: unknown
  verification: unknown
  undo: unknown
}

// One re-check per eligible run per tick, at most `limit` runs (the unique
// key on (execution_id, kind) makes a repeat or a second worker harmless)
export async function recheckDeliveries(
  now = new Date(),
  { limit = 50, readers = providerReaders }: { limit?: number; readers?: Readers } = {}
) {
  const from = new Date(now.getTime() - RECHECK_UNTIL_MS)
  const to = new Date(now.getTime() - RECHECK_AFTER_MS)
  // Dates go in as ISO text: the database driver can't send a Date inside a raw
  // query (PGlite can, which is why the tests never showed it)
  // shortcut: eligibility is finished here by recheckTarget (the one rule);
  // a candidate it rejects only costs a slot for its 30 minutes
  const candidates = rowsOf<Candidate>(
    await privileged.execute(sql`
      select te.id, te.user_id, te.task_id, te.tool_name, te.input, te.verification, te.undo
      from kriya.tool_executions te
      where te.side_effect and te.status = 'succeeded'
        and te.tool_name in (${sql.join(
          RECHECK_TOOLS.map((tool) => sql`${tool}`),
          sql`, `
        )})
        and (te.verification is null or te.verification ->> 'status' = 'unverified')
        and te.finished_at >= ${from.toISOString()}::timestamptz
        and te.finished_at <= ${to.toISOString()}::timestamptz
        and not exists (
          select 1 from kriya.delivery_checks dc
          where dc.execution_id = te.id and dc.kind = 'recheck')
      order by te.finished_at
      limit ${limit}`)
  )

  const result = { candidates: candidates.length, checked: 0, skipped: 0, errors: 0 }
  const tally: Record<CheckStatus, number> = {
    verified: 0,
    unverified: 0,
    failed: 0,
    gone: 0,
  }
  for (const run of candidates) {
    try {
      const target = recheckTarget({
        toolName: run.tool_name,
        input: run.input,
        verification: run.verification,
        undo: run.undo,
      })
      if (!target) {
        result.skipped++
        continue
      }
      let verdict: Verdict
      try {
        // Always the run's own person's token: a provider id from anywhere
        // else could only ever be read as them
        verdict = await judge(run.user_id, target, readers)
      } catch (error) {
        log.warn("delivery re-check couldn't read", {
          executionId: run.id,
          error: (error as Error)?.name ?? "error",
        })
        verdict = { status: "unverified", note: "Checked again: it couldn't be read." }
      }
      const evidence: Verification["evidence"] = [
        {
          kind: "provider_id",
          value:
            target.kind === "calendar"
              ? target.eventId
              : target.kind === "github_issue"
                ? `${target.repo}#${target.number}`
                : target.range,
        },
      ]
      const inserted = await privileged
        .insert(deliveryChecks)
        .values({
          userId: run.user_id,
          taskId: run.task_id,
          executionId: run.id,
          kind: "recheck",
          status: verdict.status,
          evidence,
          note: verdict.note,
        })
        .onConflictDoNothing()
        .returning({ id: deliveryChecks.id })
      if (inserted.length > 0) {
        result.checked++
        tally[verdict.status]++
      }
    } catch (error) {
      result.errors++
      log.error("delivery re-check failed", { executionId: run.id, error })
    }
  }
  return { ...result, ...tally }
}
