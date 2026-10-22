import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { MANDATE_STATUSES, type Grant } from "@/db/schema"
import { grantMatches } from "@/lib/operator/grants"

// Operator metrics OM1–OM8 (track O, O8; TEST_AND_EVALUATION §2) for the
// owner's page, across every person: counts and tool names only, never a
// title, an address or anything a person wrote (OT-SEC-03). Values are
// returned as counts ("x of n"); the page never rounds them.

// Nearest rank, as lib/quotes.ts
const rank = (sorted: number[], q: number) => sorted[Math.ceil(q * sorted.length) - 1]

// Rows of a job's own goal thread: approvals, episodes, tasks
const JOB_THREAD = sql`
  kriya.goals g join kriya.mandates m on m.goal_id = g.id and m.user_id = g.user_id`

export async function operatorMetrics(days: number) {
  const since = sql`now() - make_interval(days => ${days})`
  const one = async <T>(query: ReturnType<typeof sql>) =>
    rowsOf<T>(await privileged.execute(query))[0]
  const num = (v: unknown) => Number(v ?? 0)

  // OM1: of the jobs that ended in the window (declined never started), how many were done
  const om1 = await one<{ completed: string; ended: string }>(sql`
    select count(*) filter (where status = 'completed') as completed, count(*) as ended
    from kriya.mandates
    where status in ('completed', 'expired', 'revoked', 'closed') and closed_at >= ${since}`)

  // OM2: "What I did" records in job threads that list an unconfirmed claim
  const om2 = await one<{ unconfirmed: string; records: string }>(sql`
    select count(*) filter (where jsonb_array_length(e.unconfirmed) > 0) as unconfirmed,
           count(*) as records
    from kriya.episodes e join ${JOB_THREAD} on g.thread_id = e.thread_id and g.user_id = e.user_id
    where e.created_at >= ${since} and e.deleted_at is null`)

  // OM3: runs a grant answered: failed or missing checks, and any outside the grant's pins
  const granted = rowsOf<{
    tool_name: string
    input: unknown
    verification: { status?: string } | null
    tool: Grant["tool"]
    pins: Grant["pins"]
  }>(
    await privileged.execute(sql`
      select te.tool_name, te.input, te.verification, gr.tool, gr.pins
      from kriya.tool_executions te
      join kriya.grants gr on gr.id = te.grant_id and gr.user_id = te.user_id
      where te.started_at >= ${since}`)
  )
  const om3 = {
    failedChecks: granted.filter((r) => r.verification?.status !== "verified").length,
    // Re-checked from the stored input; a redacted or cut input counts as outside
    outsidePins: granted.filter(
      (r) =>
        !grantMatches(
          {
            id: "",
            tool: r.tool,
            pins: r.pins,
            maxUses: 1,
            uses: 0,
            expiresAt: new Date(),
          },
          r.tool_name,
          r.input
        )
    ).length,
    granted: granted.length,
  }

  // OM4: how long decided approvals in job threads waited
  const waits = rowsOf<{ secs: string }>(
    await privileged.execute(sql`
      select extract(epoch from a.decided_at - a.created_at) as secs
      from kriya.approvals a join ${JOB_THREAD} on g.thread_id = a.thread_id and g.user_id = a.user_id
      where a.created_at >= ${since} and a.decided_at is not null
      order by 1`)
  ).map((r) => Number(r.secs))
  const om4 = {
    n: waits.length,
    p50Seconds: waits.length ? rank(waits, 0.5) : null,
    p95Seconds: waits.length ? rank(waits, 0.95) : null,
  }

  // OM5: approvals asked in job threads, over the jobs open at some point in the window
  const om5 = await one<{ approvals: string; jobs: string }>(sql`
    select
      (select count(*) from kriya.approvals a join ${JOB_THREAD}
         on g.thread_id = a.thread_id and g.user_id = a.user_id
       where a.created_at >= ${since}) as approvals,
      (select count(*) from kriya.mandates
       where approved_at is not null and (closed_at is null or closed_at >= ${since})) as jobs`)

  // OM6: what the jobs completed in the window cost, by how sure the number is
  const om6 = await one<{
    completed: string
    final: string | null
    estimated: string | null
    unpriced: string
  }>(sql`
    select
      (select count(*) from kriya.mandates where status = 'completed' and closed_at >= ${since}) as completed,
      sum(c.charge_micro_inr) filter (where c.status = 'final') as final,
      sum(c.charge_micro_inr) filter (where c.status = 'estimated') as estimated,
      count(c.id) filter (where c.status = 'unpriced') as unpriced
    from ${JOB_THREAD}
    join kriya.tasks t on t.thread_id = g.thread_id and t.user_id = g.user_id
    join kriya.charges c on c.task_id = t.id
    where m.status = 'completed' and m.closed_at >= ${since}`)

  // OM7: the same outside action with the same input succeeding twice in one job
  const om7 = await one<{ duplicates: string }>(sql`
    select count(*) as duplicates from (
      select m.id
      from kriya.tool_executions te
      join kriya.tasks t on t.id = te.task_id
      join ${JOB_THREAD} on g.thread_id = t.thread_id and g.user_id = t.user_id
      where te.status = 'succeeded' and te.side_effect and te.started_at >= ${since}
      group by m.id, te.tool_name, te.input
      having count(*) > 1) d`)

  // OM8 (current state: status history isn't stored): needing the person now, of open jobs
  const om8 = await one<{ needs: string; open: string }>(sql`
    select count(*) filter (where status = 'needs_person') as needs, count(*) as open
    from kriya.mandates where status in ('active', 'needs_person', 'paused')`)

  const statuses = Object.fromEntries(
    rowsOf<{ status: string; n: string }>(
      await privileged.execute(
        sql`select status, count(*) as n from kriya.mandates group by status`
      )
    ).map((r) => [r.status, num(r.n)])
  ) as Partial<Record<(typeof MANDATE_STATUSES)[number], number>>

  const grants = rowsOf<{ tool: string; grants: string; uses: string; max_uses: string }>(
    await privileged.execute(sql`
      select tool, count(*) as grants, sum(uses) as uses, sum(max_uses) as max_uses
      from kriya.grants group by tool order by tool`)
  ).map((r) => ({
    tool: r.tool,
    grants: num(r.grants),
    uses: num(r.uses),
    maxUses: num(r.max_uses),
  }))

  return {
    days,
    om1: { completed: num(om1?.completed), ended: num(om1?.ended) },
    om2: { unconfirmed: num(om2?.unconfirmed), records: num(om2?.records) },
    om3,
    om4,
    om5: { approvals: num(om5?.approvals), jobs: num(om5?.jobs) },
    om6: {
      completed: num(om6?.completed),
      finalMicroInr: num(om6?.final),
      estimatedMicroInr: num(om6?.estimated),
      unpricedRuns: num(om6?.unpriced),
    },
    om7: { duplicates: num(om7?.duplicates) },
    om8: { needsPerson: num(om8?.needs), open: num(om8?.open) },
    statuses,
    grants,
  }
}

export type OperatorMetrics = Awaited<ReturnType<typeof operatorMetrics>>
