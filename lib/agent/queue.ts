import type { UIMessageChunk } from "ai"
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm"

import { privileged, withUser, type Q } from "@/db"
import {
  approvals,
  squadMembers,
  taskEvents,
  tasks,
  threads,
  type Task,
  type TaskInput,
} from "@/db/schema"
import { loadMessages, saveMessage, textOf } from "@/lib/agent/messages"
import type { KriyaMessage } from "@/lib/agent/tools"
import { getMaxSteps, getSetting } from "@/lib/config"
import { checkTaskAllowed, usageSummary } from "@/lib/entitlements"
import { capToProviderMicroUsd, parseRate } from "@/lib/money"
import {
  isGatewayConfigured,
  ModelConfigError,
  modelForTier,
  resolveTier,
} from "@/lib/models"

// The web side of agent tasks: put a turn on the queue, follow it, stop it.
// The work itself happens in the worker (worker/index.ts), so a task keeps
// going when the browser closes, and survives a web deploy.

export class TurnError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request"
  ) {
    super(message)
    this.name = "TurnError"
  }
}

// A queued task that no worker picked up within this window fails, so a
// person isn't left waiting forever behind an outage
const QUEUE_GRACE_MS = 10 * 60_000

type PgError = {
  code?: string
  constraint_name?: string
  constraint?: string
  cause?: unknown
}

// Drizzle wraps driver errors; postgres.js names the constraint
// `constraint_name`, PGlite (tests) `constraint`
export function isUniqueViolation(error: unknown, constraint: string) {
  for (let e = error as PgError | undefined; e; e = e.cause as PgError | undefined) {
    if (e.code === "23505" && (e.constraint_name ?? e.constraint) === constraint)
      return true
  }
  return false
}

// What every new task needs: the thread (through RLS: someone else's thread
// finds nothing), the agent who starts, and the plan's limits and routing
async function prepare(userId: string, threadId: string, agentId?: string) {
  const thread = await withUser(userId, (tx) =>
    tx.query.threads.findFirst({
      where: eq(threads.id, threadId),
      with: {
        agent: true,
        squad: {
          with: {
            members: { orderBy: asc(squadMembers.position), with: { agent: true } },
          },
        },
      },
    })
  )
  if (!thread) throw new TurnError("Thread not found.", 404, "not_found")
  const members = thread.squad
    ? thread.squad.members.map((member) => member.agent)
    : thread.agent
      ? [thread.agent]
      : []
  const first = members.find((member) => member.id === agentId) ?? members[0]
  if (!first) throw new TurnError("This thread has no agents left in it.", 410, "gone")

  const usage = await usageSummary(userId)
  const limit = checkTaskAllowed(usage)
  if (!limit.ok) throw new TurnError(limit.message, 402, limit.code)

  if (!isGatewayConfigured()) {
    throw new TurnError(
      "Kriya can't reach its AI models right now. Try again soon.",
      503,
      "unavailable"
    )
  }
  const plan = usage.plan
  const tier = await resolveTier(first.model, plan)
  try {
    await modelForTier(tier)
  } catch (error) {
    if (error instanceof ModelConfigError) {
      console.error("[kriya] routing:", error.message)
      throw new TurnError(
        "Kriya can't reach its AI models right now. Try again soon.",
        503,
        "unavailable"
      )
    }
    throw error
  }
  const steps = Math.min(plan.maxSteps, await getMaxSteps())
  return { thread, first, plan, tier, steps }
}

type Prepared = Awaited<ReturnType<typeof prepare>>

function taskRow(
  userId: string,
  threadId: string,
  { first, plan, tier, steps }: Prepared,
  messageId: string,
  idempotencyKey: string | null,
  // A scheduled run (A3): its channel, schedule and ₹-capped budget
  run: { scheduleId?: string; costBudgetMicroUsd?: number } = {}
) {
  const input: TaskInput = run.scheduleId
    ? { messageId, agentId: first.id, channel: "schedule", scheduleId: run.scheduleId }
    : { messageId, agentId: first.id, channel: "web" }
  return {
    userId,
    threadId,
    agentId: first.id,
    input,
    planId: plan.id,
    tier,
    deadlineAt: new Date(Date.now() + plan.maxTaskSeconds * 1000 + QUEUE_GRACE_MS),
    stepBudget: steps,
    costBudgetMicroUsd: run.costBudgetMicroUsd ?? plan.maxTaskCostMicroUsd,
    idempotencyKey,
  }
}

// The same request again is the same task; a second task while one runs is refused
async function insertTask(
  userId: string,
  idempotencyKey: string | null,
  insert: () => Promise<Task>
) {
  try {
    return await insert()
  } catch (error) {
    if (isUniqueViolation(error, "tasks_one_active_per_thread")) {
      throw new TurnError("An agent is already working in this thread.", 409, "busy")
    }
    if (idempotencyKey && isUniqueViolation(error, "tasks_user_id_idempotency_key_key")) {
      const [existing] = await withUser(userId, (tx) =>
        tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.idempotencyKey, idempotencyKey)))
      )
      if (existing) return existing
    }
    throw error
  }
}

export async function enqueueTurn({
  userId,
  threadId,
  message,
  agentId,
  idempotencyKey,
}: {
  userId: string
  threadId: string
  message: KriyaMessage
  agentId?: string
  idempotencyKey?: string
}) {
  const prepared = await prepare(userId, threadId, agentId)
  const { thread, first } = prepared

  // Only plain text from the person; everything else in a message is the server's
  const userMessage: KriyaMessage = {
    id: message.id,
    role: "user",
    parts: message.parts.filter((part) => part.type === "text"),
    metadata: thread.squad ? { agentId: first.id } : {},
  }
  const prompt = textOf(userMessage)

  // Thread ownership was checked above; the message and the task land together
  return insertTask(userId, idempotencyKey ?? null, () =>
    privileged.transaction(async (tx) => {
      await saveMessage(tx, userId, threadId, userMessage)
      await tx
        .update(threads)
        .set({
          title: thread.title ?? (prompt.slice(0, 80) || "Untitled"),
          preview: prompt.slice(0, 140),
          activeAt: new Date(),
        })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
      const [task] = await tx
        .insert(tasks)
        .values(
          taskRow(userId, threadId, prepared, userMessage.id, idempotencyKey ?? null)
        )
        .returning()
      return task
    })
  )
}

// A schedule's run (A3, AD-15): its prompt becomes a user message marked as
// scheduled, and the task goes through the same prepare() checks as a turn
// the person starts. The due time keys both, so a run recovered after a
// crash is the same task. A person's ₹ cap per run becomes the task's
// budget (K2), never above the plan's.
export async function enqueueScheduled({
  userId,
  threadId,
  agentId,
  prompt,
  scheduleId,
  dueAt,
  capMicroInr,
}: {
  userId: string
  threadId: string
  agentId: string
  prompt: string
  scheduleId: string
  dueAt: Date
  capMicroInr?: number | null
}) {
  const prepared = await prepare(userId, threadId, agentId)
  const { thread, first, plan } = prepared
  const key = `schedule:${scheduleId}:${dueAt.toISOString()}`
  const message: KriyaMessage = {
    id: `run-${scheduleId}-${dueAt.getTime()}`,
    role: "user",
    parts: [{ type: "text", text: prompt }],
    metadata: {
      channel: "schedule",
      scheduleId,
      ...(thread.squad && { agentId: first.id }),
    },
  }
  const capped = capMicroInr
    ? capToProviderMicroUsd(
        capMicroInr,
        parseRate(await getSetting("fx.usdInr")),
        plan.markupBps
      )
    : null
  // Without an exchange rate the cap can't be converted: the plan's budget
  const costBudgetMicroUsd =
    capped === null ? undefined : Math.max(1, Math.min(capped, plan.maxTaskCostMicroUsd))

  return insertTask(userId, key, () =>
    privileged.transaction(async (tx) => {
      await saveMessage(tx, userId, threadId, message)
      await tx
        .update(threads)
        .set({
          title: thread.title ?? prompt.slice(0, 80),
          preview: prompt.slice(0, 140),
          activeAt: new Date(),
        })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
      const [task] = await tx
        .insert(tasks)
        .values(
          taskRow(userId, threadId, prepared, message.id, key, {
            scheduleId,
            costBudgetMicroUsd,
          })
        )
        .returning()
      return task
    })
  )
}

// The person's answer to a tool call waiting for approval (a calendar event,
// a Gmail draft). Checked against the saved message, never taken from the
// browser: the approval must exist, be pending, and be in the person's own
// thread. Once every pending approval in the reply is answered, the reply
// carries on in the worker, which runs the approved calls.
export async function enqueueApproval({
  userId,
  threadId,
  approvalId,
  approved,
}: {
  userId: string
  threadId: string
  approvalId: string
  approved: boolean
}) {
  // The Inbox's index (A3): an approval that expired or was already
  // answered can't be answered again, even from an old tab (AF-14). Without
  // an index row (agents.inbox off), the message parts decide, as before.
  const decided = and(
    eq(approvals.userId, userId),
    eq(approvals.threadId, threadId),
    eq(approvals.id, approvalId)
  )
  const [indexed] = await privileged
    .select({ status: approvals.status })
    .from(approvals)
    .where(decided)
  if (indexed && indexed.status !== "pending") {
    throw new TurnError(
      "This request isn't waiting for an answer any more.",
      409,
      "stale"
    )
  }
  const decide = (q: Q) =>
    q
      .update(approvals)
      .set({ status: approved ? "approved" : "declined", decidedAt: new Date() })
      .where(and(decided, eq(approvals.status, "pending")))

  const history = await withUser(userId, (tx) => loadMessages(tx, threadId))
  const last = history.at(-1)
  type Pending = { state?: string; approval?: { id?: string } }
  const parts = (last?.parts ?? []) as Pending[]
  const target = parts.find(
    (part) => part.state === "approval-requested" && part.approval?.id === approvalId
  )
  if (!last || last.role !== "assistant" || !target) {
    throw new TurnError(
      "This request isn't waiting for an answer any more.",
      409,
      "stale"
    )
  }

  const answered: KriyaMessage = {
    ...last,
    parts: last.parts.map((part) =>
      part === (target as unknown)
        ? ({
            ...part,
            state: "approval-responded",
            approval: {
              ...target.approval,
              approved,
              ...(approved ? {} : { reason: "The person declined." }),
            },
          } as typeof part)
        : part
    ),
  }
  const stillPending = (answered.parts as Pending[]).some(
    (part) => part.state === "approval-requested"
  )
  if (stillPending) {
    await withUser(userId, async (tx) => {
      // Only the server writes messages; the thread was found through RLS
      await saveMessage(tx, userId, threadId, answered)
    })
    await decide(privileged)
    return null
  }

  const prepared = await prepare(userId, threadId, last.metadata?.agentId)
  const key = `approval:${threadId}:${approvalId}`
  return insertTask(userId, key, () =>
    privileged.transaction(async (tx) => {
      await saveMessage(tx, userId, threadId, answered)
      await decide(tx)
      const [task] = await tx
        .insert(tasks)
        .values(taskRow(userId, threadId, prepared, answered.id, key))
        .returning()
      return task
    })
  )
}

const ACTIVE = ["queued", "running"] as const

export async function activeTask(userId: string, threadId: string) {
  const [task] = await withUser(userId, (tx) =>
    tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.threadId, threadId), inArray(tasks.status, [...ACTIVE])))
      .limit(1)
  )
  return task ?? null
}

// A queued task is canceled at once; a running one at the worker's next
// heartbeat (within seconds). What it produced so far is kept.
export async function cancelThreadTask(userId: string, threadId: string) {
  const now = new Date()
  const queued = await privileged
    .update(tasks)
    .set({ status: "canceled", cancelRequestedAt: now, finishedAt: now })
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.threadId, threadId),
        eq(tasks.status, "queued")
      )
    )
    .returning({ id: tasks.id })
  const running = await privileged
    .update(tasks)
    .set({ cancelRequestedAt: now })
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.threadId, threadId),
        eq(tasks.status, "running")
      )
    )
    .returning({ id: tasks.id })
  return queued.length + running.length > 0
}

/* ───────────────────────────── stream ───────────────────────────── */

const POLL_MS = 350
// Lite mode (K10): slower checks for people on slow networks and data packs
const LITE_POLL_MS = 1_500
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Replays a task's stream from the start, then follows it until it ends.
// Reads go through RLS, so only the task's owner can follow it.
export function streamTask(
  userId: string,
  taskId: string,
  signal?: AbortSignal,
  { lite = false }: { lite?: boolean } = {}
) {
  const pollMs = lite ? LITE_POLL_MS : POLL_MS
  let attempt = -1
  let seq = -1
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        while (!signal?.aborted) {
          const { task, events } = await withUser(userId, async (tx) => {
            // Status first: events committed before a terminal status are then
            // guaranteed to be in the next read
            const [task] = await tx
              .select({ status: tasks.status, error: tasks.error })
              .from(tasks)
              .where(eq(tasks.id, taskId))
            const events = await tx
              .select({
                attempt: taskEvents.attempt,
                seq: taskEvents.seq,
                chunks: taskEvents.chunks,
              })
              .from(taskEvents)
              .where(
                and(
                  eq(taskEvents.taskId, taskId),
                  or(
                    gt(taskEvents.attempt, attempt),
                    and(eq(taskEvents.attempt, attempt), gt(taskEvents.seq, seq))
                  )
                )
              )
              .orderBy(asc(taskEvents.attempt), asc(taskEvents.seq))
              .limit(100)
            return { task, events }
          })
          if (!task) break

          for (const event of events) {
            if (event.attempt !== attempt) {
              // shortcut: a retried attempt can't rewind what the page already
              // drew, so the page is told to reload instead of mixing attempts
              if (attempt !== -1) {
                controller.enqueue({
                  type: "error",
                  errorText:
                    "This task hit a problem and is being retried. Refresh to follow it.",
                })
                controller.close()
                return
              }
              attempt = event.attempt
              seq = -1
            }
            for (const chunk of event.chunks as UIMessageChunk[])
              controller.enqueue(chunk)
            seq = event.seq
          }

          const done = task.status !== "queued" && task.status !== "running"
          if (done && events.length === 0) {
            if (task.status === "failed" && attempt === -1) {
              controller.enqueue({
                type: "error",
                errorText: task.error ?? "The task failed.",
              })
            }
            break
          }
          if (events.length === 0) await sleep(pollMs)
        }
      } catch (error) {
        console.error("[kriya] stream failed:", error)
        try {
          controller.enqueue({
            type: "error",
            errorText: "Lost the connection to this task.",
          })
        } catch {}
      }
      try {
        controller.close()
      } catch {}
    },
  })
}

export async function latestTasks(
  userId: string,
  threadId: string,
  limit = 5
): Promise<Task[]> {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(tasks)
      .where(eq(tasks.threadId, threadId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
  )
}
