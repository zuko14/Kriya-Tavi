import { generateText, Output } from "ai"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, rowsOf, withUser } from "@/db"
import {
  maintenanceJobs,
  messages,
  resourceUsage,
  threadSummaries,
  type ThreadSummary,
  type Tier,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { activePolicy } from "@/lib/improve"
import { log } from "@/lib/log"
import {
  coveredCount,
  dropped,
  missingFacts,
  renderSummary,
  SUMMARY_MAX_CHARS,
  summarySchema,
  textOfParts,
  type SummaryMessage,
} from "@/lib/memory/summaries"
import { createGatewayModel, modelForTier, usageFromMetadata } from "@/lib/models"

// Background model work for memory v2 (ARCHITECTURE.md §2.5, DATA_MODEL
// §2.1): thread summary checkpoints. Jobs are kriya.maintenance_jobs rows,
// never tasks, so they don't hold the thread's one active task and the
// person can keep talking (AF-12). Their model calls are a platform cost in
// resource_usage, capped per person per day by agents.maintenanceCapMicroUsd;
// they are never charged to the person.

export const MAINTENANCE_LEASE_SECONDS = 120
const MAX_ATTEMPTS = 3

export type MaintenanceJob = {
  id: string
  userId: string
  kind: "thread_summary" | "episode_summary" | "consolidate"
  ref: string
  attempts: number
}

export type Summarizer = (input: { tier: Tier; prompt: string }) => Promise<{
  summary: ThreadSummary
  model: string
  inputTokens: number | null
  outputTokens: number | null
  // What the provider reported; null when it didn't
  costMicroUsd: number | null
}>

export const modelSummarizer: Summarizer = async ({ tier, prompt }) => {
  const model = await modelForTier(tier)
  const result = await generateText({
    model: createGatewayModel(model),
    output: Output.object({ schema: summarySchema }),
    prompt,
    maxRetries: 2,
  })
  return {
    summary: result.output,
    model,
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    costMicroUsd: usageFromMetadata(result.providerMetadata)?.costMicroUsd ?? null,
  }
}

/* ──────────────────────────── enqueue ───────────────────────────── */

// After a task: queue a checkpoint when the thread has grown past the
// trigger since the last one (the policy bundle's, A12; the baseline is
// SUMMARY_TRIGGER_CHARS). One open job per thread (unique index).
export async function enqueueSummary(userId: string, threadId: string) {
  const size = await withUser(userId, async (tx) => {
    const result = await tx.execute(sql`
      select coalesce(sum(length(m.parts::text)), 0)::int as chars
      from kriya.messages m
      where m.thread_id = ${threadId}
        and m.created_at > coalesce(
          (select max(covers_through) from kriya.thread_summaries where thread_id = ${threadId}),
          '-infinity')`)
    return rowsOf<{ chars: number }>(result)[0]?.chars ?? 0
  })
  const { bundle } = await activePolicy(userId)
  if (size <= bundle.budgets.summaryTriggerChars) return false
  const inserted = await privileged
    .insert(maintenanceJobs)
    .values({ userId, kind: "thread_summary", ref: threadId })
    .onConflictDoNothing()
    .returning({ id: maintenanceJobs.id })
  return inserted.length > 0
}

/* ───────────────────────── claim and lease ──────────────────────── */

export async function claimJob(): Promise<MaintenanceJob | null> {
  const result = await privileged.execute(sql`
    update kriya.maintenance_jobs
    set status = 'running', attempts = attempts + 1,
        lease_until = now() + make_interval(secs => ${MAINTENANCE_LEASE_SECONDS})
    where id = (
      select id from kriya.maintenance_jobs
      where status = 'queued' and available_at <= now() and attempts < ${MAX_ATTEMPTS}
      order by available_at
      limit 1
      for update skip locked)
    returning id, user_id as "userId", kind, ref, attempts`)
  return rowsOf<MaintenanceJob>(result)[0] ?? null
}

// Jobs whose worker died: back to the queue, or failed after 3 attempts
export async function recoverJobs() {
  const result = await privileged.execute(sql`
    update kriya.maintenance_jobs
    set status = case when attempts < ${MAX_ATTEMPTS} then 'queued' else 'failed' end,
        lease_until = null, error = coalesce(error, 'lease lost')
    where status = 'running' and lease_until < now()
    returning id`)
  return rowsOf<{ id: string }>(result).length
}

async function finish(job: MaintenanceJob, status: "done" | "failed", error?: string) {
  await privileged
    .update(maintenanceJobs)
    .set({ status, leaseUntil: null, error: error ?? null })
    .where(and(eq(maintenanceJobs.id, job.id), eq(maintenanceJobs.status, "running")))
}

/* ──────────────────────────── the cap ───────────────────────────── */

// Today in IST: what this person's maintenance has cost. Unpriced calls
// can't be counted, so one of them stops further jobs for the day: the cap
// is never exceeded on the strength of a missing number.
export async function withinCap(userId: string) {
  const cap = Number.parseInt(
    (await getSetting("agents.maintenanceCapMicroUsd")) ?? "0",
    10
  )
  if (!Number.isFinite(cap) || cap <= 0) return false
  const result = await privileged.execute(sql`
    select coalesce(sum(cost_micro_usd), 0)::bigint as spent,
           count(*) filter (where cost_micro_usd is null)::int as unpriced
    from kriya.resource_usage
    where user_id = ${userId} and kind = 'maintenance_model'
      and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`)
  const row = rowsOf<{ spent: string | number; unpriced: number }>(result)[0]
  return row.unpriced === 0 && Number(row.spent) < cap
}

// Waits for the next IST day without using up an attempt
async function defer(job: MaintenanceJob, reason: string) {
  await privileged.execute(sql`
    update kriya.maintenance_jobs
    set status = 'queued', attempts = attempts - 1, lease_until = null, error = ${reason},
        available_at = date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' + interval '1 day'
    where id = ${job.id} and status = 'running'`)
}

/* ─────────────────────────── the job ────────────────────────────── */

const PROMPT = `Summarise the earlier part of a conversation between a person and their AI agent. The agent will read your summary instead of these messages, so keep everything it needs to carry on: what the person told it, what was decided and why, open questions and what is still to be done.

Rules:
- Copy every amount, date, id and link exactly as written into "numbers".
- Keep names of people, places and things.
- Add nothing that isn't in the conversation.
- Keep the whole summary under 3,000 characters.`

function promptFor(previous: ThreadSummary | null, covered: SummaryMessage[]) {
  const lines = covered
    .map((message) => {
      const text = textOfParts(message).trim()
      return text ? `${message.role === "user" ? "Person" : "Agent"}: ${text}` : null
    })
    .filter(Boolean)
  return [
    PROMPT,
    previous && `Summary of what came before:\n${renderSummary(previous)}`,
    `Conversation:\n${lines.join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export type JobOutcome = "done" | "deferred" | "nothing" | "rejected"

export async function runSummaryJob(
  job: MaintenanceJob,
  summarize: Summarizer = modelSummarizer
): Promise<JobOutcome> {
  if (!(await withinCap(job.userId))) {
    await defer(job, "daily maintenance cap reached or not set")
    return "deferred"
  }
  // The person's messages are read on their behalf, under their row security
  const { rows, previous } = await withUser(job.userId, async (tx) => ({
    rows: await tx
      .select({
        role: messages.role,
        parts: messages.parts,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.threadId, job.ref))
      .orderBy(asc(messages.createdAt)),
    previous:
      (
        await tx
          .select()
          .from(threadSummaries)
          .where(eq(threadSummaries.threadId, job.ref))
          .orderBy(desc(threadSummaries.coversThrough))
          .limit(1)
      )[0] ?? null,
  }))
  const pending = previous
    ? rows.filter((m) => m.createdAt > previous.coversThrough)
    : rows
  const cut = coveredCount(pending)
  if (cut === 0) {
    await finish(job, "done", "nothing to cover")
    return "nothing"
  }
  const covered = pending.slice(0, cut)
  const prompt = promptFor(previous?.summary ?? null, covered)

  // Budget tier first; once more on balanced if the check fails (§7)
  let problem = ""
  for (const tier of ["budget", "balanced"] as const) {
    const result = await summarize({ tier, prompt })
    await privileged
      .insert(resourceUsage)
      .values({
        requestKey: `maintenance:${job.id}:${job.attempts}:${tier}`,
        userId: job.userId,
        kind: "maintenance_model",
        quantity: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
        costMicroUsd: result.costMicroUsd,
      })
      .onConflictDoNothing()

    const text = renderSummary(result.summary)
    // What the person wrote, and what the last checkpoint kept, must survive
    const missing = [
      ...missingFacts(covered, result.summary),
      ...dropped(previous?.summary.numbers ?? [], result.summary),
    ]
    if (text.length > SUMMARY_MAX_CHARS) problem = `${text.length} characters`
    else if (missing.length > 0) problem = `missing ${missing.slice(0, 5).join(", ")}`
    else {
      await privileged
        .insert(threadSummaries)
        .values({
          id: nanoid(12),
          userId: job.userId,
          threadId: job.ref,
          coversThrough: covered[covered.length - 1].createdAt,
          summary: result.summary,
          chars: text.length,
          model: result.model,
        })
        .onConflictDoNothing()
      await finish(job, "done")
      return "done"
    }
  }
  // No checkpoint: the thread costs more, but nothing is lost
  log.warn("thread summary rejected", { jobId: job.id, problem })
  await finish(job, "failed", `summary check failed: ${problem}`)
  return "rejected"
}

// Runs one claimed job; a crash puts it back with a delay, or fails it
// after the last attempt
export async function runJob(
  job: MaintenanceJob,
  summarize?: Summarizer
): Promise<JobOutcome> {
  try {
    if (job.kind === "thread_summary") return await runSummaryJob(job, summarize)
    await finish(job, "failed", `no runner for ${job.kind} yet`)
    return "rejected"
  } catch (error) {
    log.error("maintenance job failed", { jobId: job.id, error })
    await privileged
      .update(maintenanceJobs)
      .set({
        status: job.attempts < MAX_ATTEMPTS ? "queued" : "failed",
        leaseUntil: null,
        availableAt: new Date(Date.now() + 60_000 * job.attempts),
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      })
      .where(and(eq(maintenanceJobs.id, job.id), eq(maintenanceJobs.status, "running")))
    return "rejected"
  }
}
