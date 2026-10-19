import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"

// Quotes (K2, AD-28): what a workflow, skill or schedule usually costs,
// from real charges of earlier tasks only. Below 10 samples there is no
// estimate, never a guessed number (invariant 6). Only numbers leave here.

export type QuoteKey =
  { workflowId: string } | { skillId: string } | { scheduleId: string }

const MIN_SAMPLES = 10

// Nearest rank: the smallest value with at least q of the samples at or below it
const percentile = (sorted: number[], q: number) =>
  sorted[Math.ceil(q * sorted.length) - 1]

async function samples(key: QuoteKey, userId: string | null) {
  const [field, value] = Object.entries(key)[0]
  const result = await privileged.execute(sql`
    select c.charge_micro_inr as charge, c.status
    from kriya.charges c join kriya.tasks t on t.id = c.task_id
    where t.input ->> ${field} = ${value}
      and c.status in ('final', 'estimated') and c.charge_micro_inr is not null
      ${userId ? sql`and t.user_id = ${userId}` : sql``}
    order by c.created_at desc
    limit 500`)
  return rowsOf<{ charge: string | number; status: string }>(result)
}

export async function quoteFor(userId: string, key: QuoteKey) {
  let from: "yours" | "everyone" = "yours"
  let rows = await samples(key, userId)
  // Workflows are code constants, so everyone's runs say nothing personal;
  // skills and schedules are the person's own
  if (rows.length < MIN_SAMPLES && "workflowId" in key) {
    from = "everyone"
    rows = await samples(key, null)
  }
  if (rows.length < MIN_SAMPLES) return null
  const sorted = rows.map((row) => Number(row.charge)).sort((a, b) => a - b)
  return {
    p50MicroInr: percentile(sorted, 0.5),
    p90MicroInr: percentile(sorted, 0.9),
    samples: rows.length,
    from,
    estimated: rows.some((row) => row.status === "estimated"),
  }
}

export type Quote = NonNullable<Awaited<ReturnType<typeof quoteFor>>>
