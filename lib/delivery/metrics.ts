import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import type { Episode } from "@/db/schema"
import {
  deliveryOf,
  type DeliveryCheck,
  type DeliveryStatus,
} from "@/lib/delivery/status"

// Delivery metrics NM1–NM10 for the owner page (ND-17, EVALUATION_PLAN §1):
// counts and rates across everyone, read with the server's rights and never
// shown with any content (AT-OWN-A1). NM1–NM5 exist only where agents.inbox
// is on, because they read "What I did". Every rate carries its n; a rate
// with n = 0 is "no data", never 0. Imports no next/*.
//
// shortcut: episodes in the window are loaded and judged in TypeScript with
// deliveryOf, so the page and the person's card can't disagree; move to SQL
// aggregates if a window ever holds more than ~100k episodes.

const num = (value: unknown) => Number(value ?? 0)

// What a tool error says when an app was busy (lib/reliability: "The app is
// busy (503).", "… isn't responding; Kriya stopped trying…") or a connector
// reported a transient status
const TRANSIENT_ERROR = "is busy \\(|isn't responding|\\((429|502|503|504)\\)"

type Row = {
  task_id: string
  done: Episode["done"]
  unconfirmed: Episode["unconfirmed"]
  checks: Episode["checks"]
}
type CheckRow = DeliveryCheck & { task_id: string }

export async function deliveryMetrics(days: number) {
  const since = sql`now() - make_interval(days => ${days})`

  const episodes = rowsOf<Row>(
    await privileged.execute(sql`
      select task_id, done, unconfirmed, checks from kriya.episodes
      where created_at >= ${since} and deleted_at is null and task_id is not null`)
  )
  // Each task's own checks only (a check never crosses tasks)
  const checkRows = rowsOf<CheckRow>(
    await privileged.execute(sql`
      select task_id, execution_id as "executionId", status, kind from kriya.delivery_checks
      where task_id in (
        select task_id from kriya.episodes
        where created_at >= ${since} and deleted_at is null and task_id is not null)`)
  )
  const checksByTask = Map.groupBy(checkRows, (row) => row.task_id)

  const status = new Map<string, DeliveryStatus>()
  const counts: Record<DeliveryStatus, number> = {
    delivered: 0,
    partly: 0,
    not_confirmed: 0,
    nothing_to_deliver: 0,
  }
  for (const row of episodes) {
    const result = deliveryOf(row, checksByTask.get(row.task_id) ?? []).status
    status.set(row.task_id, result)
    counts[result]++
  }
  // NM1–NM3: tasks whose status isn't nothing_to_deliver
  const judged = counts.delivered + counts.partly + counts.not_confirmed

  // NM4: of the runs re-checked in the window, how many a re-check verified
  const nm4 = rowsOf<{ verified: string; total: string }>(
    await privileged.execute(sql`
      select count(*) filter (where status = 'verified') as verified, count(*) as total
      from kriya.delivery_checks where kind = 'recheck' and checked_at >= ${since}`)
  )[0]

  // NM5: records that make a claim no tool run backs (no executionId)
  const unbacked = episodes.filter((row) =>
    row.unconfirmed.some((claim) => !claim.executionId)
  ).length

  // NM6: what delivered tasks cost the person, never ₹0 for a missing price
  const delivered = episodes.filter((row) => status.get(row.task_id) === "delivered")
  const charges = delivered.length
    ? rowsOf<{ task_id: string; micro: string | null; status: string }>(
        await privileged.execute(sql`
          select task_id, charge_micro_inr as micro, status from kriya.charges
          where task_id in (
            select task_id from kriya.episodes
            where created_at >= ${since} and deleted_at is null and task_id is not null)`)
      ).filter((row) => status.get(row.task_id) === "delivered")
    : []
  const priced = charges.filter((row) => row.micro !== null && row.status !== "unpriced")
  const sum = (label: string) =>
    priced
      .filter((row) => row.status === label)
      .reduce((total, row) => total + num(row.micro), 0)
  const finalMicroInr = sum("final")
  const estimatedMicroInr = sum("estimated")

  // NM8, the part records can show: an app action that changes something
  // with no approval of that tool in its thread before it ran. Drifted tool
  // runs, guard bypasses and a token sent to the wrong server leave no row;
  // they're in the logs (MCP_CONNECTIVITY §8), so this is a floor, not the
  // whole metric.
  const nm8 = rowsOf<{ n: string }>(
    await privileged.execute(sql`
      select count(*) as n
      from kriya.tool_executions te
      join kriya.tasks t on t.id = te.task_id
      where te.tool_name like 'mcp\\_%' and te.side_effect and te.started_at >= ${since}
        and not exists (
          select 1 from kriya.approvals a
          where a.thread_id = t.thread_id and a.user_id = te.user_id
            and a.tool_name = te.tool_name and a.status = 'approved'
            and a.decided_at <= te.started_at)`)
  )[0]

  // NM9: per app, executions that failed
  const nm9 = rowsOf<{ server: string; failed: string; total: string }>(
    await privileged.execute(sql`
      select split_part(tool_name, '_', 2) as server,
             count(*) filter (where status = 'failed') as failed, count(*) as total
      from kriya.tool_executions
      where tool_name like 'mcp\\_%' and started_at >= ${since}
      group by 1 order by 1`)
  )

  // NM10: a step is wasted when every tool call in it failed because an app was
  // busy or its circuit was open: that model call bought nothing. A tool call
  // belongs to the step whose usage row is the first at or after it
  // (usage is recorded when a step ends).
  const nm10 = rowsOf<{ wasted: string; steps: string }>(
    await privileged.execute(sql`
      with steps as (
        select id, task_id, attempt, created_at,
               lag(created_at) over (partition by task_id, attempt order by created_at) as prev
        from kriya.usage_events
        where task_id is not null and created_at >= ${since}
      ), calls as (
        select s.id,
               bool_and(te.status = 'failed' and te.error ~ ${TRANSIENT_ERROR}) as all_transient
        from steps s
        join kriya.tool_executions te
          on te.task_id = s.task_id and te.attempt = s.attempt
         and te.started_at <= s.created_at and (s.prev is null or te.started_at > s.prev)
        group by s.id
      )
      select (select count(*) from calls where all_transient) as wasted,
             (select count(*) from steps) as steps`)
  )[0]

  // C1 and C3 (track A's measures, shown here beside the cost work): input
  // tokens per task, and the share of input tokens a provider served from cache.
  // A row whose usage wasn't reported is in neither; C3 also leaves out rows
  // that didn't say how much was cached, rather than counting them as 0.
  const tokens = rowsOf<{
    input: string | null
    tasks: string
    cached: string | null
    cached_input: string | null
  }>(
    await privileged.execute(sql`
      select sum(input_tokens) as input, count(distinct task_id) as tasks,
             sum(cached_tokens) as cached,
             sum(input_tokens) filter (where cached_tokens is not null) as cached_input
      from kriya.usage_events
      where task_id is not null and created_at >= ${since}
        and usage_status = 'reported' and input_tokens is not null`)
  )[0]

  return {
    days,
    statuses: counts,
    nm1: { delivered: counts.delivered, n: judged },
    nm2: { partly: counts.partly, n: judged },
    nm3: { notConfirmed: counts.not_confirmed, n: judged },
    nm4: { verified: num(nm4.verified), n: num(nm4.total) },
    nm5: { unbacked, n: episodes.length },
    nm6: {
      delivered: delivered.length,
      priced: priced.length,
      // A delivered task with no charge yet is also not priced, never ₹0
      unpriced: delivered.length - priced.length,
      finalMicroInr,
      estimatedMicroInr,
      // Mean over priced tasks only, rounded to the micro-rupee
      perTaskMicroInr: priced.length
        ? Math.round((finalMicroInr + estimatedMicroInr) / priced.length)
        : null,
    },
    nm8: { unapproved: num(nm8.n) },
    nm10: { wasted: num(nm10.wasted), n: num(nm10.steps) },
    c1: { inputTokens: num(tokens.input), tasks: num(tokens.tasks) },
    c3: { cachedTokens: num(tokens.cached), inputTokens: num(tokens.cached_input) },
    nm9: nm9.map((row) => ({
      server: row.server,
      failed: num(row.failed),
      n: num(row.total),
    })),
  }
}

export type DeliveryMetrics = Awaited<ReturnType<typeof deliveryMetrics>>
