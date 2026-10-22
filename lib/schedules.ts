import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm"
import { z } from "zod"

import { privileged, rowsOf, type Q, type Tx } from "@/db"
import { mandates, scheduleRuns, schedules, type WatchConfig } from "@/db/schema"
import { enqueueScheduled, TurnError } from "@/lib/agent/queue"
import { getSetting } from "@/lib/config"
import { checkWatch, watchPrompt } from "@/lib/watch"

// Schedules (A3): when each one fires next, in India time, and how that
// reads to a person. IST is UTC+5:30 all year (no daylight saving), so wall
// clock maths is a fixed offset. ponytail: only Asia/Kolkata; other zones
// need a real tz library and DST-aware stepping.

const IST_MS = 330 * 60_000
const DAY_MINUTES = 1440

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour")
const instant = z.iso.datetime({ offset: true })

export const ruleSchema = z.discriminatedUnion("freq", [
  z.object({ freq: z.literal("once"), startAt: instant }),
  z.object({ freq: z.literal("daily"), at: time }),
  z.object({
    freq: z.literal("weekly"),
    at: time,
    // 1 = Monday … 7 = Sunday
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7).readonly(),
  }),
  z.object({
    freq: z.literal("monthly"),
    at: time,
    // Up to 28, so every month has the day
    dayOfMonth: z.number().int().min(1).max(28),
  }),
  z.object({
    freq: z.literal("interval"),
    everyMinutes: z.number().int().min(60).max(525_600),
    startAt: instant.optional(),
  }),
])

export type Rule = z.infer<typeof ruleSchema>

export const SCHEDULE_TIMEZONE = "Asia/Kolkata"

// The first fire strictly after `after`, or null when there is none
export function nextRun(rule: Rule, after: Date): Date | null {
  const t = after.getTime()
  switch (rule.freq) {
    case "once": {
      const at = Date.parse(rule.startAt)
      return at > t ? new Date(at) : null
    }
    case "interval": {
      const step = rule.everyMinutes * 60_000
      const start = rule.startAt ? Date.parse(rule.startAt) : t
      if (start > t) return new Date(start)
      return new Date(start + (Math.floor((t - start) / step) + 1) * step)
    }
    default: {
      const [hour, minute] = rule.at.split(":").map(Number)
      // The IST calendar day, read through the UTC getters
      const local = new Date(t + IST_MS)
      for (let offset = 0; offset <= 62; offset++) {
        const day = new Date(
          Date.UTC(
            local.getUTCFullYear(),
            local.getUTCMonth(),
            local.getUTCDate() + offset
          )
        )
        if (rule.freq === "weekly" && !rule.days.includes(day.getUTCDay() || 7)) continue
        if (rule.freq === "monthly" && day.getUTCDate() !== rule.dayOfMonth) continue
        const at =
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            hour,
            minute
          ) - IST_MS
        if (at > t) return new Date(at)
      }
      return null
    }
  }
}

export function nextRuns(rule: Rule, after: Date, count = 3) {
  const runs: Date[] = []
  for (let at = nextRun(rule, after); at && runs.length < count; at = nextRun(rule, at)) {
    runs.push(at)
  }
  return runs
}

/* ───────────────────────────── in words ─────────────────────────── */

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const clock = (hhmm: string) => {
  const [hour, minute] = hhmm.split(":").map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`
}

const list = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]

// "Every Monday at 9:00 am", in IST
export function describeRule(rule: Rule) {
  switch (rule.freq) {
    case "once": {
      const local = new Date(Date.parse(rule.startAt) + IST_MS)
      const hhmm = `${local.getUTCHours()}:${String(local.getUTCMinutes()).padStart(2, "0")}`
      return `Once, on ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} at ${clock(hhmm)}`
    }
    case "daily":
      return `Every day at ${clock(rule.at)}`
    case "weekly":
      return `Every ${list([...new Set(rule.days)].sort().map((d) => DAYS[d - 1]))} at ${clock(rule.at)}`
    case "monthly":
      return `On day ${rule.dayOfMonth} of every month at ${clock(rule.at)}`
    case "interval":
      return `Every ${rule.everyMinutes} minutes`
  }
}

// For the approval card: how many runs a month this rule makes, rounded up
export function runsPerMonth(rule: Rule) {
  switch (rule.freq) {
    case "once":
    case "monthly":
      return 1
    case "daily":
      return 30
    case "weekly":
      return Math.ceil((new Set(rule.days).size * 30) / 7)
    case "interval":
      return Math.floor((30 * DAY_MINUTES) / rule.everyMinutes)
  }
}

// The shortest time between two runs, checked against the plan's minimum
export function minGapMinutes(rule: Rule) {
  switch (rule.freq) {
    case "once":
      return Number.POSITIVE_INFINITY
    case "daily":
      return DAY_MINUTES
    case "monthly":
      return 28 * DAY_MINUTES
    case "interval":
      return rule.everyMinutes
    case "weekly": {
      const days = [...new Set(rule.days)].sort()
      const gaps = days.map((d, i) => (i === 0 ? d + 7 - days.at(-1)! : d - days[i - 1]))
      return Math.min(...gaps.map((gap) => (gap || 7) * DAY_MINUTES))
    }
  }
}

/* ───────────────────────────── writes ───────────────────────────── */

export class ScheduleError extends Error {}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: SCHEDULE_TIMEZONE,
  dateStyle: "medium",
  timeStyle: "short",
})

// What the person sees before approving, and the agent after: cadence,
// next three runs in IST, and roughly how many tasks a month it makes
export function scheduleFacts(rule: Rule, now = new Date()) {
  return {
    cadence: describeRule(rule),
    nextRuns: nextRuns(rule, now).map((at) => IST_TIME.format(at)),
    runsPerMonth: runsPerMonth(rule),
    note: "Each run is a task that counts against the plan.",
  }
}

// Inside the caller's withUser transaction, after the plan limits were
// checked. The person approved this exact schedule (R2), so it's approved
// now. `id` comes from the tool call, so a retried call can't add a second.
export async function createSchedule(
  tx: Tx,
  input: {
    id: string
    userId: string
    agentId: string
    threadId: string
    goalId?: string | null
    prompt: string
    rule: Rule
    maxRuns?: number
    backgroundAllowed?: boolean
    // A13: a watcher (K5) checks this page on each run
    watch?: WatchConfig | null
  },
  now = new Date()
) {
  const next = nextRun(input.rule, now)
  if (!next) throw new ScheduleError("That time has already passed.")
  await tx
    .insert(schedules)
    .values({
      id: input.id,
      userId: input.userId,
      agentId: input.agentId,
      threadId: input.threadId,
      goalId: input.goalId ?? null,
      kind: input.watch ? "watch" : input.rule.freq === "once" ? "once" : "recurring",
      watch: input.watch ?? null,
      prompt: input.prompt,
      rule: input.rule,
      timezone: SCHEDULE_TIMEZONE,
      nextRunAt: next,
      maxRuns: input.maxRuns ?? null,
      backgroundAllowed: input.backgroundAllowed ?? false,
      approvedAt: now,
    })
    .onConflictDoNothing()
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, input.id))
  if (!row) throw new ScheduleError("The schedule couldn't be saved.")
  return row
}

// Pause, end or re-time a schedule. Resuming is the person's alone.
export async function updateSchedule(
  tx: Tx,
  scheduleId: string,
  change: { status?: "paused" | "ended"; rule?: Rule; reason?: string },
  now = new Date()
) {
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId))
  if (!row) throw new ScheduleError(`No schedule with id ${scheduleId}.`)
  const status = change.status ?? row.status
  if (row.status === "ended" && (change.rule || status !== "ended")) {
    throw new ScheduleError("This schedule has ended.")
  }
  const rule = change.rule ?? ruleSchema.parse(row.rule)
  const next = status === "active" ? nextRun(rule, now) : null
  await tx
    .update(schedules)
    .set({
      status,
      rule,
      nextRunAt: next,
      ...(change.status === "paused" && { pauseReason: change.reason ?? "agent" }),
      // A watcher stays a watcher when re-timed
      ...(change.rule &&
        !row.watch && { kind: rule.freq === "once" ? "once" : "recurring" }),
    })
    .where(eq(schedules.id, scheduleId))
  return { scheduleId, status, nextRunAt: next, ...scheduleFacts(rule, now) }
}

/* ───────────────────────────── scheduler ────────────────────────── */

export type DueRun = {
  scheduleId: string
  userId: string
  threadId: string
  agentId: string
  prompt: string
  dueAt: Date
  capMicroInr: number | null
  kind?: "once" | "recurring" | "watch"
  watch?: WatchConfig | null
  // O7: the playbook of the job that owns the schedule's goal
  workflowId?: string
}

// A goal's spend this month (IST) against its ₹ cap (K2). ponytail: unpriced
// charges (no exchange rate) can't be counted, so they don't stop a goal.
async function goalOverBudget(tx: Q, goalId: string) {
  const result = await tx.execute(sql`
    select g.monthly_budget_micro_inr as cap, coalesce(sum(c.charge_micro_inr), 0) as spent
    from kriya.goals g
    left join kriya.tasks t on t.thread_id = g.thread_id and t.user_id = g.user_id
      and t.created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
    left join kriya.charges c on c.task_id = t.id
    where g.id = ${goalId}
    group by g.monthly_budget_micro_inr`)
  const row = rowsOf<{ cap: string | number | null; spent: string | number }>(result)[0]
  return row?.cap != null && Number(row.spent) >= Number(row.cap)
}

// Step 1 (worker): lock due schedules, record one run per due time, and
// move each to its next time. Missed times while the worker was down are
// skipped, not replayed. Tasks are made in step 2, through queue.ts.
export async function claimDueSchedules(max = 50): Promise<DueRun[]> {
  return privileged.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.status, "active"), lte(schedules.nextRunAt, sql`now()`)))
      .orderBy(asc(schedules.nextRunAt))
      .limit(max)
      .for("update", { skipLocked: true })
    const now = Date.now()
    const claimed: DueRun[] = []
    // A job's playbook, by goal; schedules without a job have none
    const goalIds = due.flatMap((row) => row.goalId ?? [])
    const playbooks = goalIds.length
      ? await tx
          .select({
            goalId: mandates.goalId,
            userId: mandates.userId,
            playbookId: mandates.playbookId,
          })
          .from(mandates)
          .where(inArray(mandates.goalId, goalIds))
      : []
    for (const row of due) {
      const dueAt = row.nextRunAt!
      const rule = ruleSchema.safeParse(row.rule)
      const overBudget = row.goalId ? await goalOverBudget(tx, row.goalId) : false
      const outcome = overBudget ? "skipped_budget" : rule.success ? "claimed" : "failed"
      const [run] = await tx
        .insert(scheduleRuns)
        .values({
          scheduleId: row.id,
          userId: row.userId,
          dueAt,
          outcome,
          ...(!rule.success && { error: "The schedule's rule isn't valid." }),
        })
        .onConflictDoNothing()
        .returning()
      if (!rule.success || overBudget) {
        await tx
          .update(schedules)
          .set({
            status: "paused",
            pauseReason: overBudget ? "budget" : "rule",
            nextRunAt: null,
          })
          .where(eq(schedules.id, row.id))
        continue
      }
      const runs = row.runs + 1
      const next =
        row.maxRuns && runs >= row.maxRuns
          ? null
          : nextRun(rule.data, new Date(Math.max(dueAt.getTime(), now)))
      await tx
        .update(schedules)
        .set({
          runs,
          lastRunAt: dueAt,
          nextRunAt: next,
          ...(!next && { status: "ended" }),
        })
        .where(eq(schedules.id, row.id))
      if (run) {
        claimed.push({
          scheduleId: row.id,
          userId: row.userId,
          threadId: row.threadId,
          agentId: row.agentId,
          prompt: row.prompt,
          dueAt,
          capMicroInr: row.capMicroInr,
          kind: row.kind,
          watch: row.watch,
          ...playbooks
            .filter(
              (m) => m.goalId === row.goalId && m.userId === row.userId && m.playbookId
            )
            .map((m) => ({ workflowId: m.playbookId! }))[0],
        })
      }
    }
    return claimed
  })
}

// TurnError codes that mean the person is over a plan limit
const LIMIT_CODES = new Set(["daily_limit", "allowance"])

// Step 2: the run as an ordinary task. A busy thread skips this fire; a
// limit pauses the schedule with the reason until the person resumes it.
// Anything unexpected leaves the run claimed for recovery to retry.
// A watcher's check (K5). No change, or a failed fetch, is the run's outcome
// and no task is made; a change returns the diff for the run's task.
async function runWatch(
  run: DueRun
): Promise<{ outcome: "unchanged" | "failed" } | { diff: string }> {
  const record = (outcome: "unchanged" | "failed", error: string | null = null) =>
    privileged
      .update(scheduleRuns)
      .set({ outcome, error })
      .where(
        and(
          eq(scheduleRuns.scheduleId, run.scheduleId),
          eq(scheduleRuns.dueAt, run.dueAt),
          eq(scheduleRuns.outcome, "claimed")
        )
      )
  if (!run.watch || (await getSetting("agents.watchers")) !== "on") {
    await record("failed", "Watchers are switched off.")
    return { outcome: "failed" }
  }
  const result = await checkWatch({
    scheduleId: run.scheduleId,
    userId: run.userId,
    watch: run.watch,
    key: `${run.scheduleId}:${run.dueAt.toISOString()}`,
  })
  if (result.kind === "changed") return { diff: result.diff }
  if (result.kind === "failed") {
    await record("failed", `Couldn't read the page: ${result.error}`.slice(0, 500))
    // Five failures in a row: paused with the reason, until the person resumes
    if (result.pause) {
      await privileged
        .update(schedules)
        .set({ status: "paused", pauseReason: "fetch", nextRunAt: null })
        .where(and(eq(schedules.id, run.scheduleId), eq(schedules.status, "active")))
    }
    return { outcome: "failed" }
  }
  await record("unchanged")
  return { outcome: "unchanged" }
}

export async function runDue(run: DueRun) {
  // A watcher (K5) checks its page first; only a change makes a task
  if (run.kind === "watch") {
    const watched = await runWatch(run)
    if ("outcome" in watched) return watched.outcome
    run = { ...run, prompt: watchPrompt(run.prompt, run.watch!, watched.diff) }
  }
  let outcome: "enqueued" | "skipped_active" | "skipped_limit" | "failed"
  let taskId: string | null = null
  let error: string | null = null
  try {
    taskId = (await enqueueScheduled(run)).id
    outcome = "enqueued"
  } catch (e) {
    if (!(e instanceof TurnError) || e.code === "unavailable") throw e
    outcome =
      e.code === "busy"
        ? "skipped_active"
        : LIMIT_CODES.has(e.code)
          ? "skipped_limit"
          : "failed"
    if (outcome === "failed") error = e.message.slice(0, 500)
  }
  await privileged
    .update(scheduleRuns)
    .set({ outcome, taskId, error })
    .where(
      and(
        eq(scheduleRuns.scheduleId, run.scheduleId),
        eq(scheduleRuns.dueAt, run.dueAt),
        eq(scheduleRuns.outcome, "claimed")
      )
    )
  if (outcome === "skipped_limit") {
    await privileged
      .update(schedules)
      .set({ status: "paused", pauseReason: "limit", nextRunAt: null })
      .where(and(eq(schedules.id, run.scheduleId), eq(schedules.status, "active")))
  }
  return outcome
}

// Runs a crashed worker left claimed: enqueued again after 2 minutes (the
// task's idempotency key makes that safe), given up after an hour
export async function recoverClaimedRuns() {
  await privileged
    .update(scheduleRuns)
    .set({ outcome: "failed", error: "Not started within an hour." })
    .where(
      and(
        eq(scheduleRuns.outcome, "claimed"),
        lt(scheduleRuns.createdAt, sql`now() - interval '1 hour'`)
      )
    )
  const stale = await privileged
    .select({ run: scheduleRuns, schedule: schedules })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(
      and(
        eq(scheduleRuns.outcome, "claimed"),
        lt(scheduleRuns.createdAt, sql`now() - interval '2 minutes'`)
      )
    )
    .limit(50)
  for (const { run, schedule } of stale) {
    await runDue({
      scheduleId: schedule.id,
      userId: schedule.userId,
      threadId: schedule.threadId,
      agentId: schedule.agentId,
      prompt: schedule.prompt,
      dueAt: run.dueAt,
      capMicroInr: schedule.capMicroInr,
    })
  }
  return stale.length
}

/* ─────────────────────────── the person's ───────────────────────── */

// Only the person's actions call these: resuming is theirs alone (the
// scheduler and agents only ever pause or end)
export async function setScheduleStatus(
  tx: Tx,
  scheduleId: string,
  status: "active" | "paused" | "ended",
  now = new Date()
) {
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId))
  if (!row) throw new ScheduleError(`No schedule with id ${scheduleId}.`)
  // The transition table refuses it too; this says it plainly
  if (row.status === "ended") throw new ScheduleError("This schedule has ended.")
  let nextRunAt: Date | null = null
  if (status === "active") {
    nextRunAt = nextRun(ruleSchema.parse(row.rule), now)
    if (!nextRunAt)
      throw new ScheduleError("Its time has passed. Set a new time instead.")
  }
  await tx
    .update(schedules)
    .set({ status, nextRunAt, pauseReason: status === "paused" ? "person" : null })
    .where(eq(schedules.id, scheduleId))
}

// The person's ₹ cap per run (K2); null removes it
export async function setScheduleCap(
  tx: Tx,
  scheduleId: string,
  capMicroInr: number | null
) {
  const rows = await tx
    .update(schedules)
    .set({ capMicroInr })
    .where(eq(schedules.id, scheduleId))
    .returning({ id: schedules.id })
  if (rows.length === 0) throw new ScheduleError(`No schedule with id ${scheduleId}.`)
}
